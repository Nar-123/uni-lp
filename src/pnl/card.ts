import sharp from 'sharp';
import { CHAINS, type SupportedChainId } from '../config.js';
import type { TrackedPosition } from '../db/index.js';
import type { PositionPnl } from './compute.js';

const W = 1080;
const H = 1350;

export type PnlCardInput = {
  pos: TrackedPosition;
  pnl: PositionPnl;
  /** Footer credit — default env CARD_AUTHOR or Bismillah Dawo */
  author?: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCardUsd(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(2)}k`;
  if (a >= 100) return `${sign}$${a.toFixed(2)}`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(4)}`;
  return `${sign}$${a.toFixed(4)}`;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtDate(ts: number): string {
  if (!ts || ts <= 0) return '—';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function quoteSymbol(chainId: SupportedChainId, pos: TrackedPosition): string {
  const c = CHAINS[chainId];
  const wrapped = c.wrapped.toLowerCase();
  const t0 = pos.token0.toLowerCase();
  const t1 = pos.token1.toLowerCase();
  if (t0 === wrapped || t1 === wrapped) return c.wrappedSymbol; // WETH / WBNB
  if (c.usdg && (t0 === c.usdg.toLowerCase() || t1 === c.usdg.toLowerCase())) return 'USDG';
  if (c.usdt && (t0 === c.usdt.toLowerCase() || t1 === c.usdt.toLowerCase())) return 'USDT';
  if (c.usdc && (t0 === c.usdc.toLowerCase() || t1 === c.usdc.toLowerCase())) return 'USDC';
  return c.wrappedSymbol;
}

/** Pair title like WALLET / WETH (uppercase, spaced slash). */
export function cardPairTitle(chainId: SupportedChainId, pos: TrackedPosition): string {
  const quote = quoteSymbol(chainId, pos);
  const label = pos.label?.trim();
  if (label) {
    if (label.includes('/')) {
      return label
        .split('/')
        .map((p) => p.trim().toUpperCase())
        .join(' / ');
    }
    return `${label.toUpperCase()} / ${quote.toUpperCase()}`;
  }
  return `POS #${pos.tokenId} / ${quote.toUpperCase()}`;
}

function chainBrand(chainId: SupportedChainId): { name: string; showFeather: boolean } {
  if (chainId === 4663) return { name: 'Robinhood', showFeather: true };
  if (chainId === 8453) return { name: 'Base', showFeather: false };
  return { name: 'BSC', showFeather: false };
}

function cardAuthor(): string {
  return (process.env.CARD_AUTHOR ?? 'Bismillah Dawo').trim() || 'Bismillah Dawo';
}

/**
 * Build PNG buffer for a PnL share card matching the dark purple Uniswap-style card.
 */
export async function renderPnlCard(input: PnlCardInput): Promise<Buffer> {
  const { pos, pnl } = input;
  const chainId = pos.chainId as SupportedChainId;
  const brand = chainBrand(chainId);
  const protocol =
    pos.protocol === 'v4'
      ? 'V4'
      : pos.dex === 'pancakeswap'
        ? 'PCS'
        : 'V3';
  const title = cardPairTitle(chainId, pos);
  const profit = pnl.pnlUsd >= 0;
  const accent = profit ? '#3DFFB5' : '#FF6B7A';
  const pnlText = fmtCardUsd(pnl.pnlUsd);
  const pctText = fmtPct(pnl.pnlPct);
  const author = esc(input.author ?? cardAuthor());
  const start = fmtDate(pos.openedAt);
  const end = fmtDate(pos.closedAt && pos.closedAt > 0 ? pos.closedAt : Date.now());
  const dateRange = `${start} → ${end}`;

  // Scale title font if long
  const titleLen = title.length;
  const titleSize = titleLen > 22 ? 56 : titleLen > 16 ? 64 : 72;

  // Feather glyph (single clean path) next to Robinhood brand
  const brandBlock = brand.showFeather
    ? `<g transform="translate(${W / 2}, 92)">
        <text x="-14" y="0" text-anchor="end" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="28" font-weight="600" fill="#121018">${esc(brand.name)}</text>
        <path transform="translate(0,-20) scale(1.4)" fill="#121018"
          d="M9.5 1.2c.35-.2.8-.1 1 .25 2.4 4.2 3.8 8.8 3.8 13.4 0 2.6-.6 4.9-1.8 6.6-.25.35-.7.45-1.05.25-.35-.2-.5-.65-.35-1.05.2-.55.3-1.15.3-1.8 0-3.9-1-7.7-2.9-11.2C8.1 5.2 8.5 2.8 9.5 1.2z M6.2 5.5c-1.5 2.6-2.4 5.6-2.4 8.8 0 1.7.3 3.3.85 4.7-.45.1-.9.15-1.35.15C1.3 19.15 0 16.9 0 13.7c0-2.9 1.15-5.6 2.9-7.9.9.4 2.1 1.1 3.3 1.7z"/>
      </g>`
    : `<text x="${W / 2}" y="92" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="28" font-weight="600" fill="#121018">${esc(brand.name)}</text>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="35%" y2="100%">
      <stop offset="0%" stop-color="#4A1B6B"/>
      <stop offset="42%" stop-color="#2A1B4E"/>
      <stop offset="100%" stop-color="#0B1C38"/>
    </linearGradient>
    <linearGradient id="vignette" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.25"/>
    </linearGradient>
  </defs>

  <!-- Card body -->
  <rect x="0" y="0" width="${W}" height="${H}" rx="56" ry="56" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="${H}" rx="56" ry="56" fill="url(#vignette)"/>

  <!-- Protocol pill -->
  <rect x="56" y="56" width="88" height="44" rx="14" ry="14" fill="#2A2438" fill-opacity="0.85"/>
  <text x="100" y="86" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="600" fill="#C8C4D4" letter-spacing="0.5">${esc(protocol)}</text>

  <!-- Chain brand -->
  ${brandBlock}

  <!-- Pair title (serif) -->
  <text x="72" y="280" font-family="Georgia, 'Times New Roman', Times, serif" font-size="${titleSize}" font-weight="400" fill="#F4F0FA" letter-spacing="1">${esc(title)}</text>

  <!-- PnL block -->
  <text x="72" y="980" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="92" font-weight="700" fill="${accent}" letter-spacing="-1.5">${esc(pnlText)}</text>
  <text x="72" y="1055" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="36" font-weight="600" fill="${accent}">${esc(pctText)}</text>

  <!-- Footer -->
  <text x="72" y="1275" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="24" font-weight="500" fill="#8B8799">by ${author}</text>
  <text x="${W - 72}" y="1275" text-anchor="end" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="500" fill="#8B8799">${esc(dateRange)}</text>
</svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 8 }).toBuffer();
}
