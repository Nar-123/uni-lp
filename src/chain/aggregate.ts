/**
 * Multi-provider quote aggregation for bridge / same-chain swap.
 * Races Relay + Across (when configured), picks best expected output.
 */
import { type Hash } from 'viem';
import { CHAINS, type SupportedChainId, txUrl, isSupportedChainId } from '../config.js';
import {
  executeAcrossQuote,
  hasAcrossCredentials,
  previewAcrossTrade,
  type AcrossBridgePreview,
  type AcrossExecuteResult,
  type AcrossQuote,
} from './across.js';
import {
  executeRelayQuote,
  getBridgeAsset,
  getBridgeableBalance,
  previewRelayTrade,
  type BridgeAsset,
  type BridgeExecuteResult,
  type BridgePreview,
  type RelayQuote,
} from './relay.js';
import { formatUnits } from './tokens.js';

export type QuoteProvider = 'relay' | 'across';

export type ProviderQuoteSummary = {
  provider: QuoteProvider;
  amountOutRaw: bigint;
  amountOutFormatted: string;
  timeEstimate?: number;
  feeUsd?: string;
  error?: string;
};

export type AggregatedPreview = {
  /** Winning provider */
  provider: QuoteProvider;
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  from: BridgeAsset;
  to: BridgeAsset;
  amountIn: bigint;
  amountInFormatted: string;
  amountOutFormatted: string;
  amountOutRaw: bigint;
  amountOutUsd?: string;
  timeEstimate?: number;
  networkCostUsd?: string;
  feeUsd?: string;
  priceImpactPercent?: string;
  rate?: string;
  /** All attempts (for display / debug) */
  candidates: ProviderQuoteSummary[];
  /** Provider-specific quote payload for execution */
  relayQuote?: RelayQuote;
  acrossQuote?: AcrossQuote;
};

export type AggregatedExecuteResult = {
  provider: QuoteProvider;
  originTxs: { chainId: SupportedChainId; hash: Hash; link: string }[];
  destTxHashes: string[];
  requestId?: string;
  depositTxHash?: Hash;
};

function relayAmountOutRaw(preview: BridgePreview): bigint {
  const amt = preview.quote.details?.currencyOut?.amount;
  if (amt && /^\d+$/.test(amt)) return BigInt(amt);
  // fallback parse formatted — last resort
  return 0n;
}

function toRelayCandidate(p: BridgePreview): ProviderQuoteSummary {
  const amountOutRaw = relayAmountOutRaw(p);
  return {
    provider: 'relay',
    amountOutRaw,
    amountOutFormatted: p.amountOutFormatted,
    timeEstimate: p.timeEstimate,
    feeUsd: p.feeUsd,
  };
}

function toAcrossCandidate(p: AcrossBridgePreview): ProviderQuoteSummary {
  return {
    provider: 'across',
    amountOutRaw: p.amountOutRaw,
    amountOutFormatted: p.amountOutFormatted,
    timeEstimate: p.timeEstimate,
    feeUsd: p.feeUsd,
  };
}

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Race Relay + Across (if keys present). Pick max amountOutRaw.
 * Same-chain: Across often has no route — Relay still used.
 * RH→BSC: Across currently has no route; Relay wins.
 */
export async function previewAggregatedTrade(params: {
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<AggregatedPreview> {
  if (params.amount <= 0n) throw new Error('Amount must be > 0');

  const from = getBridgeAsset(params.fromChain, params.fromSymbol);
  const to = getBridgeAsset(params.toChain, params.toSymbol);

  // Shared balance / gas checks (once) via Relay helpers
  const bal = await getBridgeableBalance(params.fromChain, from);
  if (params.amount > bal) {
    throw new Error(
      `Insufficient ${from.symbol}: need ${formatUnits(params.amount, from.decimals)}, have ${formatUnits(bal, from.decimals)}` +
        (from.isNative ? ' (gas reserve kept)' : ''),
    );
  }

  const tradeParams = {
    fromChain: params.fromChain,
    toChain: params.toChain,
    fromSymbol: params.fromSymbol,
    toSymbol: params.toSymbol,
    amount: params.amount,
  };

  const tasks: Promise<
    Settled<
      | { kind: 'relay'; preview: BridgePreview }
      | { kind: 'across'; preview: AcrossBridgePreview }
    >
  >[] = [
    settle(
      previewRelayTrade(tradeParams).then((preview) => ({
        kind: 'relay' as const,
        preview,
      })),
    ),
  ];

  if (hasAcrossCredentials()) {
    tasks.push(
      settle(
        previewAcrossTrade(tradeParams).then((preview) => ({
          kind: 'across' as const,
          preview,
        })),
      ),
    );
  }

  const results = await Promise.all(tasks);
  let bestRelay: BridgePreview | undefined;
  let bestAcross: AcrossBridgePreview | undefined;

  // tasks[0] = relay, tasks[1] = across (if present)
  const candidates: ProviderQuoteSummary[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const provider: QuoteProvider = i === 0 ? 'relay' : 'across';
    if (!r.ok) {
      candidates.push({
        provider,
        amountOutRaw: 0n,
        amountOutFormatted: '—',
        error: r.error.slice(0, 180),
      });
      continue;
    }
    if (r.value.kind === 'relay') {
      bestRelay = r.value.preview;
      candidates.push(toRelayCandidate(r.value.preview));
    } else {
      bestAcross = r.value.preview;
      candidates.push(toAcrossCandidate(r.value.preview));
    }
  }

  const viable = candidates.filter((c) => c.amountOutRaw > 0n && !c.error);
  if (!viable.length) {
    const errs = candidates
      .map((c) => `${c.provider}: ${c.error ?? 'no output'}`)
      .join(' | ');
    throw new Error(`No quotes available — ${errs}`);
  }

  viable.sort((a, b) =>
    a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0,
  );
  const winner = viable[0]!;

  if (winner.provider === 'relay' && bestRelay) {
    const amountOutRaw = relayAmountOutRaw(bestRelay);
    return {
      provider: 'relay',
      fromChain: bestRelay.fromChain,
      toChain: bestRelay.toChain,
      from: bestRelay.from,
      to: bestRelay.to,
      amountIn: bestRelay.amountIn,
      amountInFormatted: bestRelay.amountInFormatted,
      amountOutFormatted: bestRelay.amountOutFormatted,
      amountOutRaw,
      amountOutUsd: bestRelay.amountOutUsd,
      timeEstimate: bestRelay.timeEstimate,
      networkCostUsd: bestRelay.networkCostUsd,
      feeUsd: bestRelay.feeUsd,
      priceImpactPercent: bestRelay.priceImpactPercent,
      rate: bestRelay.rate,
      candidates,
      relayQuote: bestRelay.quote,
    };
  }

  if (winner.provider === 'across' && bestAcross) {
    return {
      provider: 'across',
      fromChain: bestAcross.fromChain,
      toChain: bestAcross.toChain,
      from: bestAcross.from,
      to: bestAcross.to,
      amountIn: bestAcross.amountIn,
      amountInFormatted: bestAcross.amountInFormatted,
      amountOutFormatted: bestAcross.amountOutFormatted,
      amountOutRaw: bestAcross.amountOutRaw,
      amountOutUsd: bestAcross.amountOutUsd,
      timeEstimate: bestAcross.timeEstimate,
      networkCostUsd: bestAcross.networkCostUsd,
      feeUsd: bestAcross.feeUsd,
      priceImpactPercent: bestAcross.priceImpactPercent,
      rate: bestAcross.rate,
      candidates,
      acrossQuote: bestAcross.quote,
    };
  }

  throw new Error('Internal: winner without quote payload');
}

export async function previewAggregatedBridge(params: {
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<AggregatedPreview> {
  if (params.fromChain === params.toChain) {
    throw new Error('Origin and destination must differ — use /swap for same-chain');
  }
  return previewAggregatedTrade(params);
}

export async function previewAggregatedSwap(params: {
  chainId: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<AggregatedPreview> {
  if (params.fromSymbol.toUpperCase() === params.toSymbol.toUpperCase()) {
    throw new Error('From and to tokens must differ');
  }
  return previewAggregatedTrade({
    fromChain: params.chainId,
    toChain: params.chainId,
    fromSymbol: params.fromSymbol,
    toSymbol: params.toSymbol,
    amount: params.amount,
  });
}

export async function executeAggregatedQuote(
  preview: AggregatedPreview,
  onProgress?: (msg: string) => void,
): Promise<AggregatedExecuteResult> {
  if (preview.provider === 'across') {
    if (!preview.acrossQuote) throw new Error('Missing Across quote');
    const r: AcrossExecuteResult = await executeAcrossQuote(
      preview.acrossQuote,
      onProgress,
    );
    return {
      provider: 'across',
      originTxs: r.originTxs,
      destTxHashes: r.destTxHashes,
      depositTxHash: r.depositTxHash,
    };
  }

  if (!preview.relayQuote) throw new Error('Missing Relay quote');
  const r: BridgeExecuteResult = await executeRelayQuote(
    preview.relayQuote,
    onProgress,
  );
  return {
    provider: 'relay',
    originTxs: r.originTxs,
    destTxHashes: r.destTxHashes,
    requestId: r.requestId,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatUsdMoney(raw: string | undefined, digits = 2): string | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(digits)}`;
}

function formatPriceImpact(percent: string | undefined): string | undefined {
  if (percent == null || percent === '') return undefined;
  const n = Number(percent);
  if (!Number.isFinite(n)) return `${percent}%`;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function providerLabel(p: QuoteProvider): string {
  return p === 'across' ? 'Across' : 'Relay';
}

function formatCandidatesBlock(candidates: ProviderQuoteSummary[]): string[] {
  if (candidates.length <= 1) return [];
  const lines = ['', 'Quotes compared'];
  // sort: best first among successful
  const sorted = [...candidates].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    if (a.amountOutRaw === b.amountOutRaw) return 0;
    return a.amountOutRaw > b.amountOutRaw ? -1 : 1;
  });
  let bestMarked = false;
  for (const c of sorted) {
    if (c.error) {
      lines.push(`· ${providerLabel(c.provider)}: unavailable`);
      continue;
    }
    const star = !bestMarked ? ' ★' : '';
    bestMarked = true;
    lines.push(
      `· ${providerLabel(c.provider)}: ~${c.amountOutFormatted}${star}` +
        (c.timeEstimate != null ? ` (~${c.timeEstimate}s)` : ''),
    );
  }
  return lines;
}

function formatAggQuoteLines(
  p: AggregatedPreview,
  title: string,
  routeLine: string,
): string {
  const lines = [
    title,
    routeLine,
    `Via ${providerLabel(p.provider)}`,
    ``,
    `Send: ${p.amountInFormatted} ${p.from.symbol}`,
    `Recv: ~${p.amountOutFormatted} ${p.to.symbol}` +
      (p.amountOutUsd ? ` (~$${Number(p.amountOutUsd).toFixed(2)})` : ''),
  ];
  if (p.rate) lines.push(`Rate: ${p.rate}`);

  lines.push(``);
  if (p.timeEstimate != null) {
    lines.push(`Estimated time`);
    lines.push(`~ ${p.timeEstimate}s`);
  }
  const netCost = formatUsdMoney(p.networkCostUsd);
  if (netCost) {
    lines.push(`Network cost`);
    lines.push(netCost);
  }
  const fee = formatUsdMoney(p.feeUsd);
  if (fee && fee !== netCost) {
    lines.push(`Fees`);
    lines.push(fee);
  }
  const impact = formatPriceImpact(p.priceImpactPercent);
  if (impact) {
    lines.push(`Price Impact`);
    lines.push(impact);
  }

  lines.push(...formatCandidatesBlock(p.candidates));
  lines.push(``, `Quotes expire quickly — confirm soon.`);
  return lines.join('\n');
}

export function formatAggregatedBridgePreview(p: AggregatedPreview): string {
  return formatAggQuoteLines(
    p,
    `🌉 Bridge (best quote)`,
    `${CHAINS[p.fromChain].name} → ${CHAINS[p.toChain].name}`,
  );
}

export function formatAggregatedSwapPreview(p: AggregatedPreview): string {
  return formatAggQuoteLines(
    p,
    `💱 Swap (best quote)`,
    `${CHAINS[p.fromChain].name} · ${p.from.symbol} → ${p.to.symbol}`,
  );
}

export function formatAggregatedResult(
  r: AggregatedExecuteResult,
  p: AggregatedPreview,
): string {
  const same = p.fromChain === p.toChain;
  const lines = [
    same
      ? `✅ Swapped ${p.amountInFormatted} ${p.from.symbol} → ~${p.amountOutFormatted} ${p.to.symbol}`
      : `✅ Bridged ${p.amountInFormatted} ${p.from.symbol} → ~${p.amountOutFormatted} ${p.to.symbol}`,
    same
      ? `${CHAINS[p.fromChain].name} · via ${providerLabel(r.provider)}`
      : `${CHAINS[p.fromChain].name} → ${CHAINS[p.toChain].name} · via ${providerLabel(r.provider)}`,
  ];
  for (const tx of r.originTxs) {
    lines.push(`Origin tx: ${tx.link}`);
  }
  if (r.destTxHashes.length) {
    for (const h of r.destTxHashes) {
      if (h.startsWith('0x') && isSupportedChainId(p.toChain)) {
        lines.push(`Dest tx: ${txUrl(p.toChain, h)}`);
      } else {
        lines.push(`Dest: ${h}`);
      }
    }
  }
  if (r.requestId) lines.push(`Request: ${r.requestId.slice(0, 18)}…`);
  if (r.depositTxHash) lines.push(`Deposit: ${r.depositTxHash.slice(0, 14)}…`);
  return lines.join('\n');
}
