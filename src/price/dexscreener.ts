import { type Address, isAddress } from 'viem';
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

// ── Runtime validation boundary for untrusted DexScreener JSON (Phase 4.6.11) ──
//
// `response.json()` returns `any` — the two `as { pairs?: DexPair[] | null }`
// casts that used to sit directly on that value performed ZERO runtime
// checking, so a malformed/unexpected external response would be trusted
// exactly as if DexScreener's own contract guaranteed it. Two concrete,
// non-theoretical failure modes existed as a result:
//   1. Crash: e.g. `pair.dexId` a number instead of a string makes
//      `pairDexId`'s `.toLowerCase()` throw; a `null` element inside
//      `pairs` makes any bare `pair.xxx` access throw.
//   2. Fabricated price: `Number(x)` coerces non-numeric-but-truthy
//      values in surprising ways — `Number([5]) === 5`,
//      `Number(true) === 1` — so a malformed `priceUsd` that is anything
//      other than a real numeric string could silently produce a real,
//      wrong-but-plausible-looking price with no error at all.
//
// The functions below convert `unknown` JSON into either a validated
// `DexPair` or `null`/an explicit rejection — nothing downstream
// (`priceUsdFromPair`, `scorePairForToken`, `isV3Pair`, `pairDexId`, the
// existing filters/sorts, and chain/pools.ts's unguarded
// `pair.baseToken.address` reads, a file this phase does not touch) ever
// sees a `DexPair`-typed value that does not actually match that shape.
//
// Design choice per pair (§16/§17 of the task): the existing architecture
// already treats each pair as an independently-triable candidate (callers
// sort/filter/loop through `DexPair[]`, trying the next one when one
// yields no price) — so a single malformed pair is simply EXCLUDED from
// the returned array rather than failing the whole response, exactly
// mirroring how a pair that merely lacks an optional field (e.g. no
// `priceUsd`) was already tolerated before this phase. Only the two
// STRUCTURAL fields every consumer (inside and outside this file) relies
// on unconditionally — `pairAddress`, and a well-formed `baseToken`/
// `quoteToken` (address/symbol/name, all required strings, address
// additionally checked with viem's `isAddress` — the same validator
// already used elsewhere in this codebase, e.g. src/config.ts) — cause a
// pair to be dropped entirely; every other field (`dexId`, `chainId`,
// `labels`, `priceUsd`, `priceNative`, `liquidity`, `volume`, `feeTier`,
// `url`) downgrades to "absent" on a type mismatch, which the existing,
// UNMODIFIED downstream code already handles safely via its own
// `??`/`?.`/`Number.isFinite` checks — this never fabricates a value,
// it only ever removes one.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** baseToken/quoteToken: required object with three required string fields — chain/pools.ts reads `.address`/`.symbol` on these without optional chaining, so a malformed token-ref must drop the whole pair, not just this field. */
function parseTokenRef(raw: unknown): DexPair['baseToken'] | null {
  if (!isPlainObject(raw)) return null;
  const { address, symbol, name } = raw;
  if (typeof address !== 'string' || !isAddress(address)) return null;
  if (typeof symbol !== 'string' || typeof name !== 'string') return null;
  return { address, symbol, name };
}

/** liquidity is optional; each numeric sub-field is independently validated (finite number or absent — never a string/array/NaN/Infinity reaching the arithmetic in scorePairForToken or the existing liquidity-based sorts). */
function parseLiquidity(raw: unknown): DexPair['liquidity'] {
  if (!isPlainObject(raw)) return undefined;
  return {
    usd: isFiniteNumber(raw.usd) ? raw.usd : undefined,
    base: isFiniteNumber(raw.base) ? raw.base : undefined,
    quote: isFiniteNumber(raw.quote) ? raw.quote : undefined,
  };
}

/** volume.h24 is not read within this file, but flows out to strategy/multiPool.ts — validated here at the boundary the same way (finite number or absent) as defense in depth; multiPool.ts's own Phase 4.6.7 hardening is unmodified and unaffected. */
function parseVolume(raw: unknown): DexPair['volume'] {
  if (!isPlainObject(raw)) return undefined;
  return { h24: isFiniteNumber(raw.h24) ? raw.h24 : undefined };
}

/**
 * Validates one raw pair object from DexScreener JSON. Returns `null` if
 * the pair is structurally unusable (see the design note above) — the
 * caller drops it from the array rather than failing the whole response.
 */
function parseDexPair(raw: unknown): DexPair | null {
  if (!isPlainObject(raw)) return null;

  const pairAddress = raw.pairAddress;
  if (typeof pairAddress !== 'string' || pairAddress.length === 0) return null;

  const baseToken = parseTokenRef(raw.baseToken);
  const quoteToken = parseTokenRef(raw.quoteToken);
  if (!baseToken || !quoteToken) return null;

  let labels: string[] | undefined;
  if (raw.labels != null) {
    if (!Array.isArray(raw.labels) || !raw.labels.every((l) => typeof l === 'string')) {
      // Malformed labels only — not identity-critical, downgrade to absent
      // (matches existing `(p.labels ?? []).map(...)` tolerance for a
      // token that simply has no labels).
      labels = undefined;
    } else {
      labels = raw.labels;
    }
  }

  const feeTier =
    typeof raw.feeTier === 'number' || typeof raw.feeTier === 'string' ? raw.feeTier : undefined;

  return {
    // dexId/chainId are typed non-optional but the existing code already
    // treats them defensively (`pair.dexId ?? ''`, `p.chainId?.toLowerCase()`)
    // — a wrong-typed value downgrades to an empty string, which safely
    // never matches any known dex/chain, rather than crashing `.toLowerCase()`.
    chainId: typeof raw.chainId === 'string' ? raw.chainId : '',
    dexId: typeof raw.dexId === 'string' ? raw.dexId : '',
    pairAddress,
    labels,
    baseToken,
    quoteToken,
    priceUsd: optionalString(raw.priceUsd),
    priceNative: optionalString(raw.priceNative),
    liquidity: parseLiquidity(raw.liquidity),
    volume: parseVolume(raw.volume),
    feeTier,
    url: optionalString(raw.url),
  };
}

/**
 * Validates the `pairs` field of a DexScreener response. `null`/`undefined`
 * (the field is genuinely absent) is the pre-existing, unchanged "no pairs
 * found" case — NOT an error. A present-but-non-array value is a
 * fundamentally malformed response shape and is rejected outright (thrown),
 * consistent with the pre-existing precedent that this module's fetch
 * functions can already throw (e.g. on a non-2xx HTTP status).
 */
function parsePairsArray(raw: unknown): DexPair[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('Invalid DexScreener response: "pairs" is present but not an array');
  }
  const out: DexPair[] = [];
  for (const item of raw) {
    const pair = parseDexPair(item);
    if (pair) out.push(pair);
  }
  return out;
}

/** Validates the full `/latest/dex/tokens/:address` response shape. */
export function parseDexScreenerTokensResponse(raw: unknown): DexPair[] {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid DexScreener response: expected a JSON object');
  }
  return parsePairsArray(raw.pairs);
}

/**
 * Validates the full `/latest/dex/pairs/:chain/:address` response shape.
 * Mirrors the pre-existing preference order exactly: a valid `pair` wins;
 * otherwise the first valid entry of `pairs` is used. A `pair` that fails
 * validation now correctly falls through to `pairs` instead of being
 * returned half-broken (a strict improvement over the prior
 * `data.pair && data.pair.pairAddress` truthy-only check, not a change to
 * the preference order itself).
 */
export function parseDexScreenerPairResponse(raw: unknown): DexPair | null {
  if (!isPlainObject(raw)) return null;
  const pair = parseDexPair(raw.pair);
  if (pair) return pair;
  const pairs = parsePairsArray(raw.pairs);
  return pairs.length ? pairs[0]! : null;
}

type PriceCacheEntry = { usd: number; at: number; source: string };
const priceCache = new Map<string, PriceCacheEntry>();
const CACHE_MS = 60_000; // 60s — enough for /list to reuse prices across positions

/**
 * Phase 4.6.9: priceCache is keyed by `chainId:tokenAddress` (chain-safe —
 * no cross-chain collision, unchanged below) and previously had a TTL
 * checked lazily on read but NO eviction — a key whose 60s freshness window
 * lapsed and was never looked up again sat in the map forever. Over a
 * long-running process this grows with the lifetime count of distinct
 * tokens ever priced (MULTI evaluates a different meme token on almost
 * every run, plus arbitrary user-supplied tokens via manual bot commands),
 * not with anything currently relevant.
 *
 * Fix mirrors the same prune-on-write idiom already used for
 * strategy/multiRisk.ts's cooldownMap and chain/tokens.ts's supplyCache
 * (Phase 4.6.8): every write first drops entries already past CACHE_MS —
 * this changes nothing observable, since an expired entry was already
 * treated as a cache miss by the existing `Date.now() - hit.at < CACHE_MS`
 * read check. A hard size cap with FIFO eviction (Map insertion order,
 * same technique as chain/tokens.ts's metaCache) is layered on top purely
 * as a backstop against a single burst of more than MAX_PRICE_CACHE_SIZE
 * distinct tokens within one 60s window — TTL pruning alone cannot bound
 * that case since nothing is yet expired. An evicted-but-still-fresh entry
 * is never wrong: the next lookup simply follows the existing cache-miss
 * path and fetches (and re-caches) the same live price.
 */
const MAX_PRICE_CACHE_SIZE = 1000;

function prunePriceCache(): void {
  const cutoff = Date.now() - CACHE_MS;
  for (const [key, entry] of priceCache) {
    if (entry.at < cutoff) priceCache.delete(key);
  }
}

function setPriceCacheBounded(key: string, entry: PriceCacheEntry): void {
  prunePriceCache();
  if (!priceCache.has(key) && priceCache.size >= MAX_PRICE_CACHE_SIZE) {
    const oldestKey = priceCache.keys().next().value;
    if (oldestKey !== undefined) priceCache.delete(oldestKey);
  }
  priceCache.set(key, entry);
}

function cacheKey(chainId: SupportedChainId, token: string): string {
  return `${chainId}:${token.toLowerCase()}`;
}

export async function fetchTokenPairs(tokenAddress: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener error ${res.status}`);
  const raw: unknown = await res.json();
  return parseDexScreenerTokensResponse(raw);
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
    const raw: unknown = await res.json();
    return parseDexScreenerPairResponse(raw);
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
    setPriceCacheBounded(key, { usd: 1, at: Date.now(), source: 'stable-peg' });
    return 1;
  }
  if (c.usdt && c.usdt.toLowerCase() === lower) {
    setPriceCacheBounded(key, { usd: 1, at: Date.now(), source: 'stable-peg' });
    return 1;
  }
  if (c.usdc && c.usdc.toLowerCase() === lower) {
    setPriceCacheBounded(key, { usd: 1, at: Date.now(), source: 'stable-peg' });
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
      setPriceCacheBounded(key, { usd: px, at: Date.now(), source: 'dexscreener' });
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
          setPriceCacheBounded(key, { usd: px, at: Date.now(), source: 'dexscreener' });
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
          setPriceCacheBounded(key, { usd: px, at: Date.now(), source: 'dexscreener-eth-mainnet-fallback' });
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
/**
 * Phase 4.6.6: explicitly rejects Infinity (and -Infinity/NaN, which the
 * prior `> 0` check already happened to reject) rather than only checking
 * `> 0` — MAX_CRITICAL_PRICE_AGE_MS=Infinity previously passed `> 0` and
 * would have silently disabled stale-price protection entirely
 * (isPriceStale's `age > maxAgeMs` can never be true against Infinity).
 * A present-but-invalid value still falls back to the same existing
 * default (90_000ms) — this only closes the Infinity gap, it does not
 * change the default or the staleness threshold semantics.
 */
export function resolveMaxCriticalPriceAgeMs(): number {
  const raw = process.env.MAX_CRITICAL_PRICE_AGE_MS;
  if (raw == null) return 90_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

export const MAX_CRITICAL_PRICE_AGE_MS: number = resolveMaxCriticalPriceAgeMs();

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

/** Test-only: exercise the bounded-cache/TTL-prune logic directly, without a real network call. */
export function __setPriceCacheEntryForTests(
  chainId: SupportedChainId,
  token: string,
  entry: PriceCacheEntry,
): void {
  setPriceCacheBounded(cacheKey(chainId, token), entry);
}
export function __priceCacheHasForTests(chainId: SupportedChainId, token: string): boolean {
  return priceCache.has(cacheKey(chainId, token));
}
export function __priceCacheSizeForTests(): number {
  return priceCache.size;
}
export function __prunePriceCacheForTests(): void {
  prunePriceCache();
}
