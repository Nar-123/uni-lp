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

/**
 * Phase 4.6.8: every successful MULTI entry adds one permanent key to
 * `cooldownMap` that this codebase previously never removed — over weeks of
 * continuous operation (MULTI typically enters a different meme token each
 * time), the map's key count grows with the lifetime count of distinct
 * tokens ever entered, not with anything currently relevant. An entry whose
 * cooldown window has already elapsed can never again affect
 * checkEntryCooldown's result (see the `< config.entryCooldownMs` check
 * below), so it is safe to drop — purely a memory bound, not a behavior
 * change. Mirrors the same prune-on-tick idiom already used by
 * volumeAlertWatcher.ts's `pruneCooldowns`.
 */
function pruneCooldownMap(maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, at] of cooldownMap) {
    if (at < cutoff) cooldownMap.delete(key);
  }
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

  // Phase 4.7 fix: a missing/not-yet-written position-meta row must fail
  // closed. It previously contributed $0 to the exposure sum (`?? 0`) —
  // exactly backwards, since lost accounting data silently permitted MORE
  // trading, not less. `config.positionSizeUsd` (the configured fixed
  // position size) is the best available worst-case estimate for a
  // metadata-less position; falling back to it, not to 0, keeps the cap
  // meaningful even when a meta write was lost to a crash window
  // (multiExecute.ts's recordMultiPositionMeta lands after several awaits).
  const exposureUsd = openMulti.reduce((sum, p) => {
    const meta = getMultiPositionMeta(p.chainId, p.tokenId);
    return sum + (meta?.positionSizeUsd ?? config.positionSizeUsd ?? 0);
  }, 0);
  // Phase 4.7 fix: include the position about to be opened, not only
  // already-open ones — otherwise the cap only ever fires *after* it has
  // already been exceeded by up to one more position's size. Only possible
  // for fixed-USD sizing (config.positionSizeUsd set): percent-of-balance
  // sizing has no fixed USD figure available pre-mint (it depends on live
  // wallet balance and live USDG price at mint time), so the incremental
  // add is a no-op in that mode — a known, documented residual limitation
  // distinct from the two bugs fixed here.
  const incomingUsd = config.positionSizeUsd ?? 0;
  if (exposureUsd + incomingUsd >= config.maxExposureUsd) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  return { pass: true };
}

export function checkEntryCooldown(
  chainId: SupportedChainId,
  tokenAddress: string,
  config: MultiConfig,
): RiskGateResult {
  pruneCooldownMap(config.entryCooldownMs);
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

/** Test-only: insert a cooldown entry with an explicit (possibly backdated) timestamp. */
export function __setCooldownEntryForTests(
  chainId: number,
  tokenAddress: string,
  at: number,
): void {
  cooldownMap.set(cooldownKey(chainId, tokenAddress), at);
}

export function __cooldownMapSizeForTests(): number {
  return cooldownMap.size;
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
