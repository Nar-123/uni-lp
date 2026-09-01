import type { Address } from 'viem';
import {
  availableV3Dexes,
  CHAINS,
  type DexId,
  type SupportedChainId,
} from '../config.js';

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number };
  feeTier?: number | string;
  url?: string;
};

type PriceCacheEntry = { usd: number; at: number; source: string };
const priceCache = new Map<string, PriceCacheEntry>();
const CACHE_MS = 60_000; // 60s — enough for /list to reuse prices across positions

function cacheKey(chainId: SupportedChainId, token: string): string {
  return `${chainId}:${token.toLowerCase()}`;
}

export async function fetchTokenPairs(tokenAddress: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener error ${res.status}`);
  const data = (await res.json()) as { pairs?: DexPair[] | null };
  return data.pairs ?? [];
}

/** Map DexScreener dexId string → our DexId (or null if unsupported) */
export function pairDexId(pair: DexPair): DexId | null {
  const dex = (pair.dexId ?? '').toLowerCase();
  if (dex === 'uniswap') return 'uniswap';
  // DexScreener uses "pancakeswap" (sometimes "pancake")
  if (dex === 'pancakeswap' || dex === 'pancake' || dex.startsWith('pancakeswap')) {
    return 'pancakeswap';
  }
  return null;
}

function isV3Pair(p: DexPair): boolean {
  const labels = (p.labels ?? []).map((l) => l.toLowerCase());
  // Exclude v2 and v4; accept unlabeled (legacy) or explicit v3
  if (labels.includes('v2') || labels.includes('v4')) return false;
  if (labels.length && !labels.includes('v3')) return false;
  // v4 poolIds are 32-byte hex (66 chars incl 0x); v3 addresses are 20-byte
  if ((p.pairAddress?.length ?? 0) > 42) return false;
  return true;
}

/**
 * V3 pairs on our chain for the given venues, sorted by TVL desc.
 * On BSC defaults to Uniswap + PancakeSwap; elsewhere Uniswap only.
 */
export async function fetchV3PoolsForToken(
  chainId: SupportedChainId,
  tokenAddress: Address,
  dexes: DexId[] = availableV3Dexes(chainId),
): Promise<DexPair[]> {
  const slug = CHAINS[chainId].dexscreenerSlug;
  const allowed = new Set(dexes);
  const pairs = await fetchTokenPairs(tokenAddress);
  const filtered = pairs.filter((p) => {
    if (p.chainId?.toLowerCase() !== slug) return false;
    const d = pairDexId(p);
    if (!d || !allowed.has(d)) return false;
    return isV3Pair(p);
  });

  filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return filtered;
}

/** @deprecated use fetchV3PoolsForToken — Uniswap-only alias */
export async function fetchUniswapV3PoolsForToken(
  chainId: SupportedChainId,
  tokenAddress: Address,
): Promise<DexPair[]> {
  return fetchV3PoolsForToken(chainId, tokenAddress, ['uniswap']);
}

/** Uniswap v4 pairs on our chain (labels include v4; pairAddress is poolId bytes32) */
export async function fetchUniswapV4PoolsForToken(
  chainId: SupportedChainId,
  tokenAddress: Address,
): Promise<DexPair[]> {
  const slug = CHAINS[chainId].dexscreenerSlug;
  const pairs = await fetchTokenPairs(tokenAddress);
  const filtered = pairs.filter((p) => {
    if (p.chainId?.toLowerCase() !== slug) return false;
    const dex = (p.dexId ?? '').toLowerCase();
    if (dex !== 'uniswap') return false;
    const labels = (p.labels ?? []).map((l) => l.toLowerCase());
    if (!labels.includes('v4')) return false;
    return true;
  });

  filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return filtered;
}

/**
 * Lookup a single pair by address / v4 poolId via DexScreener.
 * Works for v3 pool contracts (0x+40) and v4 poolIds (0x+64).
 */
export async function fetchPairByAddress(
  chainId: SupportedChainId,
  pairAddress: string,
): Promise<DexPair | null> {
  const slug = CHAINS[chainId].dexscreenerSlug;
  const addr = pairAddress.startsWith('0x') ? pairAddress : `0x${pairAddress}`;
  const url = `https://api.dexscreener.com/latest/dex/pairs/${slug}/${addr}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { pair?: DexPair | null; pairs?: DexPair[] | null };
    if (data.pair && data.pair.pairAddress) return data.pair;
    if (data.pairs?.length) return data.pairs[0]!;
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract USD price of `token` from a DexScreener pair.
 * priceUsd is ALWAYS the base token's USD price — never use it blindly for quote tokens.
 */
function priceUsdFromPair(pair: DexPair, tokenAddress: string): number | null {
  const lower = tokenAddress.toLowerCase();
  const base = pair.baseToken?.address?.toLowerCase();
  const quote = pair.quoteToken?.address?.toLowerCase();
  const baseUsd = Number(pair.priceUsd);
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return null;

  if (base === lower) return baseUsd;

  if (quote === lower) {
    // base priced in quote: priceNative ≈ base/quote (quote units per 1 base)
    // so quoteUsd = baseUsd / priceNative
    const priceNative = Number(pair.priceNative);
    if (Number.isFinite(priceNative) && priceNative > 0) {
      const q = baseUsd / priceNative;
      if (Number.isFinite(q) && q > 0) return q;
    }
    // liquidity fallback: quoteUsd ≈ (liq.usd * quote_share) / quote_amount — rough
    const liqUsd = pair.liquidity?.usd;
    const quoteAmt = pair.liquidity?.quote;
    if (liqUsd && quoteAmt && quoteAmt > 0) {
      // assume ~half of pool USD is quote (ok for deep stable/ETH pools only)
      const q = liqUsd / 2 / quoteAmt;
      if (Number.isFinite(q) && q > 0.01) return q; // reject nonsense
    }
  }
  return null;
}

function scorePairForToken(pair: DexPair, tokenAddress: string): number {
  const lower = tokenAddress.toLowerCase();
  const base = pair.baseToken?.address?.toLowerCase();
  const liq = pair.liquidity?.usd ?? 0;
  // Prefer token as base (priceUsd is direct), then high liquidity
  const baseBoost = base === lower ? 1e12 : 0;
  return baseBoost + liq;
}

/**
 * Reliable USD price for a token on a chain.
 */
export async function getTokenPriceUsd(
  chainId: SupportedChainId,
  tokenAddress: Address,
): Promise<number | null> {
  const c = CHAINS[chainId];
  // Native (v4 0x0) prices the same as wrapped
  const resolved: Address =
    tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000'
      ? c.wrapped
      : tokenAddress;

  const key = cacheKey(chainId, resolved);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.usd;

  const lower = resolved.toLowerCase();

  // Stables
  if (c.usdg && c.usdg.toLowerCase() === lower) {
    priceCache.set(key, { usd: 1, at: Date.now(), source: 'stable-peg' });
    return 1;
  }
  if (c.usdt && c.usdt.toLowerCase() === lower) {
    priceCache.set(key, { usd: 1, at: Date.now(), source: 'stable-peg' });
    return 1;
  }
  if (c.usdc && c.usdc.toLowerCase() === lower) {
    priceCache.set(key, { usd: 1, at: Date.now(), source: 'stable-peg' });
    return 1;
  }

  const slug = c.dexscreenerSlug;
  const pairs = await fetchTokenPairs(resolved);
  const onChain = pairs.filter((p) => p.chainId?.toLowerCase() === slug);
  const candidates = (onChain.length ? onChain : pairs)
    .slice()
    .sort((a, b) => scorePairForToken(b, lower) - scorePairForToken(a, lower));

  for (const pair of candidates) {
    const px = priceUsdFromPair(pair, lower);
    if (px != null && px > 0) {
      // Sanity: WETH/WBNB shouldn't be under $10 or over $1M
      const isWrapped = c.wrapped.toLowerCase() === lower;
      if (isWrapped && (px < 10 || px > 1_000_000)) continue;
      priceCache.set(key, { usd: px, at: Date.now(), source: 'dexscreener' });
      return px;
    }
  }

  // Wrapped native: try stable pairs explicitly (USDG/WETH, USDT|USDC/WBNB)
  if (c.wrapped.toLowerCase() === lower) {
    const stables = [c.usdg, c.usdt, c.usdc].filter((a): a is typeof c.wrapped => !!a);
    const stable = stables[0];
    if (stable) {
      const stablePairs = await fetchTokenPairs(stable);
      const match = stablePairs
        .filter((p) => p.chainId?.toLowerCase() === slug)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      for (const pair of match) {
        const px = priceUsdFromPair(pair, lower);
        if (px != null && px > 10 && px < 1_000_000) {
          priceCache.set(key, { usd: px, at: Date.now(), source: 'dexscreener' });
          return px;
        }
      }
    }
    // Last resort: ETH price from ethereum mainnet WETH
    try {
      const ethPairs = await fetchTokenPairs('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const ethBest = ethPairs
        .filter((p) => p.chainId === 'ethereum')
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (ethBest?.priceUsd) {
        const px = Number(ethBest.priceUsd);
        if (px > 10 && px < 1_000_000) {
          priceCache.set(key, { usd: px, at: Date.now(), source: 'dexscreener-eth-mainnet-fallback' });
          return px;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

// ── Price freshness contract (Phase 2 Part 4) ─────────────────────────────

export type PriceResult =
  | { ok: true; price: number; source: string; timestamp: number }
  | { ok: false; reason: string };

/**
 * Temporary conservative default — NOT a calibrated production value. Set
 * via MAX_CRITICAL_PRICE_AGE_MS env if a different bound is needed; the
 * default is deliberately a bit above (poll interval + cache TTL) so it
 * doesn't fight the existing 60s DexScreener cache under normal operation,
 * while still catching a genuinely stuck/stale price. Needs real
 * calibration against observed price volatility before being treated as a
 * production-tuned value — see PHASE2_PART4_AUDIT.md §7/§16.
 */
export const MAX_CRITICAL_PRICE_AGE_MS: number =
  Number(process.env.MAX_CRITICAL_PRICE_AGE_MS) > 0
    ? Number(process.env.MAX_CRITICAL_PRICE_AGE_MS)
    : 90_000;

export function isPriceStale(timestampMs: number, maxAgeMs: number = MAX_CRITICAL_PRICE_AGE_MS): boolean {
  return Date.now() - timestampMs > maxAgeMs;
}

/**
 * Critical-path price lookup for automated decisions (TP/SL, position
 * valuation feeding PnL%). Returns the full {ok,price,source,timestamp}
 * contract rather than a bare number, and NEVER silently hands back a
 * stale price: if the cached (or freshly fetched) entry is older than
 * `maxAgeMs`, it forces one bypass-cache refresh; if that refresh also
 * fails or is still stale (e.g. the underlying source itself hasn't moved
 * — can't happen with Date.now()-stamped cache, but defensive), it
 * returns `ok:false` rather than a number a caller might mistake for a
 * live price. Callers must treat `ok:false` as UNKNOWN — never as $0 and
 * never as a reason to disable protection (see tpslLogic.ts's existing
 * null-pnlPct-never-triggers contract, which this feeds into unchanged).
 */
export async function getCriticalTokenPriceUsd(
  chainId: SupportedChainId,
  tokenAddress: Address,
  maxAgeMs: number = MAX_CRITICAL_PRICE_AGE_MS,
): Promise<PriceResult> {
  const c = CHAINS[chainId];
  const resolved: Address =
    tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000'
      ? c.wrapped
      : tokenAddress;
  const key = cacheKey(chainId, resolved);

  try {
    const price = await getTokenPriceUsd(chainId, tokenAddress);
    if (price == null) return { ok: false, reason: 'price unavailable' };

    let meta = priceCache.get(key);
    if (!meta) return { ok: false, reason: 'price unavailable (no cache metadata)' };

    if (isPriceStale(meta.at, maxAgeMs)) {
      priceCache.delete(key); // force a real refetch, bypassing the cache hit
      const fresh = await getTokenPriceUsd(chainId, tokenAddress);
      meta = priceCache.get(key);
      if (fresh == null || meta == null || isPriceStale(meta.at, maxAgeMs)) {
        return { ok: false, reason: 'price stale and refresh failed' };
      }
      return { ok: true, price: fresh, source: meta.source, timestamp: meta.at };
    }

    return { ok: true, price, source: meta.source, timestamp: meta.at };
  } catch (e) {
    // A network/RPC-layer exception (e.g. DexScreener fetch failure) must
    // resolve to the same UNKNOWN contract as a clean null — never
    // propagate as an uncaught rejection that a caller might mishandle.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `price lookup failed: ${msg.slice(0, 160)}` };
  }
}

export async function valueUsd(
  chainId: SupportedChainId,
  tokenAddress: Address,
  amountHuman: number,
): Promise<number> {
  const px = await getTokenPriceUsd(chainId, tokenAddress);
  if (px == null) return 0;
  return amountHuman * px;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export function formatTvl(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return formatUsd(n);
}

/** Clear price cache (e.g. after mint for fresh quotes) */
export function clearPriceCache(): void {
  priceCache.clear();
}
