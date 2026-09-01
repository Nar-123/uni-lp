import type { Address } from 'viem';
import { CHAINS, type SupportedChainId } from '../config.js';
import {
  assertGmgnAddress,
  gmgnChainName,
  gmgnMarketTrending,
  type GmgnTrendingInterval,
  type GmgnTrendingToken,
} from './cli.js';

/** Valid intervals for market trending. */
export const SCREENER_INTERVALS = ['1m', '5m', '1h', '6h', '24h'] as const;
export type ScreenerInterval = (typeof SCREENER_INTERVALS)[number];

export function isScreenerInterval(v: unknown): v is ScreenerInterval {
  return (
    typeof v === 'string' &&
    (SCREENER_INTERVALS as readonly string[]).includes(v)
  );
}

export type ScreenerFilterPrefs = {
  screenerInterval: ScreenerInterval;
  screenerMinVolumeUsd: number;
  screenerMinKol: number;
  screenerMinTotalFee: number;
  screenerMinMcapUsd: number;
  /** 0 = no upper bound */
  screenerMaxMcapUsd: number;
  screenerLimit: number;
};

/** Manual /screener defaults (wider window). */
export const DEFAULT_SCREENER_FILTERS: ScreenerFilterPrefs = {
  screenerInterval: '6h',
  screenerMinVolumeUsd: 300_000,
  screenerMinKol: 10,
  screenerMinTotalFee: 0.5,
  screenerMinMcapUsd: 500_000,
  screenerMaxMcapUsd: 50_000_000,
  screenerLimit: 20,
};

/**
 * Volume-alert poll defaults (always 5m interval, every 60s).
 * vol≥300k · mcap 300k–50M · fees≥0.5 · KOL≥3
 */
export const DEFAULT_ALERT_FILTERS = {
  alertEnabled: true,
  alertMinVolumeUsd: 300_000,
  alertMinMcapUsd: 300_000,
  alertMaxMcapUsd: 50_000_000,
  alertMinKol: 3,
  alertMinTotalFee: 0.5,
} as const;

export type AlertFilterPrefs = {
  alertEnabled: boolean;
  alertMinVolumeUsd: number;
  alertMinMcapUsd: number;
  alertMaxMcapUsd: number;
  alertMinKol: number;
  alertMinTotalFee: number;
};

export type ScreenerToken = {
  address: Address;
  symbol: string;
  name: string;
  price: number;
  priceChangePct: number;
  volumeUsd: number;
  liquidityUsd: number;
  mcapUsd: number;
  holders: number;
  kol: number;
  /** total fees (native units) */
  totalFee: number;
  rank: number;
};

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GMGN metadata is attacker-controlled. Strip control chars and HTML/Markdown
 * actives so a token name can never inject Telegram markup or argv content.
 */
export function sanitizeLabel(v: string | undefined, max = 32): string {
  if (!v) return '';
  return v
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[`*_\[\]()~>#+=|{}.!\\<>&]/g, '')
    .trim()
    .slice(0, max);
}

/** Escape for Telegram HTML / rich HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Compact USD for filter summaries (keeps $). */
export function usdCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Ultra-short numbers for table cells (no $, max ~4 chars body).
 * 1.2B · 45M · 320k · 890
 */
export function numShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (a >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (a >= 100) return `${Math.round(n)}`;
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

/** Compact % for table: +12% / -8% / +0% */
export function pctShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  const abs = Math.abs(n);
  if (abs >= 100) return `${sign}${Math.round(n)}%`;
  if (abs >= 10) return `${sign}${n.toFixed(0)}%`;
  return `${sign}${n.toFixed(1)}%`;
}

function mapToken(raw: GmgnTrendingToken, idx: number): ScreenerToken | null {
  let address: Address;
  try {
    address = assertGmgnAddress(raw.address, 'token');
  } catch {
    return null;
  }
  return {
    address,
    symbol: sanitizeLabel(raw.symbol, 12) || '???',
    name: sanitizeLabel(raw.name, 40) || 'Unknown',
    price: num(raw.price),
    priceChangePct: num(raw.price_change_percent ?? raw.price_change_percent1h),
    volumeUsd: num(raw.volume),
    liquidityUsd: num(raw.liquidity),
    mcapUsd: num(raw.market_cap),
    holders: Math.round(num(raw.holder_count)),
    kol: Math.round(num(raw.renowned_count)),
    totalFee: num(raw.gas_fee),
    rank: num(raw.rank) || idx + 1,
  };
}

function applyClientFilters(
  tokens: ScreenerToken[],
  opts: { maxMcapUsd?: number; minMcapUsd?: number; limit: number },
): ScreenerToken[] {
  const out: ScreenerToken[] = [];
  for (const t of tokens) {
    if (opts.minMcapUsd && opts.minMcapUsd > 0 && t.mcapUsd < opts.minMcapUsd) continue;
    if (opts.maxMcapUsd && opts.maxMcapUsd > 0 && t.mcapUsd > opts.maxMcapUsd) continue;
    out.push(t);
    if (out.length >= opts.limit) break;
  }
  return out;
}

export async function fetchScreenerTokens(
  chainId: SupportedChainId,
  prefs: ScreenerFilterPrefs,
): Promise<ScreenerToken[]> {
  const interval: GmgnTrendingInterval = isScreenerInterval(prefs.screenerInterval)
    ? prefs.screenerInterval
    : '6h';
  const limit = Math.min(100, Math.max(1, Math.round(prefs.screenerLimit || 20)));

  const rank = await gmgnMarketTrending({
    chainId,
    interval,
    limit: Math.min(100, Math.max(limit, 50)),
    minVolumeUsd: prefs.screenerMinVolumeUsd,
    minMarketcapUsd: prefs.screenerMinMcapUsd,
    maxMarketcapUsd: prefs.screenerMaxMcapUsd > 0 ? prefs.screenerMaxMcapUsd : undefined,
    minRenownedCount: prefs.screenerMinKol,
    minGasFee: prefs.screenerMinTotalFee,
    orderBy: 'volume',
    direction: 'desc',
  });

  const mapped: ScreenerToken[] = [];
  for (let i = 0; i < rank.length; i++) {
    const t = mapToken(rank[i]!, i);
    if (t) mapped.push(t);
  }
  return applyClientFilters(mapped, {
    minMcapUsd: prefs.screenerMinMcapUsd,
    maxMcapUsd: prefs.screenerMaxMcapUsd,
    limit,
  });
}

/** 5m volume-alert fetch with alert-specific filters. */
export async function fetchAlertTokens(
  chainId: SupportedChainId,
  prefs: AlertFilterPrefs,
): Promise<ScreenerToken[]> {
  const rank = await gmgnMarketTrending({
    chainId,
    interval: '5m',
    limit: 100,
    minVolumeUsd: prefs.alertMinVolumeUsd,
    minMarketcapUsd: prefs.alertMinMcapUsd,
    maxMarketcapUsd: prefs.alertMaxMcapUsd > 0 ? prefs.alertMaxMcapUsd : undefined,
    minRenownedCount: prefs.alertMinKol,
    minGasFee: prefs.alertMinTotalFee,
    orderBy: 'volume',
    direction: 'desc',
  });

  const mapped: ScreenerToken[] = [];
  for (let i = 0; i < rank.length; i++) {
    const t = mapToken(rank[i]!, i);
    if (t) mapped.push(t);
  }
  return applyClientFilters(mapped, {
    minMcapUsd: prefs.alertMinMcapUsd,
    maxMcapUsd: prefs.alertMaxMcapUsd,
    limit: 30,
  });
}

export function gmgnTokenUrl(chainId: SupportedChainId, address: Address): string {
  const chain = gmgnChainName(chainId);
  return `https://gmgn.ai/${chain}/token/${address}`;
}

export function formatFilterSummary(prefs: ScreenerFilterPrefs): string {
  const vol = usdCompact(prefs.screenerMinVolumeUsd);
  const mcMin = usdCompact(prefs.screenerMinMcapUsd);
  const mcMax =
    prefs.screenerMaxMcapUsd > 0 ? usdCompact(prefs.screenerMaxMcapUsd) : '∞';
  return (
    `${prefs.screenerInterval} · vol≥${vol} · KOL≥${prefs.screenerMinKol} · ` +
    `fees≥${prefs.screenerMinTotalFee} · mc ${mcMin}–${mcMax} · top ${prefs.screenerLimit}`
  );
}

export function formatAlertFilterSummary(prefs: AlertFilterPrefs): string {
  const vol = usdCompact(prefs.alertMinVolumeUsd);
  const mcMin = usdCompact(prefs.alertMinMcapUsd);
  const mcMax = prefs.alertMaxMcapUsd > 0 ? usdCompact(prefs.alertMaxMcapUsd) : '∞';
  return (
    `5m · vol≥${vol} · KOL≥${prefs.alertMinKol} · fees≥${prefs.alertMinTotalFee} · ` +
    `mc ${mcMin}–${mcMax}`
  );
}

/**
 * Compact rich-message table for screener / alerts.
 * Columns: # · Tok · % · MC · Vol · K · Fee
 */
export function formatScreenerRichHtml(
  chainId: SupportedChainId,
  prefs: ScreenerFilterPrefs,
  tokens: ScreenerToken[],
  page: number,
  pageSize: number,
  opts: { title?: string; intervalLabel?: string } = {},
): { html: string; page: number; totalPages: number; pageTokens: ScreenerToken[] } {
  const chain = CHAINS[chainId];
  const totalPages = Math.max(1, Math.ceil(tokens.length / pageSize));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const start = p * pageSize;
  const pageTokens = tokens.slice(start, start + pageSize);

  const filterLine = escapeHtml(formatFilterSummary(prefs));
  const pageNote = tokens.length
    ? `${tokens.length} hit${tokens.length === 1 ? '' : 's'}` +
      (totalPages > 1 ? ` · p${p + 1}/${totalPages}` : '')
    : '0 hits';
  const title = escapeHtml(opts.title ?? `📡 ${chain.name}`);
  const iv = escapeHtml(opts.intervalLabel ?? prefs.screenerInterval);

  if (!pageTokens.length) {
    return {
      html:
        `<h3>${title}</h3>` +
        `<blockquote>${filterLine}</blockquote>` +
        `<p><i>${escapeHtml(pageNote)}</i> — no tokens match.</p>` +
        `<footer>⚙️ Filters · 🔄 Refresh</footer>`,
      page: p,
      totalPages,
      pageTokens,
    };
  }

  const headerRow =
    `<tr>` +
    `<th align="center">#</th>` +
    `<th align="left">Tok</th>` +
    `<th align="right">%</th>` +
    `<th align="right">MC</th>` +
    `<th align="right">Vol</th>` +
    `<th align="right">K</th>` +
    `<th align="right">Fee</th>` +
    `</tr>`;

  const dataRows = pageTokens
    .map((t, i) => {
      const n = start + i + 1;
      const chg = t.priceChangePct;
      const chgStr = escapeHtml(pctShort(chg));
      const chgCell =
        chg > 2 ? `<b>${chgStr}</b>` : chg < -2 ? `<s>${chgStr}</s>` : chgStr;
      const sym = escapeHtml(t.symbol.slice(0, 8));
      const url = gmgnTokenUrl(chainId, t.address);
      const fee =
        t.totalFee >= 100
          ? t.totalFee.toFixed(0)
          : t.totalFee >= 10
            ? t.totalFee.toFixed(1)
            : t.totalFee.toFixed(2);
      return (
        `<tr>` +
        `<td align="center">${n}</td>` +
        `<td align="left"><a href="${url}"><b>$${sym}</b></a></td>` +
        `<td align="right">${chgCell}</td>` +
        `<td align="right">${escapeHtml(numShort(t.mcapUsd))}</td>` +
        `<td align="right">${escapeHtml(numShort(t.volumeUsd))}</td>` +
        `<td align="right">${t.kol}</td>` +
        `<td align="right">${fee}</td>` +
        `</tr>`
      );
    })
    .join('');

  const caption = escapeHtml(`${chain.name} · ${iv} · ${pageNote}`);

  const caItems = pageTokens
    .map((t, i) => {
      const n = start + i + 1;
      const sym = escapeHtml(t.symbol);
      return `<li><b>${n}. $${sym}</b> <code>${t.address}</code></li>`;
    })
    .join('');

  const html =
    `<h3>${title}</h3>` +
    `<blockquote>${filterLine}</blockquote>` +
    `<table bordered striped>` +
    `<caption>${caption}</caption>` +
    headerRow +
    dataRows +
    `</table>` +
    `<details>` +
    `<summary>CAs</summary>` +
    `<ol start="${start + 1}">${caItems}</ol>` +
    `</details>` +
    `<footer>🚀 Mint · ⚙️ Filters · 🔔 Alerts</footer>`;

  return { html, page: p, totalPages, pageTokens };
}

/** Compact alert notification (new hits only). */
export function formatAlertRichHtml(
  chainId: SupportedChainId,
  prefs: AlertFilterPrefs,
  tokens: ScreenerToken[],
): string {
  const chain = CHAINS[chainId];
  const filterLine = escapeHtml(formatAlertFilterSummary(prefs));
  if (!tokens.length) {
    return (
      `<h3>🔔 5m vol · ${escapeHtml(chain.name)}</h3>` +
      `<blockquote>${filterLine}</blockquote>` +
      `<p>No new hits.</p>`
    );
  }

  const headerRow =
    `<tr>` +
    `<th align="left">Tok</th>` +
    `<th align="right">%</th>` +
    `<th align="right">MC</th>` +
    `<th align="right">Vol5m</th>` +
    `<th align="right">K</th>` +
    `<th align="right">Fee</th>` +
    `</tr>`;

  const rows = tokens
    .slice(0, 15)
    .map((t) => {
      const chg = t.priceChangePct;
      const chgStr = escapeHtml(pctShort(chg));
      const chgCell = chg > 2 ? `<b>${chgStr}</b>` : chg < -2 ? `<s>${chgStr}</s>` : chgStr;
      const sym = escapeHtml(t.symbol.slice(0, 8));
      const url = gmgnTokenUrl(chainId, t.address);
      const fee =
        t.totalFee >= 100
          ? t.totalFee.toFixed(0)
          : t.totalFee >= 10
            ? t.totalFee.toFixed(1)
            : t.totalFee.toFixed(2);
      return (
        `<tr>` +
        `<td align="left"><a href="${url}"><b>$${sym}</b></a></td>` +
        `<td align="right">${chgCell}</td>` +
        `<td align="right">${escapeHtml(numShort(t.mcapUsd))}</td>` +
        `<td align="right"><b>${escapeHtml(numShort(t.volumeUsd))}</b></td>` +
        `<td align="right">${t.kol}</td>` +
        `<td align="right">${fee}</td>` +
        `</tr>`
      );
    })
    .join('');

  const caItems = tokens
    .slice(0, 15)
    .map(
      (t) =>
        `<li><b>$${escapeHtml(t.symbol)}</b> <code>${t.address}</code></li>`,
    )
    .join('');

  return (
    `<h3>🔔 5m vol spike · ${escapeHtml(chain.name)}</h3>` +
    `<blockquote>${filterLine}</blockquote>` +
    `<p><b>${tokens.length}</b> new · poll 60s</p>` +
    `<table bordered striped>` +
    `<caption>${tokens.length} new hit${tokens.length === 1 ? '' : 's'}</caption>` +
    headerRow +
    rows +
    `</table>` +
    `<details><summary>CAs</summary><ul>${caItems}</ul></details>` +
    `<footer>Tap 🚀 Mint below</footer>`
  );
}

/** @deprecated */
export function formatScreenerHtml(
  chainId: SupportedChainId,
  prefs: ScreenerFilterPrefs,
  tokens: ScreenerToken[],
  page: number,
  pageSize: number,
): { text: string; page: number; totalPages: number; pageTokens: ScreenerToken[] } {
  const r = formatScreenerRichHtml(chainId, prefs, tokens, page, pageSize);
  return { text: r.html, page: r.page, totalPages: r.totalPages, pageTokens: r.pageTokens };
}

/** Rich HTML for the filters panel. */
export function formatScreenerFiltersRichHtml(
  chainId: SupportedChainId,
  prefs: ScreenerFilterPrefs & AlertFilterPrefs,
): string {
  const chain = CHAINS[chainId];
  const summary = escapeHtml(formatFilterSummary(prefs));
  const alertSum = escapeHtml(formatAlertFilterSummary(prefs));
  const maxMc =
    prefs.screenerMaxMcapUsd > 0
      ? usdCompact(prefs.screenerMaxMcapUsd)
      : '∞';
  return (
    `<h3>⚙️ Screener & alerts</h3>` +
    `<p><b>${escapeHtml(chain.name)}</b></p>` +
    `<h4>📡 Screener</h4>` +
    `<blockquote>${summary}</blockquote>` +
    `<table bordered striped>` +
    `<tr><th align="left">Field</th><th align="right">Value</th></tr>` +
    `<tr><td>Interval</td><td align="right"><b>${escapeHtml(prefs.screenerInterval)}</b></td></tr>` +
    `<tr><td>Min vol</td><td align="right"><b>${escapeHtml(usdCompact(prefs.screenerMinVolumeUsd))}</b></td></tr>` +
    `<tr><td>KOL</td><td align="right"><b>${prefs.screenerMinKol}</b></td></tr>` +
    `<tr><td>Fees</td><td align="right"><b>${prefs.screenerMinTotalFee}</b></td></tr>` +
    `<tr><td>Min MC</td><td align="right"><b>${escapeHtml(usdCompact(prefs.screenerMinMcapUsd))}</b></td></tr>` +
    `<tr><td>Max MC</td><td align="right"><b>${escapeHtml(maxMc)}</b></td></tr>` +
    `<tr><td>Limit</td><td align="right"><b>${prefs.screenerLimit}</b></td></tr>` +
    `</table>` +
    `<h4>🔔 5m volume alerts</h4>` +
    `<blockquote>${prefs.alertEnabled ? 'ON' : 'OFF'} · ${alertSum}</blockquote>` +
    `<table bordered striped>` +
    `<tr><th align="left">Field</th><th align="right">Value</th></tr>` +
    `<tr><td>Status</td><td align="right"><b>${prefs.alertEnabled ? 'ON' : 'OFF'}</b></td></tr>` +
    `<tr><td>Min vol 5m</td><td align="right"><b>${escapeHtml(usdCompact(prefs.alertMinVolumeUsd))}</b></td></tr>` +
    `<tr><td>KOL</td><td align="right"><b>${prefs.alertMinKol}</b></td></tr>` +
    `<tr><td>Fees</td><td align="right"><b>${prefs.alertMinTotalFee}</b></td></tr>` +
    `<tr><td>Min MC</td><td align="right"><b>${escapeHtml(usdCompact(prefs.alertMinMcapUsd))}</b></td></tr>` +
    `<tr><td>Max MC</td><td align="right"><b>${escapeHtml(
      prefs.alertMaxMcapUsd > 0 ? usdCompact(prefs.alertMaxMcapUsd) : '∞',
    )}</b></td></tr>` +
    `</table>` +
    `<footer>Poll every 60s · 5m trending · edit below</footer>`
  );
}
