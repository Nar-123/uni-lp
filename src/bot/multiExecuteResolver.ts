/**
 * Phase 4.7 audit (F-13) — MULTI Execute callback_data encoding/decoding
 * and scan-to-intent resolution, extracted into a small, pure, bot.ts-free
 * module specifically so it is directly unit-testable without needing a
 * grammY handler test harness (which this codebase does not have).
 *
 * Format: `mx:<scanId>:<tokenAddress>` — deliberately NOT `multi:exec:...`
 * (the pre-F-13 format), so an old button generated before this change
 * simply fails to match the new callback regex at all: fail-closed by
 * construction, not by an explicit compatibility check.
 *
 * Callback_data budget (Telegram hard limit: 1-64 bytes, ASCII so 1
 * byte/char): "mx:" (3) + scanId (10) + ":" (1) + token (42, "0x" + 40 hex)
 * = 56 bytes — 8 bytes of margin below the limit.
 */
import type { MultiCandidate, MultiStrategyRun, TradeIntent } from '../strategy/types.js';

const CALLBACK_RE = /^mx:([0-9a-f]{10}):(0x[a-fA-F0-9]{40})$/;

export type MultiExecuteCallback = { scanId: string; token: string };

/** Builds the exact callback_data string embedded in an Execute button. */
export function buildMultiExecuteCallbackData(scanId: string, token: string): string {
  return `mx:${scanId}:${token}`;
}

/**
 * Strict parse — anchored both ends, exact character classes, no
 * partial/lenient matching. Anything not EXACTLY this shape (missing
 * scanId, missing token, malformed scanId, malformed address, extra
 * fields, wrong prefix, the old `multi:exec:<token>` format, oversized
 * payload) returns null. Never guesses, never falls back.
 */
export function parseMultiExecuteCallback(data: string): MultiExecuteCallback | null {
  const m = CALLBACK_RE.exec(data);
  if (!m) return null;
  return { scanId: m[1], token: m[2] };
}

export type MultiExecuteResolution =
  | { ok: true; run: MultiStrategyRun; intent: TradeIntent; candidate: MultiCandidate }
  | { ok: false; reason: 'RUN_REQUIRED' | 'SCAN_MISMATCH' | 'TOKEN_NOT_FOUND' };

/**
 * The central F-13 requirement: resolves a parsed callback against the
 * CURRENT session's multiRun, binding BOTH scanId and token address to the
 * exact same run. Fails closed on any mismatch — never falls back to the
 * current/newest scan, never searches other runs (there is only ever one,
 * see session.ts), never matches by token address alone.
 *
 * - No run at all (never scanned, or process restarted) -> RUN_REQUIRED.
 * - A run exists but its scanId differs from the callback's -> SCAN_MISMATCH
 *   (the exact case a stale button from a since-replaced scan hits, even
 *   when the token address it names still happens to appear in the new
 *   scan under a different pool/intent).
 * - The scanId matches but the token isn't in that run's intents/candidates
 *   -> TOKEN_NOT_FOUND (should not normally happen for a same-scan button,
 *   but fails closed rather than assuming).
 */
export function resolveMultiExecuteCallback(
  multiRun: MultiStrategyRun | undefined,
  callback: MultiExecuteCallback,
): MultiExecuteResolution {
  if (!multiRun) {
    return { ok: false, reason: 'RUN_REQUIRED' };
  }
  if (multiRun.scanId !== callback.scanId) {
    return { ok: false, reason: 'SCAN_MISMATCH' };
  }
  const token = callback.token.toLowerCase();
  const intent = multiRun.intents.find((i) => i.token.toLowerCase() === token);
  const candidate = multiRun.candidates.find((c) => c.address.toLowerCase() === token);
  if (!intent || !candidate) {
    return { ok: false, reason: 'TOKEN_NOT_FOUND' };
  }
  return { ok: true, run: multiRun, intent, candidate };
}
