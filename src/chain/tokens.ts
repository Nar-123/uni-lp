import type { Address } from 'viem';
import { erc20Abi } from './abis.js';
import { getPublicClient, getHotWalletAddress } from './clients.js';
import { CHAINS, type SupportedChainId } from '../config.js';

export type TokenMeta = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

/** Uniswap v4 native currency sentinel (and Relay native). */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000' as Address;

export function isNativeTokenAddress(address: Address | string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN;
}

const metaCache = new Map<string, TokenMeta>();
/**
 * Phase 4.6.8: token metadata (symbol/name/decimals) never changes for a
 * given ERC-20 once fetched, so this cache had no TTL — correct — but also
 * no size bound, so a distinct key was added forever (MULTI evaluates a
 * different meme token address on almost every run). Bounding by count
 * rather than time is the right fix here specifically because the cached
 * value never goes stale: an evicted key just means the next lookup pays
 * one more on-chain read and re-caches the identical result, never a
 * different or incorrect one. FIFO via Map's insertion-order iteration
 * keeps this O(1) — no scan, no timestamps needed.
 */
const MAX_META_CACHE_SIZE = 500;

function setMetaCacheBounded(key: string, meta: TokenMeta): void {
  if (!metaCache.has(key) && metaCache.size >= MAX_META_CACHE_SIZE) {
    const oldestKey = metaCache.keys().next().value;
    if (oldestKey !== undefined) metaCache.delete(oldestKey);
  }
  metaCache.set(key, meta);
}

/** Test-only: exercise the bounded-cache logic directly, without a real RPC call. */
export function __setMetaCacheEntryForTests(key: string, meta: TokenMeta): void {
  setMetaCacheBounded(key, meta);
}
export function __metaCacheSizeForTests(): number {
  return metaCache.size;
}
export function __metaCacheHasForTests(key: string): boolean {
  return metaCache.has(key);
}
export function __resetMetaCacheForTests(): void {
  metaCache.clear();
}

/**
 * ERC-20 metadata. For native (address zero) returns chain native meta
 * without calling a contract (v4 currencies use 0x0 for ETH/BNB).
 */
export async function getTokenMeta(
  chainId: SupportedChainId,
  address: Address,
): Promise<TokenMeta> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = metaCache.get(key);
  if (hit) return hit;

  // Uniswap v4 / Relay native — not an ERC-20
  if (isNativeTokenAddress(address)) {
    const c = CHAINS[chainId];
    const meta: TokenMeta = {
      address: NATIVE_TOKEN,
      symbol: c.nativeSymbol,
      name: c.nativeSymbol,
      decimals: 18,
    };
    setMetaCacheBounded(key, meta);
    return meta;
  }

  const client = getPublicClient(chainId);
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }).catch(() => 'Unknown'),
  ]);

  const meta: TokenMeta = {
    address,
    symbol: String(symbol),
    name: String(name),
    decimals: Number(decimals),
  };
  setMetaCacheBounded(key, meta);
  return meta;
}

export async function getTokenBalance(
  chainId: SupportedChainId,
  token: Address,
  owner?: Address,
): Promise<bigint> {
  const client = getPublicClient(chainId);
  const who = owner ?? getHotWalletAddress();
  if (isNativeTokenAddress(token)) {
    return client.getBalance({ address: who });
  }
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
  });
}

const supplyCache = new Map<string, { raw: bigint; at: number }>();
const SUPPLY_CACHE_MS = 60_000;

/**
 * Phase 4.6.8: this cache had a TTL (staleness is checked on read below) but
 * no eviction — a key whose TTL has already lapsed and is never looked up
 * again just sits in the map forever, growing with every distinct token
 * address ever queried. Since the TTL check already makes an expired entry
 * unusable (a fresh read replaces it on next lookup regardless), dropping
 * it early changes nothing observable — mirrors the same prune-on-write
 * idiom already used by volumeAlertWatcher.ts's `pruneCooldowns`.
 */
function pruneSupplyCache(): void {
  const cutoff = Date.now() - SUPPLY_CACHE_MS;
  for (const [key, entry] of supplyCache) {
    if (entry.at < cutoff) supplyCache.delete(key);
  }
}

/** Test-only: exercise the TTL-prune logic directly, without a real RPC call. */
export function __setSupplyCacheEntryForTests(key: string, raw: bigint, at: number): void {
  supplyCache.set(key, { raw, at });
}
export function __pruneSupplyCacheForTests(): void {
  pruneSupplyCache();
}
export function __supplyCacheSizeForTests(): number {
  return supplyCache.size;
}
export function __resetSupplyCacheForTests(): void {
  supplyCache.clear();
}

/**
 * ERC-20 totalSupply (raw). Native returns 0 (a real, known value — natives
 * have no ERC-20 supply concept). On read failure, supply is UNKNOWN and
 * must not be reported as 0 (0 supply silently implies $0 market cap for
 * callers) — returns null so callers can fail closed / omit the figure.
 */
export async function getTokenTotalSupply(
  chainId: SupportedChainId,
  token: Address,
): Promise<bigint | null> {
  if (isNativeTokenAddress(token)) return 0n;
  const key = `${chainId}:${token.toLowerCase()}`;
  const hit = supplyCache.get(key);
  if (hit && Date.now() - hit.at < SUPPLY_CACHE_MS) return hit.raw;
  try {
    const client = getPublicClient(chainId);
    const raw = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'totalSupply',
    });
    pruneSupplyCache();
    supplyCache.set(key, { raw: raw as bigint, at: Date.now() });
    return raw as bigint;
  } catch {
    return null;
  }
}

export function formatUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = a % base;
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, '');
  const s = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return neg ? `-${s}` : s;
}

export function parsePercentOfBalance(balance: bigint, percent: number): bigint {
  if (percent <= 0 || percent > 100) throw new Error('percent must be 1–100');
  // percent with 2 decimals max via basis points
  const bps = Math.round(percent * 100); // 25.5% → 2550 bps of 10000? Wait
  // Use: amount = balance * percent / 100
  // Support 2 decimal percent: multiply by 100 first
  const scaled = Math.round(percent * 100); // 25 → 2500 meaning 25.00%
  return (balance * BigInt(scaled)) / 10000n;
}

/** Human float → raw units (avoids float dust; max 8 fractional digits) */
export function humanToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const places = Math.min(Math.max(decimals, 0), 18);
  const s = amount.toFixed(Math.min(places, 8));
  const neg = s.startsWith('-');
  const bare = neg ? s.slice(1) : s;
  const [w, f = ''] = bare.split('.');
  const whole = BigInt(w || '0');
  const frac = (f + '0'.repeat(places)).slice(0, places);
  const raw = whole * 10n ** BigInt(places) + BigInt(frac || '0');
  return neg ? -raw : raw;
}

export type SizeMode = 'percent' | 'fixed';

/**
 * Resolve mint deposit size from prefs.
 * - percent: balancePercent of effective balance
 * - fixed: fixedAmountHuman in deposit-token units (e.g. 0.1 WETH)
 * Caps at effective; throws if zero / below dust.
 */
export function resolveDepositAmount(
  effective: bigint,
  opts: {
    sizeMode: SizeMode;
    balancePercent: number;
    fixedAmountHuman: number;
    decimals: number;
    symbol?: string;
  },
): bigint {
  let amount: bigint;
  if (opts.sizeMode === 'fixed') {
    amount = humanToRaw(opts.fixedAmountHuman, opts.decimals);
    if (amount <= 0n) {
      throw new Error(`Fixed amount is 0 — set Fix 0.05/0.1/… in /settings`);
    }
    if (amount > effective) {
      const have = Number(effective) / 10 ** opts.decimals;
      throw new Error(
        `Need ${opts.fixedAmountHuman} ${opts.symbol ?? 'tokens'} but only ~${have.toFixed(6)} available`,
      );
    }
  } else {
    amount = parsePercentOfBalance(effective, opts.balancePercent);
    if (amount <= 0n) throw new Error('Deposit amount is 0 — increase % or fund wallet');
  }
  return amount;
}

export function humanToFloat(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
