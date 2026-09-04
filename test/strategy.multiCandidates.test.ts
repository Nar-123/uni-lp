/**
 * MULTI candidate filtering — Phase 4.
 *
 * Verifies the mandatory filter order (data validation -> MC -> age ->
 * classification -> volume ranking -> top N) and that UNKNOWN critical data
 * always fails closed with a specific reason code rather than being
 * coerced to 0/pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndFilterCandidates } from '../src/strategy/multiCandidates.js';
import type { MultiConfig } from '../src/strategy/multiConfig.js';
import type { GmgnTokenInfo, GmgnTrendingToken } from '../src/gmgn/cli.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

function baseConfig(overrides: Partial<MultiConfig> = {}): MultiConfig {
  return {
    enabled: true,
    chainId: 4663,
    interval: '6h',
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    minCandidateVolumeUsd: 0,
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

function token(overrides: Partial<GmgnTrendingToken> & { address: string }): GmgnTrendingToken {
  return {
    symbol: overrides.symbol ?? 'TOK',
    name: overrides.name ?? 'Token',
    price: 1,
    volume: 100_000,
    liquidity: 50_000,
    market_cap: 2_000_000,
    holder_count: 1000,
    renowned_count: 0,
    gas_fee: 0,
    launchpad_platform: 'pump.fun',
    ...overrides,
  };
}

const NOW = 1_000_000_000_000;
const DAY_MS = 24 * 3_600_000;

function infoAtAge(ageHours: number): GmgnTokenInfo {
  const creationSec = Math.floor((NOW - ageHours * 3_600_000) / 1000);
  return {
    address: '0x0',
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
    creation_timestamp: creationSec,
    open_timestamp: creationSec,
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
  };
}

// ── Market cap boundary ──────────────────────────────────────────────────

test('MC boundary: exactly at the minimum passes', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', market_cap: 1_000_000 });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(rejected.length, 0);
  assert.equal(candidates.length, 1);
});

test('MC boundary: just below the minimum is rejected as MC_TOO_LOW', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', market_cap: 999_999.99 });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rejectedReason, 'MC_TOO_LOW');
});

test('UNKNOWN market cap fails closed as MC_UNKNOWN, never coerced to 0/pass', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', market_cap: undefined as unknown as number });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'MC_UNKNOWN');
});

// ── Age boundary ─────────────────────────────────────────────────────────

test('age boundary: exactly at the minimum passes', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa' });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(24),
    now: NOW,
  });
  assert.equal(rejected.length, 0);
  assert.equal(candidates.length, 1);
});

test('age boundary: just below the minimum is rejected as AGE_TOO_LOW', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa' });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(23.99),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'AGE_TOO_LOW');
});

test('UNKNOWN age (info fetch fails) fails closed as AGE_UNKNOWN, never treated as passing', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa' });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => null,
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'AGE_UNKNOWN');
});

test('UNKNOWN age (info fetch throws) also fails closed as AGE_UNKNOWN', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa' });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => {
      throw new Error('rpc down');
    },
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'AGE_UNKNOWN');
});

// ── Classification ───────────────────────────────────────────────────────

test('missing launchpad_platform classifies UNKNOWN and is rejected, never inferred from name/ticker', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', launchpad_platform: undefined, name: 'DogeMoonPumpMeme' });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'CLASSIFICATION_UNKNOWN');
  assert.equal(rejected[0].classification, 'UNKNOWN');
});

test('present launchpad_platform classifies MEME', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', launchpad_platform: 'pump.fun' });
  const { candidates } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates[0].classification, 'MEME');
});

// ── Volume UNKNOWN ───────────────────────────────────────────────────────

test('UNKNOWN volume fails closed as VOLUME_UNKNOWN', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', volume: undefined as unknown as number });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'VOLUME_UNKNOWN');
});

test('malformed volume (NaN) fails closed as VOLUME_UNKNOWN, not coerced to a number', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', volume: NaN });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'VOLUME_UNKNOWN');
});

test('malformed volume (Infinity) fails closed as VOLUME_UNKNOWN', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', volume: Infinity });
  const { rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(rejected[0].rejectedReason, 'VOLUME_UNKNOWN');
});

test('malformed volume (wrong type — a string, as a genuinely malformed API response might send) fails closed as VOLUME_UNKNOWN, never parsed/coerced', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', volume: '500000' as unknown as number });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'VOLUME_UNKNOWN');
});

// ── F-07: minimum candidate volume (Phase 4.7 audit) ─────────────────────

test('F-07 A: exactly $0 volume fails closed as VOLUME_NON_POSITIVE, even with no configured floor', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 0 });
  const t = token({ address: '0xaaa', volume: 0 });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'VOLUME_NON_POSITIVE');
});

test('F-07: negative volume (corrupt/impossible data) fails closed as VOLUME_NON_POSITIVE — this previously slipped through as a valid finite number', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 0 });
  const t = token({ address: '0xaaa', volume: -500 });
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected[0].rejectedReason, 'VOLUME_NON_POSITIVE');
});

test('F-07 C/D: normal positive volume with the floor disabled (default) is never rejected on volume grounds', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 0 });
  const t = token({ address: '0xaaa', volume: 1 }); // smallest possible positive volume
  const { candidates } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 1, 'a positive volume of any size must pass when no operator floor is configured');
});

test('F-07: an operator-configured MULTI_MIN_CANDIDATE_VOLUME_USD floor rejects below-floor candidates as VOLUME_TOO_LOW', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 10_000 });
  const tokens: GmgnTrendingToken[] = [
    token({ address: '0x01', volume: 9_999 }), // just under the floor
    token({ address: '0x02', volume: 10_000 }), // exactly at the floor — passes (floor is exclusive-below)
  ];
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => tokens,
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.ok(rejected.some((r) => r.address === '0x01' && r.rejectedReason === 'VOLUME_TOO_LOW'));
  assert.ok(candidates.some((c) => c.address === '0x02'));
});

test('F-07: the configured floor never rejects on market cap/age/classification grounds instead — reason codes stay distinct', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 10_000 });
  const t = token({ address: '0xaaa', volume: 1, market_cap: 2_000_000 }); // fails volume floor only
  const { rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(rejected[0].rejectedReason, 'VOLUME_TOO_LOW');
});

test('F-07: deterministic sorting and Top N behavior are unaffected by the new floor when all survivors clear it', async () => {
  const cfg = baseConfig({ topN: 2, minCandidateVolumeUsd: 100 });
  const tokens: GmgnTrendingToken[] = [
    token({ address: '0x01', volume: 100_000 }),
    token({ address: '0x02', volume: 900_000 }),
    token({ address: '0x03', volume: 500_000 }),
  ];
  const { candidates } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => tokens,
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => c.address),
    ['0x02', '0x03'],
    'sorting/topN must remain volume-descending and unaffected by an easily-cleared floor',
  );
});

test('F-07 K: an extremely large configured minimum deterministically rejects every candidate as VOLUME_TOO_LOW, no crash/overflow/NaN', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 1_000_000_000_000 });
  const tokens: GmgnTrendingToken[] = [
    token({ address: '0x01', volume: 900_000 }),
    token({ address: '0x02', volume: 50_000_000 }),
  ];
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => tokens,
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 0);
  assert.ok(rejected.every((r) => r.rejectedReason === 'VOLUME_TOO_LOW'));
});

test('F-07 K: a non-finite (Infinity) MULTI_MIN_CANDIDATE_VOLUME_USD is impossible via envNum\'s existing finiteness guard — falls back to the 0 default rather than rejecting everything', async () => {
  process.env.MULTI_MIN_CANDIDATE_VOLUME_USD = '1e400'; // parses to Infinity
  try {
    const { loadMultiConfig } = await import('../src/strategy/multiConfig.js');
    const cfg = loadMultiConfig(4663);
    assert.equal(cfg.minCandidateVolumeUsd, 0, 'envNum must fall back to the default, not silently accept Infinity');
    assert.equal(cfg.enabled, true);
  } finally {
    delete process.env.MULTI_MIN_CANDIDATE_VOLUME_USD;
  }
});

test('F-07: a very large (implausibly high) volume is not rejected by this fix — no upper bound was added, by design (no defensible threshold exists yet)', async () => {
  const cfg = baseConfig();
  const t = token({ address: '0xaaa', volume: 50_000_000_000 });
  const { candidates } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [t],
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 1);
});

// ── Filter-before-top10 + volume sorting ─────────────────────────────────

test('filtering happens before top N: a high-volume token that fails MC never occupies a top-N slot', async () => {
  const cfg = baseConfig({ topN: 2 });
  const tokens: GmgnTrendingToken[] = [
    token({ address: '0x01', volume: 1_000_000, market_cap: 500_000 }), // fails MC, would be #1 by volume
    token({ address: '0x02', volume: 500_000, market_cap: 2_000_000 }),
    token({ address: '0x03', volume: 400_000, market_cap: 2_000_000 }),
    token({ address: '0x04', volume: 300_000, market_cap: 2_000_000 }),
  ];
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => tokens,
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 2);
  assert.ok(!candidates.some((c) => c.address === '0x01'), 'MC-failing candidate must never reach top N');
  assert.equal(candidates[0].address, '0x02');
  assert.equal(candidates[1].address, '0x03');
  assert.ok(rejected.some((r) => r.address === '0x01' && r.rejectedReason === 'MC_TOO_LOW'));
});

test('volume sorting: survivors are ranked by volume6h descending, not by fetch order', async () => {
  const cfg = baseConfig({ topN: 10 });
  const tokens: GmgnTrendingToken[] = [
    token({ address: '0x01', volume: 100_000 }),
    token({ address: '0x02', volume: 900_000 }),
    token({ address: '0x03', volume: 500_000 }),
  ];
  const { candidates } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => tokens,
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => c.address),
    ['0x02', '0x03', '0x01'],
  );
});

test('top N: only the configured count survives even when more pass every filter', async () => {
  const cfg = baseConfig({ topN: 2 });
  const tokens: GmgnTrendingToken[] = [
    token({ address: '0x01', volume: 100 }),
    token({ address: '0x02', volume: 200 }),
    token({ address: '0x03', volume: 300 }),
  ];
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => tokens,
    infoFetcher: async () => infoAtAge(48),
    now: NOW,
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => c.address),
    ['0x03', '0x02'],
  );
  assert.ok(rejected.length === 0, 'the 3rd candidate is simply not in top N, not "rejected" with a filter reason');
});

// ── Fetch failure fails closed ───────────────────────────────────────────

test('candidate source fetch failure returns no candidates and does not throw', async () => {
  const cfg = baseConfig();
  const { candidates, rejected } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => {
      throw new Error('GMGN unreachable');
    },
  });
  assert.equal(candidates.length, 0);
  assert.equal(rejected.length, 0);
});

test('candidate-source failure is distinguishable from a genuinely empty result (never silently collapsed together)', async () => {
  const cfg = baseConfig();

  const failed = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => {
      throw new Error('GMGN unreachable');
    },
  });
  assert.equal(failed.candidates.length, 0);
  assert.ok(failed.sourceError, 'a source failure must set sourceError');
  assert.equal(failed.sourceError!.code, 'CANDIDATE_SOURCE_UNKNOWN_ERROR');

  const genuinelyEmpty = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => [], // the source responded fine, there's just nothing trending right now
  });
  assert.equal(genuinelyEmpty.candidates.length, 0);
  assert.equal(genuinelyEmpty.sourceError, undefined, 'a genuinely empty (but successful) fetch must NOT set sourceError');
});

test('a GmgnError from the CLI layer propagates its specific error code into sourceError', async () => {
  const { GmgnError } = await import('../src/gmgn/cli.js');
  const cfg = baseConfig();
  const { candidates, sourceError } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => {
      throw new GmgnError('gmgn-cli not found', undefined, 'GMGN_CLI_NOT_FOUND');
    },
  });
  assert.equal(candidates.length, 0);
  assert.equal(sourceError?.code, 'GMGN_CLI_NOT_FOUND');
  assert.match(sourceError!.message, /not found/);
});

test('disabled config returns no candidates without calling the fetcher', async () => {
  const cfg = baseConfig({ enabled: false });
  let called = false;
  const { candidates } = await fetchAndFilterCandidates(cfg, {
    fetcher: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(candidates.length, 0);
  assert.equal(called, false);
});
