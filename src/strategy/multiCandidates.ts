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

type FilterOutcome =
  | { eligible: true; candidate: MultiCandidate }
  | { eligible: false; reason: string; candidate: MultiCandidate };

/**
 * Phase 4.7 audit (F-10) — the exact base-filter decision logic used by
 * fetchAndFilterCandidates's batch loop, extracted so revalidateCandidate
 * (single-candidate, Execute-time) can reuse the IDENTICAL rules rather than
 * duplicating them. Any future change to volume/market-cap/classification
 * thresholds only ever needs to happen here.
 */
function evaluateBaseFilters(candidate: MultiCandidate, config: MultiConfig): FilterOutcome {
  if (candidate.volume6hUsd == null) {
    return { eligible: false, reason: 'VOLUME_UNKNOWN', candidate };
  }
  if (candidate.volume6hUsd <= 0) {
    return { eligible: false, reason: 'VOLUME_NON_POSITIVE', candidate };
  }
  if (candidate.volume6hUsd < config.minCandidateVolumeUsd) {
    return { eligible: false, reason: 'VOLUME_TOO_LOW', candidate };
  }
  if (candidate.marketCapUsd == null) {
    return { eligible: false, reason: 'MC_UNKNOWN', candidate };
  }
  if (candidate.marketCapUsd < config.minMarketCapUsd) {
    return { eligible: false, reason: 'MC_TOO_LOW', candidate };
  }
  if (candidate.classification === 'UNKNOWN') {
    return { eligible: false, reason: 'CLASSIFICATION_UNKNOWN', candidate };
  }
  return { eligible: true, candidate };
}

/** Same split as evaluateBaseFilters, for the age check (which needs a secondary GMGN lookup). */
function evaluateAgeFilter(
  candidate: MultiCandidate,
  ageHours: number | null,
  config: MultiConfig,
): FilterOutcome {
  const withAge: MultiCandidate = { ...candidate, ageHours };
  if (ageHours == null) {
    return { eligible: false, reason: 'AGE_UNKNOWN', candidate: withAge };
  }
  if (ageHours < config.minTokenAgeHours) {
    return { eligible: false, reason: 'AGE_TOO_LOW', candidate: withAge };
  }
  return { eligible: true, candidate: withAge };
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
    const outcome = evaluateBaseFilters(candidate, config);
    if (!outcome.eligible) {
      rejected.push(rejectWith(outcome.candidate, outcome.reason));
      continue;
    }
    afterBaseFilters.push(outcome.candidate);
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
    const outcome = evaluateAgeFilter(candidate, ageHours, config);
    if (!outcome.eligible) {
      rejected.push(rejectWith(outcome.candidate, outcome.reason));
      continue;
    }
    afterAgeFilter.push(outcome.candidate);
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

/**
 * Phase 4.7 audit (F-10) result of re-checking ONE candidate's eligibility
 * at Execute time, against live GMGN data, using the exact same rules
 * (evaluateBaseFilters/evaluateAgeFilter) as the original batch scan.
 *
 * Deliberately distinct from `sourceError` in fetchAndFilterCandidates:
 * `REVALIDATION_SOURCE_ERROR` covers every GMGN failure mode (timeout,
 * non-zero exit, malformed output, rate limit) uniformly, and — critically —
 * is never treated as "the source responded and this token failed" and
 * never falls back to the stale cached candidate. A source failure at
 * Execute time means eligibility is UNKNOWN, not "still eligible" and not
 * "now ineligible" — so it fails closed exactly like a genuine rejection
 * from the caller's point of view (Execute is refused either way), without
 * ever conflating "GMGN is down" with "this token failed my filters".
 */
export type RevalidationResult =
  | { status: 'OK'; candidate: MultiCandidate }
  | { status: 'REJECTED'; reason: string; candidate: MultiCandidate }
  | { status: 'CANDIDATE_NOT_FOUND' }
  | { status: 'REVALIDATION_SOURCE_ERROR'; message: string };

/**
 * gmgnTokenInfo (unlike defaultInfoFetcher, which swallows failures to
 * `null` for the batch scan's best-effort per-candidate age lookup) is
 * called directly here so a genuine network/exec failure propagates as a
 * catchable error — required to distinguish "GMGN failed" (source error)
 * from "GMGN succeeded but returned no usable age timestamps" (AGE_UNKNOWN,
 * a data-quality verdict, not an outage).
 */
const defaultRevalidationInfoFetcher: TokenInfoFetcher = (chainId, address) =>
  gmgnTokenInfo(chainId, address as Address);

/**
 * Re-validates exactly ONE token — never re-fetches/re-scores the other
 * ~50 Top-N candidates, never re-runs pool discovery. Cost is bounded to
 * one `market trending` call (to find this token's current 6h figures;
 * GMGN has no single-address trending query) plus one `token info` call
 * (for age) — the same two data sources the original scan already uses,
 * just not fanned out across every candidate.
 */
export async function revalidateCandidate(
  config: MultiConfig,
  tokenAddress: string,
  opts?: { fetcher?: CandidateFetcher; infoFetcher?: TokenInfoFetcher; now?: number },
): Promise<RevalidationResult> {
  const fetcher = opts?.fetcher ?? defaultFetcher;
  const infoFetcher = opts?.infoFetcher ?? defaultRevalidationInfoFetcher;
  const now = opts?.now ?? Date.now();
  const target = tokenAddress.toLowerCase();

  let raw: GmgnTrendingToken[];
  try {
    raw = await fetcher({ chainId: config.chainId, interval: '6h', limit: 100 });
  } catch (e) {
    const code = e instanceof GmgnError ? e.code : 'CANDIDATE_SOURCE_UNKNOWN_ERROR';
    const message = e instanceof Error ? e.message : String(e);
    return { status: 'REVALIDATION_SOURCE_ERROR', message: `${code}: ${message}` };
  }

  const match = raw.find(
    (t) => t && typeof t.address === 'string' && t.address.toLowerCase() === target,
  );
  if (!match) {
    return { status: 'CANDIDATE_NOT_FOUND' };
  }

  const candidate = makeBaseCandidate(match, config.chainId, now);
  const baseOutcome = evaluateBaseFilters(candidate, config);
  if (!baseOutcome.eligible) {
    return { status: 'REJECTED', reason: baseOutcome.reason, candidate: baseOutcome.candidate };
  }

  let info: GmgnTokenInfo;
  try {
    info = await infoFetcher(config.chainId, candidate.address).then((v) => {
      if (v == null) throw new Error('gmgnTokenInfo returned null');
      return v;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { status: 'REVALIDATION_SOURCE_ERROR', message };
  }

  const ageHours = ageHoursFromInfo(info, now);
  const ageOutcome = evaluateAgeFilter(baseOutcome.candidate, ageHours, config);
  if (!ageOutcome.eligible) {
    return { status: 'REJECTED', reason: ageOutcome.reason, candidate: ageOutcome.candidate };
  }

  return { status: 'OK', candidate: ageOutcome.candidate };
}
