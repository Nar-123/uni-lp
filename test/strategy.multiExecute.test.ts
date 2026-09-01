/**
 * MULTI execution boundary + dry-run + duplicate-entry — Phase 4.
 *
 * Two kinds of coverage here:
 *
 * 1. Static execution-boundary check (spec §16/§17): every strategy/*.ts
 *    source file is scanned to prove MULTI never references
 *    sendTransaction/writeContract/a wallet client directly — all execution
 *    must go through the injected `mintFn` (which defaults to the existing
 *    hardened mintSingleSided).
 *
 * 2. Behavioral tests using a spy `mintFn` to prove: dry-run never invokes
 *    it (tx count stays 0), a blocked risk gate never invokes it, and a
 *    pending unresolved transaction blocks the whole run before any
 *    candidate is even fetched.
 *
 * The full mint happy-path (real getTokenPriceUsd/getTokenMeta calls) needs
 * live RPC/price-API access and is intentionally NOT unit-tested here to
 * avoid a flaky network-dependent test — that path is covered by manual
 * dry-run verification and by tracing the call graph (multiExecute.ts ->
 * mintFn -> mintSingleSided, the same function manual mints use).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multiexec-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { createTxJournalEntry, __resetStoreForTests } = await import('../src/db/index.js');
const { executeTradeIntent, runMultiStrategy } = await import('../src/strategy/multiExecute.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');

/**
 * __resetStoreForTests() only drops the in-memory cache and reloads from the
 * same on-disk DB_PATH file — it does not clear it. Delete the file too so
 * each test gets a genuinely empty store (open positions / journal entries
 * must not leak across cases in this suite).
 */
function resetDb(): void {
  __resetStoreForTests();
  try {
    fs.rmSync(process.env.DB_PATH!, { force: true });
  } catch {
    /* ignore */
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

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

// ── Static execution boundary scan ───────────────────────────────────────

const FORBIDDEN_PATTERNS = [
  /\bsendTransaction\s*\(/,
  /\bwriteContract\s*\(/,
  /walletClient\s*\./,
  /\bgetWalletClient\s*\(/,
];

test('execution boundary: no strategy/*.ts file references a raw broadcast call or wallet client directly', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const strategyDir = path.join(here, '..', 'src', 'strategy');
  const files = fs.readdirSync(strategyDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'sanity check: strategy dir must not be empty');

  const offenders: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(strategyDir, file), 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `MULTI must never call these directly: ${offenders.join(', ')}`);
});

test('execution boundary: multiExecute.ts routes every mint through the injectable mintFn, defaulting to mintSingleSided', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'strategy', 'multiExecute.ts'), 'utf8');
  assert.match(src, /mintFn\s*=\s*params\.mintFn\s*\?\?\s*mintSingleSided/);
  assert.match(src, /await\s+mintFn\(/);
});

// ── Behavioral: mintFn is a spy, no real network/RPC ─────────────────────

test('dry-run: runMultiStrategy never invokes mintFn and reports zero executed transactions', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = baseConfig();
  let mintCalls = 0;
  const token = freshToken();

  const run = await runMultiStrategy(cfg as never, {
    dryRun: true,
    now: Date.now(),
    fetcher: async () => [
      {
        address: token,
        symbol: 'TOK',
        name: 'Token',
        price: 1,
        volume: 500_000,
        liquidity: 200_000,
        market_cap: 2_000_000,
        holder_count: 1000,
        renowned_count: 0,
        gas_fee: 0,
        launchpad_platform: 'pump.fun',
      },
    ],
    infoFetcher: async () => ({
      address: token,
      symbol: 'TOK',
      name: 'Token',
      decimals: 18,
      holder_count: 1000,
      total_supply: '0',
      circulating_supply: '0',
      liquidity: '0',
      total_fee: '0',
      trade_fee: '0',
      biggest_pool_address: '0x0',
      creation_timestamp: Math.floor((Date.now() - 48 * 3_600_000) / 1000),
      open_timestamp: Math.floor((Date.now() - 48 * 3_600_000) / 1000),
      launchpad: 'pump.fun',
      price: {
        price: '1',
        price_1h: '0',
        price_24h: '0',
        buys_24h: 0,
        sells_24h: 0,
        swaps_24h: 0,
        volume_1h: '0',
        volume_24h: '0',
      },
    }),
    poolFetcher: async () => [
      {
        protocol: 'v3',
        dex: 'uniswap',
        pair: { chainId: '4663', dexId: 'uniswap', pairAddress: '0xpool', volume: { h24: 50_000 } } as never,
        poolAddress: '0xpool',
        fee: 50_000,
        tvlUsd: 100_000,
        token0: USDG as `0x${string}`,
        token1: token as `0x${string}`,
        otherSymbol: 'TOK',
        otherAddress: token as `0x${string}`,
        label: 'pool',
      },
    ],
    mintFn: async () => {
      mintCalls++;
      throw new Error('mintFn must never be called during dry-run');
    },
  });

  assert.equal(mintCalls, 0);
  assert.equal(run.executed.length, 0);
  assert.equal(run.dryRun, true);
});

test('executeTradeIntent: a duplicate-position risk-gate failure skips execution without invoking mintFn', async () => {
  resetDb();
  __resetMultiCooldownForTests();
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

  let mintCalls = 0;
  const cfg = baseConfig();
  const intent = baseIntent(token);
  const outcome = await executeTradeIntent({
    intent: intent as never,
    candidate: baseCandidate(token) as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('must not be called');
    },
  });

  assert.equal(mintCalls, 0);
  assert.ok('skipped' in outcome && outcome.skipped);
  if ('skipped' in outcome) assert.equal(outcome.reason, 'DUPLICATE_POSITION');
});

test('executeTradeIntent: NOT_USDG risk-gate failure skips execution without invoking mintFn', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = baseConfig();
  const token = freshToken();
  const intent = baseIntent(token, { quoteToken: '0xdeadbeef00000000000000000000000000dead' });

  let mintCalls = 0;
  const outcome = await executeTradeIntent({
    intent: intent as never,
    candidate: baseCandidate(token) as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    mintFn: async () => {
      mintCalls++;
      throw new Error('must not be called');
    },
  });

  assert.equal(mintCalls, 0);
  assert.ok('skipped' in outcome && outcome.skipped);
});

test('live run: an unresolved pending transaction blocks the entire strategy run before fetching any candidates', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  createTxJournalEntry({ chainId: CHAIN, wallet: '0xwallet', nonce: 1, action: 'mint' });

  const cfg = baseConfig();
  let fetcherCalled = false;
  let mintCalls = 0;
  const run = await runMultiStrategy(cfg as never, {
    dryRun: false,
    fetcher: async () => {
      fetcherCalled = true;
      return [];
    },
    mintFn: async () => {
      mintCalls++;
      throw new Error('must not be called');
    },
  });

  assert.equal(fetcherCalled, false, 'a pending unresolved tx must block before candidate fetch, not after');
  assert.equal(mintCalls, 0);
  assert.equal(run.executed.length, 0);
});

test('disabled MULTI config (no usdgAddress) never fetches candidates or executes anything', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ usdgAddress: null, enabled: false });
  let called = false;
  const run = await runMultiStrategy(cfg as never, {
    dryRun: false,
    fetcher: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(called, false);
  assert.equal(run.candidates.length, 0);
  assert.equal(run.executed.length, 0);
});
