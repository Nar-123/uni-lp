/**
 * Phase 4.6.4 — TP/SL watcher shutdown & confirmation lifecycle.
 *
 * P2 finding: TP/SL shutdown did not cancel an in-flight 5s confirmation
 * timer, and there was no forced-exit fallback. Root cause (src/bot/
 * tpslWatcher.ts): the confirmation setTimeout's return value was
 * discarded entirely (`setTimeout(() => {...}, CONFIRM_MS)` — no handle
 * stored anywhere), so stopTpslWatcher() had no way to cancel it. It only
 * *incidentally* neutralized an armed trigger via `pending.clear()` (the
 * callback would find nothing pending and no-op), but the timer itself
 * kept running, unclearable and untracked, and an already-in-flight close
 * (past that point) had no lifecycle awareness of shutdown at all.
 *
 * This suite tests the actual, real timer/lifecycle mechanics (via
 * `__tickForTests`, real `setTimeout`s under the hood, and deterministic
 * promise-gating for "already in-flight" scenarios — never wall-clock
 * racing) using the existing scratch-DB pattern this codebase's other
 * suites already use, and the new `__setTpslDepsForTests` injection seam
 * (mirrors mintFn/spawnFn/runner injection used elsewhere this session)
 * to control PnL/close results without any real RPC/chain call.
 *
 * Two tests use a real, un-shortened CONFIRM_MS (5s) / SHUTDOWN_DEADLINE_MS
 * (15s) wait, as the task requires exercising the actual timer mechanism
 * rather than only mocking clearTimeout — kept to the minimum necessary
 * count given the real wall-clock cost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-shutdown-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, setPositionTpSl, setUserPrefs, getLedgerEntries, __resetStoreForTests } =
  await import('../src/db/index.js');
const {
  startTpslWatcher,
  stopTpslWatcher,
  __tickForTests,
  __setTpslDepsForTests,
  __resetTpslWatcherForTests,
  __getWatcherStateForTests,
  __getPendingCountForTests,
  __getConfirmTimerCountForTests,
  __getInFlightCloseCountForTests,
  __isClosingForTests,
} = await import('../src/bot/tpslWatcher.js');

const CHAIN = 4663;
const CONFIRM_MS = 5_000;
const SHUTDOWN_DEADLINE_MS = 15_000;

const fakeBot = { api: { sendMessage: async () => {} } } as unknown as Bot;

function resetDb(): void {
  __resetStoreForTests();
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

let tokenCounter = 1000;
/** Position tokenIds must be numeric strings — executeClose calls BigInt(p.tokenId). */
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
}

/** Enroll one real, TP/SL-enabled position via the real db layer. */
function enrollPosition(tokenId: string): void {
  setUserPrefs(1, { tpSlEnabled: true });
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
  });
  setPositionTpSl(CHAIN, tokenId, { enabled: true, tpPercent: 10, slPercent: 15 });
}

function fakeCloseResult(tokenId: string) {
  return {
    hash: '0xabc' as `0x${string}`,
    tokenId: BigInt(tokenId),
    amount0: 0n,
    amount1: 0n,
    amount0Human: 1,
    amount1Human: 0,
    expected0: 0n,
    expected1: 0n,
    withdrawalUsd: 100,
    feesPortionUsd: 0,
    feeSplitIsEstimated: true,
    txLink: 'https://example/tx/0xabc',
    token0: '0xusdg' as `0x${string}`,
    token1: '0xtok' as `0x${string}`,
    symbol0: 'USDG',
    symbol1: 'TOK',
  };
}

function resetAll(): void {
  __resetTpslWatcherForTests();
  resetDb();
  tokenCounter = 1000;
}

// ── 1/2. Basic lifecycle ──────────────────────────────────────────────────

test('watcher starts normally', () => {
  resetAll();
  startTpslWatcher(fakeBot);
  assert.equal(__getWatcherStateForTests(), 'running');
  __resetTpslWatcherForTests();
});

test('shutdown while idle is clean and resolves promptly', async () => {
  resetAll();
  startTpslWatcher(fakeBot);
  const start = Date.now();
  await stopTpslWatcher();
  assert.ok(Date.now() - start < 500, 'an idle shutdown must not wait for anything');
  assert.equal(__getWatcherStateForTests(), 'stopped');
  assert.equal(__getConfirmTimerCountForTests(), 0);
  assert.equal(__getPendingCountForTests(), 0);
});

// ── 3. Shutdown prevents new polling work ─────────────────────────────────

test('shutdown prevents new polling work: tick() is a no-op once stopping', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  let measureCalls = 0;
  __setTpslDepsForTests({ measurePnl: async () => { measureCalls++; return { status: 'active', pnlPct: 0, pnlUsd: 0, label: 'TOK' }; } });

  startTpslWatcher(fakeBot);
  await stopTpslWatcher();

  await __tickForTests(fakeBot);
  assert.equal(measureCalls, 0, 'tick() must return before doing any PnL work once the watcher is stopped');
});

// ── 4/16. Mandatory pre-submission test: shutdown blocks a new send ───────

test('pre-submission safety: shutdown state set, then a TP/SL trigger occurs — closePosition is called 0 times', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  let closeCalls = 0;
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }), // TP hit (10%)
    closePosition: async () => { closeCalls++; return fakeCloseResult(tokenId); },
  });

  startTpslWatcher(fakeBot);
  await stopTpslWatcher();

  // Now stopped — a trigger condition existing must not matter.
  await __tickForTests(fakeBot);
  assert.equal(closeCalls, 0, 'sendTransaction-equivalent (closePosition) must never be reached once shutdown has started');
  assert.equal(__getConfirmTimerCountForTests(), 0, 'no confirmation timer may be armed after shutdown');
});

// ── 5. Confirmation timer is actually cancelled on shutdown (fast, structural) ──

test('an armed confirmation timer is removed from tracking immediately on shutdown', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }),
  });

  startTpslWatcher(fakeBot);
  await __tickForTests(fakeBot); // arms the trigger, schedules the real 5s timer
  assert.equal(__getConfirmTimerCountForTests(), 1, 'sanity check: a timer was armed');

  await stopTpslWatcher();
  assert.equal(__getConfirmTimerCountForTests(), 0, 'the armed timer must be cancelled (Map cleared), not merely neutralized');
  assert.equal(__getPendingCountForTests(), 0);
});

// ── 6/14/7. Real timer test (mandatory): the actual setTimeout truly never fires a close ──

test('real timer: an armed confirmation genuinely never fires a close after shutdown (not merely a cleared handle)', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  let closeCalls = 0;
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }),
    closePosition: async () => { closeCalls++; return fakeCloseResult(tokenId); },
  });

  startTpslWatcher(fakeBot);
  await __tickForTests(fakeBot); // arms the real 5s timer
  await stopTpslWatcher(); // cancels it immediately (per the previous test)

  // Wait past the real CONFIRM_MS window to prove the underlying Node
  // timer genuinely never invokes its callback — not just that our own
  // bookkeeping map was cleared.
  await new Promise((r) => setTimeout(r, CONFIRM_MS + 500));
  assert.equal(closeCalls, 0, 'the cancelled confirmation must never fire a close, proven by actually waiting past its real deadline');
}, { timeout: CONFIRM_MS + 5_000 });

// ── 8/9/10/15/17. In-flight close during shutdown: deterministic gating, not wall-clock racing ──

test('shutdown during an in-flight close: the close completes normally (authoritative result wins), no duplicate send, journal/ledger correctly recorded', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);

  let closeCalls = 0;
  let releaseClose!: () => void;
  const gate = new Promise<void>((r) => { releaseClose = r; });
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }),
    closePosition: async () => {
      closeCalls++;
      await gate; // simulates "already submitted / in flight" — held open until we release it
      return fakeCloseResult(tokenId);
    },
  });

  startTpslWatcher(fakeBot);
  await __tickForTests(fakeBot); // arms the real 5s timer

  // Let the real confirmation timer fire naturally so recheckAndMaybeClose
  // actually starts and calls closePosition (now gated/in-flight).
  await new Promise((r) => setTimeout(r, CONFIRM_MS + 300));
  assert.equal(closeCalls, 1, 'sanity check: the close has genuinely started');
  assert.equal(__getInFlightCloseCountForTests(), 1);

  // Shutdown requested WHILE the close is in flight.
  const shutdown = stopTpslWatcher();

  // Give the event loop a moment, then confirm shutdown is still waiting
  // (deterministic: it cannot have finished, because `gate` is still held).
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(__getWatcherStateForTests(), 'stopping', 'shutdown must wait for in-flight work, not abandon it instantly');

  // Now let the close finish — this is the "authoritative result" arriving.
  releaseClose();
  await shutdown;

  assert.equal(__getWatcherStateForTests(), 'stopped');
  assert.equal(closeCalls, 1, 'no duplicate send: the close was attempted exactly once');
  const ledgerRows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(ledgerRows.length, 1, 'the in-flight close, once it authoritatively completes, must still be recorded normally');
  assert.equal(__isClosingForTests(CHAIN, tokenId), false);
}, { timeout: CONFIRM_MS + 5_000 });

// ── 10/16/17. Forced shutdown fallback (mandatory) ────────────────────────

test('forced shutdown fallback: an in-flight close that never resolves does not hang shutdown forever, and never fabricates a result', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);

  let closeCalls = 0;
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }),
    closePosition: async () => {
      closeCalls++;
      return new Promise(() => {}); // never resolves — simulates a stuck/unresolvable close
    },
  });

  startTpslWatcher(fakeBot);
  await __tickForTests(fakeBot);
  await new Promise((r) => setTimeout(r, CONFIRM_MS + 300)); // let the close genuinely start
  assert.equal(closeCalls, 1);
  assert.equal(__getInFlightCloseCountForTests(), 1);

  const start = Date.now();
  await stopTpslWatcher();
  const elapsedMs = Date.now() - start;

  assert.ok(
    elapsedMs < SHUTDOWN_DEADLINE_MS + 2_000,
    `shutdown must give up waiting after its bounded deadline, took ${elapsedMs}ms`,
  );
  assert.ok(elapsedMs >= SHUTDOWN_DEADLINE_MS - 500, 'shutdown must actually wait close to the full deadline, not bail early');
  assert.equal(__getWatcherStateForTests(), 'stopped');

  // Never fabricate success or failure for the still-unresolved close.
  const ledgerRows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(ledgerRows.length, 0, 'a forced-timeout shutdown must never fabricate a ledger entry for unresolved work');
  assert.equal(closeCalls, 1, 'no duplicate/retry send was attempted while waiting');
}, { timeout: SHUTDOWN_DEADLINE_MS + 10_000 });

// ── 13/14 (list numbering). Shutdown idempotency ──────────────────────────

test('repeated shutdown calls return the exact same promise — only one shutdown sequence runs', async () => {
  resetAll();
  startTpslWatcher(fakeBot);
  const p1 = stopTpslWatcher();
  const p2 = stopTpslWatcher();
  const p3 = stopTpslWatcher();
  assert.equal(p1, p2, 'a second call while shutdown is in progress must return the identical promise');
  assert.equal(p2, p3);
  await p1;
  const p4 = stopTpslWatcher();
  // Once fully stopped, further calls resolve immediately without error —
  // still exactly one lifecycle, never a second teardown attempt.
  await assert.doesNotReject(() => p4);
});

test('calling stopTpslWatcher on a never-started watcher is a safe no-op', async () => {
  resetAll();
  await assert.doesNotReject(() => stopTpslWatcher());
  assert.equal(__getWatcherStateForTests(), 'stopped');
});

// ── Restart after shutdown works cleanly (proves timers were truly released) ──

test('the watcher can be restarted cleanly after a full shutdown (no leftover timer conflicts)', async () => {
  resetAll();
  startTpslWatcher(fakeBot);
  await stopTpslWatcher();
  assert.equal(__getWatcherStateForTests(), 'stopped');

  startTpslWatcher(fakeBot);
  assert.equal(__getWatcherStateForTests(), 'running');
  await stopTpslWatcher();
  assert.equal(__getWatcherStateForTests(), 'stopped');
});
