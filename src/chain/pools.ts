import type { Address, Hex } from 'viem';
import {
  CHAINS,
  dexLabel,
  type DexId,
  type ProtocolVersion,
  resolveV3Contracts,
  type SupportedChainId,
} from '../config.js';
import { factoryAbi, poolAbi, stateViewAbi } from './abis.js';
import { getPublicClient } from './clients.js';
import {
  fetchPairByAddress,
  fetchV3PoolsForToken,
  pairDexId,
  type DexPair,
} from '../price/dexscreener.js';
import { getTokenMeta, type TokenMeta } from './tokens.js';
import {
  listV4PoolsForToken,
  resolveV4PoolKey,
  resolveV4PoolKeyFromId,
  type ListedV4Pool,
  type V4PoolKey,
} from './v4.js';

/** Default min TVL when prefs not passed (USD) */
export const MIN_POOL_TVL_USD = 2_000;

export type PoolInfo = {
  address: Address;
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tvlUsd?: number;
  dexUrl?: string;
  /** Other token relative to user CA */
  quoteSymbol: string;
  baseSymbol: string;
};

export type ListedPool = {
  protocol: ProtocolVersion;
  /** Venue for v3 (uniswap default); v4 is always uniswap */
  dex?: DexId;
  pair: DexPair;
  /** v3: pool contract address; v4: poolId (bytes32 hex) */
  poolAddress: string;
  fee: number | null;
  tvlUsd: number;
  token0: Address;
  token1: Address;
  otherSymbol: string;
  otherAddress: Address;
  label: string;
  /** v4 only */
  poolId?: Hex;
  poolKey?: V4PoolKey;
};

const ZERO = '0x0000000000000000000000000000000000000000';

export async function listPoolsForToken(
  chainId: SupportedChainId,
  tokenCa: Address,
  minTvlUsd: number = MIN_POOL_TVL_USD,
): Promise<ListedPool[]> {
  const minTvl = Math.max(0, minTvlUsd);
  const [v3, v4] = await Promise.all([
    listV3PoolsForToken(chainId, tokenCa),
    listV4PoolsForToken(chainId, tokenCa).catch((e) => {
      console.warn('[listPools] v4 failed', e instanceof Error ? e.message : e);
      return [] as ListedV4Pool[];
    }),
  ]);

  const merged: ListedPool[] = [
    ...v3,
    ...v4.map(
      (p): ListedPool => ({
        protocol: 'v4',
        pair: p.pair,
        poolAddress: p.poolId,
        fee: p.fee,
        tvlUsd: p.tvlUsd,
        token0: p.token0,
        token1: p.token1,
        otherSymbol: p.otherSymbol,
        otherAddress: p.otherAddress,
        label: p.label,
        poolId: p.poolId,
        poolKey: p.poolKey,
      }),
    ),
  ];

  const filtered = merged.filter((p) => (p.tvlUsd ?? 0) >= minTvl);
  filtered.sort((a, b) => b.tvlUsd - a.tvlUsd);
  if (merged.length && !filtered.length) {
    console.warn(
      `[pools] all ${merged.length} pool(s) below min TVL $${minTvl}`,
    );
  } else if (merged.length > filtered.length) {
    console.log(
      `[pools] showing ${filtered.length}/${merged.length} (min TVL $${minTvl})`,
    );
  }
  return filtered;
}

async function listV3PoolsForToken(
  chainId: SupportedChainId,
  tokenCa: Address,
): Promise<ListedPool[]> {
  // BSC: Uniswap + PancakeSwap; other chains: Uniswap only
  const pairs = await fetchV3PoolsForToken(chainId, tokenCa);
  const client = getPublicClient(chainId);
  const out: ListedPool[] = [];

  for (const pair of pairs) {
    const poolAddress = pair.pairAddress as Address;
    const dex: DexId = pairDexId(pair) ?? 'uniswap';
    try {
      const [token0, token1, fee] = await Promise.all([
        client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
        client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' }),
        client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' }),
      ]);

      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const ca = tokenCa.toLowerCase();
      if (t0 !== ca && t1 !== ca) continue;

      const otherIs0 = t0 !== ca;
      const otherAddress = (otherIs0 ? token0 : token1) as Address;

      let symbol = '?';
      if (pair.baseToken.address.toLowerCase() === otherAddress.toLowerCase()) {
        symbol = pair.baseToken.symbol;
      } else if (pair.quoteToken.address.toLowerCase() === otherAddress.toLowerCase()) {
        symbol = pair.quoteToken.symbol;
      } else {
        symbol = otherIs0 ? pair.baseToken.symbol : pair.quoteToken.symbol;
      }

      const feeNum = Number(fee);
      const tvlUsd = pair.liquidity?.usd ?? 0;
      const feeLabel = feeNum ? `${(feeNum / 10000).toFixed(2)}%` : '?';
      const venue = dexLabel(dex);
      out.push({
        protocol: 'v3',
        dex,
        pair,
        poolAddress,
        fee: feeNum,
        tvlUsd,
        token0: token0 as Address,
        token1: token1 as Address,
        otherSymbol: symbol,
        otherAddress,
        label: `${venue} v3 · ${symbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
      });
    } catch {
      // skip non-v3 or broken
    }
  }

  const seen = new Set<string>();
  const unique = out.filter((p) => {
    // Same pool address is unique; also key by dex in case of weird collisions
    const k = `${p.dex ?? 'uniswap'}:${p.poolAddress.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return unique;
}

export async function loadPool(
  chainId: SupportedChainId,
  poolAddress: Address,
): Promise<PoolInfo> {
  const client = getPublicClient(chainId);
  const [token0Addr, token1Addr, fee, tickSpacing, slot0, liquidity] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'tickSpacing' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' }),
  ]);

  const [token0, token1] = await Promise.all([
    getTokenMeta(chainId, token0Addr as Address),
    getTokenMeta(chainId, token1Addr as Address),
  ]);

  return {
    address: poolAddress,
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    sqrtPriceX96: slot0[0] as bigint,
    tick: Number(slot0[1]),
    liquidity: liquidity as bigint,
    baseSymbol: token0.symbol,
    quoteSymbol: token1.symbol,
  };
}

/** True for Uniswap v4 poolId (bytes32). Token/v3 pool addresses are 20 bytes. */
export function isV4PoolIdHex(text: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/i.test(text.trim());
}

export function isAddressHex(text: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/i.test(text.trim());
}

const CORE_SYMBOLS = new Set([
  'WETH',
  'WBNB',
  'ETH',
  'BNB',
  'USDC',
  'USDG',
  'USDT',
  'DAI',
]);

function isCoreSymbol(sym: string): boolean {
  return CORE_SYMBOLS.has(sym.toUpperCase());
}

/**
 * Resolve a pasted pool identifier into a ListedPool for the mint flow.
 * - v4: 0x + 64 hex poolId (always attempted)
 * - v3: 0x + 40 hex only when DexScreener (or on-chain) recognizes a pool contract
 * Returns null when input is not a known pool (caller may treat 40-hex as token CA).
 */
export async function resolveListedPoolFromPaste(
  chainId: SupportedChainId,
  raw: string,
): Promise<{ pool: ListedPool; memeToken: Address } | null> {
  const text = raw.trim();
  if (isV4PoolIdHex(text)) {
    return resolveV4PoolFromId(chainId, text as Hex);
  }
  if (isAddressHex(text)) {
    // Cheap gate: only probe on-chain if DexScreener knows this pair address
    // (avoids RPC on every token-CA paste). Still allow pure on-chain fallback
    // when DexScreener is down but factory has the pool — skip for speed.
    const ds = await fetchPairByAddress(chainId, text).catch(() => null);
    if (!ds) return null;
    const labels = (ds.labels ?? []).map((l) => l.toLowerCase());
    if (labels.includes('v4') || labels.includes('v2')) return null;
    if ((ds.pairAddress?.length ?? 0) > 42) return null;
    return resolveV3PoolFromAddress(chainId, text as Address);
  }
  return null;
}

async function resolveV4PoolFromId(
  chainId: SupportedChainId,
  poolId: Hex,
): Promise<{ pool: ListedPool; memeToken: Address } | null> {
  const client = getPublicClient(chainId);
  const wrapped = CHAINS[chainId].wrapped;
  const slug = CHAINS[chainId].dexscreenerSlug;

  const dsPair = await fetchPairByAddress(chainId, poolId).catch(() => null);

  let poolKey = await resolveV4PoolKeyFromId(chainId, poolId);
  if (!poolKey && dsPair) {
    const base = dsPair.baseToken.address as Address;
    const quote = dsPair.quoteToken.address as Address;
    poolKey = await resolveV4PoolKey(chainId, poolId, base, quote);
  }
  if (!poolKey) {
    throw new Error(
      'Could not resolve v4 PoolKey for this poolId (POSM cache empty & no DexScreener pair). ' +
        'Mint once on Uniswap UI or paste the meme token CA instead.',
    );
  }

  // Must be initialized
  const slot0 = await client.readContract({
    address: CHAINS[chainId].v4StateView,
    abi: stateViewAbi,
    functionName: 'getSlot0',
    args: [poolId],
  });
  if ((slot0[0] as bigint) === 0n) {
    throw new Error('v4 pool is not initialized (sqrtPrice = 0)');
  }

  const t0Addr =
    poolKey.currency0.toLowerCase() === ZERO ? wrapped : (poolKey.currency0 as Address);
  const t1Addr =
    poolKey.currency1.toLowerCase() === ZERO ? wrapped : (poolKey.currency1 as Address);

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(chainId, t0Addr),
    getTokenMeta(chainId, t1Addr),
  ]);

  // Meme = non-core side (prefer DexScreener base when it is non-core)
  let memeToken: Address = t0Addr;
  let otherAddress: Address = t1Addr;
  let otherSymbol = meta1.symbol;
  if (dsPair) {
    const base = dsPair.baseToken.address.toLowerCase();
    const quote = dsPair.quoteToken.address.toLowerCase();
    if (base === t0Addr.toLowerCase() || base === poolKey.currency0.toLowerCase()) {
      memeToken = t0Addr;
      otherAddress = t1Addr;
      otherSymbol = dsPair.quoteToken.symbol || meta1.symbol;
    } else if (base === t1Addr.toLowerCase() || base === poolKey.currency1.toLowerCase()) {
      memeToken = t1Addr;
      otherAddress = t0Addr;
      otherSymbol = dsPair.quoteToken.symbol || meta0.symbol;
    }
    // If DexScreener base is a core asset (stable/ETH), flip
    if (isCoreSymbol(dsPair.baseToken.symbol) && !isCoreSymbol(dsPair.quoteToken.symbol)) {
      if (quote === t0Addr.toLowerCase()) {
        memeToken = t0Addr;
        otherAddress = t1Addr;
        otherSymbol = dsPair.baseToken.symbol || meta1.symbol;
      } else {
        memeToken = t1Addr;
        otherAddress = t0Addr;
        otherSymbol = dsPair.baseToken.symbol || meta0.symbol;
      }
    }
  } else if (isCoreSymbol(meta0.symbol) && !isCoreSymbol(meta1.symbol)) {
    memeToken = t1Addr;
    otherAddress = t0Addr;
    otherSymbol = meta0.symbol;
  } else if (!isCoreSymbol(meta0.symbol) && isCoreSymbol(meta1.symbol)) {
    memeToken = t0Addr;
    otherAddress = t1Addr;
    otherSymbol = meta1.symbol;
  }

  if (otherAddress.toLowerCase() === wrapped.toLowerCase()) {
    otherSymbol = CHAINS[chainId].wrappedSymbol;
  }

  const tvlUsd = dsPair?.liquidity?.usd ?? 0;
  const feeLabel = `${(poolKey.fee / 10000).toFixed(2)}%`;
  const pair: DexPair = dsPair ?? {
    chainId: slug,
    dexId: 'uniswap',
    pairAddress: poolId,
    labels: ['v4'],
    baseToken: {
      address: memeToken,
      symbol: memeToken.toLowerCase() === t0Addr.toLowerCase() ? meta0.symbol : meta1.symbol,
      name: memeToken.toLowerCase() === t0Addr.toLowerCase() ? meta0.symbol : meta1.symbol,
    },
    quoteToken: {
      address: otherAddress,
      symbol: otherSymbol,
      name: otherSymbol,
    },
    liquidity: { usd: tvlUsd },
  };

  const pool: ListedPool = {
    protocol: 'v4',
    dex: 'uniswap',
    pair,
    poolAddress: poolId,
    fee: poolKey.fee,
    tvlUsd,
    token0: poolKey.currency0,
    token1: poolKey.currency1,
    otherSymbol,
    otherAddress,
    label: `v4 · ${otherSymbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
    poolId,
    poolKey,
  };

  return { pool, memeToken };
}

async function resolveV3PoolFromAddress(
  chainId: SupportedChainId,
  poolAddress: Address,
): Promise<{ pool: ListedPool; memeToken: Address } | null> {
  let info: PoolInfo;
  try {
    info = await loadPool(chainId, poolAddress);
  } catch {
    return null; // not a v3 pool contract
  }

  const dexes = chainId === 56 ? (['uniswap', 'pancakeswap'] as DexId[]) : (['uniswap'] as DexId[]);
  let dex: DexId = 'uniswap';
  // Prefer venue whose factory reports this pool
  for (const d of dexes) {
    try {
      const resolved = await resolvePoolFromFactory(
        chainId,
        info.token0.address,
        info.token1.address,
        info.fee,
        d,
      );
      if (resolved && resolved.toLowerCase() === poolAddress.toLowerCase()) {
        dex = d;
        break;
      }
    } catch {
      /* ignore */
    }
  }

  const dsPair = await fetchPairByAddress(chainId, poolAddress).catch(() => null);
  const tvlUsd = dsPair?.liquidity?.usd ?? 0;

  let memeToken = info.token0.address;
  let otherAddress = info.token1.address;
  let otherSymbol = info.token1.symbol;
  if (isCoreSymbol(info.token0.symbol) && !isCoreSymbol(info.token1.symbol)) {
    memeToken = info.token1.address;
    otherAddress = info.token0.address;
    otherSymbol = info.token0.symbol;
  } else if (!isCoreSymbol(info.token0.symbol) && isCoreSymbol(info.token1.symbol)) {
    memeToken = info.token0.address;
    otherAddress = info.token1.address;
    otherSymbol = info.token1.symbol;
  } else if (dsPair) {
    const base = dsPair.baseToken.address.toLowerCase();
    if (base === info.token1.address.toLowerCase()) {
      memeToken = info.token1.address;
      otherAddress = info.token0.address;
      otherSymbol = info.token0.symbol;
    }
  }

  const feeLabel = `${(info.fee / 10000).toFixed(2)}%`;
  const venue = dexLabel(dex);
  const pair: DexPair = dsPair ?? {
    chainId: CHAINS[chainId].dexscreenerSlug,
    dexId: dex === 'pancakeswap' ? 'pancakeswap' : 'uniswap',
    pairAddress: poolAddress,
    labels: ['v3'],
    baseToken: {
      address: memeToken,
      symbol: memeToken.toLowerCase() === info.token0.address.toLowerCase()
        ? info.token0.symbol
        : info.token1.symbol,
      name: '',
    },
    quoteToken: { address: otherAddress, symbol: otherSymbol, name: otherSymbol },
    liquidity: { usd: tvlUsd },
  };

  const pool: ListedPool = {
    protocol: 'v3',
    dex,
    pair,
    poolAddress,
    fee: info.fee,
    tvlUsd,
    token0: info.token0.address,
    token1: info.token1.address,
    otherSymbol,
    otherAddress,
    label: `${venue} v3 · ${otherSymbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
  };

  return { pool, memeToken };
}

export async function resolvePoolFromFactory(
  chainId: SupportedChainId,
  tokenA: Address,
  tokenB: Address,
  fee: number,
  dex: DexId = 'uniswap',
): Promise<Address | null> {
  const client = getPublicClient(chainId);
  const { factory } = resolveV3Contracts(chainId, dex);
  const pool = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [tokenA, tokenB, fee],
  });
  if (!pool || pool.toLowerCase() === ZERO) return null;
  return pool as Address;
}
