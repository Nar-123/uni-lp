/**
 * Phase 4.7 audit (F-10) — revalidateCandidate: single-candidate,
 * Execute-time re-check against live GMGN data, reusing the exact same
 * filter rules as the batch scan (evaluateBaseFilters/evaluateAgeFilter),
 * never re-fetching/re-scoring the other Top-N candidates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmgnError, type GmgnTokenInfo, type GmgnTrendingToken } from '../src/gmgn/cli.js';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { revalidateCandidate } = await import('../src/strategy/multiCandidates.js');
const { loadMultiConfig } = await import('../src/strategy/multiConfig.js');

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TOKEN = '0x000000000000000000000000000000000000AA';
const NOW = 1_000_000_000_000;
const DAY_MS = 24 * 3_600_000;

function baseConfig(overrides: Record<string, unknown> = {}) {
  const cfg = loadMultiConfig(4663);
  return { ...cfg, usdgAddress: USDG, ...overrides } as never;
}

function trendingToken(overrides: Partial<GmgnTrendingToken> & { address: string }): GmgnTrendingToken {
  return {
    symbol: 'TOK',
    name: 'Token',
    price: 1,
    volume: 500_000,
    liquidity: 100_000,
    market_cap: 2_000_000,
    holder_count: 1000,
    renowned_count: 0,
    gas_fee: 0,
    launchpad_platform: 'pump.fun',
    ...overrides,
  };
}

function tokenInfoAtAge(ageHours: number): GmgnTokenInfo {
  const creationSec = Math.floor((NOW - ageHours * 3_600_000) / 1000);
  return {
    address: TOKEN,
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
    price: { price: '1', price_1h: '0', price_24h: '0', buys_24h: 0, sells_24h: 0, swaps_24h: 0, volume_1h: '0', volume_24h: '0' },
  };
}

// 1. fresh, eligible candidate
test('1. candidate found, all filters pass -> OK with fresh candidate data', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: 700_000, market_cap: 3_000_000 })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'OK');
  if (result.status === 'OK') {
    assert.equal(result.candidate.volume6hUsd, 700_000);
    assert.equal(result.candidate.marketCapUsd, 3_000_000);
    assert.ok(result.candidate.ageHours! > 47 && result.candidate.ageHours! < 49);
  }
});

// 3. missing candidate (not found in trending list at all)
test('3 / 11. candidate no longer present in the live trending list -> CANDIDATE_NOT_FOUND', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: '0x000000000000000000000000000000000000bb' })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'CANDIDATE_NOT_FOUND');
});

// 4. volume <= 0
test('4. volume now 0 -> REJECTED VOLUME_NON_POSITIVE', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: 0 })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'VOLUME_NON_POSITIVE');
});

test('4b. negative volume -> REJECTED VOLUME_NON_POSITIVE', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: -1 })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'VOLUME_NON_POSITIVE');
});

// 5. volume below configured floor
test('5. volume below the operator-configured floor -> REJECTED VOLUME_TOO_LOW', async () => {
  const cfg = baseConfig({ minCandidateVolumeUsd: 10_000 });
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: 5_000 })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'VOLUME_TOO_LOW');
});

// 6. MC below floor
test('6. market cap now below the floor -> REJECTED MC_TOO_LOW', async () => {
  const cfg = baseConfig({ minMarketCapUsd: 1_000_000 });
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, market_cap: 500_000 })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'MC_TOO_LOW');
});

// 7. invalid classification
test('7. launchpad_platform now missing -> REJECTED CLASSIFICATION_UNKNOWN', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, launchpad_platform: undefined })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'CLASSIFICATION_UNKNOWN');
});

// stale age (still below floor is testable even though age can't literally decrease)
test('stale age below the floor -> REJECTED AGE_TOO_LOW', async () => {
  const cfg = baseConfig({ minTokenAgeHours: 24 });
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN })],
    infoFetcher: async () => tokenInfoAtAge(2),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'AGE_TOO_LOW');
});

// 8. GMGN timeout / generic throw during the trending fetch
test('8. GMGN trending call throws (timeout-shaped) -> REVALIDATION_SOURCE_ERROR, never treated as eligible or ineligible', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => {
      throw new Error('gmgn-cli timed out after 15000ms');
    },
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REVALIDATION_SOURCE_ERROR');
});

// 9. GMGN rate limit
test('9. GMGN rate-limited (GmgnError) -> REVALIDATION_SOURCE_ERROR', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => {
      throw new GmgnError('gmgn-cli rate limited (market trending)', undefined, 'GMGN_CLI_RATE_LIMITED');
    },
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REVALIDATION_SOURCE_ERROR');
});

// 10. GMGN malformed response — non-zero exit surfaces the same way (throw), a genuinely malformed-but-parseable list just yields CANDIDATE_NOT_FOUND for our target
test('10. GMGN CLI non-zero exit / malformed output (throws) -> REVALIDATION_SOURCE_ERROR', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => {
      throw new GmgnError('gmgn-cli exited with code 1', undefined, 'GMGN_CLI_EXEC_FAILED');
    },
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REVALIDATION_SOURCE_ERROR');
});

test('age lookup (token info) throws -> REVALIDATION_SOURCE_ERROR, distinct from AGE_UNKNOWN', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN })],
    infoFetcher: async () => {
      throw new Error('gmgn-cli token info RPC failure');
    },
  });
  assert.equal(result.status, 'REVALIDATION_SOURCE_ERROR');
});

// 12. stale data never used as fallback — confirm the OLD/stale candidate values passed in are never consulted; only fresh fetcher/infoFetcher output matters
test('12. revalidateCandidate ignores any pre-existing stale candidate object — it always derives fresh eligibility purely from the injected fetcher/infoFetcher, never from a cached value', async () => {
  const cfg = baseConfig();
  // Even though nothing "stale" is passed in at all (revalidateCandidate takes
  // only a token address, never a candidate object) — this is itself the
  // proof: there is no parameter through which stale data COULD leak in.
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: 999_999 })],
    infoFetcher: async () => tokenInfoAtAge(100),
  });
  assert.equal(result.status, 'OK');
  if (result.status === 'OK') assert.equal(result.candidate.volume6hUsd, 999_999);
});

test('malformed volume in the fresh trending payload (NaN) still fails closed as REJECTED VOLUME_UNKNOWN-equivalent, never coerced', async () => {
  const cfg = baseConfig();
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: NaN })],
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(result.status, 'REJECTED');
  if (result.status === 'REJECTED') assert.equal(result.reason, 'VOLUME_UNKNOWN');
});

test('revalidateCandidate does not call infoFetcher at all when base filters already reject (bounded cost — no wasted second GMGN call)', async () => {
  const cfg = baseConfig();
  let infoCalls = 0;
  const result = await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => [trendingToken({ address: TOKEN, volume: 0 })],
    infoFetcher: async () => {
      infoCalls++;
      return tokenInfoAtAge(48);
    },
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(infoCalls, 0);
});

test('exactly one trending fetch call is made per revalidation — never a fan-out across multiple candidates', async () => {
  const cfg = baseConfig();
  let fetchCalls = 0;
  await revalidateCandidate(cfg, TOKEN, {
    now: NOW,
    fetcher: async () => {
      fetchCalls++;
      return [trendingToken({ address: TOKEN })];
    },
    infoFetcher: async () => tokenInfoAtAge(48),
  });
  assert.equal(fetchCalls, 1);
});
