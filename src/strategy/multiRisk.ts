import type { SupportedChainId } from '../config.js';
import { getMultiPositionMeta, listOpenPositions, listUnresolvedTxJournal } from '../db/index.js';
import type { MultiConfig } from './multiConfig.js';
import type { TradeIntent } from './types.js';

export type RiskGateResult = { pass: boolean; reason?: string };

/** In-memory only (not persisted) — a process restart resets cooldowns, which is acceptable since duplicate-position/pending-tx checks are the durable guards against double-entry. */
const cooldownMap = new Map<string, number>();

function cooldownKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`;
}

/** Any open position (any strategy) already holding this token on this chain blocks a new MULTI entry. */
export function checkDoubleEntry(
  chainId: SupportedChainId,
  tokenAddress: string,
): RiskGateResult {
  const addr = tokenAddress.toLowerCase();
  const duplicate = listOpenPositions(chainId).some(
    (p) => p.token0.toLowerCase() === addr || p.token1.toLowerCase() === addr,
  );
  return duplicate ? { pass: false, reason: 'DUPLICATE_POSITION' } : { pass: true };
}

/** MULTI_MAX_OPEN_POSITIONS / MULTI_MAX_POSITIONS_PER_TOKEN / MULTI_MAX_EXPOSURE_USD — scoped to strategy='multi' positions only. */
export function checkPositionLimits(
  config: MultiConfig,
  chainId: SupportedChainId,
  tokenAddress: string,
): RiskGateResult {
  const addr = tokenAddress.toLowerCase();
  const openMulti = listOpenPositions(chainId).filter((p) => p.strategy === 'multi');

  if (openMulti.length >= config.maxOpenPositions) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  const perToken = openMulti.filter(
    (p) => p.token0.toLowerCase() === addr || p.token1.toLowerCase() === addr,
  ).length;
  if (perToken >= config.maxPositionsPerToken) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  const exposureUsd = openMulti.reduce((sum, p) => {
    const meta = getMultiPositionMeta(p.chainId, p.tokenId);
    return sum + (meta?.positionSizeUsd ?? 0);
  }, 0);
  if (exposureUsd >= config.maxExposureUsd) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  return { pass: true };
}

export function checkEntryCooldown(
  chainId: SupportedChainId,
  tokenAddress: string,
  config: MultiConfig,
): RiskGateResult {
  const last = cooldownMap.get(cooldownKey(chainId, tokenAddress));
  if (last != null && Date.now() - last < config.entryCooldownMs) {
    return { pass: false, reason: 'ENTRY_COOLDOWN' };
  }
  return { pass: true };
}

/** Called only after a successful entry — never on rejection, so retries aren't penalized. */
export function recordEntryCooldown(chainId: SupportedChainId, tokenAddress: string): void {
  cooldownMap.set(cooldownKey(chainId, tokenAddress), Date.now());
}

export function __resetMultiCooldownForTests(): void {
  cooldownMap.clear();
}

/** Any unresolved (non-final) journal entry on this chain blocks a new MULTI send. */
export function checkPendingTransaction(chainId: SupportedChainId): RiskGateResult {
  const unresolved = listUnresolvedTxJournal({ chainId });
  return unresolved.length > 0 ? { pass: false, reason: 'PENDING_TRANSACTION' } : { pass: true };
}

/**
 * Runs every risk-gate check and returns ALL results (not just the first
 * failure) for auditability. The caller (multiExecute.ts) treats any
 * non-passing result as a hard block — none of these checks are advisory.
 */
export async function runRiskGate(
  intent: TradeIntent,
  config: MultiConfig,
): Promise<RiskGateResult[]> {
  const results: RiskGateResult[] = [];

  const usdgOk =
    config.usdgAddress != null &&
    intent.quoteToken.toLowerCase() === config.usdgAddress.toLowerCase();
  results.push(usdgOk ? { pass: true } : { pass: false, reason: 'NOT_USDG' });

  results.push(
    intent.range.tickLower < intent.range.tickUpper
      ? { pass: true }
      : { pass: false, reason: 'INVALID_RANGE' },
  );

  results.push(checkDoubleEntry(intent.chainId, intent.token));
  results.push(checkPositionLimits(config, intent.chainId, intent.token));
  results.push(checkEntryCooldown(intent.chainId, intent.token, config));
  results.push(checkPendingTransaction(intent.chainId));

  return results;
}
