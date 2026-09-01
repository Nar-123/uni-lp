/**
 * Pure TP/SL trigger-classification logic, split out from tpslWatcher.ts so
 * it can be unit tested without pulling in the bot's full dependency chain
 * (config/env, DB, RPC clients) — see test/tpsl.test.ts.
 */

export type TriggerKind = 'tp' | 'sl';

/**
 * UNKNOWN pnlPct (null / non-finite — e.g. incomplete price data) must
 * never be classified as a trigger. Only a known, finite PnL% can arm a
 * TP or SL.
 */
export function classify(pnlPct: number | null, tp: number, sl: number): TriggerKind | null {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return null;
  if (pnlPct >= tp) return 'tp';
  if (pnlPct <= -sl) return 'sl';
  return null;
}
