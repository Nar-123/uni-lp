/**
 * MULTI risk gate — Phase 4.
 *
 * Uses the real db/index.ts JSON-file store (scratch DB_PATH set up before
 * any db-touching import), same pattern as test/ledger.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multirisk-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, createTxJournalEntry, __resetStoreForTests } = await import(
  '../src/db/index.js'
);
const {
  checkDoubleEntry,
  checkPositionLimits,
  checkEntryCooldown,
  recordEntryCooldown,
  checkPendingTransaction,
  runRiskGate,
  __resetMultiCooldownForTests,
} = await import('../src/strategy/multiRisk.js');
const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

/**
 * __resetStoreForTests() only drops the in-memory cache and forces a reload
 * from the same on-disk DB_PATH file — it does not clear that file. Each
 * test in this suite needs a genuinely empty store (position counts / open
 * journal entries must not leak across cases), so also delete the file.
 *
 * Phase 4.6.1: persist() now also maintains `<path>.bak` (previous
 * generation) and, transiently, `<path>.tmp` sidecars for crash recovery.
 * Deleting only the primary is no longer enough to get a genuinely empty
 * store on the next load() — load() will correctly (and, outside tests,
 * desirably) recover from `.bak` instead of starting empty. Tests want the
 * opposite of crash recovery here, so all three must be removed.
 */
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

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: CHAIN,
    interval: '6h' as const,
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: null,
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
    ...overrides,
  };
}

function baseIntent(token: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

// ── Duplicate entry ───────────────────────────────────────────────────────

test('checkDoubleEntry: an existing open position on the same token blocks entry', () => {
  resetDb();
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
    strategy: 'default',
  });
  const result = checkDoubleEntry(CHAIN, token);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'DUPLICATE_POSITION');
});

test('checkDoubleEntry: no existing position passes', () => {
  resetDb();
  const result = checkDoubleEntry(CHAIN, freshToken());
  assert.equal(result.pass, true);
});

// ── Position limits ───────────────────────────────────────────────────────

test('checkPositionLimits: MULTI_MAX_OPEN_POSITIONS blocks once the cap is reached (scoped to strategy=multi only)', () => {
  resetDb();
  const cfg = baseConfig({ maxOpenPositions: 1 });
  recordOpenPosition({
    chainId: CHAIN,
    tokenId: 'pos-1',
    poolAddress: '0xpool',
    token0: USDG,
    token1: freshToken(),
    fee: 50_000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'multi',
  });
  const result = checkPositionLimits(cfg as never, CHAIN, freshToken());
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'POSITION_LIMIT');
});

test('checkPositionLimits: default-strategy open positions do not count against MULTI limits', () => {
  resetDb();
  const cfg = baseConfig({ maxOpenPositions: 1 });
  recordOpenPosition({
    chainId: CHAIN,
    tokenId: 'pos-1',
    poolAddress: '0xpool',
    token0: USDG,
    token1: freshToken(),
    fee: 50_000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'default',
  });
  const result = checkPositionLimits(cfg as never, CHAIN, freshToken());
  assert.equal(result.pass, true);
});

test('checkPositionLimits: MULTI_MAX_POSITIONS_PER_TOKEN blocks a second entry on the same token', () => {
  resetDb();
  const token = freshToken();
  const cfg = baseConfig({ maxOpenPositions: 5, maxPositionsPerToken: 1 });
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
  const result = checkPositionLimits(cfg as never, CHAIN, token);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'POSITION_LIMIT');
});

// ── Entry cooldown ────────────────────────────────────────────────────────

test('entry cooldown: blocks re-entry on the same token immediately after recording', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 300_000 });
  const token = freshToken();
  recordEntryCooldown(CHAIN, token);
  const result = checkEntryCooldown(CHAIN, token, cfg as never);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'ENTRY_COOLDOWN');
});

test('entry cooldown: a rejection never records a cooldown (retries are not penalized)', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 300_000 });
  const token = freshToken();
  // No recordEntryCooldown call — simulating a rejected attempt.
  const result = checkEntryCooldown(CHAIN, token, cfg as never);
  assert.equal(result.pass, true);
});

// ── Pending transaction ───────────────────────────────────────────────────

test('checkPendingTransaction: an unresolved journal entry on this chain blocks a new MULTI send', () => {
  resetDb();
  createTxJournalEntry({ chainId: CHAIN, wallet: '0xwallet', nonce: 1, action: 'mint' });
  const result = checkPendingTransaction(CHAIN);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'PENDING_TRANSACTION');
});

test('checkPendingTransaction: no unresolved entries passes', () => {
  resetDb();
  const result = checkPendingTransaction(CHAIN);
  assert.equal(result.pass, true);
});

// ── USDG re-validation inside runRiskGate ────────────────────────────────

test('runRiskGate: quoteToken mismatched with configured USDG contract is rejected NOT_USDG', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = baseConfig();
  const intent = baseIntent(freshToken(), { quoteToken: '0xdeadbeef00000000000000000000000000dead' });
  const results = await runRiskGate(intent as never, cfg as never);
  assert.ok(results.some((r) => !r.pass && r.reason === 'NOT_USDG'));
});

test('runRiskGate: an invalid range (lower >= upper) is rejected INVALID_RANGE', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = baseConfig();
  const intent = baseIntent(freshToken(), { range: { tickLower: 200, tickUpper: 100 } });
  const results = await runRiskGate(intent as never, cfg as never);
  assert.ok(results.some((r) => !r.pass && r.reason === 'INVALID_RANGE'));
});

test('runRiskGate: a fully valid intent with no conflicts passes every check', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = baseConfig();
  const intent = baseIntent(freshToken());
  const results = await runRiskGate(intent as never, cfg as never);
  assert.ok(results.every((r) => r.pass));
});
