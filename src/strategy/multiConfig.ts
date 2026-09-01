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

function envAddress(key: string): Address | null {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  return isAddress(raw) ? (raw as Address) : null;
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
 */
function resolveUsdgAddress(chainId: SupportedChainId): Address | null {
  const explicit = envAddress('MULTI_USDG_ADDRESS');
  if (explicit) return explicit;
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
