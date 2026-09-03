/**
 * Experimental TP/SL watcher.
 *
 * - Global toggle: settings tpSlEnabled
 * - Per-position: /tp #id (optional tp% sl%)
 * - Every POLL_MS: compute PnL for enrolled open positions
 * - On hit: notify → wait CONFIRM_MS → recheck; if still hit → close
 */
import type { Bot } from 'grammy';
import { config, CHAINS, type SupportedChainId, isSupportedChainId } from '../config.js';
import {
  DEFAULT_PREFS,
  listPrefsWithTpSlEnabled,
  listTpSlEnrolledPositions,
  markClosed,
  recordLedger,
  setJournalAccountingMeta,
  setPositionTpSl,
  type JournalAccountingMeta,
  type PositionTpSl,
} from '../db/index.js';
import { closePosition } from '../chain/close.js';
import { formatPositionLine, getPosition } from '../chain/positions.js';
import { computePositionPnl } from '../pnl/compute.js';
import { formatUsd } from '../price/dexscreener.js';
import { classify, type TriggerKind } from './tpslLogic.js';

export { classify } from './tpslLogic.js';

const POLL_MS = 30_000;
const CONFIRM_MS = 5_000;
/**
 * Phase 4.6.4: bounded wait, on shutdown, for any close that had already
 * started (past the recheck, already calling closePosition) before
 * shutdown began. That in-flight work is never interrupted — it may
 * already have submitted a transaction, and the existing (unmodified)
 * journal/recovery system is what makes leaving it running safe. This
 * constant only bounds how long stopTpslWatcher()'s own returned promise
 * waits before giving up and resolving anyway ("forced-exit fallback") —
 * it never cancels, marks failed, or fabricates a result for that work.
 */
const SHUTDOWN_DEADLINE_MS = 15_000;

type Pending = {
  key: string;
  kind: TriggerKind;
  pnlPct: number;
  at: number;
};

type WatcherState = 'stopped' | 'running' | 'stopping';

const pending = new Map<string, Pending>();
/** Prevent concurrent close of same position */
const closing = new Set<string>();
/**
 * Phase 4.6.4: handles for every currently-armed 5s confirmation timer,
 * keyed by position. Previously these setTimeout return values were
 * discarded entirely — there was no way to cancel an armed trigger's
 * confirmation wait at all; shutdown only *incidentally* neutralized it
 * via pending.clear() (the callback would find nothing pending and
 * no-op), but the timer itself kept running, unclearable and untracked.
 */
const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Close operations currently in flight (already past the recheck, already calling closePosition) — tracked so shutdown can wait for them, bounded, without ever touching or interrupting them. */
const inFlightCloses = new Set<Promise<void>>();

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let watcherState: WatcherState = 'stopped';
/** Set once a shutdown is requested; repeated stopTpslWatcher() calls return this same promise (idempotency). */
let shutdownPromise: Promise<void> | null = null;

/**
 * Test-only dependency injection (Phase 4.6.4). Production code always
 * uses the real `measurePnl`/`closePosition` below (assigned once at
 * module load, after both are defined) — this exists solely so the
 * shutdown/cancellation lifecycle can be exercised deterministically
 * without real RPC/chain calls, exactly the same pattern used elsewhere
 * in this codebase (injectable mintFn, spawnFn, runner). Neither
 * function's own logic (PnL calculation, close execution, accounting) is
 * changed by this — only how the lifecycle code above them reaches them.
 */
type TpslDeps = {
  measurePnl: (
    chainId: SupportedChainId,
    tokenId: string,
    protocol: 'v3' | 'v4',
    dex?: import('../config.js').DexId,
  ) => Promise<MeasureResult>;
  closePosition: typeof closePosition;
};
// eslint-disable-next-line @typescript-eslint/no-use-before-define
let deps: TpslDeps = { measurePnl, closePosition };
export function __setTpslDepsForTests(overrides: Partial<TpslDeps>): void {
  deps = { ...deps, ...overrides };
}
export function __resetTpslDepsForTests(): void {
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  deps = { measurePnl, closePosition };
}

function posKey(p: Pick<PositionTpSl, 'chainId' | 'tokenId'>): string {
  return `${p.chainId}:${p.tokenId}`;
}

function resolveLevels(
  p: PositionTpSl,
): { tp: number; sl: number } {
  // Prefer any prefs with watcher on; else defaults
  const users = listPrefsWithTpSlEnabled();
  const base = users[0]?.prefs ?? DEFAULT_PREFS;
  const tp = p.tpPercent != null && p.tpPercent > 0 ? p.tpPercent : base.tpPercent;
  const sl = p.slPercent != null && p.slPercent > 0 ? p.slPercent : base.slPercent;
  return { tp, sl };
}

async function notifyAll(bot: Bot, text: string): Promise<void> {
  const ids = [...config.allowedUserIds];
  for (const uid of ids) {
    try {
      await bot.api.sendMessage(uid, text, {
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      console.warn('[tpsl] notify', uid, e instanceof Error ? e.message : e);
    }
  }
}

export type MeasureResult =
  | { status: 'active'; pnlPct: number | null; pnlUsd: number; label: string }
  | { status: 'gone' }
  | { status: 'unknown'; reason: string };

/**
 * Position state is UNKNOWN on a read failure (RPC/price/PnL-compute
 * error) — that must NOT be conflated with "position confirmed gone".
 * Only a clean null return from getPosition/getV4Position (ownership
 * verified, no liquidity/fees left) means "gone". Callers must treat
 * 'unknown' as no-action/retry, never as a reason to unenroll TP/SL.
 */
async function measurePnl(
  chainId: SupportedChainId,
  tokenId: string,
  protocol: 'v3' | 'v4',
  dex: import('../config.js').DexId = 'uniswap',
): Promise<MeasureResult> {
  let live: Awaited<ReturnType<typeof getPosition>>;
  try {
    if (protocol === 'v4') {
      const { getV4Position } = await import('../chain/v4.js');
      live = await getV4Position(chainId, BigInt(tokenId));
    } else {
      live = await getPosition(chainId, BigInt(tokenId), dex);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[tpsl] measure ${chainId}:${tokenId} — state unknown:`, reason);
    return { status: 'unknown', reason };
  }
  if (!live) return { status: 'gone' };

  try {
    // Price-correct via format path
    await formatPositionLine(live);
    const pnl = await computePositionPnl(chainId, tokenId, live);
    const label =
      live.symbol0 && live.symbol1
        ? !['WETH', 'WBNB', 'USDC', 'USDG', 'USDT'].includes(live.symbol0.toUpperCase())
          ? live.symbol0
          : !['WETH', 'WBNB', 'USDC', 'USDG', 'USDT'].includes(live.symbol1.toUpperCase())
            ? live.symbol1
            : `#${tokenId}`
        : `#${tokenId}`;
    return { status: 'active', pnlPct: pnl.pnlPct, pnlUsd: pnl.pnlUsd, label };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[tpsl] measure ${chainId}:${tokenId} — pnl compute failed:`, reason);
    return { status: 'unknown', reason };
  }
}

async function executeClose(
  bot: Bot,
  p: PositionTpSl,
  kind: TriggerKind,
  pnlPct: number,
  pnlUsd: number,
  label: string,
): Promise<void> {
  const key = posKey(p);
  if (closing.has(key)) return;
  closing.add(key);
  try {
    const chainId = p.chainId as SupportedChainId;
    if (!isSupportedChainId(chainId)) throw new Error(`bad chain ${p.chainId}`);

    await notifyAll(
      bot,
      `🔒 TP/SL confirmed — closing ${label} #${p.tokenId} [${p.protocol}]\n` +
        `${kind.toUpperCase()} · PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${formatUsd(pnlUsd)})`,
    );

    const result = await deps.closePosition(
      chainId,
      BigInt(p.tokenId),
      p.protocol,
      p.dex ?? 'uniswap',
    );

    // Stage accounting metadata in the journal BEFORE recordLedger() so a
    // crash between this point and the ledger writes below can be
    // recovered automatically on the next startup (Phase 3.5) — mirrors
    // the manual /close path in bot.ts exactly (Phase 4.7 finding: this
    // automated close path was the only closePosition() caller missing it).
    const closeMeta: JournalAccountingMeta[] = [
      {
        kind: 'withdrawal',
        tokenId: p.tokenId,
        tokenAddress: null,
        amountRaw: null,
        amountHuman: result.amount0Human + result.amount1Human,
        usd: result.withdrawalUsd - result.feesPortionUsd,
      },
    ];
    if (result.feesPortionUsd > 0) {
      closeMeta.push({
        kind: 'fee_claim',
        tokenId: p.tokenId,
        tokenAddress: null,
        amountRaw: null,
        amountHuman: null,
        usd: result.feesPortionUsd,
        feeSplitIsEstimated: result.feeSplitIsEstimated,
      });
    }
    setJournalAccountingMeta(chainId, result.hash, closeMeta);

    recordLedger({
      chainId,
      tokenId: p.tokenId,
      kind: 'withdrawal',
      usd: result.withdrawalUsd - result.feesPortionUsd,
      amountHuman: result.amount0Human + result.amount1Human,
      txHash: result.hash,
    });
    if (result.feesPortionUsd > 0) {
      recordLedger({
        chainId,
        tokenId: p.tokenId,
        kind: 'fee_claim',
        usd: result.feesPortionUsd,
        txHash: result.hash,
      });
    }
    markClosed(chainId, p.tokenId);
    setPositionTpSl(chainId, p.tokenId, { enabled: false });

    await notifyAll(
      bot,
      `✅ TP/SL closed ${label} #${p.tokenId} [${kind.toUpperCase()}]\n` +
        `Received ~${result.amount0Human.toFixed(6)} ${result.symbol0} + ` +
        `${result.amount1Human.toFixed(6)} ${result.symbol1}\n` +
        `~${formatUsd(result.withdrawalUsd)}\n` +
        `tx: ${result.txLink}\n` +
        `_(leftover tokens: /tokens if needed)_`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[tpsl] close failed', key, msg);
    await notifyAll(
      bot,
      `❌ TP/SL close failed #${p.tokenId}:\n${msg.slice(0, 400)}\nWatching continues — fix or /tp #${p.tokenId} off`,
    );
  } finally {
    closing.delete(key);
    pending.delete(key);
  }
}

async function tick(bot: Bot): Promise<void> {
  if (watcherState !== 'running') return;
  if (running) return;
  running = true;
  try {
    const watchers = listPrefsWithTpSlEnabled();
    if (!watchers.length) {
      // Global off for everyone — clear pending
      pending.clear();
      return;
    }

    const enrolled = listTpSlEnrolledPositions();
    if (!enrolled.length) return;

    // Only chains that enrolled positions use
    const byChain = new Map<number, PositionTpSl[]>();
    for (const p of enrolled) {
      const arr = byChain.get(p.chainId) ?? [];
      arr.push(p);
      byChain.set(p.chainId, arr);
    }

    for (const [chainIdNum, positions] of byChain) {
      if (!isSupportedChainId(chainIdNum)) continue;
      const chainId = chainIdNum as SupportedChainId;

      for (const p of positions) {
        const key = posKey(p);
        if (closing.has(key)) continue;

        const { tp, sl } = resolveLevels(p);
        const m = await deps.measurePnl(chainId, p.tokenId, p.protocol, p.dex ?? 'uniswap');
        if (m.status === 'gone') {
          // Confirmed gone (verified ownership/empty) — safe to unenroll
          setPositionTpSl(chainId, p.tokenId, { enabled: false });
          pending.delete(key);
          continue;
        }
        if (m.status === 'unknown') {
          // State unknown (RPC/price failure) — NO ACTION, keep watching,
          // retry next tick. Never disable protection on a transient error.
          continue;
        }

        const hit = classify(m.pnlPct, tp, sl);
        const pend = pending.get(key);

        if (!hit) {
          if (pend) {
            console.log(`[tpsl] cleared pending ${key} (pnl=${m.pnlPct?.toFixed(2)}%)`);
            pending.delete(key);
            await notifyAll(
              bot,
              `↩️ TP/SL cancelled for ${m.label} #${p.tokenId}\n` +
                `PnL back to ${m.pnlPct != null ? `${m.pnlPct >= 0 ? '+' : ''}${m.pnlPct.toFixed(2)}%` : 'n/a'} ` +
                `(need TP +${tp}% / SL -${sl}%)`,
            );
          }
          continue;
        }

        // First hit → arm
        if (!pend || pend.kind !== hit) {
          pending.set(key, {
            key,
            kind: hit,
            pnlPct: m.pnlPct ?? 0,
            at: Date.now(),
          });
          console.log(
            `[tpsl] arm ${hit} ${key} pnl=${m.pnlPct?.toFixed(2)}% — recheck in ${CONFIRM_MS}ms`,
          );
          await notifyAll(
            bot,
            `⚠️ TP/SL trigger (${hit.toUpperCase()}) — rechecking in 5s\n` +
              `${m.label} #${p.tokenId} [${p.protocol}] · ${CHAINS[chainId].name}\n` +
              `PnL ${m.pnlPct != null ? `${m.pnlPct >= 0 ? '+' : ''}${m.pnlPct.toFixed(2)}%` : 'n/a'} ` +
              `(${formatUsd(m.pnlUsd)})\n` +
              `Levels: TP +${tp}% · SL -${sl}%\n` +
              `_Experimental: closes only if still beyond level after 5s_`,
          );

          // Dedicated recheck after 5s (don't wait for next 30s tick).
          // Handle is tracked so shutdown can actually cancel it — an
          // armed-but-not-yet-fired trigger must not survive a shutdown
          // request (Phase 4.6.4).
          const t = setTimeout(() => {
            confirmTimers.delete(key);
            void recheckAndMaybeClose(bot, p, hit, tp, sl);
          }, CONFIRM_MS);
          confirmTimers.set(key, t);
          continue;
        }

        // Already pending same kind — recheck handled by setTimeout
      }
    }
  } catch (e) {
    console.error('[tpsl] tick', e);
  } finally {
    running = false;
  }
}

async function recheckAndMaybeClose(
  bot: Bot,
  p: PositionTpSl,
  expected: TriggerKind,
  tp: number,
  sl: number,
): Promise<void> {
  if (watcherState !== 'running') return;
  const key = posKey(p);
  const pend = pending.get(key);
  if (!pend || pend.kind !== expected) return;
  if (closing.has(key)) return;

  // Re-read enrollment
  const still = listTpSlEnrolledPositions().find(
    (x) => x.chainId === p.chainId && x.tokenId === p.tokenId,
  );
  if (!still) {
    pending.delete(key);
    return;
  }
  if (!listPrefsWithTpSlEnabled().length) {
    pending.delete(key);
    return;
  }

  const chainId = p.chainId as SupportedChainId;
  const m = await deps.measurePnl(chainId, p.tokenId, p.protocol, p.dex ?? 'uniswap');
  if (m.status === 'gone') {
    pending.delete(key);
    setPositionTpSl(chainId, p.tokenId, { enabled: false });
    return;
  }
  if (m.status === 'unknown') {
    // State unknown — don't confirm the close, don't unenroll. Leave the
    // pending trigger in place; the next regular tick (or a fresh arm)
    // will re-evaluate once data is available again.
    console.warn(`[tpsl] recheck ${key} state unknown — leaving pending, not closing`);
    return;
  }

  const hit = classify(m.pnlPct, tp, sl);
  if (hit !== expected) {
    pending.delete(key);
    console.log(
      `[tpsl] recheck failed ${key}: now ${m.pnlPct?.toFixed(2)}% (wanted ${expected})`,
    );
    await notifyAll(
      bot,
      `↩️ TP/SL not confirmed for ${m.label} #${p.tokenId}\n` +
        `After 5s PnL is ${m.pnlPct != null ? `${m.pnlPct >= 0 ? '+' : ''}${m.pnlPct.toFixed(2)}%` : 'n/a'} — still watching`,
    );
    return;
  }

  // Re-check right before committing: measurePnl above involved awaits, so
  // shutdown may have started in the meantime. If it has, this is still
  // the pre-submission checkpoint — no transaction exists yet — so bail
  // out here rather than starting one (§6.A: shutdown before submission
  // -> zero sends). Once executeClose is actually called below, it is
  // tracked and allowed to run to completion untouched (§6.B/D) — it is
  // never safe to interrupt a close that may already be broadcasting.
  if (watcherState !== 'running') return;

  // Persist → close. Tracked in inFlightCloses so a concurrent shutdown
  // can wait (bounded) for this to finish without ever cancelling it.
  const closePromise = executeClose(bot, p, expected, m.pnlPct ?? 0, m.pnlUsd, m.label);
  inFlightCloses.add(closePromise);
  try {
    await closePromise;
  } finally {
    inFlightCloses.delete(closePromise);
  }
}

let startupTimer: ReturnType<typeof setTimeout> | null = null;

export function startTpslWatcher(bot: Bot): void {
  if (timer) return;
  console.log(
    `[tpsl] experimental watcher started (poll ${POLL_MS / 1000}s, confirm ${CONFIRM_MS / 1000}s)`,
  );
  watcherState = 'running';
  shutdownPromise = null;
  // First tick delayed so bot is fully up
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void tick(bot);
  }, 8_000);
  timer = setInterval(() => void tick(bot), POLL_MS);
}

/**
 * Phase 4.6.4: bounded, idempotent shutdown.
 *
 * 1. Immediately marks the watcher 'stopping' — tick() and
 *    recheckAndMaybeClose() both check this and refuse to do any new work
 *    (no new arms, no new closes started) from this point on, closing the
 *    "shutdown started -> watcher polls again -> new transaction
 *    submitted" gap.
 * 2. Stops the poll interval and the (rare) delayed first-tick timer.
 * 3. Cancels every armed-but-not-yet-fired 5s confirmation timer — the
 *    actual P2 fix. Previously these handles were discarded; an armed
 *    trigger's confirmation wait could not be cancelled at all.
 * 4. Waits, bounded by SHUTDOWN_DEADLINE_MS, for any close that was
 *    already in flight (already past the recheck, already calling
 *    closePosition) when shutdown began. That work is never interrupted —
 *    it is only ever waited for, and only up to the deadline. If the
 *    deadline passes first, this function still resolves (the
 *    "forced-exit fallback" the audit asked for) rather than hanging
 *    forever; the in-flight close keeps running independently and its
 *    outcome is still handled entirely by the existing (untouched)
 *    journal/recovery system — nothing here marks it confirmed, failed,
 *    or removes its journal entry.
 *
 * Repeated calls (multiple SIGTERM/SIGINT, or any other caller) return
 * the exact same promise — only one shutdown sequence ever actually runs.
 */
export function stopTpslWatcher(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (watcherState === 'stopped') return Promise.resolve();

  watcherState = 'stopping';

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  for (const t of confirmTimers.values()) {
    clearTimeout(t);
  }
  confirmTimers.clear();
  pending.clear();

  const inFlight = [...inFlightCloses];
  shutdownPromise = (async () => {
    if (inFlight.length > 0) {
      console.log(`[tpsl] shutdown: waiting up to ${SHUTDOWN_DEADLINE_MS}ms for ${inFlight.length} in-flight close(s)`);
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<void>((r) => {
        deadlineTimer = setTimeout(r, SHUTDOWN_DEADLINE_MS);
      });
      try {
        await Promise.race([Promise.allSettled(inFlight), deadline]);
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    }
    closing.clear();
    watcherState = 'stopped';
    console.log('[tpsl] shutdown complete');
  })();

  return shutdownPromise;
}

// ── Test-only exports (Phase 4.6.4) ─────────────────────────────────────
// None of these are used by production code (src/index.ts only calls the
// public startTpslWatcher/stopTpslWatcher above). They exist solely to
// make the shutdown/cancellation lifecycle deterministically testable.

/** Directly invoke one poll tick — normally only reachable via the internal setInterval. */
export { tick as __tickForTests };

export function __getWatcherStateForTests(): WatcherState {
  return watcherState;
}
export function __getPendingCountForTests(): number {
  return pending.size;
}
export function __getConfirmTimerCountForTests(): number {
  return confirmTimers.size;
}
export function __getInFlightCloseCountForTests(): number {
  return inFlightCloses.size;
}
export function __isClosingForTests(chainId: number, tokenId: string): boolean {
  return closing.has(`${chainId}:${tokenId}`);
}

/**
 * Full reset between tests: clears every module-level lifecycle map/flag
 * and restores the real (non-overridden) measurePnl/closePosition. Does
 * NOT touch any db/index.ts state — tests still own their own scratch DB
 * lifecycle exactly as every other suite in this codebase does.
 */
export function __resetTpslWatcherForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  for (const t of confirmTimers.values()) clearTimeout(t);
  confirmTimers.clear();
  pending.clear();
  closing.clear();
  inFlightCloses.clear();
  running = false;
  watcherState = 'stopped';
  shutdownPromise = null;
  __resetTpslDepsForTests();
}
