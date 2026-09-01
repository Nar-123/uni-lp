import type { Address, Hex } from 'viem';
import { Token, Pool, Position } from './uniswap.js';
import {
  availableV3Dexes,
  CHAINS,
  type DexId,
  type ProtocolVersion,
  resolveV3Contracts,
  type SupportedChainId,
} from '../config.js';
import { factoryAbi, npmAbi, poolAbi } from './abis.js';
import { getHotWalletAddress, getPublicClient } from './clients.js';
import { getTokenMeta, formatUnits, humanToFloat } from './tokens.js';
import { resolvePoolFromFactory } from './pools.js';
import { getTokenPriceUsd, getCriticalTokenPriceUsd, formatUsd } from '../price/dexscreener.js';
import {
  formatCompactRange,
  formatEthVal,
  formatAge,
  uniswapPositionUrl,
} from './prices.js';
import { computePositionPnl } from '../pnl/compute.js';
import { getPositionOpenedAt, listTrackedTokenIds, markZombieClosed, trackedNftCount, getTrackedPosition } from '../db/index.js';
import {
  computeV3UnclaimedFees,
  computeV3UnclaimedFeesFromData,
} from './fees.js';
import { classifyOwnershipError, priceCompleteFor } from './safety.js';

import type { V4PoolKey } from './v4.js';

export type OnChainPosition = {
  tokenId: bigint;
  chainId: SupportedChainId;
  protocol: ProtocolVersion;
  /** v3 venue; undefined/uniswap for legacy + v4 */
  dex?: DexId;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  amount0: bigint;
  amount1: bigint;
  inRange: boolean;
  currentTick: number;
  poolAddress: Address | string | null;
  valueUsd: number;
  unclaimedFeesUsd: number;
  amount0Human: number;
  amount1Human: number;
  /**
   * False when a token price needed for valueUsd/unclaimedFeesUsd was
   * UNKNOWN (price provider failure/timeout) and was excluded rather than
   * treated as $0. Automated PnL/TP-SL decisions must not trust valueUsd
   * when this is false — see computePositionPnl.
   */
  priceComplete: boolean;
  /** v4 only */
  poolKey?: V4PoolKey;
  poolId?: Hex;
};

const ZERO = '0x0000000000000000000000000000000000000000';

type RawNpmPosition = {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0Stored: bigint;
  tokensOwed1Stored: bigint;
};

function poolKey(token0: Address, token1: Address, fee: number): string {
  return `${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`;
}

/**
 * Compute current withdrawable amount0/amount1 for a v3 position from live
 * pool state. Throws on failure — callers that need a safety-critical
 * "expected withdrawal" (e.g. close minOut) must not treat a computation
 * failure as amount=0; see `amountsFromSdk` for the display-only variant
 * that degrades to zero instead.
 */
export function computeV3AmountsForLiquidity(params: {
  chainId: SupportedChainId;
  token0: Address;
  token1: Address;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  name0: string;
  name1: string;
  fee: number;
  sqrtPriceX96: bigint;
  poolLiquidity: bigint;
  currentTick: number;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}): { amount0: bigint; amount1: bigint } {
  const t0 = new Token(
    params.chainId,
    params.token0,
    params.decimals0,
    params.symbol0,
    params.name0,
  );
  const t1 = new Token(
    params.chainId,
    params.token1,
    params.decimals1,
    params.symbol1,
    params.name1,
  );
  const pool = new Pool(
    t0,
    t1,
    params.fee,
    params.sqrtPriceX96.toString(),
    params.poolLiquidity.toString(),
    params.currentTick,
  );
  const position = new Position({
    pool,
    liquidity: params.liquidity.toString(),
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
  });
  return {
    amount0: BigInt(position.amount0.quotient.toString()),
    amount1: BigInt(position.amount1.quotient.toString()),
  };
}

/** Display-only variant: degrades to {0,0} on failure (never used for safety gating). */
function amountsFromSdk(
  params: Parameters<typeof computeV3AmountsForLiquidity>[0],
): { amount0: bigint; amount1: bigint } {
  try {
    return computeV3AmountsForLiquidity(params);
  } catch {
    return { amount0: 0n, amount1: 0n };
  }
}

/** Enumerate NPM NFTs for a v3 venue — parallel index reads. */
export async function listNpmTokenIds(
  chainId: SupportedChainId,
  dex: DexId = 'uniswap',
): Promise<bigint[]> {
  const client = getPublicClient(chainId);
  const { npm } = resolveV3Contracts(chainId, dex);
  const owner = getHotWalletAddress();
  const bal = await client.readContract({
    address: npm,
    abi: npmAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  if (bal === 0n) return [];

  const n = Number(bal);
  // Prefer multicall; fall back to parallel eth_calls
  try {
    const results = await client.multicall({
      contracts: Array.from({ length: n }, (_, i) => ({
        address: npm,
        abi: npmAbi,
        functionName: 'tokenOfOwnerByIndex' as const,
        args: [owner, BigInt(i)] as const,
      })),
      allowFailure: true,
    });
    const ids: bigint[] = [];
    for (const r of results) {
      if (r.status === 'success') ids.push(r.result as bigint);
    }
    if (ids.length > 0) return ids;
  } catch {
    /* multicall unsupported — parallel single calls */
  }

  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      client.readContract({
        address: npm,
        abi: npmAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [owner, BigInt(i)],
      }),
    ),
  );
}

/**
 * Batch-load many v3 positions in a few multicall rounds instead of
 * ~10 sequential RPCs per NFT (was killing /list with 4+ positions).
 */
async function loadV3PositionsBatched(
  chainId: SupportedChainId,
  tokenIds: bigint[],
  dex: DexId = 'uniswap',
): Promise<OnChainPosition[]> {
  if (tokenIds.length === 0) return [];
  const t0 = Date.now();
  const client = getPublicClient(chainId);
  const { npm, factory } = resolveV3Contracts(chainId, dex);

  // --- round 1: all positions() ---
  let raws: (RawNpmPosition | null)[] = [];
  try {
    const posMc = await client.multicall({
      contracts: tokenIds.map((tokenId) => ({
        address: npm,
        abi: npmAbi,
        functionName: 'positions' as const,
        args: [tokenId] as const,
      })),
      allowFailure: true,
    });
    raws = posMc.map((r, i) => {
      if (r.status !== 'success') return null;
      const pos = r.result as readonly unknown[];
      const liquidity = pos[7] as bigint;
      const tokensOwed0Stored = pos[10] as bigint;
      const tokensOwed1Stored = pos[11] as bigint;
      if (liquidity === 0n && tokensOwed0Stored === 0n && tokensOwed1Stored === 0n) {
        return null;
      }
      return {
        tokenId: tokenIds[i]!,
        token0: pos[2] as Address,
        token1: pos[3] as Address,
        fee: Number(pos[4]),
        tickLower: Number(pos[5]),
        tickUpper: Number(pos[6]),
        liquidity,
        feeGrowthInside0LastX128: pos[8] as bigint,
        feeGrowthInside1LastX128: pos[9] as bigint,
        tokensOwed0Stored,
        tokensOwed1Stored,
      };
    });
  } catch {
    // multicall failed entirely — fall back to per-id getPosition
    console.warn(`[list v3 ${dex}] multicall positions failed; falling back`);
    const fallback = await Promise.all(
      tokenIds.map((id) => getPosition(chainId, id, dex).catch(() => null)),
    );
    return fallback.filter((p): p is OnChainPosition => p != null);
  }

  const active = raws.filter((r): r is RawNpmPosition => r != null);
  if (active.length === 0) return [];

  // --- round 2: unique factory getPool ---
  const poolQueryKeys: string[] = [];
  const poolQueryArgs: { token0: Address; token1: Address; fee: number }[] = [];
  const seenPoolQ = new Set<string>();
  for (const r of active) {
    const k = poolKey(r.token0, r.token1, r.fee);
    if (seenPoolQ.has(k)) continue;
    seenPoolQ.add(k);
    poolQueryKeys.push(k);
    poolQueryArgs.push({ token0: r.token0, token1: r.token1, fee: r.fee });
  }

  const poolByQuery = new Map<string, Address>();
  try {
    const poolMc = await client.multicall({
      contracts: poolQueryArgs.map((q) => ({
        address: factory,
        abi: factoryAbi,
        functionName: 'getPool' as const,
        args: [q.token0, q.token1, q.fee] as const,
      })),
      allowFailure: true,
    });
    for (let i = 0; i < poolMc.length; i++) {
      const r = poolMc[i]!;
      if (r.status !== 'success') continue;
      const addr = r.result as Address;
      if (addr && addr.toLowerCase() !== ZERO) {
        poolByQuery.set(poolQueryKeys[i]!, addr);
      }
    }
  } catch {
    await Promise.all(
      poolQueryArgs.map(async (q, i) => {
        const addr = await resolvePoolFromFactory(chainId, q.token0, q.token1, q.fee, dex);
        if (addr) poolByQuery.set(poolQueryKeys[i]!, addr);
      }),
    );
  }

  const uniquePools = [...new Set(poolByQuery.values())];

  // --- round 3: per-pool slot0 + liquidity + fee globals (4 reads × pools) ---
  type PoolState = {
    sqrtPriceX96: bigint;
    tick: number;
    poolLiquidity: bigint;
    feeGrowthGlobal0X128: bigint;
    feeGrowthGlobal1X128: bigint;
  };
  const poolState = new Map<string, PoolState>();

  if (uniquePools.length > 0) {
    try {
      const contracts = uniquePools.flatMap((pool) => [
        {
          address: pool,
          abi: poolAbi,
          functionName: 'slot0' as const,
        },
        {
          address: pool,
          abi: poolAbi,
          functionName: 'liquidity' as const,
        },
        {
          address: pool,
          abi: poolAbi,
          functionName: 'feeGrowthGlobal0X128' as const,
        },
        {
          address: pool,
          abi: poolAbi,
          functionName: 'feeGrowthGlobal1X128' as const,
        },
      ]);
      const mc = await client.multicall({ contracts, allowFailure: true });
      for (let i = 0; i < uniquePools.length; i++) {
        const base = i * 4;
        const slot0R = mc[base];
        const liqR = mc[base + 1];
        const g0R = mc[base + 2];
        const g1R = mc[base + 3];
        if (slot0R?.status !== 'success') continue;
        const slot0 = slot0R.result as readonly unknown[];
        poolState.set(uniquePools[i]!.toLowerCase(), {
          sqrtPriceX96: slot0[0] as bigint,
          tick: Number(slot0[1]),
          poolLiquidity:
            liqR?.status === 'success' ? (liqR.result as bigint) : 0n,
          feeGrowthGlobal0X128:
            g0R?.status === 'success' ? (g0R.result as bigint) : 0n,
          feeGrowthGlobal1X128:
            g1R?.status === 'success' ? (g1R.result as bigint) : 0n,
        });
      }
    } catch (e) {
      console.warn('[list v3] pool multicall failed', e instanceof Error ? e.message : e);
    }
  }

  // --- round 4: unique (pool, tick) outsides ---
  type TickOutside = { o0: bigint; o1: bigint };
  const tickOutside = new Map<string, TickOutside>();
  const tickJobs: { pool: Address; tick: number; key: string }[] = [];
  const seenTick = new Set<string>();
  for (const r of active) {
    const pool = poolByQuery.get(poolKey(r.token0, r.token1, r.fee));
    if (!pool || r.liquidity === 0n) continue;
    for (const tick of [r.tickLower, r.tickUpper]) {
      const key = `${pool.toLowerCase()}:${tick}`;
      if (seenTick.has(key)) continue;
      seenTick.add(key);
      tickJobs.push({ pool, tick, key });
    }
  }
  if (tickJobs.length > 0) {
    try {
      const mc = await client.multicall({
        contracts: tickJobs.map((j) => ({
          address: j.pool,
          abi: poolAbi,
          functionName: 'ticks' as const,
          args: [j.tick] as const,
        })),
        allowFailure: true,
      });
      for (let i = 0; i < tickJobs.length; i++) {
        const r = mc[i];
        if (r?.status !== 'success') continue;
        const t = r.result as readonly unknown[];
        tickOutside.set(tickJobs[i]!.key, {
          o0: t[2] as bigint,
          o1: t[3] as bigint,
        });
      }
    } catch {
      /* fees fall back to tokensOwed only */
    }
  }

  // --- token meta + prices (unique, parallel) ---
  const tokenSet = new Set<string>();
  for (const r of active) {
    tokenSet.add(r.token0.toLowerCase());
    tokenSet.add(r.token1.toLowerCase());
  }
  const tokenAddrs = [...tokenSet] as Address[];
  // re-resolve originals from active
  const addrMap = new Map<string, Address>();
  for (const r of active) {
    addrMap.set(r.token0.toLowerCase(), r.token0);
    addrMap.set(r.token1.toLowerCase(), r.token1);
  }
  const uniqueAddrs = tokenAddrs.map((a) => addrMap.get(a) ?? a);

  const [metas, prices] = await Promise.all([
    Promise.all(uniqueAddrs.map((a) => getTokenMeta(chainId, a))),
    Promise.all(uniqueAddrs.map((a) => getTokenPriceUsd(chainId, a))),
  ]);
  const metaBy = new Map(uniqueAddrs.map((a, i) => [a.toLowerCase(), metas[i]!]));
  const priceBy = new Map(uniqueAddrs.map((a, i) => [a.toLowerCase(), prices[i]]));

  // --- assemble ---
  const out: OnChainPosition[] = [];
  for (const r of active) {
    const meta0 = metaBy.get(r.token0.toLowerCase())!;
    const meta1 = metaBy.get(r.token1.toLowerCase())!;
    const poolAddress =
      poolByQuery.get(poolKey(r.token0, r.token1, r.fee)) ?? null;
    const state = poolAddress
      ? poolState.get(poolAddress.toLowerCase())
      : undefined;

    let currentTick = 0;
    let amount0 = 0n;
    let amount1 = 0n;
    let inRange = false;
    let tokensOwed0 = r.tokensOwed0Stored;
    let tokensOwed1 = r.tokensOwed1Stored;

    if (poolAddress && state && r.liquidity > 0n) {
      currentTick = state.tick;
      inRange = currentTick >= r.tickLower && currentTick < r.tickUpper;
      const am = amountsFromSdk({
        chainId,
        token0: r.token0,
        token1: r.token1,
        decimals0: meta0.decimals,
        decimals1: meta1.decimals,
        symbol0: meta0.symbol,
        symbol1: meta1.symbol,
        name0: meta0.name,
        name1: meta1.name,
        fee: r.fee,
        sqrtPriceX96: state.sqrtPriceX96,
        poolLiquidity: state.poolLiquidity,
        currentTick,
        liquidity: r.liquidity,
        tickLower: r.tickLower,
        tickUpper: r.tickUpper,
      });
      amount0 = am.amount0;
      amount1 = am.amount1;

      const lo = tickOutside.get(`${poolAddress.toLowerCase()}:${r.tickLower}`);
      const hi = tickOutside.get(`${poolAddress.toLowerCase()}:${r.tickUpper}`);
      if (lo && hi) {
        const live = computeV3UnclaimedFeesFromData({
          tickLower: r.tickLower,
          tickUpper: r.tickUpper,
          liquidity: r.liquidity,
          feeGrowthInside0LastX128: r.feeGrowthInside0LastX128,
          feeGrowthInside1LastX128: r.feeGrowthInside1LastX128,
          tokensOwed0: r.tokensOwed0Stored,
          tokensOwed1: r.tokensOwed1Stored,
          currentTick,
          feeGrowthGlobal0X128: state.feeGrowthGlobal0X128,
          feeGrowthGlobal1X128: state.feeGrowthGlobal1X128,
          feeGrowthOutside0LowerX128: lo.o0,
          feeGrowthOutside1LowerX128: lo.o1,
          feeGrowthOutside0UpperX128: hi.o0,
          feeGrowthOutside1UpperX128: hi.o1,
        });
        tokensOwed0 = live.fees0;
        tokensOwed1 = live.fees1;
      }
    }

    const a0 = humanToFloat(amount0, meta0.decimals);
    const a1 = humanToFloat(amount1, meta1.decimals);
    const f0 = humanToFloat(tokensOwed0, meta0.decimals);
    const f1 = humanToFloat(tokensOwed1, meta1.decimals);
    const p0 = priceBy.get(r.token0.toLowerCase());
    const p1 = priceBy.get(r.token1.toLowerCase());

    out.push({
      tokenId: r.tokenId,
      chainId,
      protocol: 'v3',
      dex,
      token0: r.token0,
      token1: r.token1,
      fee: r.fee,
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      liquidity: r.liquidity,
      tokensOwed0,
      tokensOwed1,
      symbol0: meta0.symbol,
      symbol1: meta1.symbol,
      decimals0: meta0.decimals,
      decimals1: meta1.decimals,
      amount0,
      amount1,
      inRange,
      currentTick,
      poolAddress,
      valueUsd: a0 * (p0 ?? 0) + a1 * (p1 ?? 0),
      unclaimedFeesUsd: f0 * (p0 ?? 0) + f1 * (p1 ?? 0),
      amount0Human: a0,
      amount1Human: a1,
      priceComplete: priceCompleteFor({ amount0: a0 + f0, amount1: a1 + f1, p0, p1 }),
    });
  }

  console.log(
    `[list v3 ${dex}] batched n=${out.length} pools=${uniquePools.length} ticks=${tickJobs.length} ${Date.now() - t0}ms`,
  );
  return out;
}

export async function getPosition(
  chainId: SupportedChainId,
  tokenId: bigint,
  dex: DexId = 'uniswap',
): Promise<OnChainPosition | null> {
  const client = getPublicClient(chainId);
  const { npm } = resolveV3Contracts(chainId, dex);
  const hot = getHotWalletAddress().toLowerCase();

  // Ownership first — DB may still list positions from a previous wallet.
  // A contract revert (burned / never minted) is a confirmed "gone" — safe
  // to return null. Any other failure (RPC timeout, rate limit, etc.) means
  // ownership is UNKNOWN, not "not owned" — rethrow so callers don't treat
  // a transient read failure as "position doesn't exist".
  try {
    const owner = await client.readContract({
      address: npm,
      abi: npmAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    });
    if ((owner as string).toLowerCase() !== hot) return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (classifyOwnershipError(msg) === 'gone') {
      return null; // burned / not minted — confirmed gone
    }
    throw e; // ownership unknown — fail closed, do not treat as gone
  }

  const pos = await client.readContract({
    address: npm,
    abi: npmAbi,
    functionName: 'positions',
    args: [tokenId],
  });

  const token0 = pos[2] as Address;
  const token1 = pos[3] as Address;
  const fee = Number(pos[4]);
  const tickLower = Number(pos[5]);
  const tickUpper = Number(pos[6]);
  const liquidity = pos[7] as bigint;
  const feeGrowthInside0LastX128 = pos[8] as bigint;
  const feeGrowthInside1LastX128 = pos[9] as bigint;
  const tokensOwed0Stored = pos[10] as bigint;
  const tokensOwed1Stored = pos[11] as bigint;

  if (liquidity === 0n && tokensOwed0Stored === 0n && tokensOwed1Stored === 0n) {
    return null;
  }

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(chainId, token0),
    getTokenMeta(chainId, token1),
  ]);

  const poolAddress = await resolvePoolFromFactory(chainId, token0, token1, fee, dex);
  let currentTick = 0;
  let amount0 = 0n;
  let amount1 = 0n;
  let inRange = false;
  let tokensOwed0 = tokensOwed0Stored;
  let tokensOwed1 = tokensOwed1Stored;

  if (poolAddress && liquidity > 0n) {
    const [slot0, poolLiquidity] = await Promise.all([
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'liquidity',
      }),
    ]);
    currentTick = Number(slot0[1]);
    inRange = currentTick >= tickLower && currentTick < tickUpper;

    const am = amountsFromSdk({
      chainId,
      token0,
      token1,
      decimals0: meta0.decimals,
      decimals1: meta1.decimals,
      symbol0: meta0.symbol,
      symbol1: meta1.symbol,
      name0: meta0.name,
      name1: meta1.name,
      fee,
      sqrtPriceX96: slot0[0] as bigint,
      poolLiquidity: poolLiquidity as bigint,
      currentTick,
      liquidity,
      tickLower,
      tickUpper,
    });
    amount0 = am.amount0;
    amount1 = am.amount1;

    const live = await computeV3UnclaimedFees({
      chainId,
      poolAddress,
      tickLower,
      tickUpper,
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0: tokensOwed0Stored,
      tokensOwed1: tokensOwed1Stored,
      currentTick,
    });
    tokensOwed0 = live.fees0;
    tokensOwed1 = live.fees1;
  }

  const a0 = humanToFloat(amount0, meta0.decimals);
  const a1 = humanToFloat(amount1, meta1.decimals);
  const f0 = humanToFloat(tokensOwed0, meta0.decimals);
  const f1 = humanToFloat(tokensOwed1, meta1.decimals);

  // Critical path (feeds TP/SL via computePositionPnl → pnlPct): use the
  // freshness-checked price lookup, not the bare cached number. A stale or
  // unavailable price becomes p0/p1 = null here, which priceCompleteFor
  // already treats as UNKNOWN (priceComplete=false → pnlPct=null → TP/SL
  // takes no action) — never a fabricated $0.
  const [r0, r1] = await Promise.all([
    getCriticalTokenPriceUsd(chainId, token0),
    getCriticalTokenPriceUsd(chainId, token1),
  ]);
  const p0 = r0.ok ? r0.price : null;
  const p1 = r1.ok ? r1.price : null;
  const valueUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  const unclaimedFeesUsd = f0 * (p0 ?? 0) + f1 * (p1 ?? 0);
  const priceComplete = priceCompleteFor({ amount0: a0 + f0, amount1: a1 + f1, p0, p1 });

  return {
    tokenId,
    chainId,
    protocol: 'v3',
    dex,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    tokensOwed0,
    tokensOwed1,
    symbol0: meta0.symbol,
    symbol1: meta1.symbol,
    decimals0: meta0.decimals,
    decimals1: meta1.decimals,
    amount0,
    amount1,
    inRange,
    currentTick,
    poolAddress,
    valueUsd,
    unclaimedFeesUsd,
    amount0Human: a0,
    amount1Human: a1,
    priceComplete,
  };
}

export async function listPositions(chainId: SupportedChainId): Promise<OnChainPosition[]> {
  const t0 = Date.now();
  const { listV4Positions } = await import('./v4.js');
  const dexes = availableV3Dexes(chainId);

  const [v3ByDex, v4] = await Promise.all([
    Promise.all(
      dexes.map(async (dex) => {
        try {
          const ids = await listNpmTokenIds(chainId, dex);
          const positions = await loadV3PositionsBatched(chainId, ids, dex);
          return { dex, ids, positions };
        } catch (e) {
          console.warn(
            `[list] v3 ${dex} failed`,
            e instanceof Error ? e.message : e,
          );
          return { dex, ids: [] as bigint[], positions: [] as OnChainPosition[] };
        }
      }),
    ),
    listV4Positions(chainId).catch((e) => {
      console.warn('[list] v4 failed', e instanceof Error ? e.message : e);
      return [] as OnChainPosition[];
    }),
  ]);

  const v3 = v3ByDex.flatMap((x) => x.positions);
  const v3IdCount = v3ByDex.reduce((n, x) => n + x.ids.length, 0);
  const dexSummary = v3ByDex.map((x) => `${x.dex}=${x.positions.length}`).join(' ');

  console.log(
    `[list] chain=${chainId} v3=${v3.length}/${v3IdCount} (${dexSummary}) v4=${v4.length} ${Date.now() - t0}ms`,
  );
  return [...v3, ...v4];
}

/**
 * Fast path: query only DB-tracked open positions first using the
 * "trusted-source early exit" pattern.
 *
 * 1. Read open token IDs from local DB (cheap, zero RPC).
 * 2. Query only those specific NFTs on-chain (targeted getPosition).
 * 3. If all are active AND count matches → return immediately (skip full enumeration).
 * 4. If mismatch → fall back to full listPositions() (scan all NFTs).
 * 5. Auto-clean zombie DB entries (positions marked 'open' but dead on-chain).
 *
 * This avoids querying hundreds of closed/stale NFTs when the wallet
 * holds many historical position tokens that are no longer active.
 */
export async function listPositionsFast(
  chainId: SupportedChainId,
): Promise<OnChainPosition[]> {
  const t0 = Date.now();
  const dbOpenIds = listTrackedTokenIds(chainId, 'open');

  // No DB-tracked open positions → check if we can skip entirely
  if (dbOpenIds.length === 0) {
    const counts = trackedNftCount(chainId);
    // Full scan — v4 is now fast (skips empty shells), v3 handles balanceOf early-return
    console.log(`[list-fast] chain=${chainId} dbOpen=0 tracked=${counts.total} → hybrid scan`);
    return listPositions(chainId);
  }

  const dexes = availableV3Dexes(chainId);

  // Separate DB positions by protocol to avoid v3/v4 shadowing
  const v3DbIds: string[] = [];
  const v4DbIds: string[] = [];
  const unknownIds: string[] = [];
  for (const id of dbOpenIds) {
    const tracked = getTrackedPosition(id, chainId);
    if (tracked?.protocol === 'v4') {
      v4DbIds.push(id);
    } else if (tracked?.protocol === 'v3') {
      v3DbIds.push(id);
    } else {
      unknownIds.push(id);
    }
  }

  // Track RPC failures separately so we don't zombie-close on transient errors
  const rpcUncertain = new Set<string>();

  // Round 1: query known v3 positions via getPosition (ownership-checked inside)
  const v3Results = await Promise.all(
    [...v3DbIds, ...unknownIds].map(async (tokenIdStr) => {
      const tokenId = BigInt(tokenIdStr);
      let sawRpcError = false;
      for (const dex of dexes) {
        try {
          const pos = await getPosition(chainId, tokenId, dex);
          if (pos) return pos;
        } catch (e) {
          sawRpcError = true;
          console.warn(
            `[list-fast] v3 getPosition #${tokenIdStr} dex=${dex}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      // null = not owned / empty on all dexes; only mark uncertain if every attempt errored
      if (sawRpcError) rpcUncertain.add(tokenIdStr);
      return null;
    }),
  );
  const activeV3 = v3Results.filter((p): p is OnChainPosition => p !== null);
  const v3FoundIds = new Set(activeV3.map((p) => p.tokenId.toString()));

  // Round 2: query known v4 positions — getV4Position checks ownerOf == hot wallet
  const v4Candidates = [...v4DbIds, ...unknownIds.filter((id) => !v3FoundIds.has(id))];
  let activeV4: OnChainPosition[] = [];
  if (v4Candidates.length > 0) {
    const { getV4Position } = await import('./v4.js');
    const v4Results = await Promise.all(
      v4Candidates.map(async (tokenIdStr) => {
        try {
          return await getV4Position(chainId, BigInt(tokenIdStr));
        } catch (e) {
          // RPC / rate-limit — keep DB open; don't treat as not-owned
          rpcUncertain.add(tokenIdStr);
          console.warn(
            `[list-fast] v4 getV4Position #${tokenIdStr}:`,
            e instanceof Error ? e.message : e,
          );
          return null;
        }
      }),
    );
    activeV4 = v4Results.filter((p): p is OnChainPosition => p !== null);
  }

  const allActive = [...activeV3, ...activeV4];
  // Keep open: live positions + ones we couldn't verify (RPC fail)
  const keepOpen = new Set([
    ...allActive.map((p) => p.tokenId.toString()),
    ...rpcUncertain,
  ]);

  // Zombie cleanup: only confirmed not-owned / empty (not in keepOpen)
  const zombiesCleaned = markZombieClosed(chainId, keepOpen);
  if (zombiesCleaned > 0) {
    console.log(`[list-fast] chain=${chainId} zombies cleaned=${zombiesCleaned}`);
  }

  // Completeness check: DB targeted path misses externally-minted v4 NFTs and
  // positions wrongly marked empty-shell. POSM balanceOf includes empty shells;
  // if wallet holds more NFTs than live v4 we found, full discover (which
  // re-probes shells for liquidity).
  let needFullScan = allActive.length === 0 || rpcUncertain.size > 0;
  if (!needFullScan) {
    try {
      const { CHAINS } = await import('../config.js');
      const { getHotWalletAddress, getPublicClient } = await import('./clients.js');
      const { v4PositionManagerAbi } = await import('./abis.js');
      const client = getPublicClient(chainId);
      const bal = (await client.readContract({
        address: CHAINS[chainId].v4PositionManager,
        abi: v4PositionManagerAbi,
        functionName: 'balanceOf',
        args: [getHotWalletAddress()],
      })) as bigint;
      if (Number(bal) > activeV4.length) {
        needFullScan = true;
        console.log(
          `[list-fast] chain=${chainId} incomplete bal=${bal} activeV4=${activeV4.length} → full scan`,
        );
      }
    } catch (e) {
      needFullScan = true;
      console.warn(
        '[list-fast] balanceOf check failed',
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (!needFullScan) {
    console.log(
      `[list-fast] chain=${chainId} targeted=${allActive.length} v3=${activeV3.length} v4=${activeV4.length} zombies=${zombiesCleaned} uncertain=${rpcUncertain.size} ${Date.now() - t0}ms`,
    );
    return allActive;
  }

  console.log(
    `[list-fast] chain=${chainId} targeted=${allActive.length}/${dbOpenIds.length} → full scan`,
  );
  const full = await listPositions(chainId);
  console.log(`[list-fast] chain=${chainId} full total=${full.length} ${Date.now() - t0}ms`);
  return full;
}

/** Prefer non-wrapped symbol as display name */
function displayName(p: OnChainPosition): string {
  const wrapped = new Set(['WETH', 'WBNB', 'ETH', 'BNB', 'USDC', 'USDG', 'USDT']);
  if (!wrapped.has(p.symbol0.toUpperCase())) return p.symbol0;
  if (!wrapped.has(p.symbol1.toUpperCase())) return p.symbol1;
  return `${p.symbol0}/${p.symbol1}`;
}

/**
 * Compact one-liner:
 * CashDog | Age: 2h | Val: E 0.0096 ($32) | Unclaimed: E 0.0001 ($0.34) | PnL: -12.50% | 🟢 IN | Range: …
 */
export async function formatPositionLine(p: OnChainPosition): Promise<string> {
  const venue =
    p.protocol === 'v4'
      ? 'v4'
      : p.dex === 'pancakeswap'
        ? 'PCS'
        : 'v3';
  const name = `${displayName(p)} [${venue}]`;
  const opened = getPositionOpenedAt(p.chainId, p.tokenId.toString());
  const age = formatAge(opened);

  const wrapped = CHAINS[p.chainId].wrapped.toLowerCase();
  // Parallel: PnL + prices (price cache hits are free after list batch)
  const [pnl, nativePrice, px0, px1] = await Promise.all([
    computePositionPnl(p.chainId, p.tokenId, p),
    getTokenPriceUsd(p.chainId, CHAINS[p.chainId].wrapped),
    getTokenPriceUsd(p.chainId, p.token0),
    getTokenPriceUsd(p.chainId, p.token1),
  ]);
  const nPx = nativePrice ?? 0;

  let valNative = 0;
  let unclNative = 0;
  if (p.token0.toLowerCase() === wrapped) {
    valNative += p.amount0Human;
    unclNative += humanToFloat(p.tokensOwed0, p.decimals0);
  } else if (nPx > 0 && (px0 ?? 0) > 0) {
    valNative += (p.amount0Human * (px0 as number)) / nPx;
    unclNative += (humanToFloat(p.tokensOwed0, p.decimals0) * (px0 as number)) / nPx;
  }
  if (p.token1.toLowerCase() === wrapped) {
    valNative += p.amount1Human;
    unclNative += humanToFloat(p.tokensOwed1, p.decimals1);
  } else if (nPx > 0 && (px1 ?? 0) > 0) {
    valNative += (p.amount1Human * (px1 as number)) / nPx;
    unclNative += (humanToFloat(p.tokensOwed1, p.decimals1) * (px1 as number)) / nPx;
  }

  const valueUsd =
    nPx > 0 && valNative > 0 ? valNative * nPx : p.valueUsd;
  const unclaimedUsd = nPx > 0 ? unclNative * nPx : p.unclaimedFeesUsd;

  const valE = formatEthVal(valNative, p.chainId);
  const unclE = formatEthVal(unclNative, p.chainId);
  const valStr = valueUsd > 0 ? `${valE} (${formatUsd(valueUsd)})` : valE;
  const unclStr =
    unclaimedUsd > 0 ? `${unclE} (${formatUsd(unclaimedUsd)})` : unclE;

  const pnlStr =
    pnl.pnlPct != null
      ? `${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct.toFixed(2)}%`
      : 'n/a';
  const status = p.inRange ? '🟢 IN' : '🔴 OUT';

  const range = formatCompactRange({
    chainId: p.chainId,
    token0: p.token0,
    token1: p.token1,
    decimals0: p.decimals0,
    decimals1: p.decimals1,
    symbol0: p.symbol0,
    symbol1: p.symbol1,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    currentTick: p.currentTick,
  });

  const link = uniswapPositionUrl(
    p.chainId,
    p.tokenId,
    p.protocol,
    p.dex ?? 'uniswap',
  );

  p.valueUsd = valueUsd;
  p.unclaimedFeesUsd = unclaimedUsd;

  return (
    `${name} | Age: ${age} | Val: ${valStr} | Unclaimed: ${unclStr} | PnL: ${pnlStr} | ${status} | Range: ${range}\n` +
    `${link}`
  );
}

// silence unused
void formatUnits;
void humanToFloat;
