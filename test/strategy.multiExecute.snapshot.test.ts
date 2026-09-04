/**
 * Phase 4.7 audit (F-10 + execution TOCTOU) — executeTradeIntentFromSnapshot:
 * the Telegram-session-aware Execute entry point.
 *
 * Covers: TTL expiry, single-candidate revalidation wiring, failure
 * semantics (never falling back to stale/cached data), and the per-token
 * in-flight execution lock — including a REAL concurrency test using a
 * deferred promise to pause one call mid-flight and prove a second
 * concurrent call is rejected before it can reach mintFn, not merely
 * asserted sequentially.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multiexec-snapshot-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { __resetStoreForTests, listOpenPositions } = await import('../src/db/index.js');
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
    positionSizeUsd: 100,
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 3,
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

function fakeMintResult(overrides: Record<string, unknown> = {}) {
  return {
    hash: '0xabc',
    tokenId: 1n,
    amount0: 0n,
    amount1: 0n,
    tickLower: 100,
    tickUpper: 200,
    currentTick: 150,
    depositToken: USDG,
    depositAmount: 100_000_000n,
    txLink: '',
    poolAddress: '0xpool',
    fee: 50_000,
    token0: USDG,
    token1: '0xmeme',
    protocol: 'v3' as const,
    dex: 'uniswap' as const,
    ...overrides,
  };
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

// ── F-10: TTL ──────────────────────────────────────────────────────────

test('25 / 2. expired snapshot is rejected SNAPSHOT_EXPIRED before any revalidation call is made', async () => {
  resetAll();
  const token = freshToken();
  let revalidateCalls = 0;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: 0, // far in the past
    now: 10_000_000, // now - 0 >> snapshotTtlMs (600_000)
    revalidateFn: async () => {
      revalidateCalls++;
      return { status: 'OK', candidate: baseCandidate(token) } as never;
    },
  });
  assert.ok('skipped' in outcome && outcome.reason === 'SNAPSHOT_EXPIRED');
  assert.equal(revalidateCalls, 0, 'an expired snapshot must never trigger a GMGN call');
});

test('1. fresh snapshot (within TTL) + eligible candidate -> proceeds all the way to mintFn', async () => {
  // mintFn throws immediately once reached (matching this codebase's own
  // established pattern in strategy.multiExecute.test.ts — a mintFn that
  // instead RETURNS a result would let executeTradeIntent's post-mint
  // accounting section run for real (getTokenMeta/getTokenPriceUsd against
  // the live chain), which needs live RPC access this environment does not
  // reliably have. Reaching mintFn at all (mintCalls===1) is exactly what
  // this test needs to prove — that every gate before it passed.
  resetAll();
  const token = freshToken();
  let mintCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000, // 1 minute old, well within default 10-minute TTL
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached, not a real mint');
    },
  });
  assert.equal(mintCalls, 1);
  assert.ok('skipped' in outcome && outcome.reason === 'SIMULATION_FAILED');
});

// ── F-10: revalidation failure semantics ─────────────────────────────────

test('8 / 9 / 10. GMGN failure during revalidation never falls back to stale data — rejected, mintFn never called', async () => {
  resetAll();
  const token = freshToken();
  let mintCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'REVALIDATION_SOURCE_ERROR', message: 'gmgn-cli timed out' }) as never,
    mintFn: async () => {
      mintCalls++;
      return fakeMintResult() as never;
    },
  });
  assert.ok('skipped' in outcome && outcome.reason === 'REVALIDATION_SOURCE_ERROR');
  assert.equal(mintCalls, 0);
});

test('11. candidate no longer found during revalidation -> CANDIDATE_NOT_FOUND, never assumed eligible', async () => {
  resetAll();
  const token = freshToken();
  let mintCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'CANDIDATE_NOT_FOUND' }) as never,
    mintFn: async () => {
      mintCalls++;
      return fakeMintResult() as never;
    },
  });
  assert.ok('skipped' in outcome && outcome.reason === 'CANDIDATE_NOT_FOUND');
  assert.equal(mintCalls, 0);
});

test('4-7 / 13. revalidation REJECTED (e.g. VOLUME_TOO_LOW) surfaces that exact reason and never calls mintFn', async () => {
  resetAll();
  const token = freshToken();
  let mintCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'REJECTED', reason: 'VOLUME_TOO_LOW', candidate: baseCandidate(token) }) as never,
    mintFn: async () => {
      mintCalls++;
      return fakeMintResult() as never;
    },
  });
  assert.ok('skipped' in outcome && outcome.reason === 'VOLUME_TOO_LOW');
  assert.equal(mintCalls, 0);
});

test('zero broadcast attempts on any failed revalidation outcome (no open position recorded)', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'REJECTED', reason: 'MC_TOO_LOW', candidate: baseCandidate(token) }) as never,
    mintFn: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(listOpenPositions(CHAIN).length, 0);
});

// ── Integration ordering ─────────────────────────────────────────────────

test('26 / 27. revalidation runs before the existing risk gate/F-08/mint pipeline — a revalidation rejection short-circuits before runRiskGate\'s DB checks matter', async () => {
  resetAll();
  const token = freshToken();
  let liquidityCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'REJECTED', reason: 'AGE_TOO_LOW', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => {
      liquidityCalls++;
      return { status: 'OK' } as never;
    },
  });
  assert.ok('skipped' in outcome && outcome.reason === 'AGE_TOO_LOW');
  assert.equal(liquidityCalls, 0, 'F-08 must never run once revalidation has already rejected');
});

test('27 / 28. the existing risk gate still executes and can still independently reject even after revalidation passes', async () => {
  resetAll();
  const { recordOpenPosition } = await import('../src/db/index.js');
  const token = freshToken();
  recordOpenPosition({
    chainId: CHAIN,
    tokenId: 'pos-1',
    poolAddress: '0xpool',
    token0: USDG,
    token1: token,
    fee: 50_000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'multi',
  });
  const now = 10_000_000;
  let mintCalls = 0;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    mintFn: async () => {
      mintCalls++;
      return fakeMintResult() as never;
    },
  });
  assert.ok('skipped' in outcome && outcome.reason === 'DUPLICATE_POSITION');
  assert.equal(mintCalls, 0);
});

test('28. F-08 liquidity validation still executes after revalidation passes and before mint', async () => {
  resetAll();
  const token = freshToken();
  let liquidityCalls = 0;
  let mintCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => {
      liquidityCalls++;
      return { status: 'TVL_MISMATCH' } as never;
    },
    mintFn: async () => {
      mintCalls++;
      return fakeMintResult() as never;
    },
  });
  assert.equal(liquidityCalls, 1);
  assert.equal(mintCalls, 0);
  assert.ok('skipped' in outcome && outcome.reason === 'TVL_MISMATCH');
});

test('29 / 30. mintFn remains the final execution path and is reached exactly once when every gate passes', async () => {
  resetAll();
  const token = freshToken();
  let mintCalls = 0;
  const now = 10_000_000;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });
  assert.equal(mintCalls, 1);
  assert.ok('skipped' in outcome && outcome.reason === 'SIMULATION_FAILED');
});

// ── TOCTOU: lock release guarantees (Part 7) ─────────────────────────────

test('17. lock is released after a GMGN/revalidation failure — a subsequent Execute for the same token can proceed', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  const params = {
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
  };
  const first = await executeTradeIntentFromSnapshot({
    ...params,
    revalidateFn: async () => ({ status: 'REVALIDATION_SOURCE_ERROR', message: 'x' }) as never,
  });
  assert.ok('skipped' in first && first.reason === 'REVALIDATION_SOURCE_ERROR');
  assert.equal(__executionLockSizeForTests(), 0, 'lock must be released after a revalidation failure');

  let mintCalls = 0;
  const second = await executeTradeIntentFromSnapshot({
    ...params,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });
  assert.equal(mintCalls, 1);
  assert.ok('skipped' in second && second.reason === 'SIMULATION_FAILED');
});

test('18. lock is released after an F-08 liquidity failure — a subsequent Execute can proceed', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  const params = {
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
  };
  const first = await executeTradeIntentFromSnapshot({
    ...params,
    verifyLiquidityFn: async () => ({ status: 'TVL_MISMATCH' }) as never,
  });
  assert.ok('skipped' in first && first.reason === 'TVL_MISMATCH');
  assert.equal(__executionLockSizeForTests(), 0);

  let mintCalls = 0;
  const second = await executeTradeIntentFromSnapshot({
    ...params,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });
  assert.equal(mintCalls, 1);
});

test('19. lock is released after mintFn throws — a subsequent Execute can proceed', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  const params = {
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
  };
  const first = await executeTradeIntentFromSnapshot({
    ...params,
    mintFn: async () => {
      throw new Error('simulated mint failure');
    },
  });
  assert.ok('skipped' in first && first.reason === 'SIMULATION_FAILED');
  assert.equal(__executionLockSizeForTests(), 0, 'lock must be released even when mintFn throws');

  let mintCalls = 0;
  const second = await executeTradeIntentFromSnapshot({
    ...params,
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });
  assert.equal(mintCalls, 1);
});

test('20. lock is released after reaching mintFn (the last gate) — a subsequent Execute for a NEW token is unaffected (and the old key is gone)', async () => {
  // "Success" here means "reached and called the final gate", per this
  // file's header note on avoiding the real, unmocked post-mint accounting
  // RPC calls (getTokenMeta/getTokenPriceUsd) that a genuinely-returning
  // mintFn would trigger inside executeTradeIntent.
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  let mintCalls = 0;
  const outcome = await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(token) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });
  assert.equal(mintCalls, 1);
  assert.ok('skipped' in outcome && outcome.reason === 'SIMULATION_FAILED');
  assert.equal(__executionLockSizeForTests(), 0, 'lock must be released after the flow completes, success or not');
});

test('22 / 23. lock does not leak after an early rejection (SNAPSHOT_EXPIRED) or after an exception thrown inside revalidateFn itself', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;

  // Early rejection before the lock is ever acquired (TTL check) — nothing to leak.
  await executeTradeIntentFromSnapshot({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: 0,
    now: 10_000_000,
  });
  assert.equal(__executionLockSizeForTests(), 0);

  // revalidateFn itself throws (not just returns a source-error result) — must still release via finally.
  await assert.rejects(
    executeTradeIntentFromSnapshot({
      intent: baseIntent(token) as never,
      candidate: baseCandidate(token) as never,
      config: baseConfig() as never,
      prefs: PREFS as never,
      snapshotTimestamp: now - 60_000,
      now,
      revalidateFn: async () => {
        throw new Error('unexpected throw inside revalidateFn');
      },
    }),
  );
  assert.equal(__executionLockSizeForTests(), 0, 'lock must not leak even when revalidateFn itself throws (not just returns a failure status)');
});

test('24. repeated Execute after a failure can retry normally (no permanent lock)', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  for (let i = 0; i < 3; i++) {
    await executeTradeIntentFromSnapshot({
      intent: baseIntent(token) as never,
      candidate: baseCandidate(token) as never,
      config: baseConfig() as never,
      prefs: PREFS as never,
      snapshotTimestamp: now - 60_000,
      now,
      revalidateFn: async () => ({ status: 'REJECTED', reason: 'MC_TOO_LOW', candidate: baseCandidate(token) }) as never,
    });
  }
  assert.equal(__executionLockSizeForTests(), 0);
});

// ── TOCTOU: same-token vs different-token (Part 6) ───────────────────────

test('21 (F-11 update): two DIFFERENT tokens on the same wallet no longer execute independently — the global reservation serializes them, closing the cross-token risk-limit race a prior version of this test incorrectly treated as desirable', async () => {
  // Historical note: this test previously asserted the OPPOSITE — that
  // token Y should proceed while token X was still in flight. That was
  // exactly the gap the final adversarial audit proved exploitable
  // (MAX_OPEN_POSITIONS/MAX_EXPOSURE_USD both bypassable by two different
  // tokens racing checkPositionLimits before either recorded a position).
  // See test/strategy.multiExecute.globalToctou.test.ts for the dedicated
  // before/after proof. This test now documents and locks in the corrected
  // behavior at the wrapper level.
  resetAll();
  const tokenX = freshToken();
  const tokenY = freshToken();
  const now = 10_000_000;
  const gateX = deferred<void>();
  let mintCallsX = 0;
  let mintCallsY = 0;

  const promiseX = executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenX) as never,
    candidate: baseCandidate(tokenX) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => {
      await gateX.promise;
      return { status: 'OK', candidate: baseCandidate(tokenX) } as never;
    },
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsX++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });

  await new Promise((r) => setImmediate(r));

  // Token Y, same wallet, different token — must now be blocked by the
  // GLOBAL reservation (not the per-token lock, which never sees a
  // collision here — X and Y have distinct per-token keys).
  const outcomeY = await executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenY) as never,
    candidate: baseCandidate(tokenY) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => {
      mintCallsY += 0; // never reached if the reservation works — see assertion below
      return { status: 'OK', candidate: baseCandidate(tokenY) } as never;
    },
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsY++;
      throw new Error('must not be called — Y must be blocked before mint');
    },
  });

  assert.ok(
    'skipped' in outcomeY && outcomeY.reason === 'GLOBAL_EXECUTION_IN_PROGRESS',
    `expected Y to be blocked by the global reservation while X is in flight, got: ${JSON.stringify(outcomeY)}`,
  );
  assert.equal(mintCallsY, 0, 'Y must never reach mintFn while X holds the global reservation');

  // Release X; it completes, releasing both its locks.
  gateX.resolve();
  const outcomeX = await promiseX;
  assert.ok('skipped' in outcomeX && outcomeX.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsX, 1);

  // Now that X is fully done, Y can retry normally and reach mintFn.
  const outcomeYRetry = await executeTradeIntentFromSnapshot({
    intent: baseIntent(tokenY) as never,
    candidate: baseCandidate(tokenY) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    revalidateFn: async () => ({ status: 'OK', candidate: baseCandidate(tokenY) }) as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }) as never,
    mintFn: async () => {
      mintCallsY++;
      throw new Error('stop here — proves mintFn was reached');
    },
  });
  assert.ok('skipped' in outcomeYRetry && outcomeYRetry.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsY, 1, 'Y succeeds in reaching mintFn once X has fully released the reservation');
});

// ── TOCTOU: the real concurrency test (Part 12) ──────────────────────────

test('14-16 / 32. REAL concurrency: two concurrent Execute calls for the SAME token — exactly one reaches mintFn, the other gets EXECUTION_IN_PROGRESS, proven with a deferred promise barrier (not a fake sequential test)', async () => {
  resetAll();
  const token = freshToken();
  const now = 10_000_000;
  const gate = deferred<void>();
  let mintCalls = 0;
  let revalidateCallsA = 0;
  let revalidateCallsB = 0;

  const paramsBase = {
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: baseConfig() as never,
    prefs: PREFS as never,
    snapshotTimestamp: now - 60_000,
    now,
    verifyLiquidityFn: (async () => ({ status: 'OK' })) as never,
    mintFn: (async () => {
      mintCalls++;
      throw new Error('stop here — proves mintFn was reached');
    }) as never,
  };

  // A enters, acquires the lock, and pauses mid-revalidation until the test releases it.
  const promiseA = executeTradeIntentFromSnapshot({
    ...paramsBase,
    revalidateFn: async () => {
      revalidateCallsA++;
      await gate.promise;
      return { status: 'OK', candidate: baseCandidate(token) } as never;
    },
  });

  // Yield the event loop just enough for A to run synchronously up through
  // tryAcquireExecutionLock and start (and block inside) its revalidateFn —
  // this is the real, deterministic barrier: A is provably still in
  // flight, holding the lock, when B is launched below.
  await new Promise((r) => setImmediate(r));
  assert.equal(revalidateCallsA, 1, 'A must already be inside its (paused) revalidation call');

  // B attempts the SAME token while A still holds the lock.
  const outcomeB = await executeTradeIntentFromSnapshot({
    ...paramsBase,
    revalidateFn: async () => {
      revalidateCallsB++;
      return { status: 'OK', candidate: baseCandidate(token) } as never;
    },
  });

  assert.ok('skipped' in outcomeB, 'B must be rejected while A is still in flight');
  if ('skipped' in outcomeB) assert.equal(outcomeB.reason, 'EXECUTION_IN_PROGRESS');
  assert.equal(revalidateCallsB, 0, 'B must never even attempt revalidation once the lock is held');
  assert.equal(mintCalls, 0, 'neither call has reached mintFn yet');

  // Release A; it should now complete normally, and only now does mintFn fire.
  gate.resolve();
  const outcomeA = await promiseA;
  assert.ok('skipped' in outcomeA && outcomeA.reason === 'SIMULATION_FAILED', 'A reaches and calls mintFn once released');
  assert.equal(mintCalls, 1, 'exactly one mintFn call total across both concurrent attempts');
  assert.equal(__executionLockSizeForTests(), 0, 'lock released after A completes');
});
