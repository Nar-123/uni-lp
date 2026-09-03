/**
 * Phase 4.6.7 — scoreMultiPool NaN/Infinity hardening.
 *
 * scoreMultiPool's tvlUsd/volumeUsd inputs originate from an external API
 * response cast with `as` (dexscreener.ts) — nothing at runtime guarantees
 * they are actually finite, non-negative numbers. This file proves that a
 * present-but-corrupt value (NaN/Infinity/-Infinity/negative/malformed) can
 * never produce a score that reaches ranking or selection, while every
 * pre-existing valid-data behavior (including absent-field handling, the
 * formula itself, and tie-break ordering) is byte-for-byte unchanged.
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

function pool(
  overrides: Partial<ListedPool> & { poolAddress: string },
  volumeH24?: number,
): ListedPool {
  return {
    protocol: 'v3',
    dex: 'uniswap',
    pair: {
      chainId: '4663',
      dexId: 'uniswap',
      pairAddress: overrides.poolAddress,
      ...(volumeH24 !== undefined ? { volume: { h24: volumeH24 } } : {}),
    } as ListedPool['pair'],
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

// ── 1. Valid finite inputs → identical score to the pre-fix formula ──────

test('valid finite inputs: score matches the exact pre-existing formula (regression pin)', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: 100_000, fee: 50_000 }), cfg);
  // tvlScore = min(1, 100000/100000) = 1; volumeScore/volumeTvlScore = 0 (no volume); feeScore = 1.0
  // totalScore = 1*0.3 + 0*0.3 + 0*0.25 + 1.0*0.15 = 0.45
  assert.equal(scored.tvlScore, 1);
  assert.equal(scored.volumeScore, 0);
  assert.equal(scored.volumeTvlScore, 0);
  assert.equal(scored.feeScore, 1.0);
  assert.ok(Math.abs(scored.totalScore - (1 * 0.3 + 1.0 * 0.15)) < 1e-12, 'exact pre-existing weighted-sum formula, modulo float rounding');
  assert.deepEqual(scored.rejectedReasons, []);
});

// ── 2-7. Invalid numeric inputs are rejected, never silently zeroed-and-accepted ──

test('NaN tvlUsd is rejected, not silently scored as 0', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: NaN }), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_TVL_INPUT'));
  assert.ok(Number.isFinite(scored.totalScore), 'even the placeholder score must be finite');
});

test('Infinity tvlUsd is rejected (bypasses the TVL_TOO_LOW gate but not this one)', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: Infinity }), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_TVL_INPUT'));
  assert.ok(Number.isFinite(scored.totalScore));
});

test('-Infinity tvlUsd is rejected', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: -Infinity }), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_TVL_INPUT'));
  assert.ok(Number.isFinite(scored.totalScore));
});

test('Infinity volumeUsd (h24) is rejected — no pre-existing gate covers this field at all', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa' }, Infinity), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_VOLUME_INPUT'));
  assert.ok(Number.isFinite(scored.totalScore));
});

test('-Infinity volumeUsd is rejected', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa' }, -Infinity), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_VOLUME_INPUT'));
});

test('NaN volumeUsd is rejected', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa' }, NaN), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_VOLUME_INPUT'));
});

test('negative tvlUsd is rejected (TVL cannot be negative)', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: -500 }), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_TVL_INPUT'));
});

test('negative volumeUsd is rejected (24h volume cannot be negative)', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa' }, -1), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_VOLUME_INPUT'));
});

test('malformed (non-numeric) tvlUsd reaching the function at runtime is rejected', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(
    pool({ poolAddress: '0xa', tvlUsd: 'not-a-number' as unknown as number }),
    cfg,
  );
  assert.ok(scored.rejectedReasons.includes('INVALID_TVL_INPUT'));
});

// ── 8-10. Zero and absent data remain valid — preserve existing semantics ──

test('zero volume with positive TVL is valid (0/TVL = 0, not undefined)', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: 100_000 }, 0), cfg);
  assert.deepEqual(scored.rejectedReasons, []);
  assert.equal(scored.volumeScore, 0);
  assert.equal(scored.volumeTvlScore, 0);
  assert.ok(Number.isFinite(scored.totalScore));
});

test('zero TVL is valid data, not corrupt — the volume/TVL guard already prevents 0/0 without needing rejection', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: 0 }, 10_000), cfg);
  assert.deepEqual(scored.rejectedReasons, []);
  assert.equal(scored.tvlScore, 0);
  assert.equal(scored.volumeTvlScore, 0, 'volume/TVL guarded by tvlUsd > 0, never divides by zero');
  assert.ok(Number.isFinite(scored.totalScore));
});

test('absent (null) tvlUsd/volumeUsd remain valid-and-zero, not rejected — preserves the pre-existing, already-tested UNKNOWN-data contract', () => {
  // This is a deliberate divergence from a generic "undefined critical input -> rejected"
  // template: this codebase's own pre-existing contract (see
  // test/strategy.multiPool.test.ts's "missing volume/TVL data scores 0 ...") treats an
  // absent field as legitimately-unknown-but-safe (0 contribution), never as corrupt data.
  // Rejecting it here would violate the "preserve valid score/ranking semantics exactly"
  // requirement and break that pre-existing, still-passing test.
  const cfg = baseConfig();
  const scored = scoreMultiPool(
    pool({ poolAddress: '0xa', tvlUsd: null as unknown as number }),
    cfg,
  );
  assert.deepEqual(scored.rejectedReasons, []);
  assert.equal(scored.tvlScore, 0);
  assert.equal(scored.volumeScore, 0);
  assert.equal(scored.volumeTvlScore, 0);
  assert.ok(Number.isFinite(scored.totalScore));
});

// ── 11. Failure isolation: one corrupt pool must not affect others ───────

test('failure isolation: a NaN-volume pool is excluded; valid pools before/after it are unaffected', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xaaaa', tvlUsd: 300_000 }, 10_000), // valid
    pool({ poolAddress: '0xbbbb', tvlUsd: 300_000 }, NaN), // corrupt
    pool({ poolAddress: '0xcccc', tvlUsd: 300_000 }, 20_000), // valid
  ];
  const { pools, selected, rejected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(pools.length, 2, 'the corrupt pool must not enter the ranked list');
  assert.ok(pools.every((p) => p.poolAddress !== '0xbbbb'));
  assert.ok(selected, 'valid pools must still be selectable');
  assert.equal(selected!.poolAddress, '0xcccc', 'higher volume among the two valid pools wins, unaffected by the corrupt one');
  assert.ok(rejected.some((r) => r.poolAddress === '0xbbbb' && r.reason === 'INVALID_VOLUME_INPUT'));
});

// ── 12. All-invalid: fail closed, no invented fallback ────────────────────

test('all-invalid: every pool corrupt -> no selection, no fallback, no first-pool-by-default', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xaaaa', tvlUsd: Infinity }),
    pool({ poolAddress: '0xbbbb', tvlUsd: -Infinity }),
    pool({ poolAddress: '0xcccc', tvlUsd: 300_000 }, NaN),
  ];
  const { pools, selected, rejected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(pools.length, 0);
  assert.equal(selected, null);
  assert.equal(rejected.length, 3);
  // -Infinity tvlUsd is caught earlier by the pre-existing TVL_TOO_LOW gate
  // (-Infinity >= MIN_POOL_TVL_USD is false) — still fails closed, just via a
  // different, pre-existing reason code than the two INVALID_* codes added
  // by this phase. Every pool must be excluded one way or another.
  assert.ok(rejected.every((r) => ['TVL_TOO_LOW', 'INVALID_TVL_INPUT', 'INVALID_VOLUME_INPUT'].includes(r.reason)));
});

// ── 13. An invalid pool can never win ranking even if its raw numbers "look best" ──

test('invalid pool cannot rank first even with an enormous (Infinity) raw TVL', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xmodest', tvlUsd: 50_000 }, 5_000), // valid, modest
    pool({ poolAddress: '0xcorrupt', tvlUsd: Infinity }, 1_000_000), // would dominate any naive comparator
  ];
  const { selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.ok(selected);
  assert.equal(selected!.poolAddress, '0xmodest', 'the corrupt pool must never win by virtue of an oversized raw value');
});

// ── 14. Invalid pool cannot reach execution ───────────────────────────────

test('invalid pool cannot reach execution: selected is null so multiExecute\'s existing NO_VALID_POOL gate applies unchanged', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [pool({ poolAddress: '0xonly', tvlUsd: 300_000 }, Infinity)];
  const { selected } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(selected, null, 'multiExecute.ts already treats a null `selected` as NO_VALID_POOL — no execution can be reached');
});

// ── 15. Tie-breaker preserved when an invalid pool is mixed in ───────────

test('tie-break among valid equal-score pools is unaffected by an invalid pool present in the same batch', async () => {
  const cfg = baseConfig();
  const listed: ListedPool[] = [
    pool({ poolAddress: '0xbbbb', fee: 50_000, tvlUsd: 100_000 }),
    pool({ poolAddress: '0xaaaa', fee: 50_000, tvlUsd: 100_000 }),
    pool({ poolAddress: '0xzzzz', fee: 50_000, tvlUsd: 100_000 }, NaN), // corrupt, must not disturb the tie-break
  ];
  const { selected, pools } = await discoverAndScorePoolsForCandidate(cfg, candidate(), {
    poolFetcher: async () => listed,
  });
  assert.equal(pools.length, 2);
  assert.equal(selected!.poolAddress, '0xaaaa', 'identical scores still tie-break to the lexicographically lower address');
});

// ── 16. Extreme finite values are accepted, never clamped, never unsafe ──

test('extreme finite values (Number.MAX_VALUE / MIN_VALUE) are accepted, not rejected, and produce a finite score', () => {
  const cfg = baseConfig();
  const scored = scoreMultiPool(
    pool({ poolAddress: '0xa', tvlUsd: Number.MAX_VALUE }, Number.MIN_VALUE),
    cfg,
  );
  assert.deepEqual(scored.rejectedReasons, [], 'an unusually large but finite value is not "invalid" merely for being large');
  assert.ok(Number.isFinite(scored.totalScore));
  // formula is unchanged: Math.min(1, ...) still caps sub-scores at 1
  assert.equal(scored.tvlScore, 1);
});

// ── 17. Every accepted pool's final score is guaranteed finite ───────────

test('final score is always finite for every accepted (non-rejected) pool', () => {
  const cfg = baseConfig();
  const cases: [number, number][] = [
    [100_000, 10_000],
    [0, 0],
    [Number.MAX_VALUE, 0],
    [2_000, Number.MAX_VALUE],
  ];
  for (const [tvlUsd, vol] of cases) {
    const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd }, vol), cfg);
    if (scored.rejectedReasons.length === 0) {
      assert.ok(Number.isFinite(scored.totalScore), `expected finite score for tvl=${tvlUsd} vol=${vol}`);
    }
  }
});

// ── 18. Output validation catches a non-finite result from a source other than tvl/volume ──

test('output validation: a non-finite arithmetic result (e.g. a corrupt config weight) is still caught and rejected', () => {
  const cfg = baseConfig({ poolTvlWeight: Infinity });
  const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd: 100_000 }), cfg);
  assert.ok(scored.rejectedReasons.includes('INVALID_SCORE_RESULT'));
  assert.ok(Number.isFinite(scored.totalScore), 'the placeholder score returned must still be finite');
});

// ── Property-style test: every input-domain combination either yields a finite ──
// ── accepted score, or is excluded via rejectedReasons — never a NaN/Infinity escape ──

test('property test: across the full input-value domain, an accepted pool always has a finite score', () => {
  const cfg = baseConfig();
  const values = [100_000, 0, -1, NaN, Infinity, -Infinity];
  for (const tvlUsd of values) {
    for (const vol of values) {
      const scored = scoreMultiPool(pool({ poolAddress: '0xa', tvlUsd }, vol), cfg);
      if (scored.rejectedReasons.length === 0) {
        assert.ok(
          Number.isFinite(scored.totalScore),
          `accepted pool must have a finite score for tvlUsd=${tvlUsd} vol=${vol}`,
        );
      } else {
        assert.ok(Number.isFinite(scored.totalScore), 'even a rejected pool\'s placeholder score must be finite');
      }
      // Invariant: whenever either raw input is not a finite non-negative number,
      // the pool must be flagged invalid.
      const tvlIsCorrupt = !(Number.isFinite(tvlUsd) && tvlUsd >= 0);
      const volIsCorrupt = !(Number.isFinite(vol) && vol >= 0);
      if (tvlIsCorrupt) assert.ok(scored.rejectedReasons.includes('INVALID_TVL_INPUT'));
      if (volIsCorrupt) assert.ok(scored.rejectedReasons.includes('INVALID_VOLUME_INPUT'));
      if (!tvlIsCorrupt && !volIsCorrupt) assert.deepEqual(scored.rejectedReasons, []);
    }
  }
});
