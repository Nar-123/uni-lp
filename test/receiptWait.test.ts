/**
 * Phase 4.6.13 — transaction receipt deadline hardening.
 *
 * The 35 `client.waitForTransactionReceipt({ hash })` calls across
 * execution-strategy files (close.ts, mint.ts, v4.ts, swap.ts, wrap.ts,
 * transfer.ts, revoke.ts, relay.ts, across.ts, tradingApi.ts,
 * gmgn/swap.ts) previously relied on viem's own IMPLICIT default
 * (`timeout: 180_000`, confirmed directly from viem's source) rather
 * than an explicit, codebase-owned deadline. This file proves the new
 * `src/chain/receiptWait.ts` constant/helper is correct, and — using a
 * REAL viem `createPublicClient` with a fake `custom()` transport (not a
 * duck-typed mock) — proves the actual mechanism every one of those 35
 * call sites now relies on genuinely bounds the wait, genuinely
 * preserves the exact existing success/revert outcomes, and genuinely
 * never fabricates a result on timeout or RPC failure.
 *
 * No production call site's surrounding logic (gas, nonce, minOut,
 * simulation, transaction construction) was touched — only the
 * `waitForTransactionReceipt({...})` call itself gained one property.
 * See PHASE4_6_13_RECEIPT_DEADLINE_FIX_REPORT.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, custom, WaitForTransactionReceiptTimeoutError } from 'viem';
import type { EIP1193RequestFn } from 'viem';
import {
  EXECUTION_RECEIPT_TIMEOUT_MS,
  isReceiptWaitTimeout,
} from '../src/chain/receiptWait.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, '..', 'src');

const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const TEST_CHAIN = {
  id: 1337,
  name: 'test-chain',
  nativeCurrency: { name: 'Test', symbol: 'TST', decimals: 18 },
  rpcUrls: { default: { http: ['http://localhost'] } },
} as const;

/** Raw JSON-RPC shape (as a node would actually return it) — viem's own
 * formatter converts the hex `status` ("0x1"/"0x0") into the friendly
 * "success"/"reverted" string every production call site checks. */
function fakeReceipt(status: 'success' | 'reverted') {
  return {
    status: status === 'success' ? '0x1' : '0x0',
    transactionHash: HASH,
    blockNumber: '0x1',
    blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    transactionIndex: '0x0',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    gasUsed: '0x1',
    effectiveGasPrice: '0x1',
    logs: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    type: '0x2',
  };
}

/**
 * A real viem PublicClient backed by a fake `custom()` transport — every
 * RPC method the client actually calls goes through `handler`. This is
 * the same client "shape" every one of the 35 production call sites
 * uses (`client.waitForTransactionReceipt({...})`), not a duck-typed
 * stand-in for it.
 */
function fakeClient(handler: (method: string, params: unknown[]) => unknown) {
  const request: EIP1193RequestFn = (async ({ method, params }) => {
    return handler(method, (params ?? []) as unknown[]);
  }) as EIP1193RequestFn;
  return createPublicClient({ chain: TEST_CHAIN, transport: custom({ request }) });
}

// ── The constant itself ────────────────────────────────────────────────

test('EXECUTION_RECEIPT_TIMEOUT_MS is a positive finite number matching the documented value (180s — viem\'s own pre-existing default, made explicit)', () => {
  assert.equal(typeof EXECUTION_RECEIPT_TIMEOUT_MS, 'number');
  assert.ok(Number.isFinite(EXECUTION_RECEIPT_TIMEOUT_MS));
  assert.ok(EXECUTION_RECEIPT_TIMEOUT_MS > 0);
  assert.equal(EXECUTION_RECEIPT_TIMEOUT_MS, 180_000);
});

test('isReceiptWaitTimeout correctly identifies viem\'s own timeout error and rejects every other error', () => {
  assert.ok(isReceiptWaitTimeout(new WaitForTransactionReceiptTimeoutError({ hash: HASH })));
  assert.ok(!isReceiptWaitTimeout(new Error('some other failure')));
  assert.ok(!isReceiptWaitTimeout(null));
  assert.ok(!isReceiptWaitTimeout(undefined));
  assert.ok(!isReceiptWaitTimeout('a string'));
});

// ── Success behavior preserved exactly (§12 of the phase task) ───────────

test('success before deadline: an immediately-available successful receipt is returned unchanged, with a timeout present', async () => {
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') return fakeReceipt('success');
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: HASH,
    timeout: EXECUTION_RECEIPT_TIMEOUT_MS,
  });
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.transactionHash, HASH);
});

// ── Revert behavior preserved exactly (§13 of the phase task) ────────────

test('revert before deadline: a confirmed-reverted receipt is returned unchanged, never converted to a timeout or thrown error', async () => {
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') return fakeReceipt('reverted');
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: HASH,
    timeout: EXECUTION_RECEIPT_TIMEOUT_MS,
  });
  assert.equal(receipt.status, 'reverted', 'a definitively confirmed revert must remain a revert, never UNKNOWN');
});

// ── Timeout: bounded, never fabricates success/failure (§6, §11, §15) ────

test('receipt timeout: a receipt that never appears causes a bounded rejection with viem\'s own distinguishable timeout error, never a fabricated receipt', async () => {
  let lookups = 0;
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') {
      lookups++;
      return null; // never found — the transaction never confirms within the test window
    }
    if (method === 'eth_blockNumber') return '0x10';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: '0xblock' };
    throw new Error(`unexpected method ${method}`);
  });

  const shortTimeoutMs = 200; // test-only override — does not touch or read production's 180s value
  const start = Date.now();
  await assert.rejects(
    () => client.waitForTransactionReceipt({ hash: HASH, timeout: shortTimeoutMs }),
    (e: unknown) => {
      assert.ok(isReceiptWaitTimeout(e), 'must be viem\'s own WaitForTransactionReceiptTimeoutError, not a generic error');
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5_000, `expected a bounded wait, took ${elapsed}ms`);
  assert.ok(lookups > 0, 'sanity: the fake receipt lookup was actually exercised');
});

test('receipt timeout does not fabricate SUCCESS: the rejection carries no receipt-shaped success value', async () => {
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await client.waitForTransactionReceipt({ hash: HASH, timeout: 150 });
    assert.fail('expected a rejection, not a resolved value');
  } catch (e) {
    assert.ok(isReceiptWaitTimeout(e));
    assert.ok(!('status' in (e as object)), 'the thrown error must not itself look like a receipt');
  }
});

test('receipt timeout does not fabricate FAILED: the thrown error is a distinguishable timeout, not a synthesized revert', async () => {
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await client.waitForTransactionReceipt({ hash: HASH, timeout: 150 });
    assert.fail('expected a rejection');
  } catch (e) {
    // Must be the timeout error specifically, never an Error whose message
    // resembles a revert (which would risk being matched by any caller-side
    // "reverted" string check and misclassified as a confirmed failure).
    assert.ok(isReceiptWaitTimeout(e));
    const msg = e instanceof Error ? e.message : String(e);
    assert.doesNotMatch(msg, /reverted/i, 'a timeout error must never read like a confirmed revert');
  }
});

// ── Unresolved RPC error → UNKNOWN, never a fabricated failure (§14) ──────

test('persistent RPC error during polling never resolves to a fabricated receipt — surfaces as a rejection, not a success', async () => {
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') {
      throw new Error('connection reset');
    }
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  // Whatever the exact rejection shape (viem may retry internally before
  // giving up, or the timeout may fire first) — the only invariant this
  // test requires is that it NEVER resolves to a value, i.e. never
  // fabricates a receipt/outcome from a persistently-failing RPC.
  await assert.rejects(() => client.waitForTransactionReceipt({ hash: HASH, timeout: 500 }));
});

// ── Deadline does not reset indefinitely (§16) ───────────────────────────

test('deadline is a single fixed window, not reset by each internal polling attempt', async () => {
  let lookupCount = 0;
  const client = fakeClient((method) => {
    if (method === 'eth_getTransactionReceipt') {
      lookupCount++;
      return null;
    }
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  const timeoutMs = 300;
  const start = Date.now();
  await assert.rejects(() => client.waitForTransactionReceipt({ hash: HASH, timeout: timeoutMs }));
  const elapsed = Date.now() - start;
  // However many internal polling attempts viem made, the TOTAL wall-clock
  // time must stay close to the single configured deadline, not
  // (attempts * timeout) — proving the deadline is one fixed window.
  assert.ok(elapsed < timeoutMs + 2_000, `expected total wait near ${timeoutMs}ms regardless of poll count, took ${elapsed}ms`);
});

// ── No duplicate submission (§9 of the phase task) ────────────────────────

test('a receipt-wait timeout never itself issues a send/broadcast RPC call — the wait function has no capability to resend', async () => {
  const calledMethods = new Set<string>();
  const client = fakeClient((method) => {
    calledMethods.add(method);
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_blockNumber') return '0x10';
    throw new Error(`unexpected method ${method}`);
  });
  await assert.rejects(() => client.waitForTransactionReceipt({ hash: HASH, timeout: 150 }));
  assert.ok(
    !calledMethods.has('eth_sendRawTransaction') && !calledMethods.has('eth_sendTransaction'),
    'waiting for a receipt must never itself broadcast a transaction',
  );
});

// ── Structural regression: every one of the 35 call sites uses the shared constant ──

const EXECUTION_FILES = [
  'chain/across.ts',
  'gmgn/swap.ts',
  'chain/mint.ts',
  'chain/close.ts',
  'chain/relay.ts',
  'chain/revoke.ts',
  'chain/swap.ts',
  'chain/tradingApi.ts',
  'chain/transfer.ts',
  'chain/v4.ts',
  'chain/wrap.ts',
];

test('every waitForTransactionReceipt call in every execution-strategy file now passes the shared, explicit timeout', () => {
  let totalCallSites = 0;
  for (const rel of EXECUTION_FILES) {
    const full = path.join(SRC_ROOT, rel);
    const content = fs.readFileSync(full, 'utf8');
    assert.match(
      content,
      /import \{ EXECUTION_RECEIPT_TIMEOUT_MS \} from ['"].*receiptWait\.js['"];/,
      `${rel} must import EXECUTION_RECEIPT_TIMEOUT_MS`,
    );
    const callSiteRegex = /\.waitForTransactionReceipt\(\{[^}]*\}\)/g;
    const matches = content.match(callSiteRegex) ?? [];
    assert.ok(matches.length > 0, `${rel} was expected to contain at least one waitForTransactionReceipt call`);
    for (const m of matches) {
      assert.match(m, /timeout:\s*EXECUTION_RECEIPT_TIMEOUT_MS/, `call site in ${rel} missing explicit timeout: ${m}`);
    }
    totalCallSites += matches.length;
  }
  assert.equal(totalCallSites, 35, 'expected exactly the 35 originally-inventoried call sites, no more, no fewer');
});

test('V3 (close.ts) and V4 (v4.ts) close paths use the identical timeout constant — no protocol-specific safety difference', () => {
  const v3 = fs.readFileSync(path.join(SRC_ROOT, 'chain/close.ts'), 'utf8');
  const v4 = fs.readFileSync(path.join(SRC_ROOT, 'chain/v4.ts'), 'utf8');
  assert.match(v3, /EXECUTION_RECEIPT_TIMEOUT_MS/);
  assert.match(v4, /EXECUTION_RECEIPT_TIMEOUT_MS/);
  // Both import from the exact same shared module — not two independently
  // defined constants that could silently drift apart.
  assert.match(v3, /from '\.\/receiptWait\.js'/);
  assert.match(v4, /from '\.\/receiptWait\.js'/);
});
