import type { Address } from 'viem';
import type { SupportedChainId } from '../config.js';
import {
  GmgnError,
  gmgnMarketTrending,
  gmgnTokenInfo,
  type GmgnMarketTrendingParams,
  type GmgnTokenInfo,
  type GmgnTrendingToken,
} from '../gmgn/cli.js';
import type { MultiConfig } from './multiConfig.js';
import type { CandidateType, MultiCandidate, RejectedCandidate } from './types.js';

export type CandidateFetcher = (params: GmgnMarketTrendingParams) => Promise<GmgnTrendingToken[]>;
export type TokenInfoFetcher = (
  chainId: SupportedChainId,
  address: string,
) => Promise<GmgnTokenInfo | null>;

const defaultFetcher: CandidateFetcher = (params) => gmgnMarketTrending(params);

const defaultInfoFetcher: TokenInfoFetcher = async (chainId, address) => {
  try {
    return await gmgnTokenInfo(chainId, address as Address);
  } catch {
    return null;
  }
};

/** launchpad_platform present & non-empty → MEME. Never inferred from ticker/name. Missing → UNKNOWN. */
function classify(raw: GmgnTrendingToken): CandidateType {
  const platform = raw.launchpad_platform;
  if (platform == null || String(platform).trim() === '') return 'UNKNOWN';
  return 'MEME';
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** GMGN timestamps are unix seconds. Uses the earliest of creation/open timestamp as "born at". */
function ageHoursFromInfo(info: GmgnTokenInfo | null, now: number): number | null {
  if (!info) return null;
  const stamps = [info.creation_timestamp, info.open_timestamp].filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  );
  if (stamps.length === 0) return null;
  const earliestMs = Math.min(...stamps) * 1000;
  const ageMs = now - earliestMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return ageMs / 3_600_000;
}

function makeBaseCandidate(
  raw: GmgnTrendingToken,
  chainId: SupportedChainId,
  now: number,
): MultiCandidate {
  return {
    address: raw.address,
    symbol: raw.symbol,
    name: raw.name,
    chainId,
    marketCapUsd: numberOrNull(raw.market_cap),
    ageHours: null,
    volume6hUsd: numberOrNull(raw.volume),
    liquidityUsd: numberOrNull(raw.liquidity),
    classification: classify(raw),
    launchpadPlatform: raw.launchpad_platform ?? null,
    candidateScore: 0,
    reasons: [],
    source: 'gmgn_trending_6h',
    sourceTimestamp: now,
  };
}

function rejectWith(candidate: MultiCandidate, reason: string): RejectedCandidate {
  return { ...candidate, rejectedReason: reason };
}

function compareCandidates(a: MultiCandidate, b: MultiCandidate): number {
  const va = a.volume6hUsd ?? 0;
  const vb = b.volume6hUsd ?? 0;
  if (vb !== va) return vb - va;
  const la = a.liquidityUsd ?? 0;
  const lb = b.liquidityUsd ?? 0;
  if (lb !== la) return lb - la;
  const aAddr = a.address.toLowerCase();
  const bAddr = b.address.toLowerCase();
  return aAddr < bAddr ? -1 : aAddr > bAddr ? 1 : 0;
}

/**
 * Fetches GMGN 6h trending candidates and applies the mandatory filter order:
 * data validation → market cap → token age → classification → volume ranking
 * → top N. UNKNOWN data always fails closed with an explicit reason code —
 * never coerced to 0, never allowed to pass silently.
 */
/**
 * A candidate-source failure (gmgn-cli not found, exec failed, timed out,
 * non-zero exit, malformed/empty output, ...) MUST be distinguishable from
 * "the source responded and genuinely returned nothing today" — collapsing
 * both into an empty candidate list would let an operator mistake a broken
 * integration for a quiet market. `code` is a GmgnErrorCode when the
 * failure came from gmgn-cli; otherwise a generic fallback for a custom
 * fetcher's own error.
 */
export type CandidateSourceError = { code: string; message: string };

export async function fetchAndFilterCandidates(
  config: MultiConfig,
  opts?: { fetcher?: CandidateFetcher; infoFetcher?: TokenInfoFetcher; now?: number },
): Promise<{ candidates: MultiCandidate[]; rejected: RejectedCandidate[]; sourceError?: CandidateSourceError }> {
  if (!config.enabled) {
    return { candidates: [], rejected: [] };
  }

  const fetcher = opts?.fetcher ?? defaultFetcher;
  const infoFetcher = opts?.infoFetcher ?? defaultInfoFetcher;
  const now = opts?.now ?? Date.now();
  const rejected: RejectedCandidate[] = [];

  let raw: GmgnTrendingToken[];
  try {
    raw = await fetcher({
      chainId: config.chainId,
      interval: '6h',
      limit: Math.min(100, Math.max(config.topN * 5, 50)),
    });
  } catch (e) {
    // Fetch failure fails closed (no candidates, no crash) but is reported
    // distinctly from a genuinely empty result — never silently coerced
    // into "0 candidates today".
    const code = e instanceof GmgnError ? e.code : 'CANDIDATE_SOURCE_UNKNOWN_ERROR';
    const message = e instanceof Error ? e.message : String(e);
    return { candidates: [], rejected: [], sourceError: { code, message } };
  }

  const afterBaseFilters: MultiCandidate[] = [];
  for (const t of raw) {
    if (!t || typeof t.address !== 'string' || t.address.trim() === '') continue;
    const candidate = makeBaseCandidate(t, config.chainId, now);

    if (candidate.volume6hUsd == null) {
      rejected.push(rejectWith(candidate, 'VOLUME_UNKNOWN'));
      continue;
    }
    if (candidate.marketCapUsd == null) {
      rejected.push(rejectWith(candidate, 'MC_UNKNOWN'));
      continue;
    }
    if (candidate.marketCapUsd < config.minMarketCapUsd) {
      rejected.push(rejectWith(candidate, 'MC_TOO_LOW'));
      continue;
    }
    if (candidate.classification === 'UNKNOWN') {
      rejected.push(rejectWith(candidate, 'CLASSIFICATION_UNKNOWN'));
      continue;
    }
    afterBaseFilters.push(candidate);
  }

  // Token age is not present in trending payload — requires a secondary per-token lookup.
  const infoResults = await Promise.allSettled(
    afterBaseFilters.map((c) => infoFetcher(config.chainId, c.address)),
  );

  const afterAgeFilter: MultiCandidate[] = [];
  for (let i = 0; i < afterBaseFilters.length; i++) {
    const candidate = afterBaseFilters[i];
    const settled = infoResults[i];
    const info = settled.status === 'fulfilled' ? settled.value : null;
    const ageHours = ageHoursFromInfo(info, now);
    const withAge: MultiCandidate = { ...candidate, ageHours };

    if (ageHours == null) {
      rejected.push(rejectWith(withAge, 'AGE_UNKNOWN'));
      continue;
    }
    if (ageHours < config.minTokenAgeHours) {
      rejected.push(rejectWith(withAge, 'AGE_TOO_LOW'));
      continue;
    }
    afterAgeFilter.push(withAge);
  }

  const ranked = afterAgeFilter.slice().sort(compareCandidates);
  const top = ranked.slice(0, config.topN).map((c, idx) => ({
    ...c,
    candidateScore: ranked.length > 0 ? (ranked.length - idx) / ranked.length : 0,
    reasons: [
      `volume6hUsd=${c.volume6hUsd}`,
      `marketCapUsd=${c.marketCapUsd}`,
      `ageHours=${c.ageHours?.toFixed(2)}`,
      `classification=${c.classification}`,
      `rank=${idx + 1}/${ranked.length}`,
    ],
  }));

  return { candidates: top, rejected };
}
