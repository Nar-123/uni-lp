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
  setPositionTpSl,
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

type Pending = {
  key: string;
  kind: TriggerKind;
  pnlPct: number;
  at: number;
};

const pending = new Map<string, Pending>();
/** Prevent concurrent close of same position */
const closing = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

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

    const result = await closePosition(
      chainId,
      BigInt(p.tokenId),
      p.protocol,
      p.dex ?? 'uniswap',
    );
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
        const m = await measurePnl(chainId, p.tokenId, p.protocol, p.dex ?? 'uniswap');
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

          // Dedicated recheck after 5s (don't wait for next 30s tick)
          setTimeout(() => {
            void recheckAndMaybeClose(bot, p, hit, tp, sl);
          }, CONFIRM_MS);
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
  const m = await measurePnl(chainId, p.tokenId, p.protocol, p.dex ?? 'uniswap');
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

  // Persist → close
  await executeClose(bot, p, expected, m.pnlPct ?? 0, m.pnlUsd, m.label);
}

export function startTpslWatcher(bot: Bot): void {
  if (timer) return;
  console.log(
    `[tpsl] experimental watcher started (poll ${POLL_MS / 1000}s, confirm ${CONFIRM_MS / 1000}s)`,
  );
  // First tick delayed so bot is fully up
  setTimeout(() => void tick(bot), 8_000);
  timer = setInterval(() => void tick(bot), POLL_MS);
}

export function stopTpslWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  pending.clear();
  closing.clear();
}
