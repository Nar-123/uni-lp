/**
 * MULTI pool discovery + scoring — Phase 4.
 *
 * Verifies: USDG validated by contract address (not symbol), only actually-
 * available preferred fee tiers are ever selected (never forced/manufactured),
 * TVL/volume/volume-per-TVL/fee all contribute to scoring, and pool ranking
 * is deterministic (never "TVL alone").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverAndScorePoolsForCandidate,
  scoreMultiPool,
} from '../src/strategy/multiPool.js';
import type { MultiConfig } from '../src/strategy/multiConfig.js';
import type { MultiCandidate } from '../src/strategy/types.js';
import type { ListedPool } from '../src/chain/pools.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const OTHER_STABLE_SAME_SYMBOL = '0x1111111111111111111111111111111111111111'; // "USDG"-labelled but wrong contract
const TOKEN = '0x2222222222222222222222222222222222222222';

function baseConfig(overrides: Partial<MultiConfig> = {}): MultiConfig {
  return {
    enabled: true,
    chainId: 4663,
    interval: '6h',
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: null,
    usdgAddress: USDG as `0x${string}`,
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

function candidate(): MultiCandidate {
  return {
    address: TOKEN,
    symbol: 'TOK',
    name: 'Token',
    chainId: 4663,
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

function pool(overrides: Partial<ListedPool> & { poolAddress: string }): ListedPool {
  return {
    protocol: 'v3',
    dex: 'uniswap',
    pair: { chainId: '4663', dexId: 'uniswap', pairAddress: overrides.poolAddress } as ListedPool['pair'],
    fee: 50_000,
    tvlUsd: 100_000,
    token0: USDG as `0x${string}`,
    token1: TOKEN as `0x${string}`,
    otherSymbol: 'TOK',
    otherAddress: TOKEN as `0x${string}`,
    label: 'pool',
    ...overrides,
  };
}

// ── USDG validated by contract address, not symbol ───────────────────────

test('USDG address: a pool paired with a different contract (even if it were labelled USDG) is rejected NOT_USDG', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xpoolA', token0: OTHER_STABLE_SAME_SYMBOL as `0x${string}`, token1: TOKEN as `0x${string}` }),
  ];
  const { pools, selected, rejected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(pools.length, 0);
  assert.equal(selected, null);
  assert.equal(rejected[0].reason, 'NOT_USDG');
});

test('USDG address: matches case-insensitively and works as either token0 or token1', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xpoolA', token0: TOKEN as `0x${string}`, token1: USDG.toUpperCase() as `0x${string}` }),
  ];
  const { selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.ok(selected);
  assert.equal(selected!.poolAddress, '0xpoolA');
});

test('no usdgAddress configured: discovery is disabled entirely, no fetcher call', async () => {
  const cfg = baseConfig({ usdgAddress: null });
  let called = false;
  const { pools, selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(pools.length, 0);
  assert.equal(selected, null);
  assert.equal(called, false);
});

// ── Fee tier availability: never forced ──────────────────────────────────

test('fee tier: only actually-listed preferred tiers (5%/4%/3%) are selected', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xpoolA', fee: 40_000, tvlUsd: 50_000 }),
  ];
  const { selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.ok(selected);
  assert.equal(selected!.fee, 40_000);
});

test('fee tier: an unsupported/unavailable tier is never substituted or forced — pool is rejected', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xpoolA', fee: 3_000, tvlUsd: 500_000 }), // standard 0.3% tier, not in MULTI's preferred set
  ];
  const { selected, rejected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(selected, null);
  assert.equal(rejected[0].reason, 'FEE_TIER_NOT_SUPPORTED');
});

test('fee tier: null/unknown fee is rejected, never coerced to a default tier', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [pool({ poolAddress: '0xpoolA', fee: null })];
  const { selected, rejected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(selected, null);
  assert.equal(rejected[0].reason, 'FEE_TIER_NOT_SUPPORTED');
});

test('fee preference order: when multiple preferred tiers are all available, 5% scores highest', () => {
  const cfg = baseConfig();
  const p5 = scoreMultiPool(pool({ poolAddress: '0xa', fee: 50_000, tvlUsd: 100_000 }), cfg);
  const p4 = scoreMultiPool(pool({ poolAddress: '0xb', fee: 40_000, tvlUsd: 100_000 }), cfg);
  const p3 = scoreMultiPool(pool({ poolAddress: '0xc', fee: 30_000, tvlUsd: 100_000 }), cfg);
  assert.ok(p5.feeScore > p4.feeScore);
  assert.ok(p4.feeScore > p3.feeScore);
});

// ── TVL gate ──────────────────────────────────────────────────────────────

test('TVL below the minimum is rejected as TVL_TOO_LOW', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [pool({ poolAddress: '0xpoolA', tvlUsd: 100 })];
  const { selected, rejected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(selected, null);
  assert.equal(rejected[0].reason, 'TVL_TOO_LOW');
});

// ── Scoring incorporates TVL + volume + volume/TVL + fee, not TVL alone ──

test('pool scoring: higher volume/TVL ratio outranks a pool that only wins on raw TVL', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({
      poolAddress: '0xhighTvlLowTurnover',
      fee: 50_000,
      tvlUsd: 500_000,
      pair: { chainId: '4663', dexId: 'uniswap', pairAddress: '0xhighTvlLowTurnover', volume: { h24: 1_000 } } as ListedPool['pair'],
    }),
    pool({
      poolAddress: '0xlowerTvlHighTurnover',
      fee: 50_000,
      tvlUsd: 200_000,
      pair: { chainId: '4663', dexId: 'uniswap', pairAddress: '0xlowerTvlHighTurnover', volume: { h24: 400_000 } } as ListedPool['pair'],
    }),
  ];
  const { selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(selected!.poolAddress, '0xlowerTvlHighTurnover');
});

test('pool scoring: missing volume/TVL data scores 0 for that dimension rather than throwing or faking a value', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(
    pool({
      poolAddress: '0xa',
      tvlUsd: null as unknown as number,
      pair: { chainId: '4663', dexId: 'uniswap', pairAddress: '0xa' } as ListedPool['pair'],
    }),
    cfg,
  );
  assert.equal(scored.tvlScore, 0);
  assert.equal(scored.volumeScore, 0);
  assert.equal(scored.volumeTvlScore, 0);
  assert.ok(Number.isFinite(scored.totalScore));
});

test('pool ranking tie-break is deterministic (score -> tvl -> volume -> address), not selection order', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xbbbb', fee: 50_000, tvlUsd: 100_000 }),
    pool({ poolAddress: '0xaaaa', fee: 50_000, tvlUsd: 100_000 }),
  ];
  const { selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(selected!.poolAddress, '0xaaaa', 'identical scores tie-break to the lexicographically lower address');
});

test('pool discovery fetch failure fails closed: no pools, no crash', async () => {
  const cfg = baseConfig();
  const { pools, selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => {
      throw new Error('rpc down');
    },
  });
  assert.equal(pools.length, 0);
  assert.equal(selected, null);
});
