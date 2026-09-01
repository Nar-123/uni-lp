import { Token, tickToPrice } from './uniswap.js';
import type { SupportedChainId } from '../config.js';
import { CHAINS } from '../config.js';

/** Stablecoin symbols we orient prices against (quote = stable). */
const STABLE_SYMBOLS = new Set(['USDG', 'USDC', 'USDT', 'DAI', 'BUSD', 'USD1']);

export function isStableSymbol(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toUpperCase());
}

/**
 * How many multiples pool/range can diverge from DexScreener before we warn.
 * 1.5 = 50% off market (e.g. pool 0.0015 vs market 0.001).
 * Even ~50% can wreck single-sided LP — keep this tight.
 */
export const PRICE_MISMATCH_RATIO = 1.5;

const SUB: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
};

function toSubscript(n: number): string {
  return String(n)
    .split('')
    .map((c) => SUB[c] ?? c)
    .join('');
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

export function formatHumanPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return n.toExponential(3);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) {
    const s = abs >= 100 ? n.toFixed(2) : abs >= 10 ? n.toFixed(4) : n.toFixed(6);
    return trimZeros(s);
  }
  if (abs >= 1e-3) return trimZeros(n.toFixed(6));
  return formatSubscriptPrice(n);
}

/**
 * Compact tiny prices: 0.0000390 → 0.0₄390
 * (count of zeros after decimal before first non-zero as subscript)
 */
export function formatSubscriptPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n < 0) return `-${formatSubscriptPrice(-n)}`;
  if (n >= 0.001) return formatHumanPrice(n);

  // Use enough precision
  const raw = n.toFixed(20);
  const m = raw.match(/^0\.(0*)([1-9]\d*)/);
  if (!m) return n.toExponential(3);
  const zeroCount = m[1].length;
  // take ~3 significant digits from the rest
  let rest = m[2].replace(/0+$/, '');
  if (rest.length > 3) rest = rest.slice(0, 3);
  return `0.0${toSubscript(zeroCount)}${rest}`;
}

export function priceAtTick(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tick: number;
}): { price: number; inverse: number } {
  const t0 = new Token(params.chainId, params.token0, params.decimals0, params.symbol0);
  const t1 = new Token(params.chainId, params.token1, params.decimals1, params.symbol1);
  const p = tickToPrice(t0, t1, params.tick);
  const price = parseFloat(p.toSignificant(12));
  const inverse = price > 0 ? 1 / price : 0;
  return { price, inverse };
}

function nativeUnit(symbol: string): 'ETH' | 'BNB' | null {
  const s = symbol.toUpperCase();
  if (s === 'WETH' || s === 'ETH') return 'ETH';
  if (s === 'WBNB' || s === 'BNB') return 'BNB';
  return null;
}

/**
 * Display orientation for a pool:
 * - stable/meme → always **stable per 1 meme** (DexScreener-style meme priced in USDG/USDC/USDT)
 * - native/meme → **native per 1 meme** (ETH/BNB per alt)
 * - else → token1 per token0
 *
 * Uniswap raw price = token1 per token0; inverse = token0 per token1.
 */
export type PriceOrientation = {
  /** Multiply raw token1/token0 price by this to get display units */
  useInverse: boolean;
  /** Label like MEME/USDG or MEME/ETH (base/quote convention users expect) */
  unitLabel: string;
  /** Quote symbol only (USDG, ETH) for short "now X USDG" lines */
  quoteSymbol: string;
  /** Base (meme/alt) symbol */
  baseSymbol: string;
  kind: 'stable' | 'native' | 'raw';
};

export function resolvePriceOrientation(params: {
  symbol0: string;
  symbol1: string;
}): PriceOrientation {
  const s0 = params.symbol0;
  const s1 = params.symbol1;
  const st0 = isStableSymbol(s0);
  const st1 = isStableSymbol(s1);
  const n0 = nativeUnit(s0);
  const n1 = nativeUnit(s1);

  // Stable + non-stable → force stable-per-meme (meme/USDG label)
  if (st0 && !st1) {
    // token0=stable, token1=meme → need inverse (stable per meme)
    return {
      useInverse: true,
      unitLabel: `${s1}/${s0}`,
      quoteSymbol: s0,
      baseSymbol: s1,
      kind: 'stable',
    };
  }
  if (st1 && !st0) {
    // token1=stable, token0=meme → price is already stable per meme
    return {
      useInverse: false,
      unitLabel: `${s0}/${s1}`,
      quoteSymbol: s1,
      baseSymbol: s0,
      kind: 'stable',
    };
  }

  // Native + non-native → native per alt (meme priced in ETH/BNB)
  if (n0 && !n1) {
    return {
      useInverse: true,
      unitLabel: `${s1}/${n0}`,
      quoteSymbol: n0,
      baseSymbol: s1,
      kind: 'native',
    };
  }
  if (n1 && !n0) {
    return {
      useInverse: false,
      unitLabel: `${s0}/${n1}`,
      quoteSymbol: n1,
      baseSymbol: s0,
      kind: 'native',
    };
  }

  return {
    useInverse: false,
    unitLabel: `${s1}/${s0}`,
    quoteSymbol: s1,
    baseSymbol: s0,
    kind: 'raw',
  };
}

/** Display price at a tick in oriented units (quote per 1 base). */
export function orientedPriceAtTick(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tick: number;
  orientation?: PriceOrientation;
}): { value: number; orientation: PriceOrientation } {
  const orientation =
    params.orientation ??
    resolvePriceOrientation({ symbol0: params.symbol0, symbol1: params.symbol1 });
  const raw = priceAtTick(params);
  const value = orientation.useInverse ? raw.inverse : raw.price;
  return { value, orientation };
}

/**
 * Human side note for single-sided mint confirms.
 *
 * Tick-space "above" means higher Uniswap ticks. When we invert for meme/stable
 * display (useInverse), higher ticks = **lower** meme/USDG price — so the old
 * "range ABOVE pool tick" line lied to users who read FRONG/USDG numbers.
 *
 * @param side tick-space side from computeSingleSidedRange
 * @param depositSymbol what the wallet is depositing
 */
export function describeSingleSidedSide(params: {
  side: 'above' | 'below';
  orientation: PriceOrientation;
  depositSymbol: string;
  baseSymbol: string;
  quoteSymbol: string;
}): string {
  const { side, orientation, depositSymbol } = params;
  // In display units (quote per 1 base): invert flips above↔below
  const rangeAboveDisplay =
    orientation.useInverse ? side === 'below' : side === 'above';

  const dep = depositSymbol;
  const unit = orientation.unitLabel;

  if (rangeAboveDisplay) {
    // Range is higher meme price than now → needs pump to fill
    // Usually deposit = meme (token1 when stable is token0 after invert logic)
    return (
      `range ABOVE market (${unit}) · ` +
      `single-sided ${dep} — fills if ${orientation.baseSymbol} pumps into range`
    );
  }
  // Range is lower meme price than now → needs dump to fill
  return (
    `range BELOW market (${unit}) · ` +
    `single-sided ${dep} — fills if ${orientation.baseSymbol} dumps into range`
  );
}

/**
 * Compact range for list / mint confirm.
 * Stable/meme pairs always show **stable per meme** (meme/USDG), matching DexScreener.
 * Native pairs show native per alt. Example: `0.0₅185–0.0₅210 (now 0.0₅190) MEME/USDG`
 */
export function formatCompactRange(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  /** Prefer showing this token as the quote (denominator). Default: WETH/WBNB if present. */
  preferQuoteSymbol?: string;
  /**
   * DexScreener market in oriented units (meme/stable).
   * When set, shown in parens instead of pool "now" tick.
   */
  marketPrice?: number | null;
}): string {
  const orientation = resolvePriceOrientation(params);
  const lo = orientedPriceAtTick({ ...params, tick: params.tickLower, orientation });
  const hi = orientedPriceAtTick({ ...params, tick: params.tickUpper, orientation });

  // After orientation, low tick may be higher price than high tick (or vice versa)
  const a = Math.min(lo.value, hi.value);
  const b = Math.max(lo.value, hi.value);

  const market =
    params.marketPrice != null &&
    Number.isFinite(params.marketPrice) &&
    params.marketPrice > 0
      ? params.marketPrice
      : null;

  if (market != null) {
    return (
      `${formatSubscriptPrice(a)}–${formatSubscriptPrice(b)} ` +
      `(market ${formatSubscriptPrice(market)}) ${orientation.unitLabel}`
    );
  }

  // Fallback when no DexScreener price (list positions, post-mint, etc.)
  const cur = orientedPriceAtTick({ ...params, tick: params.currentTick, orientation });
  return (
    `${formatSubscriptPrice(a)}–${formatSubscriptPrice(b)} ` +
    `(now ${formatSubscriptPrice(cur.value)}) ${orientation.unitLabel}`
  );
}

/** Compact mcap: 530k · 1.1M · $12.5B */
export function formatMcapCompact(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '?';
  const abs = Math.abs(usd);
  if (abs >= 1e12) return `${(usd / 1e12).toFixed(2).replace(/\.?0+$/, '')}T`;
  if (abs >= 1e9) return `${(usd / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1e6) {
    const m = usd / 1e6;
    return m >= 10 ? `${m.toFixed(1).replace(/\.0$/, '')}M` : `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (abs >= 1e3) {
    const k = usd / 1e3;
    // 530k style (no $); round nicely
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(0)}k`;
  }
  return usd.toFixed(0);
}

/**
 * FDV/mcap at oriented prices: price (quote per base) × quoteUsd × base supply.
 * For USDT pairs quoteUsd≈1; for ETH/BNB pairs quoteUsd = native USD.
 */
export function mcapAtOrientedPrice(params: {
  orientedPrice: number;
  quoteUsd: number;
  /** Human units of base (meme) supply = totalSupply / 10^decimals */
  baseSupplyHuman: number;
}): number | null {
  const { orientedPrice, quoteUsd, baseSupplyHuman } = params;
  if (
    !(orientedPrice > 0) ||
    !(quoteUsd > 0) ||
    !(baseSupplyHuman > 0) ||
    !Number.isFinite(orientedPrice) ||
    !Number.isFinite(quoteUsd) ||
    !Number.isFinite(baseSupplyHuman)
  ) {
    return null;
  }
  const m = orientedPrice * quoteUsd * baseSupplyHuman;
  return Number.isFinite(m) && m > 0 ? m : null;
}

/** e.g. `530k mcap – 1.1M mcap` */
export function formatMcapRange(lowUsd: number, highUsd: number): string {
  const a = Math.min(lowUsd, highUsd);
  const b = Math.max(lowUsd, highUsd);
  return `${formatMcapCompact(a)} mcap – ${formatMcapCompact(b)} mcap`;
}

/**
 * Current spot in oriented units (stable/meme → meme/USDG style).
 * e.g. `0.0₅190 MEME/USDG` or `0.0₅190 MEME/ETH`
 */
export function formatSpotPrice(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tick: number;
}): string {
  const { value, orientation } = orientedPriceAtTick(params);
  return `${formatSubscriptPrice(value)} ${orientation.unitLabel}`;
}

/**
 * Compare pool-oriented spot (and optional range) to DexScreener market.
 * Market for stable/meme ≈ meme USD (stable ≈ $1). For native pairs: memeUsd / nativeUsd.
 */
export type PriceMismatchReport = {
  mismatch: boolean;
  ratio: number | null;
  poolPrice: number;
  marketPrice: number | null;
  rangeLow: number;
  rangeHigh: number;
  unitLabel: string;
  /** Human lines for confirm UI */
  lines: string[];
};

/** Mint confirm payload — text + optional DexScreener mismatch guard */
export type MintPreviewResult = {
  text: string;
  /** True when pool/range diverges hard from DexScreener — bot should require 2nd confirm */
  priceMismatch: boolean;
  mismatch?: PriceMismatchReport;
};

export function evaluatePriceMismatch(params: {
  poolPrice: number;
  marketPrice: number | null;
  rangeLow: number;
  rangeHigh: number;
  unitLabel: string;
  threshold?: number;
}): PriceMismatchReport {
  const threshold = params.threshold ?? PRICE_MISMATCH_RATIO;
  const { poolPrice, marketPrice, rangeLow, rangeHigh, unitLabel } = params;

  const lines: string[] = [];
  let worst = 1;
  let mismatch = false;

  const ratioOf = (a: number, b: number) => {
    if (!(a > 0) || !(b > 0)) return 1;
    return a > b ? a / b : b / a;
  };

  const pctOff = (r: number) => `${((r - 1) * 100).toFixed(0)}%`;

  if (marketPrice != null && marketPrice > 0 && poolPrice > 0) {
    const r = ratioOf(poolPrice, marketPrice);
    if (r > worst) worst = r;
    if (r >= threshold) {
      mismatch = true;
      const dir = poolPrice > marketPrice ? 'above' : 'below';
      lines.push(
        `⚠️ Pool tick ${pctOff(r)} ${dir} DexScreener (~${r.toFixed(2)}×)`,
      );
      lines.push(
        `  Pool now: ${formatSubscriptPrice(poolPrice)} ${unitLabel}`,
      );
      lines.push(
        `  Market:   ${formatSubscriptPrice(marketPrice)} ${unitLabel}`,
      );
      lines.push(
        `  Thin/manipulated pools can lie — minting here can lose money.`,
      );
    }
  }

  // Single-sided stable only: range must sit BELOW DexScreener market.
  // 1) min (rangeLow) >> market → entire band ABOVE market → instant fill / arb risk
  // 2) max (rangeHigh) far below market → entry too distant (optional distance guard)
  // Never use geometric mid (far edge false-alarms on wide %).
  if (marketPrice != null && marketPrice > 0 && rangeLow > 0 && rangeHigh > 0) {
    const minP = rangeLow;
    const maxP = rangeHigh;

    // Arb: min above market (range wholly above real price)
    if (minP > marketPrice) {
      const rMin = ratioOf(minP, marketPrice);
      if (rMin > worst) worst = rMin;
      // Any min > market is wrong for buy-dip; hard-warn if ≥ threshold, still warn if smaller
      if (rMin >= threshold || minP > marketPrice) {
        mismatch = true;
        lines.push(
          `⚠️ Range MIN is ABOVE DexScreener — arb / wrong side (~${rMin.toFixed(2)}×)`,
        );
        lines.push(
          `  Range min: ${formatSubscriptPrice(minP)} ${unitLabel}`,
        );
        lines.push(
          `  Market:    ${formatSubscriptPrice(marketPrice)} ${unitLabel}`,
        );
        lines.push(
          `  Pool tick may be juiced; real market already below your band → you get filled bad.`,
        );
      }
    } else if (maxP > 0 && maxP < marketPrice) {
      // Healthy side (max below market): only flag if near edge is too far from market
      const rMax = ratioOf(maxP, marketPrice);
      if (rMax > worst) worst = rMax;
      if (rMax >= threshold) {
        mismatch = true;
        if (!lines.some((l) => l.startsWith('⚠️'))) {
          lines.push(
            `⚠️ Range max ${pctOff(rMax)} below DexScreener (~${rMax.toFixed(2)}×)`,
          );
        }
        lines.push(
          `  Range max: ${formatSubscriptPrice(maxP)} ${unitLabel}`,
        );
        lines.push(
          `  Market:    ${formatSubscriptPrice(marketPrice)} ${unitLabel}`,
        );
        lines.push(
          `  Needs a deep dump to fill — check pool vs market.`,
        );
      }
    }
  }

  if (mismatch) {
    lines.push(`Tap ⚠️ Confirm anyway only if you understand the risk.`);
  }

  return {
    mismatch,
    ratio: marketPrice != null && marketPrice > 0 ? worst : null,
    poolPrice,
    marketPrice,
    rangeLow,
    rangeHigh,
    unitLabel,
    lines,
  };
}

export function formatPriceRange(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tickLower: number;
  tickUpper: number;
  currentTick?: number;
}): string {
  const lo = priceAtTick({ ...params, tick: params.tickLower });
  const hi = priceAtTick({ ...params, tick: params.tickUpper });
  let line =
    `${formatHumanPrice(lo.price)} → ${formatHumanPrice(hi.price)} ${params.symbol1} per ${params.symbol0}\n` +
    `  (${formatHumanPrice(hi.inverse)} → ${formatHumanPrice(lo.inverse)} ${params.symbol0} per ${params.symbol1})`;
  if (params.currentTick != null) {
    const cur = priceAtTick({ ...params, tick: params.currentTick });
    line += `\n  now: ${formatHumanPrice(cur.price)} ${params.symbol1}/${params.symbol0}`;
  }
  return line;
}

export function uniswapPositionUrl(
  chainId: SupportedChainId,
  tokenId: string | bigint,
  protocol: 'v3' | 'v4' = 'v3',
  dex: import('../config.js').DexId = 'uniswap',
): string {
  if (dex === 'pancakeswap' && protocol === 'v3') {
    // Official PCS liquidity page for the position NFT
    return `https://pancakeswap.finance/liquidity/${tokenId.toString()}?chain=bsc`;
  }
  // Uniswap app path slugs differ from DexScreener for some chains
  const appSlug =
    chainId === 56 ? 'bnb' : chainId === 8453 ? 'base' : CHAINS[chainId].dexscreenerSlug;
  const ver = protocol === 'v4' ? 'v4' : 'v3';
  return `https://app.uniswap.org/positions/${ver}/${appSlug}/${tokenId.toString()}`;
}

export function formatAge(openedAtMs: number | null | undefined): string {
  if (!openedAtMs) return '?';
  const h = Math.max(0, (Date.now() - openedAtMs) / 3_600_000);
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/**
 * Compact native-denominated value prefix:
 * - ETH chains → `E 0.0123`
 * - BSC (BNB) → `B 0.0123`
 */
export function nativeValPrefix(chainId?: SupportedChainId | number): 'E' | 'B' {
  return chainId === 56 ? 'B' : 'E';
}

/** Native-style value: E 0.0123 (ETH) or B 0.0123 (BNB on BSC) */
export function formatEthVal(amount: number, chainId?: SupportedChainId | number): string {
  const unit = nativeValPrefix(chainId);
  if (!Number.isFinite(amount) || amount === 0) return `${unit} 0.0000`;
  if (Math.abs(amount) >= 1) return `${unit} ${amount.toFixed(4)}`;
  if (Math.abs(amount) >= 0.0001) return `${unit} ${amount.toFixed(4)}`;
  return `${unit} ${amount.toFixed(6)}`;
}
