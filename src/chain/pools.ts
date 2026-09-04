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
import type { MinimalReadClient } from './quote.js';
import {
  fetchPairByAddress,
  fetchV3PoolsForToken,
  getTokenPriceUsd,
  pairDexId,
  type DexPair,
} from '../price/dexscreener.js';
import { getTokenBalance, getTokenMeta, humanToFloat, type TokenMeta } from './tokens.js';
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

/**
 * Phase 4.7 audit (F-09) — pure decision logic, split out from
 * listV3PoolsForToken's RPC call so the security-critical comparison
 * itself is directly unit-testable. `factoryResult` is whatever
 * resolvePoolFromFactory(chainId, token0, token1, fee, dex) returned (null
 * for "no such pool" / zero address); `candidatePoolAddress` is the
 * address being verified (DexScreener's pairAddress). Only an exact match
 * verifies the candidate — anything else (null, a different real pool for
 * that same token/fee pair, a zero address) is untrusted.
 */
export function isFactoryVerifiedPool(
  factoryResult: string | null,
  candidatePoolAddress: string,
): boolean {
  return factoryResult != null && factoryResult.toLowerCase() === candidatePoolAddress.toLowerCase();
}

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

      // Phase 4.7 audit (F-09): DexScreener's pairAddress is untrusted input
      // — a contract that merely implements token0()/token1()/fee() (trivial
      // to deploy) would otherwise be accepted purely because it returned
      // plausible-looking values. The only authoritative source for "is this
      // THE canonical pool for (token0, token1, fee)" is the chain-specific
      // v3 factory itself (resolveV3Contracts already selects per-chain,
      // per-venue — never assumes one chain's factory applies to another).
      // Any outcome other than an exact address match — mismatch, zero
      // address, or the factory call itself failing (RPC error, factory not
      // deployed for this dex on this chain) — fails closed: the candidate
      // pool is skipped, never silently trusted. This never touches the
      // separate manual paste-address flow (resolveV3PoolFromAddress),
      // which has a different, human-in-the-loop trust model.
      let factoryVerified: Address | null = null;
      try {
        factoryVerified = await resolvePoolFromFactory(chainId, token0 as Address, token1 as Address, feeNum, dex);
      } catch (e) {
        console.warn(
          `[pools] factory verification RPC failure for candidate pool ${poolAddress} (${dex}, chain ${chainId}): ` +
            `${e instanceof Error ? e.message : String(e)} — skipping (fail closed)`,
        );
        continue;
      }
      if (!isFactoryVerifiedPool(factoryVerified, poolAddress)) {
        console.warn(
          `[pools] factory verification failed for candidate pool ${poolAddress} (${dex}, chain ${chainId}, ` +
            `token0=${token0}, token1=${token1}, fee=${feeNum}): factory returned ${factoryVerified ?? 'null'} — ` +
            `skipping (fail closed, possible spoofed/incorrect pairAddress from DexScreener)`,
        );
        continue;
      }

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
  client: MinimalReadClient = getPublicClient(chainId),
): Promise<Address | null> {
  const { factory } = resolveV3Contracts(chainId, dex);
  const pool = (await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [tokenA, tokenB, fee],
  })) as Address;
  if (!pool || pool.toLowerCase() === ZERO) return null;
  return pool as Address;
}

/**
 * Phase 4.7 audit (F-08) result of independently verifying a V3 pool's
 * reserves on-chain, rather than trusting DexScreener's `liquidity.usd`
 * (which can be stale, cached, or — in principle — manufactured by whoever
 * controls what DexScreener indexes for a brand-new pair).
 *
 * `TVL_MISMATCH` intentionally reuses the SAME bar the candidate pool
 * already had to clear via DexScreener's number (`MIN_POOL_TVL_USD`,
 * chain.ts's existing hard filter in discoverAndScorePoolsForCandidate) —
 * this is not a new, separately-invented tolerance/ratio. The claim being
 * verified is narrow and defensible: "the pool genuinely holds at least as
 * much real, on-chain, reliably-priced reserves as DexScreener's number
 * was already required to show" — not "DexScreener's exact figure is
 * accurate to some percent," which would require picking an arbitrary
 * tolerance band with no existing anchor in this codebase.
 */
export type OnChainReserveCheckResult =
  | { status: 'OK'; onchainTvlUsd: number }
  | { status: 'ONCHAIN_VALIDATION_ERROR'; message: string }
  | { status: 'TVL_MISMATCH'; onchainTvlUsd: number; dexscreenerTvlUsd: number };

/**
 * Pure decision logic, deliberately separated from the RPC-fetching wrapper
 * below (same split already used by multiPool.ts's scoreMultiPool/
 * isValidMetric) so every numeric edge case — matching/diverging TVL,
 * missing price, NaN/Infinity, zero balances — is unit-testable without any
 * network access or mocked RPC client.
 */
export function classifyOnChainReserves(params: {
  balA: bigint;
  decimalsA: number;
  priceA: number | null;
  balB: bigint;
  decimalsB: number;
  priceB: number | null;
  dexscreenerTvlUsd: number;
}): OnChainReserveCheckResult {
  const { balA, decimalsA, priceA, balB, decimalsB, priceB, dexscreenerTvlUsd } = params;

  if (priceA == null || priceB == null) {
    return {
      status: 'ONCHAIN_VALIDATION_ERROR',
      message: `price unavailable for ${priceA == null ? 'tokenA' : 'tokenB'} — refusing to treat as $0`,
    };
  }

  const usdA = humanToFloat(balA, decimalsA) * priceA;
  const usdB = humanToFloat(balB, decimalsB) * priceB;
  const onchainTvlUsd = usdA + usdB;

  if (!Number.isFinite(onchainTvlUsd) || onchainTvlUsd < 0) {
    return {
      status: 'ONCHAIN_VALIDATION_ERROR',
      message: `computed on-chain TVL is not a valid finite non-negative number (${onchainTvlUsd})`,
    };
  }

  if (onchainTvlUsd < MIN_POOL_TVL_USD) {
    return { status: 'TVL_MISMATCH', onchainTvlUsd, dexscreenerTvlUsd };
  }

  return { status: 'OK', onchainTvlUsd };
}

/**
 * V3-only. A V3 pool contract itself custodies 100% of both tokens owed to
 * every LP across every tick range (unlike v4's singleton PoolManager, which
 * pools funds for many pools together — see verifyV4PoolHasLiquidity in
 * v4.ts for why this exact technique does not carry over). Reading the
 * pool's own ERC20 balances is therefore a complete, authoritative on-chain
 * reserve figure — not `liquidity()` (a virtual, current-tick-only unit) and
 * not a re-derived sqrtPriceX96/tick computation, both of which the Phase
 * 4.7 audit explicitly flagged as easy to misuse ("do not invent a TVL
 * formula", "do not confuse liquidity units... with pool TVL").
 *
 * Fails closed (ONCHAIN_VALIDATION_ERROR) on any RPC failure or missing
 * price for either side — never coerces an unpriceable/unreadable side to
 * $0, which would silently understate real TVL and could wrongly reject a
 * genuinely healthy pool, or — worse — silently pass one with a manipulated
 * price feed reporting near-zero for the "other" side.
 */
/** Injectable for tests — mirrors the existing optional-client pattern used elsewhere (e.g. swap.ts's estimateAmountOut) so real-RPC failure paths are unit-testable without live network access. */
export type OnChainReserveDeps = {
  getBalance: typeof getTokenBalance;
  getMeta: typeof getTokenMeta;
  getPrice: typeof getTokenPriceUsd;
};

const defaultOnChainReserveDeps: OnChainReserveDeps = {
  getBalance: getTokenBalance,
  getMeta: getTokenMeta,
  getPrice: getTokenPriceUsd,
};

export async function verifyOnChainPoolReserves(
  chainId: SupportedChainId,
  poolAddress: Address,
  tokenA: Address,
  tokenB: Address,
  dexscreenerTvlUsd: number,
  deps: OnChainReserveDeps = defaultOnChainReserveDeps,
): Promise<OnChainReserveCheckResult> {
  let balA: bigint;
  let balB: bigint;
  try {
    [balA, balB] = await Promise.all([
      deps.getBalance(chainId, tokenA, poolAddress),
      deps.getBalance(chainId, tokenB, poolAddress),
    ]);
  } catch (e) {
    return {
      status: 'ONCHAIN_VALIDATION_ERROR',
      message: `on-chain balance read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let metaA: TokenMeta;
  let metaB: TokenMeta;
  let priceA: number | null;
  let priceB: number | null;
  try {
    [metaA, metaB, priceA, priceB] = await Promise.all([
      deps.getMeta(chainId, tokenA),
      deps.getMeta(chainId, tokenB),
      deps.getPrice(chainId, tokenA),
      deps.getPrice(chainId, tokenB),
    ]);
  } catch (e) {
    return {
      status: 'ONCHAIN_VALIDATION_ERROR',
      message: `token metadata/price lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return classifyOnChainReserves({
    balA,
    decimalsA: metaA.decimals,
    priceA,
    balB,
    decimalsB: metaB.decimals,
    priceB,
    dexscreenerTvlUsd,
  });
}
