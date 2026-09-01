import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBroadcastError,
  pollReceiptOnce,
  waitForReceiptBounded,
  checkNonceConsumed,
  resolveAmbiguousTx,
  recoverUnresolvedEntries,
  markNoRetry,
  isNoRetryTxError,
  type MinimalReceiptClient,
  type MinimalNonceClient,
} from '../src/chain/txRecovery.js';
import { withRetries } from '../src/chain/retry.js';

const noSleep = async () => {};
const WALLET = '0x1000000000000000000000000000000000000001' as `0x${string}`;
const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

function receiptClient(sequence: Array<{ status: 'success' | 'reverted' } | null | 'throw'>): MinimalReceiptClient {
  let i = 0;
  return {
    getTransactionReceipt: async () => {
      const v = sequence[Math.min(i, sequence.length - 1)];
      i++;
      if (v === 'throw') throw new Error('receipt lookup failed');
      return v;
    },
  };
}

function nonceClient(sequence: Array<number | 'throw'>): MinimalNonceClient {
  let i = 0;
  return {
    getTransactionCount: async () => {
      const v = sequence[Math.min(i, sequence.length - 1)];
      i++;
      if (v === 'throw') throw new Error('nonce lookup failed');
      return v;
    },
  };
}

// ── classifyBroadcastError ──────────────────────────────────────────────

test('classifyBroadcastError: clearly local/pre-network rejections are NOT_SUBMITTED', () => {
  assert.equal(classifyBroadcastError(new Error('insufficient funds for gas')), 'NOT_SUBMITTED');
  assert.equal(classifyBroadcastError(new Error('nonce too low')), 'NOT_SUBMITTED');
  assert.equal(classifyBroadcastError(new Error('invalid address')), 'NOT_SUBMITTED');
});

test('classifyBroadcastError: timeouts / unknown errors default to AMBIGUOUS (fail-closed)', () => {
  assert.equal(classifyBroadcastError(new Error('timeout')), 'AMBIGUOUS');
  assert.equal(classifyBroadcastError(new Error('ECONNRESET')), 'AMBIGUOUS');
  assert.equal(classifyBroadcastError(new Error('some unexpected RPC shape')), 'AMBIGUOUS');
});

// ── 1. broadcast success (fast receipt) ─────────────────────────────────

test('1. broadcast success: a hash whose receipt is already available resolves MINED_SUCCESS on the first poll', async () => {
  const client = receiptClient([{ status: 'success' }]);
  const r = await waitForReceiptBounded(client, HASH, 3, 10, noSleep);
  assert.equal(r, 'MINED_SUCCESS');
});

// ── 2. broadcast timeout WITH hash → hash-first recovery ────────────────

test('2. broadcast timeout with hash: pending at first, then confirms success — resolves CONFIRMED', async () => {
  const client = receiptClient([null, null, { status: 'success' }]);
  const outcome = await resolveAmbiguousTx(
    client as MinimalReceiptClient & MinimalNonceClient,
    { txHash: HASH, nonce: 5, wallet: WALLET },
    { receiptAttempts: 5, receiptBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(outcome, 'CONFIRMED');
});

// ── 3. broadcast timeout WITHOUT hash → nonce-based recovery ────────────

test('3. broadcast timeout without hash: nonce never advances across bounded checks — resolves NOT_SUBMITTED', async () => {
  const client = nonceClient([5, 5, 5, 5, 5]);
  const outcome = await resolveAmbiguousTx(
    client as MinimalReceiptClient & MinimalNonceClient,
    { txHash: null, nonce: 5, wallet: WALLET },
    { nonceAttempts: 5, nonceBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(outcome, 'NOT_SUBMITTED');
});

// ── 4. transaction later mined (success) ────────────────────────────────

test('4. transaction later mined: pending several polls, then success', async () => {
  const client = receiptClient([null, null, null, { status: 'success' }]);
  const r = await waitForReceiptBounded(client, HASH, 6, 1, noSleep);
  assert.equal(r, 'MINED_SUCCESS');
});

// ── 5. transaction later reverted ───────────────────────────────────────

test('5. transaction later reverted: pending, then reverted', async () => {
  const client = receiptClient([null, { status: 'reverted' }]);
  const r = await waitForReceiptBounded(client, HASH, 5, 1, noSleep);
  assert.equal(r, 'MINED_REVERT');
  const outcome = await resolveAmbiguousTx(
    receiptClient([null, { status: 'reverted' }]) as MinimalReceiptClient & MinimalNonceClient,
    { txHash: HASH, nonce: 1, wallet: WALLET },
    { receiptAttempts: 5, receiptBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(outcome, 'MINED_REVERT');
});

// ── 6. receipt delayed beyond the bounded window ────────────────────────

test('6. receipt delayed: still pending after every bounded attempt stays unresolved (SUBMITTED), never assumed', async () => {
  const client = receiptClient([null, null, null, null]);
  const r = await waitForReceiptBounded(client, HASH, 4, 1, noSleep);
  assert.equal(r, 'PENDING');
  const outcome = await resolveAmbiguousTx(
    receiptClient([null, null, null, null]) as MinimalReceiptClient & MinimalNonceClient,
    { txHash: HASH, nonce: 1, wallet: WALLET },
    { receiptAttempts: 4, receiptBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(outcome, 'SUBMITTED');
});

// ── 7. restart with unresolved tx(s) ────────────────────────────────────

test('7. restart with unresolved tx: recoverUnresolvedEntries resolves each and reports counts', async () => {
  const entries = [
    { id: 1, chainId: 8453, action: 'writeContract:mint', txHash: HASH, nonce: 5, wallet: WALLET },
    { id: 2, chainId: 8453, action: 'sendTransaction:native', txHash: null, nonce: 7, wallet: WALLET },
  ];
  const resolvedIds: Array<[number, string]> = [];
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    entries,
    () => ({
      getTransactionReceipt: async () => ({ status: 'success' as const }),
      getTransactionCount: async () => 7, // entry #2's nonce (7) has NOT advanced (still == attempted)
    }),
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 1, nonceAttempts: 2, nonceBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(resolved, 2);
  assert.equal(stillUnresolved, 0);
  assert.deepEqual(
    resolvedIds.find(([id]) => id === 1),
    [1, 'CONFIRMED'],
  );
  assert.deepEqual(
    resolvedIds.find(([id]) => id === 2),
    [2, 'NOT_SUBMITTED'],
  );
});

// ── 8. unknown transaction cannot trigger retry ─────────────────────────

test('8. unknown transaction (marked no-retry) cannot trigger a retry, even with a permissive shouldRetry', async () => {
  let calls = 0;
  const err = markNoRetry(new Error('ambiguous broadcast'), { journalId: 1, state: 'RECOVERY_REQUIRED' });
  assert.ok(isNoRetryTxError(err));
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw err;
      },
      { times: 5, backoffMs: 1, shouldRetry: () => true }, // caller says "always retry" — must still be vetoed
    ),
  );
  assert.equal(calls, 1, 'must only be attempted once — no retry after an ambiguous/unresolved broadcast');
});

// ── 9. known-not-submitted CAN retry ────────────────────────────────────

test('9. a plain (unmarked) transient error can retry normally', async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls++;
      if (calls < 2) throw new Error('transient RPC timeout');
      return 'ok';
    },
    { times: 3, backoffMs: 1 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2, 'must have retried once after the first (unmarked) failure');
});

// ── 10. duplicate transaction prevented ─────────────────────────────────

test('10. duplicate prevention: a nonce that DID advance with no hash never resolves to a retry-safe state', async () => {
  const client = nonceClient([6]); // pending nonce (6) > attempted nonce (5) — consumed
  const outcome = await resolveAmbiguousTx(
    client as MinimalReceiptClient & MinimalNonceClient,
    { txHash: null, nonce: 5, wallet: WALLET },
    { nonceAttempts: 5, nonceBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(outcome, 'RECOVERY_REQUIRED');
  assert.notEqual(outcome, 'NOT_SUBMITTED', 'a consumed nonce must never be reported as safe to retry');
});

test('nonce recovery: flaky (UNKNOWN) reads reset the not-consumed streak instead of racing to a false NOT_SUBMITTED', async () => {
  // 4 clean not-consumed reads would normally satisfy attempts=5's streak
  // requirement on the 5th — but a throw in between must reset the count.
  const client = nonceClient([5, 5, 'throw', 5, 5]);
  const outcome = await resolveAmbiguousTx(
    client as MinimalReceiptClient & MinimalNonceClient,
    { txHash: null, nonce: 5, wallet: WALLET },
    { nonceAttempts: 5, nonceBackoffMs: 1, sleepFn: noSleep },
  );
  assert.equal(outcome, 'RECOVERY_REQUIRED');
});

test('resolveAmbiguousTx: no hash and no nonce known → RECOVERY_REQUIRED immediately', async () => {
  const client = nonceClient([]);
  const outcome = await resolveAmbiguousTx(client as MinimalReceiptClient & MinimalNonceClient, {
    txHash: null,
    nonce: null,
    wallet: WALLET,
  });
  assert.equal(outcome, 'RECOVERY_REQUIRED');
});

test('pollReceiptOnce: a receipt-lookup RPC error is PENDING, never misread as reverted', async () => {
  const client: MinimalReceiptClient = {
    getTransactionReceipt: async () => {
      throw new Error('RPC hiccup');
    },
  };
  assert.equal(await pollReceiptOnce(client, HASH), 'PENDING');
});
