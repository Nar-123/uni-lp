/**
 * FINAL ADVERSARIAL AUDIT — Critical Check #1 (global TOCTOU) — and its
 * F-11 fix.
 *
 * checkPositionLimits (multiRisk.ts) reads listOpenPositions() synchronously
 * with no reservation, and recordOpenPosition() only happens after mintFn
 * succeeds — two DIFFERENT tokens (different per-token lock keys) can both
 * pass the risk gate before either has recorded a position.
 *
 * Two layers are tested separately, deliberately:
 *
 *  - executeTradeIntent (the raw execution engine) has NO locking of its
 *    own — locking lives one layer up, in executeTradeIntentFromSnapshot.
 *    Calling executeTradeIntent directly (as runMultiStrategy's dormant
 *    dryRun:false path does) is therefore still exposed to this race by
 *    design/scope, not by omission — these tests remain audit evidence of
 *    that fact and are expected to keep demonstrating the race (both reach
 *    mintFn) even after the F-11 fix.
 *
 *  - executeTradeIntentFromSnapshot (the actual, only production entry
 *    point — the Telegram Execute callback) now acquires an F-11 GLOBAL
 *    (chain+wallet) reservation, in addition to the existing per-token
 *    lock, before revalidation. These tests now prove the fix: a second,
 *    different token is blocked (GLOBAL_EXECUTION_IN_PROGRESS) while the
 *    first is still in flight, and can retry successfully once released.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-global-toctou-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { __resetStoreForTests, listOpenPositions } = await import('../src/db/index.js');
const { executeTradeIntent, executeTradeIntentFromSnapshot } = await import('../src/strategy/multiExecute.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');
const { __resetExecutionLocksForTests } = await import('../src/strategy/executionLock.js');

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

const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: CHAIN,
    interval: '6h' as const,
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    minCandidateVolumeUsd: 0,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: 100,
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 1,
    maxPositionsPerToken: 1,
    maxExposureUsd: 500,
    entryCooldownMs: 300_000,
    tpPercent: 10,
    slPercent: 15,
    snapshotTtlMs: 600_000,
    ...overrides,
  };
}

function baseCandidate(address: string) {
  return {
    address,
    symbol: 'TOK',
    name: 'Token',
    chainId: CHAIN,
    marketCapUsd: 2_000_000,
    ageHours: 48,
    volume6hUsd: 500_000,
    liquidityUsd: 200_000,
    classification: 'MEME' as const,
    launchpadPlatform: 'pump.fun',
    candidateScore: 1,
    reasons: [],
    source: 'gmgn_trending_6h' as const,
    sourceTimestamp: Date.now(),
  };
}

function baseIntent(token: string) {
  return {
    strategy: 'multi' as const,
    chainId: CHAIN,
    token,
    quoteToken: USDG,
    pool: {
      poolAddress: '0xpool',
      protocol: 'v3' as const,
      dex: 'uniswap' as const,
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
    side: 'above' as const,
    range: { tickLower: 100, tickUpper: 200 },
    positionSize: { sizeMode: 'fixed' as const, fixedAmountHuman: 100 },
    depositToken: USDG,
    reason: 'test',
    candidateScore: 1,
    poolScore: 0.5,
  };
}

const PREFS = { sizeMode: 'fixed' as const, fixedAmountHuman: 10, balancePercent: 0 };

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function resetAll(): void {
  resetDb();
  __resetMultiCooldownForTests();
  __resetExecutionLocksForTests();
}

test('CRITICAL FINDING: two DIFFERENT tokens both pass checkPositionLimits (MAX_OPEN_POSITIONS=1, zero positions) concurrently and BOTH reach mintFn — the per-token lock does not serialize this, because each token acquires a distinct lock key', async () => {
  resetAll();
  const tokenA = freshToken();
  const tokenB = freshToken();
  const cfg = baseConfig({ maxOpenPositions: 1, maxPositionsPerToken: 1 });

  assert.equal(listOpenPositions(CHAIN).length, 0, 'sanity: zero open positions at start');

  const gateA = deferred<void>();
  let mintCallsA = 0;
  let mintCallsB = 0;

  // A: passes runRiskGate (0 open positions, limit 1 -> OK), then pauses
  // inside F-08's liquidity check — i.e. exactly "after risk validation,
  // before journal/broadcast", per the audit's own example.
  const promiseA = executeTradeIntent({
    intent: baseIntent(tokenA) as never,
    candidate: baseCandidate(tokenA) as never,
    config: cfg as never,
    prefs: PREFS as never,
    verifyLiquidityFn: async () => {
      await gateA.promise;
      return { status: 'OK' } as never;
    },
    mintFn: async () => {
      mintCallsA++;
      throw new Error('stop — proves mintFn reached, not a real mint');
    },
  });

  // Let A run synchronously through runRiskGate and into its paused F-08 call.
  await new Promise((r) => setImmediate(r));

  // B executes concurrently for a DIFFERENT token. Its OWN runRiskGate call
  // reads listOpenPositions() — which is STILL EMPTY, because A has not
  // recorded anything yet (recordOpenPosition only runs after a successful
  // mintFn, far downstream of where A is currently paused).
  const outcomeB = await executeTradeIntent({
    intent: baseIntent(tokenB) as never,
    candidate: baseCandidate(tokenB) as never,
    config: cfg as never,
    prefs: PREFS as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsB++;
      throw new Error('stop — proves mintFn reached, not a real mint');
    },
  });

  // THE FINDING: B is NOT blocked by POSITION_LIMIT, despite A already
  // "holding" the one allowed slot in every practical sense.
  assert.ok(
    'skipped' in outcomeB && outcomeB.reason === 'SIMULATION_FAILED',
    `expected B to reach mintFn (reason SIMULATION_FAILED from the injected throw), got: ${JSON.stringify(outcomeB)}`,
  );
  assert.equal(mintCallsB, 1, 'B reached mintFn — checkPositionLimits did not block it');

  gateA.resolve();
  const outcomeA = await promiseA;
  assert.ok('skipped' in outcomeA && outcomeA.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsA, 1, 'A also reached mintFn');

  // Both A and B reached mintFn with MAX_OPEN_POSITIONS=1 and zero prior
  // positions. Had mintFn been real, BOTH would have broadcast a mint,
  // exceeding the configured global limit by one full position.
});

test('F-11 FIX PROVEN: the Telegram-facing executeTradeIntentFromSnapshot wrapper now blocks a second, different token via the GLOBAL reservation — B never reaches mintFn while A is in flight, and can retry successfully once A releases', async () => {
  resetAll();
  const tokenA = freshToken();
  const tokenB = freshToken();
  const cfg = baseConfig({ maxOpenPositions: 1, maxPositionsPerToken: 1 });
  const now = 10_000_000;

  const gateA = deferred<void>();
  let mintCallsA = 0;
  let mintCallsB = 0;
  let revalidateCallsB = 0;

  const promiseA = executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenA) as never,
    candidate: baseCandidate(tokenA) as never,
    config: cfg as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(tokenA) }) as never,
    verifyLiquidityFn: async () => {
      await gateA.promise;
      return { status: 'OK' } as never;
    },
    mintFn: async () => {
      mintCallsA++;
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  // B's per-token lock (distinct key from A's) would happily be acquired —
  // the GLOBAL reservation is what must stop it here, before it ever
  // spends a revalidation call.
  const outcomeB = await executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenB) as never,
    candidate: baseCandidate(tokenB) as never,
    config: cfg as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => {
      revalidateCallsB++;
      return { status: 'OK', candidate: baseCandidate(tokenB) } as never;
    },
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsB++;
      throw new Error('must not be called');
    },
  });

  assert.ok(
    'skipped' in outcomeB && outcomeB.reason === 'GLOBAL_EXECUTION_IN_PROGRESS',
    `expected B blocked by the global reservation, got: ${JSON.stringify(outcomeB)}`,
  );
  assert.equal(revalidateCallsB, 0, 'B must be blocked before spending any revalidation API budget');
  assert.equal(mintCallsB, 0, 'B must never reach mintFn while A holds the global reservation');

  gateA.resolve();
  await promiseA;
  assert.equal(mintCallsA, 1);

  // Reservation released — B retries and now proceeds normally.
  const outcomeBRetry = await executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenB) as never,
    candidate: baseCandidate(tokenB) as never,
    config: cfg as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(tokenB) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsB++;
      throw new Error('stop');
    },
  });
  assert.ok('skipped' in outcomeBRetry && outcomeBRetry.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsB, 1, 'B succeeds in reaching mintFn once the reservation is free');
});

test('CRITICAL FINDING (raw executeTradeIntent, by design/scope — see file header): MAX_EXPOSURE_USD is independently vulnerable to the same race — two different tokens can both pass the exposure check when neither has recorded its position/meta yet, even with maxOpenPositions set high enough not to be the binding constraint', async () => {
  resetAll();
  const tokenA = freshToken();
  const tokenB = freshToken();
  // maxOpenPositions=10 (not binding); maxExposureUsd=60 with positionSizeUsd=50
  // means a SECOND $50 entry (100 total) must be rejected if exposure were
  // read after the first was recorded — but neither has recorded yet.
  const cfg = baseConfig({ maxOpenPositions: 10, maxPositionsPerToken: 10, maxExposureUsd: 60, positionSizeUsd: 50 });

  const gateA = deferred<void>();
  let mintCallsA = 0;
  let mintCallsB = 0;

  const promiseA = executeTradeIntent({
    intent: baseIntent(tokenA) as never,
    candidate: baseCandidate(tokenA) as never,
    config: cfg as never,
    prefs: PREFS as never,
    verifyLiquidityFn: async () => {
      await gateA.promise;
      return { status: 'OK' } as never;
    },
    mintFn: async () => {
      mintCallsA++;
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  const outcomeB = await executeTradeIntent({
    intent: baseIntent(tokenB) as never,
    candidate: baseCandidate(tokenB) as never,
    config: cfg as never,
    prefs: PREFS as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsB++;
      throw new Error('stop');
    },
  });

  assert.ok(
    'skipped' in outcomeB && outcomeB.reason === 'SIMULATION_FAILED',
    `expected B to pass the exposure gate and reach mintFn, got: ${JSON.stringify(outcomeB)}`,
  );
  assert.equal(mintCallsB, 1, 'B was not blocked by MAX_EXPOSURE_USD even though A already "counts" toward the same budget');

  gateA.resolve();
  await promiseA;
  assert.equal(mintCallsA, 1);
  // A ($50) + B ($50) = $100 > maxExposureUsd ($60) — the configured cap
  // would have been exceeded had both mintFns been real.
});

test('F-11 FIX PROVEN (MAX_EXPOSURE_USD, via the wrapper): B is blocked by the global reservation before it can even attempt to pass the exposure gate, closing the race the previous test demonstrates at the raw executeTradeIntent layer', async () => {
  resetAll();
  const tokenA = freshToken();
  const tokenB = freshToken();
  const cfg = baseConfig({ maxOpenPositions: 10, maxPositionsPerToken: 10, maxExposureUsd: 60, positionSizeUsd: 50 });
  const now = 10_000_000;

  const gateA = deferred<void>();
  let mintCallsA = 0;
  let mintCallsB = 0;

  const promiseA = executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenA) as never,
    candidate: baseCandidate(tokenA) as never,
    config: cfg as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(tokenA) }) as never,
    verifyLiquidityFn: async () => {
      await gateA.promise;
      return { status: 'OK' } as never;
    },
    mintFn: async () => {
      mintCallsA++;
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  const outcomeB = await executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenB) as never,
    candidate: baseCandidate(tokenB) as never,
    config: cfg as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(tokenB) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsB++;
      throw new Error('must not be called');
    },
  });

  assert.ok(
    'skipped' in outcomeB && outcomeB.reason === 'GLOBAL_EXECUTION_IN_PROGRESS',
    `expected B blocked by the global reservation, got: ${JSON.stringify(outcomeB)}`,
  );
  assert.equal(mintCallsB, 0);

  gateA.resolve();
  await promiseA;
  assert.equal(mintCallsA, 1);
});
