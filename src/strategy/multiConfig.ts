import { type Address, isAddress } from 'viem';
import { CHAINS, isSupportedChainId, type SupportedChainId } from '../config.js';
import type { StrategyName } from './types.js';

export type MultiConfig = {
  enabled: boolean;
  disabledReason?: string;
  chainId: SupportedChainId;
  interval: '6h';
  minMarketCapUsd: number;
  minTokenAgeHours: number;
  /**
   * Optional operator-chosen floor (USD) on candidate.volume6hUsd, ON TOP OF
   * the always-on, non-configurable requirement that volume be strictly
   * positive (see multiCandidates.ts's VOLUME_NON_POSITIVE check — a
   * "trending" token reporting $0 or negative 6h volume is a data-integrity
   * failure, not a risk-tolerance choice, so that check is not gated by this
   * config value). Default 0 = disabled: no floor beyond "genuinely nonzero
   * positive volume occurred". Phase 4.7 audit (F-07) deliberately does not
   * hardcode a specific positive dollar figure here — there is no existing,
   * defensible analytical basis in this codebase for picking one (unlike
   * minMarketCapUsd, which has an explicit operator-set default) — so the
   * operator must opt in to a stricter floor themselves once they have a
   * reasoned number, rather than the code inventing one "to be safer".
   */
  minCandidateVolumeUsd: number;
  topN: number;
  rangePercent: number;
  /** null = fall back to the user's existing size prefs (UserPrefs) */
  positionSizeUsd: number | null;
  /** null = no known USDG address for this chain/config — MULTI entry disabled */
  usdgAddress: Address | null;
  poolTvlWeight: number;
  poolVolumeWeight: number;
  poolVolumeTvlWeight: number;
  poolFeeWeight: number;
  maxOpenPositions: number;
  maxPositionsPerToken: number;
  maxExposureUsd: number;
  entryCooldownMs: number;
  tpPercent: number;
  slPercent: number;
};

/** Reads STRATEGY env var — 'multi' opts in explicitly, anything else (incl. unset) is 'default'. */
export function getActiveStrategyName(): StrategyName {
  const raw = (process.env.STRATEGY ?? 'default').trim().toLowerCase();
  return raw === 'multi' ? 'multi' : 'default';
}

/**
 * Phase 4.6.10: the complete, authoritative list of STRATEGY values this
 * codebase recognizes — kept in sync with the `StrategyName` union itself
 * (not invented independently), so a new strategy added to that type must
 * also be added here to become acceptable.
 */
const VALID_STRATEGY_NAMES: readonly StrategyName[] = ['default', 'multi'];

/**
 * Phase 4.6.10: authoritative startup-time STRATEGY validation — the one
 * place a present-but-unrecognized value (typo, empty string, garbage) is
 * rejected outright rather than silently absorbed into the default
 * strategy. Call once, early at process startup, before any
 * transaction-capable service starts; a thrown error here is expected to
 * propagate all the way to the top-level startup failure handler.
 *
 * Deliberately separate from `getActiveStrategyName()` above, which stays
 * unchanged and must keep never throwing — it is called live, on every
 * `/multi`-family Telegram command (see bot.ts), not just once at startup,
 * so making it throw would turn an invalid STRATEGY into a per-command
 * runtime error instead of a single, controlled startup failure. By the
 * time `getActiveStrategyName()` is ever invoked, this function has
 * already guaranteed `process.env.STRATEGY` is either unset or a name in
 * `VALID_STRATEGY_NAMES` — env vars do not change during a process's life.
 *
 * MISSING (unset) STRATEGY is intentionally NOT an error — it is the
 * existing, documented default, matching `getActiveStrategyName()`'s own
 * `?? 'default'` contract. A PRESENT value is normalized the exact same
 * way `getActiveStrategyName()` already does (trim + lowercase — existing
 * behavior, not new normalization) before being checked for membership;
 * only a value that still doesn't match any known name after that fails.
 */
export function assertValidStrategyEnv(): void {
  const raw = process.env.STRATEGY;
  if (raw == null) return; // unset — existing default applies, not an error
  const normalized = raw.trim().toLowerCase();
  if ((VALID_STRATEGY_NAMES as readonly string[]).includes(normalized)) return;
  throw new Error(
    `Invalid STRATEGY "${raw}": expected one of ${VALID_STRATEGY_NAMES.join(', ')} (or unset, which defaults to 'default')`,
  );
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envPositiveOrNull(key: string): number | null {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveChainId(chainId?: SupportedChainId): SupportedChainId {
  if (chainId != null) return chainId;
  const raw = envNum('MULTI_CHAIN_ID', 4663);
  return isSupportedChainId(raw) ? raw : 4663;
}

/**
 * Resolve the USDG quote-asset address for MULTI. MULTI_USDG_ADDRESS (if a
 * valid address) always wins; otherwise falls back to the chain's known
 * USDG contract (CHAINS[chainId].usdg). Never resolved by symbol — a chain
 * with no known USDG address returns null (MULTI entry disabled for it),
 * per the spec's "no fallback to USDC/USDT/WETH/native" rule.
 *
 * Phase 4.7 fix: a MULTI_USDG_ADDRESS that is present but malformed (typo,
 * truncated, ENS name, trailing punctuation) must fail closed to null —
 * exactly like "unset" — rather than silently substituting the chain
 * default. Silently trading against a different quote asset than the one
 * the operator explicitly configured is a worse outcome than disabling
 * MULTI entirely; validateMultiConfig()'s existing `!usdgAddress` check
 * already disables MULTI with a clear reason for null, so returning null
 * here (instead of the chain default) routes a malformed override through
 * that same safe, already-tested path.
 */
function resolveUsdgAddress(chainId: SupportedChainId): Address | null {
  const raw = process.env.MULTI_USDG_ADDRESS?.trim();
  if (raw) {
    return isAddress(raw) ? (raw as Address) : null;
  }
  return CHAINS[chainId].usdg ?? null;
}

export function loadMultiConfig(chainId?: SupportedChainId): MultiConfig {
  const resolvedChainId = resolveChainId(chainId);

  const base: MultiConfig = {
    enabled: true,
    chainId: resolvedChainId,
    interval: '6h',
    minMarketCapUsd: envNum('MULTI_MIN_MARKET_CAP_USD', 1_000_000),
    minTokenAgeHours: envNum('MULTI_MIN_TOKEN_AGE_HOURS', 24),
    minCandidateVolumeUsd: envNum('MULTI_MIN_CANDIDATE_VOLUME_USD', 0),
    topN: Math.round(envNum('MULTI_TOP_N', 10)),
    rangePercent: envNum('MULTI_RANGE_PERCENT', 50),
    positionSizeUsd: envPositiveOrNull('MULTI_POSITION_SIZE_USD'),
    usdgAddress: resolveUsdgAddress(resolvedChainId),
    poolTvlWeight: envNum('MULTI_POOL_TVL_WEIGHT', 0.3),
    poolVolumeWeight: envNum('MULTI_POOL_VOLUME_WEIGHT', 0.3),
    poolVolumeTvlWeight: envNum('MULTI_POOL_VOLUME_TVL_WEIGHT', 0.25),
    poolFeeWeight: envNum('MULTI_POOL_FEE_WEIGHT', 0.15),
    maxOpenPositions: Math.round(envNum('MULTI_MAX_OPEN_POSITIONS', 3)),
    maxPositionsPerToken: Math.round(envNum('MULTI_MAX_POSITIONS_PER_TOKEN', 1)),
    maxExposureUsd: envNum('MULTI_MAX_EXPOSURE_USD', 500),
    entryCooldownMs: Math.round(envNum('MULTI_ENTRY_COOLDOWN_MS', 300_000)),
    tpPercent: envNum('MULTI_TP_PERCENT', 10),
    slPercent: envNum('MULTI_SL_PERCENT', 15),
  };

  const validation = validateMultiConfig(base);
  if (!validation.valid) {
    return { ...base, enabled: false, disabledReason: validation.reason };
  }
  return base;
}

/**
 * Fail-closed config validation (spec §36): any invalid value disables MULTI
 * entirely rather than starting with malformed/partial config.
 */
export function validateMultiConfig(c: MultiConfig): { valid: boolean; reason?: string } {
  if (!(c.minMarketCapUsd > 0)) {
    return { valid: false, reason: 'MULTI_MIN_MARKET_CAP_USD must be > 0' };
  }
  if (!(c.minTokenAgeHours >= 0)) {
    return { valid: false, reason: 'MULTI_MIN_TOKEN_AGE_HOURS must be >= 0' };
  }
  if (!(c.minCandidateVolumeUsd >= 0)) {
    return { valid: false, reason: 'MULTI_MIN_CANDIDATE_VOLUME_USD must be >= 0' };
  }
  if (!(c.topN > 0)) {
    return { valid: false, reason: 'MULTI_TOP_N must be > 0' };
  }
  if (!(c.rangePercent > 0 && c.rangePercent < 100)) {
    return { valid: false, reason: 'MULTI_RANGE_PERCENT must be between 0 and 100 exclusive' };
  }
  if (c.positionSizeUsd != null && !(c.positionSizeUsd > 0)) {
    return { valid: false, reason: 'MULTI_POSITION_SIZE_USD must be > 0 when set' };
  }
  if (!c.usdgAddress) {
    return {
      valid: false,
      reason: 'No valid USDG address for this chain (MULTI_USDG_ADDRESS or chain default) — MULTI entry disabled',
    };
  }
  if (
    c.poolTvlWeight < 0 ||
    c.poolVolumeWeight < 0 ||
    c.poolVolumeTvlWeight < 0 ||
    c.poolFeeWeight < 0
  ) {
    return { valid: false, reason: 'Pool scoring weights must be >= 0' };
  }
  if (!(c.maxOpenPositions > 0)) {
    return { valid: false, reason: 'MULTI_MAX_OPEN_POSITIONS must be > 0' };
  }
  if (!(c.maxPositionsPerToken > 0)) {
    return { valid: false, reason: 'MULTI_MAX_POSITIONS_PER_TOKEN must be > 0' };
  }
  if (!(c.maxExposureUsd > 0)) {
    return { valid: false, reason: 'MULTI_MAX_EXPOSURE_USD must be > 0' };
  }
  if (!(c.entryCooldownMs >= 0)) {
    return { valid: false, reason: 'MULTI_ENTRY_COOLDOWN_MS must be >= 0' };
  }
  return { valid: true };
}
