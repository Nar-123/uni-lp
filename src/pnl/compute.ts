import type { Address } from 'viem';
import { CHAINS, SUPPORTED_CHAIN_IDS, type SupportedChainId } from '../config.js';
import {
  getLedgerEntries,
  listTrackedPositions,
  sumAllLedger,
  sumLedger,
  type TrackedPosition,
} from '../db/index.js';
import type { OnChainPosition } from '../chain/positions.js';
import { formatUsd, getTokenPriceUsd } from '../price/dexscreener.js';

export type PositionPnl = {
  tokenId: string;
  depositsUsd: number;
  withdrawalsUsd: number;
  feesClaimedUsd: number;
  currentValueUsd: number;
  unclaimedFeesUsd: number;
  /** current + unclaimed + withdrawals + fees_claimed - deposits */
  pnlUsd: number;
  pnlPct: number | null;
};

/**
 * Reprice deposit rows using amount_human * live token price when available.
 * Fixes historical bad USD (e.g. WETH priced as meme via DexScreener quote bug).
 */
async function repriceDepositsUsd(
  chainId: SupportedChainId,
  tokenId?: string,
): Promise<number> {
  const entries = getLedgerEntries(chainId, tokenId, 'deposit');
  if (entries.length === 0) return 0;

  // Unique tokens → one price fetch each (parallel), then sum
  const needPrice = entries.filter(
    (e) => e.tokenAddress && e.amountHuman != null && e.amountHuman > 0,
  );
  const uniq = [
    ...new Set(needPrice.map((e) => (e.tokenAddress as string).toLowerCase())),
  ];
  const priceEntries = await Promise.all(
    uniq.map(async (addr) => {
      const px = await getTokenPriceUsd(chainId, addr as Address);
      return [addr, px] as const;
    }),
  );
  const priceBy = new Map(priceEntries);

  let total = 0;
  for (const e of entries) {
    if (e.tokenAddress && e.amountHuman != null && e.amountHuman > 0) {
      const px = priceBy.get(e.tokenAddress.toLowerCase());
      if (px != null && px > 0) {
        total += e.amountHuman * px;
        continue;
      }
    }
    total += e.usd || 0;
  }
  return total;
}

async function repriceAllDepositsUsd(chainId: SupportedChainId | null): Promise<number> {
  if (chainId != null) return repriceDepositsUsd(chainId);
  let total = 0;
  for (const id of SUPPORTED_CHAIN_IDS) {
    total += await repriceDepositsUsd(id);
  }
  return total;
}

/**
 * Pure PnL% resolver: UNKNOWN price data must not be treated as a valid
 * (deeply negative) PnL — it must yield "unknown" (null), which downstream
 * TP/SL logic already treats as "no action" rather than a stop-loss trigger.
 * `priceComplete === false` means valueUsd was computed with a missing
 * token price and must not be trusted for automated decisions;
 * `undefined`/`true` (e.g. a deliberately-zero value for a closed position)
 * is trusted as before.
 */
export function computePnlPct(
  pnlUsd: number,
  depositsUsd: number,
  priceComplete: boolean | undefined,
): number | null {
  if (priceComplete === false) return null;
  if (depositsUsd > 1e-6) return (pnlUsd / depositsUsd) * 100;
  return null;
}

export async function computePositionPnl(
  chainId: SupportedChainId,
  tokenId: string | bigint,
  live?:
    | (Pick<OnChainPosition, 'valueUsd' | 'unclaimedFeesUsd'> & {
        priceComplete?: boolean;
      })
    | null,
): Promise<PositionPnl> {
  const id = tokenId.toString();
  const depositsUsd = await repriceDepositsUsd(chainId, id);
  const withdrawalsUsd = sumLedger(chainId, id, 'withdrawal');
  const feesClaimedUsd = sumLedger(chainId, id, 'fee_claim');
  const currentValueUsd = live?.valueUsd ?? 0;
  const unclaimedFeesUsd = live?.unclaimedFeesUsd ?? 0;

  const pnlUsd =
    currentValueUsd + unclaimedFeesUsd + withdrawalsUsd + feesClaimedUsd - depositsUsd;

  const pnlPct = computePnlPct(pnlUsd, depositsUsd, live?.priceComplete);

  return {
    tokenId: id,
    depositsUsd,
    withdrawalsUsd,
    feesClaimedUsd,
    currentValueUsd,
    unclaimedFeesUsd,
    pnlUsd,
    pnlPct,
  };
}

export function formatPnl(p: PositionPnl): string {
  const sign = p.pnlUsd >= 0 ? '+' : '';
  const pct =
    p.pnlPct != null ? ` (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%)` : '';
  return (
    `PnL ${sign}${formatUsd(p.pnlUsd)}${pct}\n` +
    `  dep ${formatUsd(p.depositsUsd)} | wd ${formatUsd(p.withdrawalsUsd)} | ` +
    `fees claimed ${formatUsd(p.feesClaimedUsd)}\n` +
    `  now ${formatUsd(p.currentValueUsd)} + unclaimed ${formatUsd(p.unclaimedFeesUsd)}`
  );
}

export async function portfolioSummary(
  chainId: SupportedChainId | null,
  liveTotalValue: number,
  liveUnclaimed: number,
): Promise<string> {
  const dep = await repriceAllDepositsUsd(chainId);
  const wd = sumAllLedger(chainId, 'withdrawal');
  const fees = sumAllLedger(chainId, 'fee_claim');
  const pnl = liveTotalValue + liveUnclaimed + wd + fees - dep;
  const sign = pnl >= 0 ? '+' : '';
  const pct = dep > 1e-6 ? ` (${((pnl / dep) * 100) >= 0 ? '+' : ''}${((pnl / dep) * 100).toFixed(2)}%)` : '';
  return (
    `Portfolio PnL ${sign}${formatUsd(pnl)}${pct}\n` +
    `deposits ${formatUsd(dep)} | withdrawals ${formatUsd(wd)} | fees claimed ${formatUsd(fees)}\n` +
    `open value ${formatUsd(liveTotalValue)} | unclaimed fees ${formatUsd(liveUnclaimed)}`
  );
}

/**
 * Compact duration: 4m · 1h6m · 2h33m · 1d3h.
 * Returns null when start is missing/invalid (caller skips the segment).
 */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  // < 1s: treat as no meaningful duration
  if (totalSec < 1) return null;
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 48) return m > 0 ? `${h}h${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d${rh}h` : `${d}d`;
}

/** Compact money for history lines (matches ◎2.656 / +◎0.1238 style). */
function fmtHistAmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if (a >= 1000) return n.toFixed(1);
  if (a >= 100) return n.toFixed(2);
  if (a >= 1) return n.toFixed(3);
  if (a >= 0.01) return n.toFixed(4);
  return n.toFixed(4);
}

function quoteSymbolForPos(chainId: SupportedChainId, pos: TrackedPosition): string {
  const c = CHAINS[chainId];
  const wrapped = c.wrapped.toLowerCase();
  const t0 = pos.token0.toLowerCase();
  const t1 = pos.token1.toLowerCase();
  if (t0 === wrapped || t1 === wrapped) return c.nativeSymbol; // ETH / BNB
  if (c.usdg && (t0 === c.usdg.toLowerCase() || t1 === c.usdg.toLowerCase())) return 'USDG';
  if (c.usdt && (t0 === c.usdt.toLowerCase() || t1 === c.usdt.toLowerCase())) return 'USDT';
  if (c.usdc && (t0 === c.usdc.toLowerCase() || t1 === c.usdc.toLowerCase())) return 'USDC';
  return c.nativeSymbol;
}

function historyPairName(chainId: SupportedChainId, pos: TrackedPosition): string {
  const quote = quoteSymbolForPos(chainId, pos);
  const label = pos.label?.trim();
  if (label) {
    // Avoid double-append if label already looks like TOKEN/QUOTE
    if (label.includes('/')) return label;
    return `${label}/${quote}`;
  }
  return `pos/${quote}`;
}

/**
 * Per-position history from local DB ledger — compact one-liners, newest first.
 *
 * 🟢 #1918 blackfebu/ETH | 4m | $2.656 → +$0.0002 (+0.0%)
 * 🔴 #1917 febu/ETH | 2m | $2.700 → $-0.0000 (-0.0%)
 *
 * Duration omitted when open/close timestamps are missing.
 * Closed = realized (wd + fees − dep). Open can merge live mark when provided.
 */
export async function buildPositionHistory(params: {
  chainId: SupportedChainId;
  /** live on-chain positions for open mark-to-market */
  liveByTokenId?: Map<string, Pick<OnChainPosition, 'valueUsd' | 'unclaimedFeesUsd'>>;
  /** max rows (default 20) */
  limit?: number;
}): Promise<string> {
  const { chainId, liveByTokenId, limit = 20 } = params;
  const tracked = listTrackedPositions(chainId, 'all').slice(0, limit);
  if (!tracked.length) {
    return 'No tracked positions yet. Mint & close via the bot to build history.';
  }

  const now = Date.now();
  const lines: string[] = [];

  for (const pos of tracked) {
    const live = liveByTokenId?.get(pos.tokenId) ?? null;
    const hasLiveMark = pos.status === 'open' && live != null;
    const pnl = await computePositionPnl(
      chainId,
      pos.tokenId,
      hasLiveMark
        ? { valueUsd: live!.valueUsd, unclaimedFeesUsd: live!.unclaimedFeesUsd }
        : pos.status === 'closed'
          ? { valueUsd: 0, unclaimedFeesUsd: 0 }
          : null,
    );

    const emoji = pnl.pnlUsd >= 0 ? '🟢' : '🔴';
    const name = historyPairName(chainId, pos);

    let durMs: number | null = null;
    if (pos.openedAt > 0) {
      if (pos.status === 'closed' && pos.closedAt && pos.closedAt > pos.openedAt) {
        durMs = pos.closedAt - pos.openedAt;
      } else if (pos.status === 'open') {
        durMs = now - pos.openedAt;
      }
    }
    const dur = durMs != null ? formatDuration(durMs) : null;

    const depStr = `$${fmtHistAmt(pnl.depositsUsd)}`;
    const pnlBody = `$${fmtHistAmt(pnl.pnlUsd)}`;
    const pnlStr = pnl.pnlUsd >= 0 ? `+${pnlBody}` : pnlBody; // negatives already have -
    const pct =
      pnl.pnlPct != null
        ? ` (${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct.toFixed(1)}%)`
        : '';

    // 🟢 #id name | 4m | $dep → +$pnl (+x%)   — skip duration segment if none
    const mid = dur ? ` | ${dur} | ` : ` | `;
    lines.push(
      `${emoji} #${pos.tokenId} ${name}${mid}${depStr} → ${pnlStr}${pct}`,
    );
  }

  return lines.join('\n');
}
