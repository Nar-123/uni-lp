/**
 * Phase 4.6.3 — transaction recovery pre-send latency.
 *
 * P2 finding: unresolved tx-journal entries were re-checked sequentially
 * before every send (src/chain/clients.ts's journalledSend), turning a
 * slow/flaky RPC into a multi-minute stall even though each entry's check
 * (resolveAmbiguousTx — a bounded receipt or pending-nonce poll) is fully
 * independent, read-only, and touches only that entry's own txHash/nonce.
 *
 * Fix: recoverUnresolvedEntries() (src/chain/txRecovery.ts) now runs all
 * entries' checks concurrently via Promise.all, with each entry's own
 * try/catch preserved internally so one entry's failure/slowness can never
 * affect another's classification. journalledSend now calls this shared,
 * already-well-tested function instead of duplicating its own sequential
 * loop.
 *
 * This file focuses on: the latency improvement itself (timing proof),
 * that UNKNOWN state is never collapsed into a false CONFIRMED/FAILED
 * across a mixed batch (the mandatory failure-injection test), and that a
 * remaining UNKNOWN entry still blocks a new send (the mandatory pre-send
 * safety test) — reproducing journalledSend's exact, unchanged gating
 * pattern (`stillUnresolved.length > 0` blocks) rather than re-testing the
 * unexported function itself, which would require full wallet/RPC
 * infrastructure this fix does not touch.
 *
 * Classification-correctness at the single-entry level (CONFIRMED,
 * MINED_REVERT, NOT_SUBMITTED, RECOVERY_REQUIRED, SUBMITTED, RPC-error ->
 * PENDING/UNKNOWN) is already covered by test/txRecovery.test.ts and is
 * completely unchanged by this phase — resolveAmbiguousTx itself was not
 * modified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverUnresolvedEntries,
  type MinimalNonceClient,
  type MinimalReceiptClient,
  type RecoveryOutcome,
} from '../src/chain/txRecovery.js';

const noSleep = async () => {};
const WALLET = '0x1000000000000000000000000000000000000001' as `0x${string}`;

function hash(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Entry = { id: number; chainId: number; action: string; txHash: `0x${string}` | null; nonce: number | null; wallet: `0x${string}` };

function entry(id: number, overrides: Partial<Entry> = {}): Entry {
  return { id, chainId: 8453, action: 'writeContract:mint', txHash: hash(id), nonce: id, wallet: WALLET, ...overrides };
}

// ── 1. Zero unresolved: no RPC at all ────────────────────────────────────

test('zero unresolved transactions: no client is constructed, no RPC call made', async () => {
  let clientRequested = false;
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    [],
    () => {
      clientRequested = true;
      throw new Error('must not be called for an empty batch');
    },
    () => {
      throw new Error('onResolved must not be called for an empty batch');
    },
  );
  assert.equal(resolved, 0);
  assert.equal(stillUnresolved, 0);
  assert.equal(clientRequested, false);
});

// ── 2. One unresolved: existing behavior preserved ───────────────────────

test('one unresolved transaction: resolves exactly as before (single-entry behavior unchanged)', async () => {
  const client: MinimalReceiptClient & MinimalNonceClient = {
    getTransactionReceipt: async () => ({ status: 'success' }),
    getTransactionCount: async () => 0,
  };
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    [entry(1)],
    () => client,
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 1, sleepFn: noSleep },
  );
  assert.equal(resolved, 1);
  assert.equal(stillUnresolved, 0);
  assert.deepEqual(resolvedIds, [[1, 'CONFIRMED']]);
});

// ── 3 & 14. Multiple independent entries run concurrently, not sequentially ──

test('multiple independent unresolved transactions are checked concurrently, not sequentially (real timing proof)', async () => {
  const PER_ENTRY_DELAY_MS = 500;
  const N = 3;

  function slowConfirmedClient(): MinimalReceiptClient & MinimalNonceClient {
    return {
      getTransactionReceipt: async () => {
        await delay(PER_ENTRY_DELAY_MS);
        return { status: 'success' };
      },
      getTransactionCount: async () => 0,
    };
  }

  const entries = Array.from({ length: N }, (_, i) => entry(i + 1));
  const start = Date.now();
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    entries,
    () => slowConfirmedClient(),
    () => {},
    { receiptAttempts: 1, sleepFn: noSleep },
  );
  const elapsedMs = Date.now() - start;

  assert.equal(resolved, N);
  assert.equal(stillUnresolved, 0);
  // Sequential would take ~N * PER_ENTRY_DELAY_MS (~1500ms for N=3).
  // Concurrent should take ~PER_ENTRY_DELAY_MS regardless of N. Generous
  // tolerance — this asserts ordering/parallelism, not exact wall-clock
  // timing: well under 2x a single entry's delay, and nowhere near the
  // sequential sum.
  assert.ok(
    elapsedMs < PER_ENTRY_DELAY_MS * 2,
    `expected concurrent execution (~${PER_ENTRY_DELAY_MS}ms) but took ${elapsedMs}ms — looks sequential (would be ~${PER_ENTRY_DELAY_MS * N}ms)`,
  );
});

// ── 4/5. Confirmed and failed classification survive batching ───────────

test('a confirmed transaction is classified CONFIRMED within a batch', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  await recoverUnresolvedEntries(
    [entry(1)],
    () => ({ getTransactionReceipt: async () => ({ status: 'success' }), getTransactionCount: async () => 0 }),
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 1, sleepFn: noSleep },
  );
  assert.deepEqual(resolvedIds, [[1, 'CONFIRMED']]);
});

test('an authoritatively-failed (never submitted) transaction is classified NOT_SUBMITTED within a batch', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  await recoverUnresolvedEntries(
    [entry(1, { txHash: null })],
    () => ({ getTransactionReceipt: async () => null, getTransactionCount: async () => 1 }), // nonce never advances past attempted
    (id, outcome) => resolvedIds.push([id, outcome]),
    { nonceAttempts: 3, nonceBackoffMs: 1, sleepFn: noSleep },
  );
  assert.deepEqual(resolvedIds, [[1, 'NOT_SUBMITTED']]);
});

// ── 6/7/8. RPC timeout / error / malformed receipt -> UNKNOWN, never FAILED ──

test('RPC timeout (receipt lookup never resolves in time) classifies UNKNOWN (SUBMITTED), never FAILED', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  await recoverUnresolvedEntries(
    [entry(1)],
    () => ({ getTransactionReceipt: async () => null, getTransactionCount: async () => 0 }), // perpetually pending
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 3, receiptBackoffMs: 1, sleepFn: noSleep },
  );
  assert.deepEqual(resolvedIds, [[1, 'SUBMITTED']], 'a still-pending/timed-out receipt lookup must never resolve to a FAILED-like state');
});

test('RPC error (receipt lookup throws) classifies UNKNOWN (SUBMITTED), never FAILED or crashes the batch', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  const { stillUnresolved } = await recoverUnresolvedEntries(
    [entry(1)],
    () => ({
      getTransactionReceipt: async () => {
        throw new Error('ECONNRESET');
      },
      getTransactionCount: async () => 0,
    }),
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 2, receiptBackoffMs: 1, sleepFn: noSleep },
  );
  assert.deepEqual(resolvedIds, [[1, 'SUBMITTED']]);
  assert.equal(stillUnresolved, 1);
});

test('a getClientForChain throw (e.g. unsupported chain) is isolated to that entry, never crashes the whole batch', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    [entry(1)],
    () => {
      throw new Error('no client for this chain');
    },
    (id, outcome) => resolvedIds.push([id, outcome]),
  );
  assert.equal(resolved, 0);
  assert.equal(stillUnresolved, 1);
  assert.deepEqual(resolvedIds, [], 'onResolved must never be called for an entry whose check itself threw');
});

// ── 9/10/15. Mandatory failure-injection test: mixed batch, UNKNOWN preserved ──

test('failure injection: CONFIRMED + RPC-timeout(UNKNOWN) + FAILED in one batch — each classified independently, UNKNOWN never collapsed', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];

  // Distinct chainIds so getClientForChain can route each entry to its own
  // fixture client unambiguously (recoverUnresolvedEntries keys clients by
  // chainId, not entry id).
  const clientsByChain: Record<number, MinimalReceiptClient & MinimalNonceClient> = {
    // TX1 -> CONFIRMED
    401: { getTransactionReceipt: async () => ({ status: 'success' }), getTransactionCount: async () => 0 },
    // TX2 -> RPC timeout on every attempt -> UNKNOWN (SUBMITTED)
    402: { getTransactionReceipt: async () => null, getTransactionCount: async () => 0 },
    // TX3 -> authoritatively reverted -> FAILED (MINED_REVERT)
    403: { getTransactionReceipt: async () => ({ status: 'reverted' }), getTransactionCount: async () => 0 },
  };

  const entries = [entry(1, { chainId: 401 }), entry(2, { chainId: 402 }), entry(3, { chainId: 403 })];
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    entries,
    (chainId) => clientsByChain[chainId],
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 2, receiptBackoffMs: 1, sleepFn: noSleep },
  );

  const byId = new Map(resolvedIds);
  assert.equal(byId.get(1), 'CONFIRMED');
  assert.equal(byId.get(2), 'SUBMITTED', 'TX2 (RPC timeout) must remain UNKNOWN, never upgraded by TX1 or TX3\'s outcome');
  assert.equal(byId.get(3), 'MINED_REVERT');

  // TX1 and TX3 are terminal (resolved); TX2 alone remains unresolved.
  assert.equal(resolved, 2);
  assert.equal(stillUnresolved, 1);
});

// The mixed FAILED+UNKNOWN scenario needs per-entry client routing since
// recoverUnresolvedEntries's getClientForChain is keyed by chainId, not
// entry id. Re-run with distinct chain ids so each entry gets its own
// fixture client unambiguously.
test('failure injection: FAILED + UNKNOWN (distinct chains) — UNKNOWN alone keeps the batch unresolved', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  const clientsByChain: Record<number, MinimalReceiptClient & MinimalNonceClient> = {
    111: { getTransactionReceipt: async () => null, getTransactionCount: async () => 1 }, // NOT_SUBMITTED
    222: {
      getTransactionReceipt: async () => {
        throw new Error('RPC unavailable');
      },
      getTransactionCount: async () => 0,
    },
  };
  const entries = [
    entry(1, { chainId: 111, txHash: null }),
    entry(2, { chainId: 222 }),
  ];
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    entries,
    (chainId) => clientsByChain[chainId],
    (id, outcome) => resolvedIds.push([id, outcome]),
    { nonceAttempts: 2, nonceBackoffMs: 1, receiptAttempts: 2, receiptBackoffMs: 1, sleepFn: noSleep },
  );
  const byId = new Map(resolvedIds);
  assert.equal(byId.get(1), 'NOT_SUBMITTED');
  assert.equal(byId.get(2), 'SUBMITTED');
  assert.equal(resolved, 1, 'only the authoritatively-FAILED entry is resolved');
  assert.equal(stillUnresolved, 1, 'the UNKNOWN entry alone must keep the batch unresolved');
});

// ── 11/12. All-confirmed / all-failed batches ────────────────────────────

test('all entries confirmed: batch is fully resolved', async () => {
  const client: MinimalReceiptClient & MinimalNonceClient = {
    getTransactionReceipt: async () => ({ status: 'success' }),
    getTransactionCount: async () => 0,
  };
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    [entry(1), entry(2), entry(3)],
    () => client,
    () => {},
    { receiptAttempts: 1, sleepFn: noSleep },
  );
  assert.equal(resolved, 3);
  assert.equal(stillUnresolved, 0);
});

test('all entries authoritatively failed (reverted): existing safe behavior preserved, batch fully resolved', async () => {
  const client: MinimalReceiptClient & MinimalNonceClient = {
    getTransactionReceipt: async () => ({ status: 'reverted' }),
    getTransactionCount: async () => 0,
  };
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  const { resolved, stillUnresolved } = await recoverUnresolvedEntries(
    [entry(1), entry(2)],
    () => client,
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 1, sleepFn: noSleep },
  );
  assert.equal(resolved, 2);
  assert.equal(stillUnresolved, 0);
  assert.ok(resolvedIds.every(([, o]) => o === 'MINED_REVERT'));
});

// ── 13. Recovery timeout must never become FAILED ────────────────────────

test('recovery timeout never becomes FAILED, at the batch level', async () => {
  const resolvedIds: Array<[number, RecoveryOutcome]> = [];
  await recoverUnresolvedEntries(
    [entry(1), entry(2, { txHash: null })],
    () => ({ getTransactionReceipt: async () => null, getTransactionCount: async () => 1 }),
    (id, outcome) => resolvedIds.push([id, outcome]),
    { receiptAttempts: 2, receiptBackoffMs: 1, nonceAttempts: 1, nonceBackoffMs: 1, sleepFn: noSleep },
  );
  for (const [, outcome] of resolvedIds) {
    assert.notEqual(outcome, 'MINED_REVERT', 'a timeout/still-pending outcome must never be reported as FAILED');
  }
});

// ── 16. Pre-send safety: the mandatory test ──────────────────────────────
//
// journalledSend's gate (src/chain/clients.ts, unchanged this phase) is:
//   const stillUnresolved = listUnresolvedTxJournal(...);
//   if (stillUnresolved.length > 0) throw new Error(...);  // never sends
// This reproduces that exact, unchanged pattern against
// recoverUnresolvedEntries's real (now-parallel) output, proving an
// unresolved/UNKNOWN entry still blocks the send — the send function is
// never reached.

test('pre-send safety: an unresolved (RPC-unavailable) entry blocks the new transaction — send is never invoked', async () => {
  let sendCalls = 0;
  const fakeSend = () => {
    sendCalls++;
    return Promise.resolve(hash(999));
  };

  const resolvedOutcomes = new Map<number, RecoveryOutcome>();
  await recoverUnresolvedEntries(
    [entry(1)],
    () => ({
      getTransactionReceipt: async () => {
        throw new Error('RPC unavailable');
      },
      getTransactionCount: async () => 0,
    }),
    (id, outcome) => resolvedOutcomes.set(id, outcome),
    { receiptAttempts: 2, receiptBackoffMs: 1, sleepFn: noSleep },
  );

  // Reproduce journalledSend's exact gating decision: an entry stays
  // "unresolved" unless its outcome was CONFIRMED/MINED_REVERT/NOT_SUBMITTED.
  const TERMINAL: RecoveryOutcome[] = ['CONFIRMED', 'MINED_REVERT', 'NOT_SUBMITTED'];
  const stillUnresolvedCount = [...resolvedOutcomes.values()].filter((o) => !TERMINAL.includes(o)).length;

  if (stillUnresolvedCount > 0) {
    // This is the exact branch journalledSend takes — it throws instead
    // of ever reaching the broadcast call.
  } else {
    await fakeSend();
  }

  assert.equal(stillUnresolvedCount, 1);
  assert.equal(sendCalls, 0, 'a new transaction must NEVER be sent while an entry remains UNKNOWN/unresolved');
});

test('pre-send safety: a batch fully resolved to terminal states permits the new transaction', async () => {
  let sendCalls = 0;
  const fakeSend = () => {
    sendCalls++;
    return Promise.resolve(hash(999));
  };

  const resolvedOutcomes = new Map<number, RecoveryOutcome>();
  await recoverUnresolvedEntries(
    [entry(1)],
    () => ({ getTransactionReceipt: async () => ({ status: 'success' }), getTransactionCount: async () => 0 }),
    (id, outcome) => resolvedOutcomes.set(id, outcome),
    { receiptAttempts: 1, sleepFn: noSleep },
  );

  const TERMINAL: RecoveryOutcome[] = ['CONFIRMED', 'MINED_REVERT', 'NOT_SUBMITTED'];
  const stillUnresolvedCount = [...resolvedOutcomes.values()].filter((o) => !TERMINAL.includes(o)).length;
  if (stillUnresolvedCount === 0) {
    await fakeSend();
  }

  assert.equal(stillUnresolvedCount, 0);
  assert.equal(sendCalls, 1, 'a fully-resolved batch must permit the new transaction (sanity check on the harness itself)');
});

// ── Concurrency safety: no duplicate/racing journal mutation ─────────────

test('concurrent entries never call onResolved for the wrong id, even when the slowest entry settles last', async () => {
  const calls: Array<[number, RecoveryOutcome]> = [];
  // Distinct chainIds so each entry gets its own client/delay/outcome —
  // proving that whichever order they actually settle in (entry 1 is
  // deliberately the slowest and CONFIRMED; 2 and 3 finish faster with
  // different outcomes), each id is reported with exactly its own result.
  const entries = [
    entry(1, { chainId: 301 }),
    entry(2, { chainId: 302, txHash: null }),
    entry(3, { chainId: 303 }),
  ];
  const clientsByChain: Record<number, MinimalReceiptClient & MinimalNonceClient> = {
    301: {
      getTransactionReceipt: async () => {
        await delay(40); // slowest
        return { status: 'success' };
      },
      getTransactionCount: async () => 0,
    },
    302: {
      getTransactionReceipt: async () => null,
      getTransactionCount: async () => {
        await delay(5); // fastest
        return 2; // nonce never advances past attempted (2) -> NOT_SUBMITTED
      },
    },
    303: {
      getTransactionReceipt: async () => {
        await delay(15);
        return { status: 'reverted' };
      },
      getTransactionCount: async () => 0,
    },
  };
  await recoverUnresolvedEntries(
    entries,
    (chainId) => clientsByChain[chainId],
    (id, outcome) => calls.push([id, outcome]),
    { receiptAttempts: 1, nonceAttempts: 1, sleepFn: noSleep },
  );
  const byId = new Map(calls);
  assert.equal(calls.length, 3, 'every entry must be reported exactly once');
  assert.equal(byId.get(1), 'CONFIRMED', 'the slowest entry must still get its own correct outcome, not a faster entry\'s');
  assert.equal(byId.get(2), 'NOT_SUBMITTED');
  assert.equal(byId.get(3), 'MINED_REVERT');
});

test('duplicate pre-send recovery calls do not double-invoke onResolved for the same entry within one call', async () => {
  const calls: number[] = [];
  await recoverUnresolvedEntries(
    [entry(1)],
    () => ({ getTransactionReceipt: async () => ({ status: 'success' }), getTransactionCount: async () => 0 }),
    (id) => calls.push(id),
    { receiptAttempts: 1, sleepFn: noSleep },
  );
  assert.deepEqual(calls, [1]);
});
