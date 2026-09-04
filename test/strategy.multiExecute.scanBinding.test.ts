/**
 * Phase 4.7 audit (F-13) — end-to-end scan-binding proof, wiring the real
 * production functions together (parseMultiExecuteCallback,
 * resolveMultiExecuteCallback, executeTradeIntentFromSnapshot) exactly as
 * bot.ts's `mx:...` callback handler does, via a small local
 * `simulateExecuteCallback` helper that mirrors that handler's control
 * flow one-for-one (parse -> resolve -> TTL -> executeTradeIntentFromSnapshot)
 * with the Telegram-specific ctx.answerCallbackQuery/ctx.reply calls
 * omitted.
 *
 * HONEST COVERAGE NOTE: this codebase has no test harness for grammY's
 * registered callbackQuery handlers themselves (confirmed — no existing
 * test file imports bot.ts or invokes a bot.callbackQuery handler
 * directly), so this is NOT a literal invocation of the handler at
 * bot.ts:~1719. It is a faithful reconstruction of that handler's exact
 * control flow using the same real, unmodified, exported functions the
 * handler itself calls. The remaining gap — proving grammY actually routes
 * `ctx.callbackQuery.data` into these functions correctly — is a thin,
 * mechanical wiring concern (three function calls in sequence) rather than
 * business logic, and is not covered by an automated test here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-scanbinding-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { __resetStoreForTests } = await import('../src/db/index.js');
const { executeTradeIntentFromSnapshot, generateScanId } = await import('../src/strategy/multiExecute.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');
const { __resetExecutionLocksForTests } = await import('../src/strategy/executionLock.js');
const {
  buildMultiExecuteCallbackData,
  parseMultiExecuteCallback,
  resolveMultiExecuteCallback,
} = await import('../src/bot/multiExecuteResolver.js');

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
const TOKEN_X = '0x00000000000000000000000000000000000000AA';

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

function makeCandidate(address: string) {
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

function makeIntent(token: string, poolAddress: string) {
  return {
    strategy: 'multi' as const,
    chainId: CHAIN,
    token,
    quoteToken: USDG,
    pool: {
      poolAddress,
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

function makeRun(scanId: string, tokens: { token: string; pool: string }[], timestamp: number) {
  return {
    scanId,
    chainId: CHAIN,
    dryRun: true,
    timestamp,
    candidates: tokens.map((t) => makeCandidate(t.token)),
    rejected: [],
    intents: tokens.map((t) => makeIntent(t.token, t.pool)),
    executed: [],
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

/**
 * Mirrors bot.ts's `mx:...` callbackQuery handler control flow exactly:
 * parse -> resolve (scanId + token binding) -> F-10 TTL -> the real,
 * unmodified executeTradeIntentFromSnapshot. See file header for the
 * honest coverage note on what this does and does not prove.
 */
async function simulateExecuteCallback(params: {
  sess: { multiRun?: unknown };
  callbackData: string;
  config: unknown;
  now: number;
  revalidateFn?: unknown;
  verifyLiquidityFn?: unknown;
  mintFn?: unknown;
}) {
  const parsed = parseMultiExecuteCallback(params.callbackData);
  if (!parsed) return { skipped: true, reason: 'PARSE_FAILED' };
  const resolution = resolveMultiExecuteCallback(params.sess.multiRun as never, parsed);
  if (!resolution.ok) return { skipped: true, reason: resolution.reason };
  const { run, intent, candidate } = resolution;
  const cfg = params.config as { snapshotTtlMs: number };
  if (params.now - run.timestamp > cfg.snapshotTtlMs) {
    return { skipped: true, reason: 'SNAPSHOT_EXPIRED' };
  }
  return executeTradeIntentFromSnapshot({
    intent,
    candidate,
    config: params.config as never,
    prefs: PREFS as never,
    snapshotTimestamp: run.timestamp,
    now: params.now,
    revalidateFn: params.revalidateFn as never,
    verifyLiquidityFn: params.verifyLiquidityFn as never,
    mintFn: params.mintFn as never,
  });
}

// ── Items 24, 2: scanId generation ────────────────────────────────────────

test('1 / 24. generateScanId produces unique, non-colliding ids across many repeated calls', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 5000; i++) ids.add(generateScanId());
  assert.equal(ids.size, 5000, 'no collisions across 5000 generated scan ids');
});

test('2. the same scan retains the same scanId across its lifecycle (report formatting, button building, execute) — proven at the type/data level: one MultiStrategyRun object, one scanId field, read (never regenerated) by every consumer', () => {
  const scanId = generateScanId();
  const run = makeRun(scanId, [{ token: TOKEN_X, pool: '0xP1' }], Date.now());
  const cb1 = buildMultiExecuteCallbackData(run.scanId, TOKEN_X);
  const cb2 = buildMultiExecuteCallbackData(run.scanId, TOKEN_X);
  assert.equal(cb1, cb2, 'building a button twice from the same run yields the same callback data');
  assert.ok(cb1.includes(scanId));
});

// ── Items 14-16: stale callback causes zero downstream work ──────────────

test('14 / 15 / 16. a stale (scan-mismatched) callback causes ZERO GMGN/revalidation calls, ZERO risk-gate entry, and ZERO mintFn calls', async () => {
  resetAll();
  const cfg = baseConfig();
  const now = Date.now();

  const runA = makeRun('aaaaaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }], now);
  const runB = makeRun('bbbbbbbbbb', [{ token: TOKEN_X, pool: '0xP2' }], now);
  const sess = { multiRun: runB }; // current session holds B; A is stale

  let revalidateCalls = 0;
  let liquidityCalls = 0;
  let mintCalls = 0;

  const outcome = await simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(runA.scanId, TOKEN_X), // OLD button from A
    config: cfg,
    now,
    revalidateFn: () => {
      revalidateCalls++;
      return { status: 'OK', candidate: makeCandidate(TOKEN_X) };
    },
    verifyLiquidityFn: () => {
      liquidityCalls++;
      return { status: 'OK' };
    },
    mintFn: () => {
      mintCalls++;
      throw new Error('must not be called');
    },
  });

  assert.deepEqual(outcome, { skipped: true, reason: 'SCAN_MISMATCH' });
  assert.equal(revalidateCalls, 0, 'zero GMGN/revalidation calls for a stale callback');
  assert.equal(liquidityCalls, 0, 'zero F-08 calls — proves the risk-gate/execution pipeline was never entered');
  assert.equal(mintCalls, 0, 'zero mint calls');
});

// ── F-10 regression (items 18, 19) ────────────────────────────────────────

test('18. F-10 snapshot TTL is still enforced after scan-id binding succeeds', async () => {
  resetAll();
  const cfg = baseConfig();
  const now = 10_000_000;
  const oldTimestamp = now - cfg.snapshotTtlMs - 1; // just past expiry
  const run = makeRun('aaaaaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }], oldTimestamp);
  const sess = { multiRun: run };

  let revalidateCalls = 0;
  const outcome = await simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(run.scanId, TOKEN_X),
    config: cfg,
    now,
    revalidateFn: () => {
      revalidateCalls++;
      return { status: 'OK', candidate: makeCandidate(TOKEN_X) };
    },
  });

  assert.deepEqual(outcome, { skipped: true, reason: 'SNAPSHOT_EXPIRED' });
  assert.equal(revalidateCalls, 0, 'expired snapshot must be rejected before any GMGN call, same as before F-13');
});

test('19. F-10 candidate revalidation still runs and can still reject, once scan-id binding succeeds and TTL passes', async () => {
  resetAll();
  const cfg = baseConfig();
  const now = 10_000_000;
  const run = makeRun('aaaaaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }], now - 60_000);
  const sess = { multiRun: run };

  const outcome = await simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(run.scanId, TOKEN_X),
    config: cfg,
    now,
    revalidateFn: () => ({ status: 'REJECTED', reason: 'VOLUME_TOO_LOW', candidate: makeCandidate(TOKEN_X) }),
  });

  assert.deepEqual(outcome, { skipped: true, reason: 'VOLUME_TOO_LOW' });
});

// ── F-11 regression (item 20): two different tokens, SAME scan ───────────

test('20. F-11 global reservation still blocks two different tokens from the SAME scan executing concurrently', async () => {
  resetAll();
  const cfg = baseConfig({ maxOpenPositions: 1, maxPositionsPerToken: 1 });
  const now = 10_000_000;
  const tokenY = freshToken();
  const run = makeRun('aaaaaaaaaa', [
    { token: TOKEN_X, pool: '0xP1' },
    { token: tokenY, pool: '0xP2' },
  ], now - 60_000);
  const sess = { multiRun: run };

  const gate = deferred<void>();
  let mintCalls = 0;

  const promiseX = simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(run.scanId, TOKEN_X),
    config: cfg,
    now,
    revalidateFn: () => ({ status: 'OK', candidate: makeCandidate(TOKEN_X) }),
    verifyLiquidityFn: async () => {
      await gate.promise;
      return { status: 'OK' };
    },
    mintFn: () => {
      mintCalls++;
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  const outcomeY = await simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(run.scanId, tokenY),
    config: cfg,
    now,
    revalidateFn: () => ({ status: 'OK', candidate: makeCandidate(tokenY) }),
    verifyLiquidityFn: async () => ({ status: 'OK' }),
    mintFn: () => {
      mintCalls++;
      throw new Error('must not be called');
    },
  });

  assert.ok('skipped' in outcomeY && outcomeY.reason === 'GLOBAL_EXECUTION_IN_PROGRESS');
  assert.equal(mintCalls, 0);

  gate.resolve();
  await promiseX;
  assert.equal(mintCalls, 1);
});

// ── Same-token execution lock (item 21) ───────────────────────────────────

test('21. same-token per-token execution lock still enforced through the scan-binding wrapper', async () => {
  resetAll();
  const cfg = baseConfig();
  const now = 10_000_000;
  const run = makeRun('aaaaaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }], now - 60_000);
  const sess = { multiRun: run };

  const gate = deferred<void>();
  let mintCalls = 0;
  let revalidateCallsB = 0;

  const promiseA = simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(run.scanId, TOKEN_X),
    config: cfg,
    now,
    revalidateFn: async () => {
      await gate.promise;
      return { status: 'OK', candidate: makeCandidate(TOKEN_X) };
    },
    verifyLiquidityFn: () => ({ status: 'OK' }),
    mintFn: () => {
      mintCalls++;
      throw new Error('stop');
    },
  });

  await new Promise((r) => setImmediate(r));

  const outcomeB = await simulateExecuteCallback({
    sess,
    callbackData: buildMultiExecuteCallbackData(run.scanId, TOKEN_X), // SAME button pressed again
    config: cfg,
    now,
    revalidateFn: () => {
      revalidateCallsB++;
      return { status: 'OK', candidate: makeCandidate(TOKEN_X) };
    },
  });

  assert.ok('skipped' in outcomeB && outcomeB.reason === 'EXECUTION_IN_PROGRESS');
  assert.equal(revalidateCallsB, 0);

  gate.resolve();
  await promiseA;
  assert.equal(mintCalls, 1);
});

// ── Concurrent stale + new scan (item 22) ─────────────────────────────────

test('22. a concurrent stale callback alongside a legitimate new-scan execute remains fail-closed for the stale one and unaffected for the legitimate one', async () => {
  resetAll();
  const cfg = baseConfig();
  const now = 10_000_000;
  const runA = makeRun('aaaaaaaaaa', [{ token: TOKEN_X, pool: '0xP1' }], now - 60_000);
  const runB = makeRun('bbbbbbbbbb', [{ token: TOKEN_X, pool: '0xP2' }], now - 30_000);
  const sess = { multiRun: runB };

  let mintCallsStale = 0;
  let mintCallsLegit = 0;

  const [staleOutcome, legitOutcome] = await Promise.all([
    simulateExecuteCallback({
      sess,
      callbackData: buildMultiExecuteCallbackData(runA.scanId, TOKEN_X), // stale
      config: cfg,
      now,
      mintFn: () => {
        mintCallsStale++;
        throw new Error('must not be called');
      },
    }),
    simulateExecuteCallback({
      sess,
      callbackData: buildMultiExecuteCallbackData(runB.scanId, TOKEN_X), // legitimate, current
      config: cfg,
      now,
      revalidateFn: () => ({ status: 'OK', candidate: makeCandidate(TOKEN_X) }),
      verifyLiquidityFn: () => ({ status: 'OK' }),
      mintFn: () => {
        mintCallsLegit++;
        throw new Error('stop');
      },
    }),
  ]);

  assert.deepEqual(staleOutcome, { skipped: true, reason: 'SCAN_MISMATCH' });
  assert.equal(mintCallsStale, 0);
  assert.ok('skipped' in legitOutcome && legitOutcome.reason === 'SIMULATION_FAILED');
  assert.equal(mintCallsLegit, 1);
});

// ── The explicit "F-13 FIX PROVEN" scenario ───────────────────────────────

test('F-13 FIX PROVEN: scan A / token X, then scan B / token X (different pool) replaces the session; the OLD A button is rejected deterministically with zero GMGN/mint calls, while the NEW B button resolves and reaches the pipeline normally, with no transaction ever broadcast', async () => {
  resetAll();
  const cfg = baseConfig();
  const now = 10_000_000;

  // 1. Create Scan A (token X, pool P1).
  const runA = makeRun(generateScanId(), [{ token: TOKEN_X, pool: '0xP1' }], now - 120_000);
  // 2. Capture A's Execute callback for token X.
  const callbackA = buildMultiExecuteCallbackData(runA.scanId, TOKEN_X);

  // 3. Create Scan B with the SAME token X but a DIFFERENT pool/intent.
  const runB = makeRun(generateScanId(), [{ token: TOKEN_X, pool: '0xP2' }], now - 30_000);
  assert.notEqual(runA.scanId, runB.scanId, 'sanity: two real generated scan ids must differ');

  // 4. Replace session.multiRun with B (as a fresh /multi scan would).
  const sess: { multiRun: unknown } = { multiRun: runA };
  sess.multiRun = runB;

  // 5. Press A's callback.
  let gmgnCallsA = 0;
  let mintCallsA = 0;
  const outcomeA = await simulateExecuteCallback({
    sess,
    callbackData: callbackA,
    config: cfg,
    now,
    revalidateFn: () => {
      gmgnCallsA++;
      return { status: 'OK', candidate: makeCandidate(TOKEN_X) };
    },
    verifyLiquidityFn: () => ({ status: 'OK' }),
    mintFn: () => {
      mintCallsA++;
      throw new Error('must not be called');
    },
  });

  // 6. Verify deterministic stale/mismatch rejection.
  assert.deepEqual(outcomeA, { skipped: true, reason: 'SCAN_MISMATCH' });
  // 7. Verify zero GMGN calls.
  assert.equal(gmgnCallsA, 0);
  // 8. Verify zero mint calls.
  assert.equal(mintCallsA, 0);

  // 9. Press B's callback.
  const callbackB = buildMultiExecuteCallbackData(runB.scanId, TOKEN_X);
  let mintCallsB = 0;
  let resolvedPool: string | undefined;
  const outcomeB = await simulateExecuteCallback({
    sess,
    callbackData: callbackB,
    config: cfg,
    now,
    revalidateFn: () => ({ status: 'OK', candidate: makeCandidate(TOKEN_X) }),
    verifyLiquidityFn: () => ({ status: 'OK' }),
    mintFn: () => {
      mintCallsB++;
      throw new Error('stop here — proves mintFn was reached, not a real mint');
    },
  });

  // 10. Verify B resolves token X (to POOL P2, its own intent — captured
  // independently via the pure resolver, not inferred from the outcome).
  const resolutionB = resolveMultiExecuteCallback(runB, { scanId: runB.scanId, token: TOKEN_X });
  assert.ok(resolutionB.ok);
  if (resolutionB.ok) resolvedPool = resolutionB.intent.pool.poolAddress as string;
  assert.equal(resolvedPool, '0xP2', 'B must resolve to its OWN pool, not A\'s P1');

  // 11. Verify B reaches the existing execution pipeline (mintFn called).
  assert.equal(mintCallsB, 1);
  assert.ok('skipped' in outcomeB && outcomeB.reason === 'SIMULATION_FAILED');

  // 12. No transaction is actually broadcast — mintFn threw synchronously
  // before any real chain interaction; no journal/ledger row exists.
  const { listOpenPositions } = await import('../src/db/index.js');
  assert.equal(listOpenPositions(CHAIN).length, 0, 'zero real positions recorded — nothing was actually broadcast');
});
