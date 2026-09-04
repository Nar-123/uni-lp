/**
 * Phase 4.7 audit (F-13) — MULTI Execute callback scan-id binding.
 *
 * These tests exercise the EXACT production functions bot.ts's `mx:...`
 * callback handler calls (parseMultiExecuteCallback,
 * resolveMultiExecuteCallback, buildMultiExecuteCallbackData) — not a
 * reimplementation. This codebase has no test harness for grammY handlers
 * themselves (no existing test file imports bot.ts or invokes a registered
 * callbackQuery handler directly), so the literal Telegram-handler-level
 * integration is not covered here — see
 * test/strategy.multiExecute.scanBinding.test.ts for a simulated-handler
 * test that wires these same functions together with the real
 * executeTradeIntentFromSnapshot to prove the end-to-end zero-call property,
 * and the final report's "Test Quality" section for this gap stated
 * explicitly rather than papered over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMultiExecuteCallbackData,
  parseMultiExecuteCallback,
  resolveMultiExecuteCallback,
} from '../src/bot/multiExecuteResolver.js';
import type { MultiStrategyRun, TradeIntent, MultiCandidate } from '../src/strategy/types.js';

const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TOKEN_X = '0x00000000000000000000000000000000000000AA';
const TOKEN_Y = '0x00000000000000000000000000000000000000BB';

function makeIntent(token: string, poolAddress: string): TradeIntent {
  return {
    strategy: 'multi',
    chainId: CHAIN,
    token,
    quoteToken: USDG,
    pool: {
      poolAddress,
      protocol: 'v3',
      dex: 'uniswap',
      fee: 50_000,
      tvlUsd: 100_000,
      volumeUsd: 50_000,
      liquidityUsd: 100_000,
      currentPrice: null,
      sourceTimestamp: Date.now(),
      totalScore: 0.5,
      tvlScore: 0.5,
      volumeScore: 0.5,
      volumeTvlScore: 0.5,
      feeScore: 1,
      reasons: [],
      rejectedReasons: [],
    },
    fee: 50_000,
    side: 'above',
    range: { tickLower: 100, tickUpper: 200 },
    positionSize: { sizeMode: 'fixed', fixedAmountHuman: 100 },
    depositToken: USDG,
    reason: 'test',
    candidateScore: 1,
    poolScore: 0.5,
  };
}

function makeCandidate(address: string): MultiCandidate {
  return {
    address,
    symbol: 'TOK',
    name: 'Token',
    chainId: CHAIN,
    marketCapUsd: 2_000_000,
    ageHours: 48,
    volume6hUsd: 500_000,
    liquidityUsd: 200_000,
    classification: 'MEME',
    launchpadPlatform: 'pump.fun',
    candidateScore: 1,
    reasons: [],
    source: 'gmgn_trending_6h',
    sourceTimestamp: Date.now(),
  };
}

function makeRun(scanId: string, tokens: { token: string; pool: string }[]): MultiStrategyRun {
  return {
    scanId,
    chainId: CHAIN,
    dryRun: true,
    timestamp: Date.now(),
    candidates: tokens.map((t) => makeCandidate(t.token)),
    rejected: [],
    intents: tokens.map((t) => makeIntent(t.token, t.pool)),
    executed: [],
  };
}

// ── Callback build/parse (items 3, 10, 11, 12, 23) ────────────────────────

test('3. Execute button callback_data embeds the scanId', () => {
  const data = buildMultiExecuteCallbackData('abc1234567', TOKEN_X);
  assert.equal(data, `mx:abc1234567:${TOKEN_X}`);
});

test('23. callback_data for a real-shaped scanId+token stays within Telegram\'s 64-byte limit', () => {
  const data = buildMultiExecuteCallbackData('0123456789', '0x' + 'a'.repeat(40));
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `callback_data is ${Buffer.byteLength(data, 'utf8')} bytes, exceeds 64`);
  assert.equal(Buffer.byteLength(data, 'utf8'), 56);
});

test('round-trips: parseMultiExecuteCallback(buildMultiExecuteCallbackData(...)) recovers the exact scanId and token', () => {
  const parsed = parseMultiExecuteCallback(buildMultiExecuteCallbackData('deadbeef01', TOKEN_X));
  assert.deepEqual(parsed, { scanId: 'deadbeef01', token: TOKEN_X });
});

test('10. malformed callback (garbage string) is rejected by the parser', () => {
  assert.equal(parseMultiExecuteCallback('not-a-callback-at-all'), null);
});

test('11. missing scanId (old-format multi:exec:<token>) is rejected', () => {
  assert.equal(parseMultiExecuteCallback(`multi:exec:${TOKEN_X}`), null);
});

test('12. the old callback format fails closed — parseMultiExecuteCallback never partially matches it', () => {
  assert.equal(parseMultiExecuteCallback(`multi:exec:${TOKEN_X}`), null);
  // Also: a bare token with no prefix at all.
  assert.equal(parseMultiExecuteCallback(TOKEN_X), null);
});

test('extra/unexpected trailing field is rejected (strict anchor at both ends)', () => {
  assert.equal(parseMultiExecuteCallback(`mx:0123456789:${TOKEN_X}:extra`), null);
});

test('wrong prefix is rejected', () => {
  assert.equal(parseMultiExecuteCallback(`xx:0123456789:${TOKEN_X}`), null);
});

test('malformed scanId (wrong length, uppercase, non-hex) is rejected', () => {
  assert.equal(parseMultiExecuteCallback(`mx:012345678:${TOKEN_X}`), null, 'too short');
  assert.equal(parseMultiExecuteCallback(`mx:01234567890:${TOKEN_X}`), null, 'too long');
  assert.equal(parseMultiExecuteCallback(`mx:ABCDEF0123:${TOKEN_X}`), null, 'uppercase not accepted (generator only emits lowercase)');
  assert.equal(parseMultiExecuteCallback(`mx:zzzzzzzzzz:${TOKEN_X}`), null, 'non-hex characters');
});

test('malformed token address is rejected', () => {
  assert.equal(parseMultiExecuteCallback('mx:0123456789:0xShort'), null);
  assert.equal(parseMultiExecuteCallback('mx:0123456789:not-an-address'), null);
});

// ── Resolution / binding (items 4, 5, 9, 17) ──────────────────────────────

test('4. valid scanId + valid token resolves to the exact intent/candidate', () => {
  const run = makeRun('scanaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }]);
  const result = resolveMultiExecuteCallback(run, { scanId: 'scanaaaaaa', token: TOKEN_X });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.intent.token.toLowerCase(), TOKEN_X.toLowerCase());
    assert.equal(result.intent.pool.poolAddress, '0xP1');
  }
});

test('5. wrong scanId (same token, different/no matching run) is rejected SCAN_MISMATCH', () => {
  const run = makeRun('scanaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }]);
  const result = resolveMultiExecuteCallback(run, { scanId: 'scanbbbbbb', token: TOKEN_X });
  assert.deepEqual(result, { ok: false, reason: 'SCAN_MISMATCH' });
});

test('9. wrong token with an otherwise-valid scanId is rejected TOKEN_NOT_FOUND', () => {
  const run = makeRun('scanaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }]);
  const result = resolveMultiExecuteCallback(run, { scanId: 'scanaaaaaa', token: TOKEN_Y });
  assert.deepEqual(result, { ok: false, reason: 'TOKEN_NOT_FOUND' });
});

test('missing run (never scanned / restarted) is rejected RUN_REQUIRED', () => {
  const result = resolveMultiExecuteCallback(undefined, { scanId: 'scanaaaaaa', token: TOKEN_X });
  assert.deepEqual(result, { ok: false, reason: 'RUN_REQUIRED' });
});

test('13. a restarted-process session (no run at all) fails closed for an old button, identically to RUN_REQUIRED', () => {
  // Process restart clears session.multiRun entirely (see session.ts —
  // `sessions` is a fresh in-memory Map on every process start). Resolving
  // against `undefined` is exactly what a callback hits in that case.
  const result = resolveMultiExecuteCallback(undefined, { scanId: 'anyscan001', token: TOKEN_X });
  assert.equal(result.ok, false);
});

test('17. same scan, two different tokens: each button resolves to its OWN intent — never substituted', () => {
  const run = makeRun('scanaaaaaa', [
    { token: TOKEN_X, pool: '0xP1' },
    { token: TOKEN_Y, pool: '0xP2' },
  ]);
  const resultX = resolveMultiExecuteCallback(run, { scanId: 'scanaaaaaa', token: TOKEN_X });
  const resultY = resolveMultiExecuteCallback(run, { scanId: 'scanaaaaaa', token: TOKEN_Y });
  assert.ok(resultX.ok && resultY.ok);
  if (resultX.ok && resultY.ok) {
    assert.equal(resultX.intent.pool.poolAddress, '0xP1');
    assert.equal(resultY.intent.pool.poolAddress, '0xP2');
    assert.notEqual(resultX.intent.token.toLowerCase(), resultY.intent.token.toLowerCase());
  }
});

test('token address comparison is case-insensitive (matches the existing normalization convention used throughout this codebase)', () => {
  const run = makeRun('scanaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }]);
  const result = resolveMultiExecuteCallback(run, { scanId: 'scanaaaaaa', token: TOKEN_X.toLowerCase() });
  assert.equal(result.ok, true);
});

// ── The critical F-13 regression: same token, different scan ─────────────

test('CRITICAL: scan A + token X cannot resolve against scan B + token X, even though X is present in BOTH scans under a different pool', () => {
  const runA = makeRun('scanAAAAAA', [{ token: TOKEN_X, pool: '0xP1' }]);
  const runB = makeRun('scanBBBBBB', [{ token: TOKEN_X, pool: '0xP2' }]);

  // The operator's session now holds B (as if a newer /multi scan replaced A).
  const currentSession = runB;

  // Pressing the OLD button from A (built with A's scanId) against the
  // CURRENT session (B) must be rejected — never silently resolve to B's
  // P2 intent for the same token address.
  const oldButtonFromA = { scanId: runA.scanId, token: TOKEN_X };
  const result = resolveMultiExecuteCallback(currentSession, oldButtonFromA);
  assert.deepEqual(result, { ok: false, reason: 'SCAN_MISMATCH' });

  // The NEW button from B, for the same token, must resolve correctly to B's own P2 intent.
  const newButtonFromB = { scanId: runB.scanId, token: TOKEN_X };
  const resultB = resolveMultiExecuteCallback(currentSession, newButtonFromB);
  assert.ok(resultB.ok);
  if (resultB.ok) assert.equal(resultB.intent.pool.poolAddress, '0xP2');
});

test('scan A + token X cannot resolve as scan A + token Y (cross-token substitution within the same scan is also rejected when the callback itself names the wrong token)', () => {
  const runA = makeRun('scanAAAAAA', [{ token: TOKEN_X, pool: '0xP1' }]); // Y not in this run at all
  const result = resolveMultiExecuteCallback(runA, { scanId: 'scanAAAAAA', token: TOKEN_Y });
  assert.deepEqual(result, { ok: false, reason: 'TOKEN_NOT_FOUND' });
});
