import type { Address } from 'viem';
import { listPoolsForToken, MIN_POOL_TVL_USD, type ListedPool } from '../chain/pools.js';
import type { MultiConfig } from './multiConfig.js';
import type { MultiCandidate, MultiPoolCandidate } from './types.js';

export type PoolFetcher = typeof listPoolsForToken;

/** Only these fee tiers are ever scored — never manufactured/substituted (spec §15). */
const PREFERRED_FEE_TIERS = [500, 400, 300];
const TVL_REFERENCE_USD = 100_000;
const VOLUME_REFERENCE_USD = 50_000;
const VOLUME_TVL_RATIO_REFERENCE = 0.5;

function feeScoreFor(fee: number | null): number {
  if (fee === 500) return 1.0;
  if (fee === 400) return 0.75;
  if (fee === 300) return 0.5;
  return 0;
}

function isUsdgPool(pool: ListedPool, usdgAddress: Address): boolean {
  const usdg = usdgAddress.toLowerCase();
  return pool.token0.toLowerCase() === usdg || pool.token1.toLowerCase() === usdg;
}

/**
 * Transparent weighted pool score. Weights are configurable via
 * MULTI_POOL_*_WEIGHT and are never claimed to be optimal — this is a
 * comparison heuristic between pools that already passed the hard filters
 * (USDG pair, existing fee tier, minimum TVL).
 */
export function scoreMultiPool(pool: ListedPool, config: MultiConfig): MultiPoolCandidate {
  const volumeUsd = pool.pair?.volume?.h24 ?? null;
  const tvlUsd = pool.tvlUsd ?? null;

  const tvlScore = tvlUsd != null ? Math.min(1, tvlUsd / TVL_REFERENCE_USD) : 0;
  const volumeScore = volumeUsd != null ? Math.min(1, volumeUsd / VOLUME_REFERENCE_USD) : 0;
  const volumeTvlScore =
    volumeUsd != null && tvlUsd != null && tvlUsd > 0
      ? Math.min(1, volumeUsd / tvlUsd / VOLUME_TVL_RATIO_REFERENCE)
      : 0;
  const feeScore = feeScoreFor(pool.fee);

  const totalScore =
    tvlScore * config.poolTvlWeight +
    volumeScore * config.poolVolumeWeight +
    volumeTvlScore * config.poolVolumeTvlWeight +
    feeScore * config.poolFeeWeight;

  return {
    poolAddress: pool.poolAddress,
    protocol: pool.protocol,
    dex: pool.dex ?? 'uniswap',
    fee: pool.fee,
    tvlUsd,
    volumeUsd,
    liquidityUsd: tvlUsd,
    currentPrice: null,
    sourceTimestamp: Date.now(),
    totalScore,
    tvlScore,
    volumeScore,
    volumeTvlScore,
    feeScore,
    reasons: [`tvlUsd=${tvlUsd}`, `volumeUsd=${volumeUsd}`, `fee=${pool.fee}`],
    rejectedReasons: [],
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
  } catch {
    return { pools: [], selected: null, rejected: [] };
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
    scored.push(scoreMultiPool(pool, config));
  }

  const ranked = scored.slice().sort(comparePoolCandidates);

  return {
    pools: ranked,
    selected: ranked[0] ?? null,
    rejected,
  };
}
