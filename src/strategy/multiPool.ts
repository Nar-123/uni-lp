import type { Address } from 'viem';
import { listPoolsForToken, MIN_POOL_TVL_USD, type ListedPool } from '../chain/pools.js';
import type { MultiConfig } from './multiConfig.js';
import type { MultiCandidate, MultiPoolCandidate } from './types.js';

export type PoolFetcher = typeof listPoolsForToken;

/**
 * Only these fee tiers are ever scored — never manufactured/substituted (spec §15).
 * Units match the on-chain v3 `fee()` convention used everywhere else in this
 * codebase (hundredths of a bip; fee/10000 = percent — see chain/pools.ts
 * feeLabel). 5% = 50000, 4% = 40000, 3% = 30000. These are NOT the same as
 * config.ts's default-strategy FEE_TIERS ([100, 500, 3000, 10000]) — MULTI
 * intentionally prefers higher fee tiers for meme/volatile pairs and only
 * ever selects one that is actually listed on-chain for the pair.
 */
const PREFERRED_FEE_TIERS = [50_000, 40_000, 30_000];
const TVL_REFERENCE_USD = 100_000;
const VOLUME_REFERENCE_USD = 50_000;
const VOLUME_TVL_RATIO_REFERENCE = 0.5;

function feeScoreFor(fee: number | null): number {
  if (fee === 50_000) return 1.0;
  if (fee === 40_000) return 0.75;
  if (fee === 30_000) return 0.5;
  return 0;
}

function isUsdgPool(pool: ListedPool, usdgAddress: Address): boolean {
  const usdg = usdgAddress.toLowerCase();
  return pool.token0.toLowerCase() === usdg || pool.token1.toLowerCase() === usdg;
}

/**
 * Phase 4.6.7: `tvlUsd`/`volume.h24` are typed `number` but originate from an
 * external API response cast with `as` (dexscreener.ts's `fetchTokenPairs`) —
 * nothing at runtime guarantees a malformed/corrupted response can't hand us
 * NaN, Infinity, -Infinity, or a negative amount. `null`/`undefined` (field
 * genuinely absent) is a separate, already-handled, pre-existing case — this
 * only classifies a *present* value as valid or corrupt.
 */
function isValidMetric(value: number | null): boolean {
  return value == null || (Number.isFinite(value) && value >= 0);
}

/**
 * Transparent weighted pool score. Weights are configurable via
 * MULTI_POOL_*_WEIGHT and are never claimed to be optimal — this is a
 * comparison heuristic between pools that already passed the hard filters
 * (USDG pair, existing fee tier, minimum TVL).
 *
 * Phase 4.6.7: a present-but-corrupt tvlUsd/volumeUsd (or a non-finite
 * arithmetic result — e.g. Infinity/Infinity) never reaches the weighted sum;
 * the pool is instead flagged via `rejectedReasons` so the caller can exclude
 * it from ranking entirely (see discoverAndScorePoolsForCandidate below) —
 * it must never merely score as if the corrupt field were 0, since that would
 * still allow a corrupted pool to be ranked and selected on its other fields.
 */
export function scoreMultiPool(pool: ListedPool, config: MultiConfig): MultiPoolCandidate {
  const volumeUsdRaw = pool.pair?.volume?.h24 ?? null;
  const tvlUsdRaw = pool.tvlUsd ?? null;

  const tvlInputValid = isValidMetric(tvlUsdRaw);
  const volumeInputValid = isValidMetric(volumeUsdRaw);

  // Corrupt values are excluded from arithmetic the same way absent ones
  // already were — this keeps every sub-score below guaranteed finite
  // regardless of the rejection flagging (defense in depth, spec §6).
  const tvlUsd = tvlInputValid ? tvlUsdRaw : null;
  const volumeUsd = volumeInputValid ? volumeUsdRaw : null;

  const tvlScore = tvlUsd != null ? Math.min(1, tvlUsd / TVL_REFERENCE_USD) : 0;
  const volumeScore = volumeUsd != null ? Math.min(1, volumeUsd / VOLUME_REFERENCE_USD) : 0;
  const volumeTvlScore =
    volumeUsd != null && tvlUsd != null && tvlUsd > 0
      ? Math.min(1, volumeUsd / tvlUsd / VOLUME_TVL_RATIO_REFERENCE)
      : 0;
  const feeScore = feeScoreFor(pool.fee);

  const rawTotalScore =
    tvlScore * config.poolTvlWeight +
    volumeScore * config.poolVolumeWeight +
    volumeTvlScore * config.poolVolumeTvlWeight +
    feeScore * config.poolFeeWeight;

  // Output validation (spec §6b): guards against a non-finite result from any
  // source not already covered above (e.g. a non-finite config weight).
  const totalScoreValid = Number.isFinite(rawTotalScore);
  const totalScore = totalScoreValid ? rawTotalScore : 0;

  const rejectedReasons: string[] = [];
  if (!tvlInputValid) rejectedReasons.push('INVALID_TVL_INPUT');
  if (!volumeInputValid) rejectedReasons.push('INVALID_VOLUME_INPUT');
  if (!totalScoreValid) rejectedReasons.push('INVALID_SCORE_RESULT');

  return {
    poolAddress: pool.poolAddress,
    protocol: pool.protocol,
    dex: pool.dex ?? 'uniswap',
    fee: pool.fee,
    // Raw (possibly-corrupt) values are preserved here for observability
    // (spec §22 — the reason must never be hidden behind a fake value) — safe
    // because a pool with a non-empty rejectedReasons never leaves
    // discoverAndScorePoolsForCandidate's `scored`/`ranked` arrays, so these
    // fields can never reach the comparator.
    tvlUsd: tvlUsdRaw,
    volumeUsd: volumeUsdRaw,
    liquidityUsd: tvlUsdRaw,
    currentPrice: null,
    sourceTimestamp: Date.now(),
    totalScore,
    tvlScore,
    volumeScore,
    volumeTvlScore,
    feeScore,
    reasons: [`tvlUsd=${tvlUsdRaw}`, `volumeUsd=${volumeUsdRaw}`, `fee=${pool.fee}`],
    rejectedReasons,
  };
}

function comparePoolCandidates(a: MultiPoolCandidate, b: MultiPoolCandidate): number {
  if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
  const tvlA = a.tvlUsd ?? 0;
  const tvlB = b.tvlUsd ?? 0;
  if (tvlB !== tvlA) return tvlB - tvlA;
  const volA = a.volumeUsd ?? 0;
  const volB = b.volumeUsd ?? 0;
  if (volB !== volA) return volB - volA;
  const addrA = a.poolAddress.toLowerCase();
  const addrB = b.poolAddress.toLowerCase();
  return addrA < addrB ? -1 : addrA > addrB ? 1 : 0;
}

/**
 * Discovers pools for a candidate token, applies hard filters (USDG pair,
 * existing preferred fee tier, minimum TVL), scores survivors, and ranks
 * with a deterministic tie-break. Never selects by TVL alone.
 */
export async function discoverAndScorePoolsForCandidate(
  config: MultiConfig,
  candidate: MultiCandidate,
  opts?: { poolFetcher?: PoolFetcher },
): Promise<{
  pools: MultiPoolCandidate[];
  selected: MultiPoolCandidate | null;
  rejected: { poolAddress: string; reason: string }[];
  /**
   * Phase 4.7 fix: set only when the pool-fetch call itself threw (RPC
   * outage, DexScreener error, etc.) — distinguishes "this token genuinely
   * has no qualifying pool" from "we could not check", mirroring
   * multiCandidates.ts's sourceError for the candidate-fetch step. Without
   * this, an infrastructure outage during pool discovery was silently
   * indistinguishable from every real candidate having no pool at all.
   */
  poolFetchError?: { message: string };
}> {
  if (!config.enabled || !config.usdgAddress) {
    return { pools: [], selected: null, rejected: [] };
  }

  const fetcher = opts?.poolFetcher ?? listPoolsForToken;
  const usdgAddress = config.usdgAddress;
  const rejected: { poolAddress: string; reason: string }[] = [];

  let listed: ListedPool[];
  try {
    // minTvlUsd=0: fetch everything so filters below can attach explicit reasons
    // instead of pools silently disappearing before this function ever sees them.
    listed = await fetcher(config.chainId, candidate.address as Address, 0);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { pools: [], selected: null, rejected: [], poolFetchError: { message } };
  }

  const scored: MultiPoolCandidate[] = [];
  for (const pool of listed) {
    if (!isUsdgPool(pool, usdgAddress)) {
      rejected.push({ poolAddress: pool.poolAddress, reason: 'NOT_USDG' });
      continue;
    }
    if (pool.fee == null || !PREFERRED_FEE_TIERS.includes(pool.fee)) {
      rejected.push({ poolAddress: pool.poolAddress, reason: 'FEE_TIER_NOT_SUPPORTED' });
      continue;
    }
    if (!((pool.tvlUsd ?? 0) >= MIN_POOL_TVL_USD)) {
      rejected.push({ poolAddress: pool.poolAddress, reason: 'TVL_TOO_LOW' });
      continue;
    }
    const candidateScore = scoreMultiPool(pool, config);
    // Phase 4.6.7: a pool flagged invalid by scoreMultiPool (corrupt
    // tvlUsd/volumeUsd, or a non-finite score result) must never enter the
    // ranking list — the comparator must never see NaN/Infinity/-Infinity.
    if (candidateScore.rejectedReasons.length > 0) {
      rejected.push({ poolAddress: pool.poolAddress, reason: candidateScore.rejectedReasons[0] });
      continue;
    }
    scored.push(candidateScore);
  }

  const ranked = scored.slice().sort(comparePoolCandidates);

  return {
    pools: ranked,
    selected: ranked[0] ?? null,
    rejected,
  };
}
