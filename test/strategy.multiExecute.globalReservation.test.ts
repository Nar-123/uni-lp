/**
 * F-11 — global (chain+wallet) execution reservation: lifecycle release
 * guarantees, deadlock-freedom, and multi-party (3-token) concurrency.
 *
 * See executeTradeIntentFromSnapshot's own doc comment (multiExecute.ts)
 * for the full acquisition-order reasoning: per-token lock first, global
 * reservation second, released in reverse (global first, then per-token) —
 * every test here exercises that exact nesting via the real, unmodified
 * wrapper, never a reimplementation of the locking logic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-global-reservation-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { __resetStoreForTests } = await import('../src/db/index.js');
const { executeTradeIntentFromSnapshot } = await import('../src/strategy/multiExecute.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');
const { __resetExecutionLocksForTests, __executionLockSizeForTests } = await import('../src/strategy/executionLock.js');

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
    positionSizeUsd: 50,
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
const NOW = 10_000_000;

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

function execute(token: string, cfg: unknown, overrides: Record<string, unknown> = {}) {
  return executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: cfg as never,
    prefs: PREFS as never,
    snapshotTimestamp: NOW - 60_000,
    now: NOW,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      throw new Error('stop — proves mintFn was reached');
    },
    ...overrides,
  });
}

// ── Reservation release guarantees (items 5-10) ───────────────────────────

test('5. reservation released after reaching mintFn (the last gate) — a subsequent different token can then proceed', async () => {
  resetAll();
  const cfg = baseConfig();
  const tokenA = freshToken();
  const tokenB = freshToken();
  let mintCallsA = 0;
  let mintCallsB = 0;

  const outcomeA = await execute(tokenA, cfg, { mintFn: async () => { mintCallsA++; throw new Error('stop'); } });
  assert.ok('skipped' in outcomeA && outcomeA.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsA, 1);
  assert.equal(__executionLockSizeForTests(), 0, 'both locks released after A completes');

  const outcomeB = await execute(tokenB, cfg, { mintFn: async () => { mintCallsB++; throw new Error('stop'); } });
  assert.ok('skipped' in outcomeB && outcomeB.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsB, 1, 'B proceeds normally once A has released the reservation');
});

test('6. reservation released after mintFn throws', async () => {
  resetAll();
  const cfg = baseConfig();
  const tokenA = freshToken();
  const tokenB = freshToken();

  await execute(tokenA, cfg, { mintFn: async () => { throw new Error('simulated mint failure'); } });
  assert.equal(__executionLockSizeForTests(), 0);

  let mintCallsB = 0;
  const outcomeB = await execute(tokenB, cfg, { mintFn: async () => { mintCallsB++; throw new Error('stop'); } });
  assert.equal(mintCallsB, 1);
  assert.ok('skipped' in outcomeB && outcomeB.reason === 'SIMULATION_FAILED');
});

test('7. reservation released after a GMGN/revalidation failure', async () => {
  resetAll();
  const cfg = baseConfig();
  const tokenA = freshToken();
  const tokenB = freshToken();

  const outcomeA = await execute(tokenA, cfg, {
    revalidateFn: async () => ({ status: 'REVALIDATION_SOURCE_ERROR', message: 'gmgn timeout' }),
  });
  assert.ok('skipped' in outcomeA && outcomeA.reason === 'REVALIDATION_SOURCE_ERROR');
  assert.equal(__executionLockSizeForTests(), 0, 'reservation must release even though it was acquired before the failing revalidation call');

  let mintCallsB = 0;
  const outcomeB = await execute(tokenB, cfg, { mintFn: async () => { mintCallsB++; throw new Error('stop'); } });
  assert.equal(mintCallsB, 1);
});

test('8. reservation released after an F-08 liquidity failure', async () => {
  resetAll();
  const cfg = baseConfig();
  const tokenA = freshToken();
  const tokenB = freshToken();

  const outcomeA = await execute(tokenA, cfg, {
    verifyLiquidityFn: async () => ({ status: 'TVL_MISMATCH' }),
  });
  assert.ok('skipped' in outcomeA && outcomeA.reason === 'TVL_MISMATCH');
  assert.equal(__executionLockSizeForTests(), 0);

  let mintCallsB = 0;
  const outcomeB = await execute(tokenB, cfg, { mintFn: async () => { mintCallsB++; throw new Error('stop'); } });
  assert.equal(mintCallsB, 1);
});

test('9. reservation released when revalidateFn itself throws (a rejected promise, not just a failure status) — synchronous-looking exceptions inside async functions are promise rejections and still hit the finally', async () => {
  resetAll();
  const cfg = baseConfig();
  const tokenA = freshToken();
  const tokenB = freshToken();

  await assert.rejects(
    execute(tokenA, cfg, {
      revalidateFn: async () => {
        throw new Error('unexpected throw');
      },
    }),
  );
  assert.equal(__executionLockSizeForTests(), 0, 'no leak even when the failure is an uncaught exception rather than a returned failure status');

  let mintCallsB = 0;
  const outcomeB = await execute(tokenB, cfg, { mintFn: async () => { mintCallsB++; throw new Error('stop'); } });
  assert.equal(mintCallsB, 1);
});

test('10. repeated failed attempts never accumulate stuck reservations — retry always works', async () => {
  resetAll();
  const cfg = baseConfig();
  const token = freshToken();
  for (let i = 0; i < 5; i++) {
    await execute(token, cfg, {
      revalidateFn: async () => ({ status: 'REJECTED', reason: 'MC_TOO_LOW', candidate: baseCandidate(token) }),
    });
  }
  assert.equal(__executionLockSizeForTests(), 0);
});

test('13. no deadlock: per-token lock acquired first, global reservation second, every time — a stress loop of interleaved different-token attempts always terminates and never leaves a stuck lock', async () => {
  resetAll();
  const cfg = baseConfig();
  // Fire several different-token attempts back-to-back without awaiting
  // between them (maximum interleaving pressure on the nested locks), then
  // await them all. If acquisition order were ever inconsistent, this would
  // hang; node:test's own timeout would catch it.
  const tokens = Array.from({ length: 6 }, () => freshToken());
  const promises = tokens.map((t) => execute(t, cfg));
  const outcomes = await Promise.all(promises);
  assert.equal(outcomes.length, 6);
  assert.equal(__executionLockSizeForTests(), 0, 'no lock left held after all attempts settle, in any order');
});

// ── Multi-party (3-token) concurrency (items 14-15) ───────────────────────

test('14. three tokens, maxOpenPositions=1: only one reaches mintFn while the others are blocked by the global reservation; all three eventually get a chance sequentially', async () => {
  resetAll();
  const cfg = baseConfig({ maxOpenPositions: 1, maxPositionsPerToken: 1 });
  const [tokenA, tokenB, tokenC] = [freshToken(), freshToken(), freshToken()];
  const gateA = deferred<void>();
  let mintCalls = 0;
  const reached: string[] = [];

  const promiseA = execute(tokenA, cfg, {
    verifyLiquidityFn: async () => {
      await gateA.promise;
      return { status: 'OK' };
    },
    mintFn: async () => {
      mintCalls++;
      reached.push('A');
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  // B and C both attempt concurrently while A holds the reservation.
  const [outcomeB, outcomeC] = await Promise.all([
    execute(tokenB, cfg, { mintFn: async () => { mintCalls++; reached.push('B'); throw new Error('stop'); } }),
    execute(tokenC, cfg, { mintFn: async () => { mintCalls++; reached.push('C'); throw new Error('stop'); } }),
  ]);

  assert.ok('skipped' in outcomeB && outcomeB.reason === 'GLOBAL_EXECUTION_IN_PROGRESS');
  assert.ok('skipped' in outcomeC && outcomeC.reason === 'GLOBAL_EXECUTION_IN_PROGRESS');
  assert.equal(mintCalls, 0, 'neither B nor C reached mintFn while A holds the reservation');

  gateA.resolve();
  await promiseA;
  assert.deepEqual(reached, ['A']);
  assert.equal(__executionLockSizeForTests(), 0);

  // Sequentially, B and then C can now each get their turn.
  const outcomeBRetry = await execute(tokenB, cfg, { mintFn: async () => { mintCalls++; reached.push('B'); throw new Error('stop'); } });
  assert.ok('skipped' in outcomeBRetry && outcomeBRetry.reason === 'SIMULATION_FAILED');
  const outcomeCRetry = await execute(tokenC, cfg, { mintFn: async () => { mintCalls++; reached.push('C'); throw new Error('stop'); } });
  assert.ok('skipped' in outcomeCRetry && outcomeCRetry.reason === 'SIMULATION_FAILED');
  assert.deepEqual(reached, ['A', 'B', 'C']);
});

test('15. three tokens, maxExposureUsd binding: only one is ever "in flight" toward the shared budget at a time, closing the race regardless of how many tokens contend simultaneously', async () => {
  resetAll();
  const cfg = baseConfig({ maxOpenPositions: 10, maxPositionsPerToken: 10, maxExposureUsd: 60, positionSizeUsd: 50 });
  const [tokenA, tokenB, tokenC] = [freshToken(), freshToken(), freshToken()];
  const gateA = deferred<void>();
  let mintCalls = 0;

  const promiseA = execute(tokenA, cfg, {
    verifyLiquidityFn: async () => {
      await gateA.promise;
      return { status: 'OK' };
    },
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  const [outcomeB, outcomeC] = await Promise.all([
    execute(tokenB, cfg, { mintFn: async () => { mintCalls++; throw new Error('stop'); } }),
    execute(tokenC, cfg, { mintFn: async () => { mintCalls++; throw new Error('stop'); } }),
  ]);

  assert.ok('skipped' in outcomeB && outcomeB.reason === 'GLOBAL_EXECUTION_IN_PROGRESS');
  assert.ok('skipped' in outcomeC && outcomeC.reason === 'GLOBAL_EXECUTION_IN_PROGRESS');
  assert.equal(mintCalls, 0);

  gateA.resolve();
  await promiseA;
  assert.equal(mintCalls, 1);
});
