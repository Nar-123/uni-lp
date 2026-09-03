import {
  encodeFunctionData,
  encodePacked,
  maxUint256,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import {
  availableV3Dexes,
  CHAINS,
  type DexId,
  dexLabel,
  feeTiersForDex,
  resolveV3Contracts,
  type SupportedChainId,
  primaryStableSymbol,
  txUrl,
} from '../config.js';
import { erc20Abi, factoryAbi, poolAbi } from './abis.js';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients.js';
import { formatUnits, getTokenMeta, humanToFloat, humanToRaw } from './tokens.js';
import { weth9Abi } from './wrap.js';
import { getTokenPriceUsd, formatUsd } from '../price/dexscreener.js';
import {
  computeSwapMinOut,
  requirePositiveMinOut,
  resolveReceivedAmount,
  SafetyError,
} from './safety.js';
import {
  getExecutableQuoteV3,
  isQuoteStale,
  LOCAL_QUOTE_MAX_AGE_MS,
  sqrtPriceRatio,
  type QuoteResult,
  type MinimalReadClient,
} from './quote.js';
import { estimateWriteGas } from './gas.js';
import { EXECUTION_RECEIPT_TIMEOUT_MS } from './receiptWait.js';

/** SwapRouter02 exactInputSingle / exactInput (no deadline field) — Uniswap */
const swapRouter02Abi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'unwrapWETH9',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountMinimum', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
  },
] as const;

/**
 * PancakeSwap V3 SwapRouter (deadline in exactInputSingle/exactInput).
 * https://developer.pancakeswap.finance/contracts/v3/addresses
 */
const pcsSwapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'unwrapWETH9',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountMinimum', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000';

/** Default 15% — meme pools move a lot between preview and send */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 1500;

export type PoolHit = {
  pool: Address;
  fee: number;
  liquidity: bigint;
  dex: DexId;
};

export type SwapRoute =
  | {
      kind: 'single';
      fee: number;
      poolAddress: Address;
      dex: DexId;
    }
  | {
      kind: 'multi';
      /** token → mid → wrapped */
      feeIn: number;
      feeOut: number;
      mid: Address;
      midSymbol: string;
      poolIn: Address;
      poolOut: Address;
      path: Hex;
      dex: DexId;
    };

export type SwapPreview = {
  tokenIn: Address;
  symbol: string;
  decimals: number;
  /** ms epoch — real quote timestamp; see isQuoteStale/LOCAL_QUOTE_MAX_AGE_MS in quote.ts */
  quotedAt: number;
  amountIn: bigint;
  amountInHuman: number;
  valueUsd: number;
  fee: number;
  poolAddress: Address;
  estimatedOut: bigint;
  estimatedOutHuman: number;
  amountOutMinimum: bigint;
  slippageBps: number;
  route: SwapRoute;
  routeLabel: string;
  dex: DexId;
};

/** Best direct token→WETH/WBNB, else multi-hop token→stable→wrapped (v3 only). */
export async function findRouteToWrapped(
  chainId: SupportedChainId,
  token: Address,
  preferredDex?: DexId,
): Promise<SwapRoute | null> {
  const wrapped = CHAINS[chainId].wrapped;
  if (token.toLowerCase() === wrapped.toLowerCase()) return null;

  const direct = await findBestPoolToWrapped(chainId, token, preferredDex);
  if (direct) {
    return {
      kind: 'single',
      fee: direct.fee,
      poolAddress: direct.pool,
      dex: direct.dex,
    };
  }

  // Multi-hop via primary stable (USDT on BSC, USDG on Robinhood, else USDC)
  // Both legs must be on the same venue.
  const mids = [primaryStable(chainId), CHAINS[chainId].usdc, CHAINS[chainId].usdt, CHAINS[chainId].usdg]
    .filter((a): a is Address => !!a)
    .filter((a, i, arr) => arr.findIndex((x) => x.toLowerCase() === a.toLowerCase()) === i)
    .filter((a) => a.toLowerCase() !== token.toLowerCase());

  const dexes = preferredDex ? [preferredDex] : availableV3Dexes(chainId);
  let best: SwapRoute | null = null;
  let bestScore = 0n;

  for (const dex of dexes) {
    for (const mid of mids) {
      const legIn = await findBestPool(chainId, token, mid, dex);
      const legOut = await findBestPool(chainId, mid, wrapped, dex);
      if (!legIn || !legOut) continue;
      // Score by min liquidity of the two legs (bottleneck)
      const score = legIn.liquidity < legOut.liquidity ? legIn.liquidity : legOut.liquidity;
      if (score > bestScore) {
        bestScore = score;
        const midMeta = await getTokenMeta(chainId, mid);
        const path = encodePacked(
          ['address', 'uint24', 'address', 'uint24', 'address'],
          [token, legIn.fee, mid, legOut.fee, wrapped],
        );
        best = {
          kind: 'multi',
          feeIn: legIn.fee,
          feeOut: legOut.fee,
          mid,
          midSymbol: midMeta.symbol,
          poolIn: legIn.pool,
          poolOut: legOut.pool,
          path,
          dex,
        };
      }
    }
  }
  return best;
}

export async function findBestPoolToWrapped(
  chainId: SupportedChainId,
  token: Address,
  preferredDex?: DexId,
): Promise<PoolHit | null> {
  return findBestPool(chainId, token, CHAINS[chainId].wrapped, preferredDex);
}

/** All liquid pools token↔wrapped across venues, deepest first */
export async function listPoolsToWrapped(
  chainId: SupportedChainId,
  token: Address,
  preferredDex?: DexId,
): Promise<PoolHit[]> {
  const client = getPublicClient(chainId);
  const wrapped = CHAINS[chainId].wrapped;
  const dexes = preferredDex ? [preferredDex] : availableV3Dexes(chainId);
  const out: PoolHit[] = [];

  for (const dex of dexes) {
    const { factory } = resolveV3Contracts(chainId, dex);
    for (const fee of feeTiersForDex(dex)) {
      try {
        const pool = await client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: 'getPool',
          args: [token, wrapped, fee],
        });
        if (!pool || pool.toLowerCase() === ZERO) continue;
        const liq = await client.readContract({
          address: pool as Address,
          abi: poolAbi,
          functionName: 'liquidity',
        });
        if ((liq as bigint) > 0n) {
          out.push({ pool: pool as Address, fee, liquidity: liq as bigint, dex });
        }
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => (a.liquidity < b.liquidity ? 1 : -1));
  return out;
}

/**
 * Rough amountOut from slot0 (no tick-crossing). Good enough for minOut floor.
 */
export async function estimateAmountOut(
  chainId: SupportedChainId,
  poolAddress: Address,
  tokenIn: Address,
  amountIn: bigint,
  decimalsIn: number,
  decimalsOut: number,
  client: MinimalReadClient = getPublicClient(chainId),
): Promise<bigint> {
  const [token0, slot0] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
  ]);
  const sqrtPriceX96 = (slot0 as readonly unknown[])[0] as bigint;
  if (sqrtPriceX96 === 0n || amountIn === 0n) return 0n;

  const zeroForOne = tokenIn.toLowerCase() === (token0 as string).toLowerCase();
  // Decimals-adjusted price (outHuman per 1 inHuman) — sqrtPriceRatio()
  // already accounts for decimalsIn/decimalsOut possibly differing (e.g.
  // WETH 18dec / USDC 6dec), unlike a raw (sqrtP/2^96)^2 ratio applied
  // directly to human-unit amounts, which was wrong by 10^|decimalsIn -
  // decimalsOut| whenever the pair's decimals differ. See
  // PHASE2_PART3_AUDIT.md §9 and test/swap.decimals.test.ts.
  const priceRatio = sqrtPriceRatio(sqrtPriceX96, decimalsIn, decimalsOut, zeroForOne);
  if (priceRatio == null) return 0n;
  const amountInHuman = Number(amountIn) / 10 ** decimalsIn;
  const outHuman = amountInHuman * priceRatio;
  if (!Number.isFinite(outHuman) || outHuman <= 0) return 0n;
  // apply ~pool fee already small; leave for slippage param
  const raw = BigInt(Math.floor(outHuman * 10 ** decimalsOut));
  return raw > 0n ? raw : 0n;
}

async function ensureAllowance(
  chainId: SupportedChainId,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const owner = getHotWalletAddress();
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if (current >= amount) return;
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, maxUint256],
    account: wallet.account!,
    chain: wallet.chain,
  });
  await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
}

export async function previewSwapToNative(
  chainId: SupportedChainId,
  token: Address,
  amountIn?: bigint,
  slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
): Promise<SwapPreview> {
  const meta = await getTokenMeta(chainId, token);
  const client = getPublicClient(chainId);
  const owner = getHotWalletAddress();
  const bal = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const amt = amountIn != null && amountIn > 0n ? amountIn : bal;
  if (amt <= 0n) throw new Error(`No balance of ${meta.symbol}`);

  const route = await findRouteToWrapped(chainId, token);
  if (!route) {
    const mid = primaryStable(chainId);
    const midSym = mid ? (await getTokenMeta(chainId, mid)).symbol : 'USDT/USDC';
    throw new Error(
      `No v3 route ${meta.symbol}→${CHAINS[chainId].wrappedSymbol} ` +
        `(Uniswap${availableV3Dexes(chainId).includes('pancakeswap') ? '/PancakeSwap' : ''} ` +
        `direct or via ${midSym}).`,
    );
  }

  let estimatedOut = 0n;
  let fee = 0;
  let poolAddress: Address = CHAINS[chainId].wrapped;
  let routeLabel = '';
  let quotedAt = Date.now();
  const venue = dexLabel(route.dex);
  const wrappedMeta = await getTokenMeta(chainId, CHAINS[chainId].wrapped);

  if (route.kind === 'single') {
    fee = route.fee;
    poolAddress = route.poolAddress;
    routeLabel = `${venue} direct · fee ${(fee / 10000).toFixed(2)}%`;
    const q = await getExecutableQuoteV3({
      chainId,
      poolAddress: route.poolAddress,
      tokenIn: token,
      tokenOut: CHAINS[chainId].wrapped,
      decimalsIn: meta.decimals,
      decimalsOut: wrappedMeta.decimals,
      symbolIn: meta.symbol,
      symbolOut: wrappedMeta.symbol,
      nameIn: meta.name,
      nameOut: wrappedMeta.name,
      fee,
      amountIn: amt,
    });
    if (!q.ok) {
      throw new SafetyError(
        `[safety] previewSwapToNative: no real executable quote for ${meta.symbol}→` +
          `${CHAINS[chainId].wrappedSymbol} (${q.code}: ${q.reason}) — aborting, no rough-estimate fallback`,
      );
    }
    estimatedOut = q.amountOut;
    quotedAt = q.quotedAt;
  } else {
    fee = route.feeIn;
    poolAddress = route.poolIn;
    routeLabel =
      `${venue} via ${route.midSymbol} · ` +
      `${(route.feeIn / 10000).toFixed(2)}% + ${(route.feeOut / 10000).toFixed(2)}%`;
    const midMeta = await getTokenMeta(chainId, route.mid);
    const qIn = await getExecutableQuoteV3({
      chainId,
      poolAddress: route.poolIn,
      tokenIn: token,
      tokenOut: route.mid,
      decimalsIn: meta.decimals,
      decimalsOut: midMeta.decimals,
      symbolIn: meta.symbol,
      symbolOut: midMeta.symbol,
      nameIn: meta.name,
      nameOut: midMeta.name,
      fee: route.feeIn,
      amountIn: amt,
    });
    if (!qIn.ok) {
      throw new SafetyError(
        `[safety] previewSwapToNative: no real executable quote for leg ${meta.symbol}→${midMeta.symbol} ` +
          `(${qIn.code}: ${qIn.reason}) — aborting, no rough-estimate fallback`,
      );
    }
    const qOut = await getExecutableQuoteV3({
      chainId,
      poolAddress: route.poolOut,
      tokenIn: route.mid,
      tokenOut: CHAINS[chainId].wrapped,
      decimalsIn: midMeta.decimals,
      decimalsOut: wrappedMeta.decimals,
      symbolIn: midMeta.symbol,
      symbolOut: wrappedMeta.symbol,
      nameIn: midMeta.name,
      nameOut: wrappedMeta.name,
      fee: route.feeOut,
      amountIn: qIn.amountOut,
    });
    if (!qOut.ok) {
      throw new SafetyError(
        `[safety] previewSwapToNative: no real executable quote for leg ${midMeta.symbol}→` +
          `${CHAINS[chainId].wrappedSymbol} (${qOut.code}: ${qOut.reason}) — aborting, no rough-estimate fallback`,
      );
    }
    estimatedOut = qOut.amountOut;
    quotedAt = qOut.quotedAt;
  }

  const amountOutMinimum = computeSwapMinOut({
    estimatedOut,
    slippageBps,
    context: `previewSwapToNative ${meta.symbol}`,
  });

  const human = humanToFloat(amt, meta.decimals);
  const px = (await getTokenPriceUsd(chainId, token)) ?? 0;

  return {
    tokenIn: token,
    symbol: meta.symbol,
    decimals: meta.decimals,
    quotedAt,
    amountIn: amt,
    amountInHuman: human,
    valueUsd: human * px,
    fee,
    poolAddress,
    estimatedOut,
    estimatedOutHuman: humanToFloat(estimatedOut, 18),
    amountOutMinimum,
    slippageBps,
    route,
    routeLabel,
    dex: route.dex,
  };
}

function swapDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 1200);
}

async function tryExactInputSingle(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  fee: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  toRouter: boolean;
  dex: DexId;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getPublicClient(params.chainId);
  const owner = getHotWalletAddress();
  const { swapRouter: router } = resolveV3Contracts(params.chainId, params.dex);
  const wrapped = CHAINS[params.chainId].wrapped;
  try {
    if (params.dex === 'pancakeswap') {
      await client.simulateContract({
        address: router,
        abi: pcsSwapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: params.tokenIn,
            tokenOut: wrapped,
            fee: params.fee,
            recipient: params.toRouter ? router : owner,
            deadline: swapDeadline(),
            amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
        account: owner,
      });
    } else {
      await client.simulateContract({
        address: router,
        abi: swapRouter02Abi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: params.tokenIn,
            tokenOut: wrapped,
            fee: params.fee,
            recipient: params.toRouter ? router : owner,
            amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
        account: owner,
      });
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Swap token → WETH/WBNB via SwapRouter02 (direct or multi-hop via stable), then unwrap.
 * Prefers Uniswap Trading API (native out) when UNISWAP_API_KEY is set.
 */
export async function swapTokenToNative(
  chainId: SupportedChainId,
  token: Address,
  amountIn?: bigint,
  slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
): Promise<{ hash: Hash; txLink: string; amountIn: bigint; symbol: string }> {
  const meta = await getTokenMeta(chainId, token);
  const client = getPublicClient(chainId);
  const owner = getHotWalletAddress();
  const bal = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const amt = amountIn != null && amountIn > 0n ? amountIn : bal;
  if (amt <= 0n) throw new Error(`No balance of ${meta.symbol}`);

  // Trading API is Uniswap-only — try first when a UNI route exists / no PCS preference
  const { hasTradingApiKey, swapTokenToNativeViaApi } = await import('./tradingApi.js');
  if (hasTradingApiKey()) {
    try {
      const slipPct = Math.min(50, Math.max(0.1, slippageBps / 100));
      const r = await swapTokenToNativeViaApi(chainId, token, amt, slipPct);
      return {
        hash: r.hash,
        txLink: r.txLink,
        amountIn: r.amountIn,
        symbol: meta.symbol,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[swapTokenToNative] Trading API failed, local fallback:', msg.slice(0, 240));
    }
  }

  const { withRetries } = await import('./retry.js');
  const nativeBefore = await client.getBalance({ address: owner });
  let lastPreview: SwapPreview | undefined;

  const recordTelemetry = async (params: {
    ok: boolean;
    txHash?: Hash;
    errorMsg?: string;
  }): Promise<void> => {
    if (!lastPreview) return;
    try {
      const { recordExecutionTelemetry } = await import('../db/index.js');
      let actualRaw: string | null = null;
      if (params.ok) {
        const nativeAfter = await client.getBalance({ address: owner });
        actualRaw = resolveReceivedAmount({
          balanceBefore: nativeBefore,
          balanceAfter: nativeAfter,
        }).toString();
      }
      const { buildGasTelemetry } = await import('./gas.js');
      const gas = params.ok && params.txHash
        ? await buildGasTelemetry(client, params.txHash)
        : null;
      recordExecutionTelemetry({
        chainId,
        opType: 'swap',
        dex: lastPreview.dex,
        slippageBpsUsed: lastPreview.slippageBps,
        quoteSource: 'v3-pool-simulation',
        quotedAt: lastPreview.quotedAt,
        route: lastPreview.routeLabel,
        legs: [
          {
            token: CHAINS[chainId].wrapped,
            estimatedRaw: lastPreview.estimatedOut.toString(),
            minRaw: lastPreview.amountOutMinimum.toString(),
            actualRaw,
          },
        ],
        txHash: params.txHash ?? null,
        ok: params.ok,
        errorMsg: params.errorMsg,
        gas,
      });
    } catch {
      /* telemetry is best-effort only */
    }
  };

  try {
    const result = await withRetries(
      async (round) => {
        const preview = await previewSwapToNative(chainId, token, amountIn, slippageBps);
        lastPreview = preview;
        const dex = preview.dex;
      const { swapRouter: router } = resolveV3Contracts(chainId, dex);
      const wrapped = CHAINS[chainId].wrapped;
      const owner = getHotWalletAddress();
      const wallet = getWalletClient(chainId);
      const client = getPublicClient(chainId);
      const route = preview.route;
      const isPcs = dex === 'pancakeswap';
      const deadline = swapDeadline();

      await ensureAllowance(chainId, token, router, preview.amountIn);

      // ensureAllowance can involve a real approve tx+wait — the quote
      // fetched before it may no longer be fresh by the time we're about
      // to use it. Refuse to trade on a stale quote; failing this round
      // simply moves to the next retry round, which re-quotes from scratch.
      if (isQuoteStale(preview.quotedAt)) {
        throw new Error(
          `[safety] swapTokenToNative: quote is stale (age > ${LOCAL_QUOTE_MAX_AGE_MS}ms) after allowance step — refusing to trade on it`,
        );
      }

      // Single, non-degrading minOut derived from the fresh quote above.
      // Retries refresh the quote (previewSwapToNative is re-run each round)
      // and rerun this check — they never weaken protection toward zero.
      const minOutLevels = [
        requirePositiveMinOut(preview.amountOutMinimum, 'swapTokenToNative'),
      ];

      let lastErr = '';
      console.log(
        `[swap] round ${round} dex=${dex} route=${preview.routeLabel} amt=${preview.amountIn} minOuts=${minOutLevels.join(',')}`,
      );

      // ── Multi-hop: exactInput(path) + unwrap ──────────────────────────
      if (route.kind === 'multi') {
        for (const minOut of minOutLevels) {
          const swapData = isPcs
            ? encodeFunctionData({
                abi: pcsSwapRouterAbi,
                functionName: 'exactInput',
                args: [
                  {
                    path: route.path,
                    recipient: router,
                    deadline,
                    amountIn: preview.amountIn,
                    amountOutMinimum: minOut,
                  },
                ],
              })
            : encodeFunctionData({
                abi: swapRouter02Abi,
                functionName: 'exactInput',
                args: [
                  {
                    path: route.path,
                    recipient: router,
                    amountIn: preview.amountIn,
                    amountOutMinimum: minOut,
                  },
                ],
              });
          const unwrapData = encodeFunctionData({
            abi: isPcs ? pcsSwapRouterAbi : swapRouter02Abi,
            functionName: 'unwrapWETH9',
            args: [minOut, owner],
          });
          try {
            if (isPcs) {
              await client.simulateContract({
                address: router,
                abi: pcsSwapRouterAbi,
                functionName: 'multicall',
                args: [[swapData, unwrapData]],
                account: owner,
              });
              const gasPcsMulti = await estimateWriteGas({
                client,
                address: router,
                abi: pcsSwapRouterAbi,
                functionName: 'multicall',
                args: [[swapData, unwrapData]],
                account: wallet.account!.address,
                fallbackGas: 900_000n,
                context: 'swapTokenToNative PCS multi-hop multicall',
              });
              const hash = await wallet.writeContract({
                address: router,
                abi: pcsSwapRouterAbi,
                functionName: 'multicall',
                args: [[swapData, unwrapData]],
                account: wallet.account!,
                chain: wallet.chain,
                gas: gasPcsMulti,
              });
              const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
              if (receipt.status !== 'success') throw new Error(`Swap tx reverted: ${hash}`);
              console.log(`[swap] ok multi PCS via ${route.midSymbol} minOut=${minOut} round=${round}`);
              return {
                hash,
                txLink: txUrl(chainId, hash),
                amountIn: preview.amountIn,
                symbol: preview.symbol,
              };
            }
            await client.simulateContract({
              address: router,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [[swapData, unwrapData]],
              account: owner,
            });
            const gasUniMulti = await estimateWriteGas({
              client,
              address: router,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [[swapData, unwrapData]],
              account: wallet.account!.address,
              fallbackGas: 900_000n,
              context: 'swapTokenToNative multi-hop multicall',
            });
            const hash = await wallet.writeContract({
              address: router,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [[swapData, unwrapData]],
              account: wallet.account!,
              chain: wallet.chain,
              gas: gasUniMulti,
            });
            const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
            if (receipt.status !== 'success') throw new Error(`Swap tx reverted: ${hash}`);
            console.log(`[swap] ok multi via ${route.midSymbol} minOut=${minOut} round=${round}`);
            return {
              hash,
              txLink: txUrl(chainId, hash),
              amountIn: preview.amountIn,
              symbol: preview.symbol,
            };
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
          }
        }
        throw new Error(
          `Multi-hop swap ${preview.symbol}→${route.midSymbol}→${CHAINS[chainId].wrappedSymbol} failed. ` +
            `Last: ${lastErr.slice(0, 220)}`,
        );
      }

      // ── Direct: try all fee tiers (prefer route's dex first) ──────────
      const pools = await listPoolsToWrapped(chainId, token, dex);
      const allPools =
        pools.length > 0 ? pools : await listPoolsToWrapped(chainId, token);
      if (!allPools.length) {
        throw new Error(
          `No liquid v3 pool for ${preview.symbol}→${CHAINS[chainId].wrappedSymbol}`,
        );
      }

      for (const p of allPools) {
        const pDex = p.dex;
        const { swapRouter: pRouter } = resolveV3Contracts(chainId, pDex);
        const pIsPcs = pDex === 'pancakeswap';
        if (pRouter.toLowerCase() !== router.toLowerCase()) {
          await ensureAllowance(chainId, token, pRouter, preview.amountIn);
        }
        for (const minOut of minOutLevels) {
          const swapData = pIsPcs
            ? encodeFunctionData({
                abi: pcsSwapRouterAbi,
                functionName: 'exactInputSingle',
                args: [
                  {
                    tokenIn: token,
                    tokenOut: wrapped,
                    fee: p.fee,
                    recipient: pRouter,
                    deadline,
                    amountIn: preview.amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
              })
            : encodeFunctionData({
                abi: swapRouter02Abi,
                functionName: 'exactInputSingle',
                args: [
                  {
                    tokenIn: token,
                    tokenOut: wrapped,
                    fee: p.fee,
                    recipient: pRouter,
                    amountIn: preview.amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
              });
          const unwrapData = encodeFunctionData({
            abi: pIsPcs ? pcsSwapRouterAbi : swapRouter02Abi,
            functionName: 'unwrapWETH9',
            args: [minOut, owner],
          });
          try {
            if (pIsPcs) {
              await client.simulateContract({
                address: pRouter,
                abi: pcsSwapRouterAbi,
                functionName: 'multicall',
                args: [[swapData, unwrapData]],
                account: owner,
              });
              const gasPcsDirect = await estimateWriteGas({
                client,
                address: pRouter,
                abi: pcsSwapRouterAbi,
                functionName: 'multicall',
                args: [[swapData, unwrapData]],
                account: wallet.account!.address,
                fallbackGas: 700_000n,
                context: 'swapTokenToNative PCS direct multicall',
              });
              const hash = await wallet.writeContract({
                address: pRouter,
                abi: pcsSwapRouterAbi,
                functionName: 'multicall',
                args: [[swapData, unwrapData]],
                account: wallet.account!,
                chain: wallet.chain,
                gas: gasPcsDirect,
              });
              const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
              if (receipt.status !== 'success') {
                throw new Error(`Swap tx reverted: ${hash}`);
              }
              console.log(
                `[swap] ok multicall PCS fee=${p.fee} minOut=${minOut} round=${round}`,
              );
              return {
                hash,
                txLink: txUrl(chainId, hash),
                amountIn: preview.amountIn,
                symbol: preview.symbol,
              };
            }
            await client.simulateContract({
              address: pRouter,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [[swapData, unwrapData]],
              account: owner,
            });
            const gasUniDirect = await estimateWriteGas({
              client,
              address: pRouter,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [[swapData, unwrapData]],
              account: wallet.account!.address,
              fallbackGas: 700_000n,
              context: 'swapTokenToNative direct multicall',
            });
            const hash = await wallet.writeContract({
              address: pRouter,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [[swapData, unwrapData]],
              account: wallet.account!,
              chain: wallet.chain,
              gas: gasUniDirect,
            });
            const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
            if (receipt.status !== 'success') {
              throw new Error(`Swap tx reverted: ${hash}`);
            }
            console.log(
              `[swap] ok multicall fee=${p.fee} minOut=${minOut} round=${round}`,
            );
            return {
              hash,
              txLink: txUrl(chainId, hash),
              amountIn: preview.amountIn,
              symbol: preview.symbol,
            };
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
            const single = await tryExactInputSingle({
              chainId,
              tokenIn: token,
              fee: p.fee,
              amountIn: preview.amountIn,
              amountOutMinimum: minOut,
              toRouter: false,
              dex: pDex,
            });
            if (!single.ok) {
              lastErr = single.error;
              continue;
            }
            try {
              let hash1: Hash;
              if (pIsPcs) {
                const pcsSingleArgs = [
                  {
                    tokenIn: token,
                    tokenOut: wrapped,
                    fee: p.fee,
                    recipient: owner,
                    deadline,
                    amountIn: preview.amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0n,
                  },
                ] as const;
                const gasPcsSingle = await estimateWriteGas({
                  client,
                  address: pRouter,
                  abi: pcsSwapRouterAbi,
                  functionName: 'exactInputSingle',
                  args: pcsSingleArgs,
                  account: wallet.account!.address,
                  fallbackGas: 500_000n,
                  context: 'swapTokenToNative PCS single fallback',
                });
                hash1 = await wallet.writeContract({
                  address: pRouter,
                  abi: pcsSwapRouterAbi,
                  functionName: 'exactInputSingle',
                  args: pcsSingleArgs,
                  account: wallet.account!,
                  chain: wallet.chain,
                  gas: gasPcsSingle,
                });
              } else {
                const uniSingleArgs = [
                  {
                    tokenIn: token,
                    tokenOut: wrapped,
                    fee: p.fee,
                    recipient: owner,
                    amountIn: preview.amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0n,
                  },
                ] as const;
                const gasUniSingle = await estimateWriteGas({
                  client,
                  address: pRouter,
                  abi: swapRouter02Abi,
                  functionName: 'exactInputSingle',
                  args: uniSingleArgs,
                  account: wallet.account!.address,
                  fallbackGas: 500_000n,
                  context: 'swapTokenToNative single fallback',
                });
                hash1 = await wallet.writeContract({
                  address: pRouter,
                  abi: swapRouter02Abi,
                  functionName: 'exactInputSingle',
                  args: uniSingleArgs,
                  account: wallet.account!,
                  chain: wallet.chain,
                  gas: gasUniSingle,
                });
              }
              const r1 = await client.waitForTransactionReceipt({ hash: hash1, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
              if (r1.status !== 'success') throw new Error(`single swap reverted ${hash1}`);

              const wbal = await client.readContract({
                address: wrapped,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [owner],
              });
              if (wbal > 0n) {
                const hash2 = await wallet.writeContract({
                  address: wrapped,
                  abi: weth9Abi,
                  functionName: 'withdraw',
                  args: [wbal],
                  account: wallet.account!,
                  chain: wallet.chain,
                });
                await client.waitForTransactionReceipt({ hash: hash2, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
              }
              console.log(`[swap] ok single ${pDex} fee=${p.fee} minOut=${minOut} round=${round}`);
              return {
                hash: hash1,
                txLink: txUrl(chainId, hash1),
                amountIn: preview.amountIn,
                symbol: preview.symbol,
              };
            } catch (e2) {
              lastErr = e2 instanceof Error ? e2.message : String(e2);
            }
          }
        }
      }

      throw new Error(
        `Swap failed round ${round}/${3} after ${allPools.length} fee tier(s). ` +
          `Last: ${lastErr.slice(0, 220)}`,
      );
      },
      { times: 3, backoffMs: 1000, label: 'swapTokenToNative' },
    );
    await recordTelemetry({ ok: true, txHash: result.hash });
    return result;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    await recordTelemetry({ ok: false, errorMsg });
    throw e;
  }
}

export function formatSwapPreview(p: SwapPreview, chainId: SupportedChainId): string {
  const slip = (p.slippageBps / 100).toFixed(1);
  const est =
    p.estimatedOut > 0n
      ? `Est. out ~${formatUnits(p.estimatedOut, 18)} ${CHAINS[chainId].nativeSymbol}\n` +
        `Min out (${slip}% slip) ~${formatUnits(p.amountOutMinimum, 18)} ${CHAINS[chainId].nativeSymbol}\n`
      : `Est. out: n/a\n`;
  const routerName = p.dex === 'pancakeswap' ? 'PancakeSwap V3 Router' : 'SwapRouter02 (v3)';
  return (
    `Swap ${formatUnits(p.amountIn, p.decimals)} ${p.symbol} → ${CHAINS[chainId].nativeSymbol}\n` +
    `Value ~${formatUsd(p.valueUsd)}\n` +
    `Route: ${p.routeLabel}\n` +
    est +
    `Router: ${routerName}`
  );
}

// ── Generic token→token (v3 local + Trading API) ─────────────────────

export async function findBestPool(
  chainId: SupportedChainId,
  tokenA: Address,
  tokenB: Address,
  preferredDex?: DexId,
): Promise<PoolHit | null> {
  const client = getPublicClient(chainId);
  const dexes = preferredDex ? [preferredDex] : availableV3Dexes(chainId);
  let best: PoolHit | null = null;
  for (const dex of dexes) {
    const { factory } = resolveV3Contracts(chainId, dex);
    for (const fee of feeTiersForDex(dex)) {
      try {
        const pool = await client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: 'getPool',
          args: [tokenA, tokenB, fee],
        });
        if (!pool || pool.toLowerCase() === ZERO) continue;
        const liq = await client.readContract({
          address: pool as Address,
          abi: poolAbi,
          functionName: 'liquidity',
        });
        if ((liq as bigint) === 0n) continue;
        if (!best || (liq as bigint) > best.liquidity) {
          best = { pool: pool as Address, fee, liquidity: liq as bigint, dex };
        }
      } catch {
        /* skip */
      }
    }
  }
  return best;
}

export type TokenToTokenRoute =
  | {
      kind: 'single';
      fee: number;
      poolAddress: Address;
      dex: DexId;
    }
  | {
      kind: 'multi';
      feeIn: number;
      feeOut: number;
      mid: Address;
      midSymbol: string;
      poolIn: Address;
      poolOut: Address;
      path: Hex;
      dex: DexId;
    };

/**
 * Best direct tokenIn→tokenOut v3 pool, else multi-hop via WETH / other stables.
 * Fixes meme→USDG when only meme/WETH exists (e.g. TRASH→WETH→USDG).
 * Scans Uniswap + PancakeSwap on BSC.
 */
export async function findRouteTokenToToken(
  chainId: SupportedChainId,
  tokenIn: Address,
  tokenOut: Address,
  preferredDex?: DexId,
): Promise<TokenToTokenRoute | null> {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;

  const direct = await findBestPool(chainId, tokenIn, tokenOut, preferredDex);
  if (direct) {
    return {
      kind: 'single',
      fee: direct.fee,
      poolAddress: direct.pool,
      dex: direct.dex,
    };
  }

  const wrapped = CHAINS[chainId].wrapped;
  const mids = [
    wrapped,
    primaryStable(chainId),
    CHAINS[chainId].usdc,
    CHAINS[chainId].usdt,
    CHAINS[chainId].usdg,
  ]
    .filter((a): a is Address => !!a)
    .filter((a, i, arr) => arr.findIndex((x) => x.toLowerCase() === a.toLowerCase()) === i)
    .filter(
      (a) =>
        a.toLowerCase() !== tokenIn.toLowerCase() &&
        a.toLowerCase() !== tokenOut.toLowerCase(),
    );

  const dexes = preferredDex ? [preferredDex] : availableV3Dexes(chainId);
  let best: TokenToTokenRoute | null = null;
  let bestScore = 0n;

  for (const dex of dexes) {
    for (const mid of mids) {
      const legIn = await findBestPool(chainId, tokenIn, mid, dex);
      const legOut = await findBestPool(chainId, mid, tokenOut, dex);
      if (!legIn || !legOut) continue;
      const score = legIn.liquidity < legOut.liquidity ? legIn.liquidity : legOut.liquidity;
      if (score > bestScore) {
        bestScore = score;
        const midMeta = await getTokenMeta(chainId, mid);
        const path = encodePacked(
          ['address', 'uint24', 'address', 'uint24', 'address'],
          [tokenIn, legIn.fee, mid, legOut.fee, tokenOut],
        );
        best = {
          kind: 'multi',
          feeIn: legIn.fee,
          feeOut: legOut.fee,
          mid,
          midSymbol: midMeta.symbol,
          poolIn: legIn.pool,
          poolOut: legOut.pool,
          path,
          dex,
        };
      }
    }
  }
  return best;
}

/** Local v3 exact-in (Uniswap SwapRouter02 or PancakeSwap V3 router). */
async function swapExactInLocal(
  chainId: SupportedChainId,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
): Promise<{ hash: Hash; txLink: string; amountIn: bigint }> {
  const [metaIn, metaOut] = await Promise.all([
    getTokenMeta(chainId, tokenIn),
    getTokenMeta(chainId, tokenOut),
  ]);
  const route = await findRouteTokenToToken(chainId, tokenIn, tokenOut);
  if (!route) {
    throw new Error(
      `No v3 route ${metaIn.symbol}→${metaOut.symbol} ` +
        `(direct or via ${CHAINS[chainId].wrappedSymbol}/stable). ` +
        `Try UNISWAP_API_KEY for v4 multi-hop.`,
    );
  }

  const dex = route.dex;
  const { swapRouter: router } = resolveV3Contracts(chainId, dex);
  const isPcs = dex === 'pancakeswap';
  const owner = getHotWalletAddress();
  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);
  await ensureAllowance(chainId, tokenIn, router, amountIn);

  const { withRetries } = await import('./retry.js');
  const outBefore = await client.readContract({
    address: tokenOut,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  let lastEstimatedOut = 0n;
  let lastMinOut = 0n;
  let lastImpactBps: number | null = null;
  let lastQuotedAt: number | undefined;

  const recordTelemetry = async (params: {
    ok: boolean;
    txHash?: Hash;
    errorMsg?: string;
  }): Promise<void> => {
    if (lastEstimatedOut <= 0n) return;
    try {
      const { recordExecutionTelemetry } = await import('../db/index.js');
      let actualRaw: string | null = null;
      if (params.ok) {
        const outAfter = await client.readContract({
          address: tokenOut,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        });
        actualRaw = resolveReceivedAmount({
          balanceBefore: outBefore,
          balanceAfter: outAfter,
        }).toString();
      }
      const { buildGasTelemetry } = await import('./gas.js');
      const gas = params.ok && params.txHash
        ? await buildGasTelemetry(client, params.txHash)
        : null;
      recordExecutionTelemetry({
        chainId,
        opType: 'swap',
        dex,
        slippageBpsUsed: slippageBps,
        priceImpactBps: lastImpactBps,
        quoteSource: 'v3-pool-simulation',
        quotedAt: lastQuotedAt,
        route: route.kind === 'single' ? `direct · fee ${route.fee}` : `via ${route.midSymbol}`,
        legs: [
          {
            token: tokenOut,
            estimatedRaw: lastEstimatedOut.toString(),
            minRaw: lastMinOut.toString(),
            actualRaw,
          },
        ],
        txHash: params.txHash ?? null,
        ok: params.ok,
        errorMsg: params.errorMsg,
        gas,
      });
    } catch {
      /* telemetry is best-effort only */
    }
  };

  try {
    const result = await withRetries(
      async (round) => {
      const deadline = swapDeadline();

      // Fresh quote every round — retries must never reuse a stale estimate
      // or weaken protection; they refresh data and rerun the safety gate.
      // Real executable quote only — no rough-estimate fallback for capital
      // execution (see quote.ts / PHASE2_PART2_QUOTE_AUDIT.md).
      let estimatedOut: bigint;
      let quotedAt: number;
      if (route.kind === 'single') {
        const q = await getExecutableQuoteV3({
          chainId,
          poolAddress: route.poolAddress,
          tokenIn,
          tokenOut,
          decimalsIn: metaIn.decimals,
          decimalsOut: metaOut.decimals,
          symbolIn: metaIn.symbol,
          symbolOut: metaOut.symbol,
          nameIn: metaIn.name,
          nameOut: metaOut.name,
          fee: route.fee,
          amountIn,
        });
        if (!q.ok) {
          throw new SafetyError(
            `[safety] swapExactInLocal: no real executable quote for ${metaIn.symbol}→${metaOut.symbol} ` +
              `(${q.code}: ${q.reason}) — aborting, no rough-estimate fallback`,
          );
        }
        estimatedOut = q.amountOut;
        quotedAt = q.quotedAt;
      } else {
        const midMeta = await getTokenMeta(chainId, route.mid);
        const qIn = await getExecutableQuoteV3({
          chainId,
          poolAddress: route.poolIn,
          tokenIn,
          tokenOut: route.mid,
          decimalsIn: metaIn.decimals,
          decimalsOut: midMeta.decimals,
          symbolIn: metaIn.symbol,
          symbolOut: midMeta.symbol,
          nameIn: metaIn.name,
          nameOut: midMeta.name,
          fee: route.feeIn,
          amountIn,
        });
        if (!qIn.ok) {
          throw new SafetyError(
            `[safety] swapExactInLocal: no real executable quote for leg ${metaIn.symbol}→${midMeta.symbol} ` +
              `(${qIn.code}: ${qIn.reason}) — aborting, no rough-estimate fallback`,
          );
        }
        const qOut = await getExecutableQuoteV3({
          chainId,
          poolAddress: route.poolOut,
          tokenIn: route.mid,
          tokenOut,
          decimalsIn: midMeta.decimals,
          decimalsOut: metaOut.decimals,
          symbolIn: midMeta.symbol,
          symbolOut: metaOut.symbol,
          nameIn: midMeta.name,
          nameOut: metaOut.name,
          fee: route.feeOut,
          amountIn: qIn.amountOut,
        });
        if (!qOut.ok) {
          throw new SafetyError(
            `[safety] swapExactInLocal: no real executable quote for leg ${midMeta.symbol}→${metaOut.symbol} ` +
              `(${qOut.code}: ${qOut.reason}) — aborting, no rough-estimate fallback`,
          );
        }
        estimatedOut = qOut.amountOut;
        quotedAt = qOut.quotedAt;
      }
      lastEstimatedOut = estimatedOut;
      lastQuotedAt = quotedAt;

      // Defense in depth: this round's quote is used within the same
      // round with no allowance-wait gap, but keep the check for
      // consistency and in case a future change introduces one.
      if (isQuoteStale(quotedAt)) {
        throw new Error(
          `[safety] swapExactInLocal: quote is stale (age > ${LOCAL_QUOTE_MAX_AGE_MS}ms) — refusing to trade on it`,
        );
      }

      const { checkPriceImpact } = await import('./priceImpact.js');
      const impact = await checkPriceImpact({
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: estimatedOut,
      });
      lastImpactBps = impact.impactBps;
      if (!impact.ok) {
        throw new Error(impact.reason ?? 'Price impact too high');
      }

      // Single, non-degrading minOut from this round's fresh quote.
      const minLevels = [
        computeSwapMinOut({
          estimatedOut,
          slippageBps,
          context: `swapExactInLocal ${metaIn.symbol}→${metaOut.symbol}`,
        }),
      ];
      lastMinOut = minLevels[0]!;

      let lastErr = '';
      for (const minOut of minLevels) {
        try {
          if (route.kind === 'multi') {
            if (isPcs) {
              const pcsMultiArgs = [
                {
                  path: route.path,
                  recipient: owner,
                  deadline,
                  amountIn,
                  amountOutMinimum: minOut,
                },
              ] as const;
              await client.simulateContract({
                address: router,
                abi: pcsSwapRouterAbi,
                functionName: 'exactInput',
                args: pcsMultiArgs,
                account: owner,
              });
              const gasPcsMulti = await estimateWriteGas({
                client,
                address: router,
                abi: pcsSwapRouterAbi,
                functionName: 'exactInput',
                args: pcsMultiArgs,
                account: wallet.account!.address,
                fallbackGas: 700_000n,
                context: 'swapExactInLocal PCS multi',
              });
              const hash = await wallet.writeContract({
                address: router,
                abi: pcsSwapRouterAbi,
                functionName: 'exactInput',
                args: pcsMultiArgs,
                account: wallet.account!,
                chain: wallet.chain,
                gas: gasPcsMulti,
              });
              const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
              if (receipt.status !== 'success') throw new Error(`swap reverted ${hash}`);
              console.log(
                `[swapExactIn] PCS multi ${metaIn.symbol}→${route.midSymbol}→${metaOut.symbol} ` +
                  `min=${minOut} round=${round}`,
              );
              return { hash, txLink: txUrl(chainId, hash), amountIn };
            }
            const uniMultiArgs = [
              {
                path: route.path,
                recipient: owner,
                amountIn,
                amountOutMinimum: minOut,
              },
            ] as const;
            await client.simulateContract({
              address: router,
              abi: swapRouter02Abi,
              functionName: 'exactInput',
              args: uniMultiArgs,
              account: owner,
            });
            const gasUniMulti = await estimateWriteGas({
              client,
              address: router,
              abi: swapRouter02Abi,
              functionName: 'exactInput',
              args: uniMultiArgs,
              account: wallet.account!.address,
              fallbackGas: 700_000n,
              context: 'swapExactInLocal multi',
            });
            const hash = await wallet.writeContract({
              address: router,
              abi: swapRouter02Abi,
              functionName: 'exactInput',
              args: uniMultiArgs,
              account: wallet.account!,
              chain: wallet.chain,
              gas: gasUniMulti,
            });
            const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
            if (receipt.status !== 'success') throw new Error(`swap reverted ${hash}`);
            console.log(
              `[swapExactIn] multi ${metaIn.symbol}→${route.midSymbol}→${metaOut.symbol} ` +
                `min=${minOut} round=${round}`,
            );
            return { hash, txLink: txUrl(chainId, hash), amountIn };
          }

          if (isPcs) {
            const pcsSingleArgs = [
              {
                tokenIn,
                tokenOut,
                fee: route.fee,
                recipient: owner,
                deadline,
                amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0n,
              },
            ] as const;
            await client.simulateContract({
              address: router,
              abi: pcsSwapRouterAbi,
              functionName: 'exactInputSingle',
              args: pcsSingleArgs,
              account: owner,
            });
            const gasPcsSingle = await estimateWriteGas({
              client,
              address: router,
              abi: pcsSwapRouterAbi,
              functionName: 'exactInputSingle',
              args: pcsSingleArgs,
              account: wallet.account!.address,
              fallbackGas: 450_000n,
              context: 'swapExactInLocal PCS single',
            });
            const hash = await wallet.writeContract({
              address: router,
              abi: pcsSwapRouterAbi,
              functionName: 'exactInputSingle',
              args: pcsSingleArgs,
              account: wallet.account!,
              chain: wallet.chain,
              gas: gasPcsSingle,
            });
            const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
            if (receipt.status !== 'success') throw new Error(`swap reverted ${hash}`);
            console.log(
              `[swapExactIn] PCS ${metaIn.symbol}→${metaOut.symbol} fee=${route.fee} min=${minOut} round=${round}`,
            );
            return { hash, txLink: txUrl(chainId, hash), amountIn };
          }

          const uniSingleArgs = [
            {
              tokenIn,
              tokenOut,
              fee: route.fee,
              recipient: owner,
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ] as const;
          await client.simulateContract({
            address: router,
            abi: swapRouter02Abi,
            functionName: 'exactInputSingle',
            args: uniSingleArgs,
            account: owner,
          });
          const gasUniSingle = await estimateWriteGas({
            client,
            address: router,
            abi: swapRouter02Abi,
            functionName: 'exactInputSingle',
            args: uniSingleArgs,
            account: wallet.account!.address,
            fallbackGas: 450_000n,
            context: 'swapExactInLocal single',
          });
          const hash = await wallet.writeContract({
            address: router,
            abi: swapRouter02Abi,
            functionName: 'exactInputSingle',
            args: uniSingleArgs,
            account: wallet.account!,
            chain: wallet.chain,
            gas: gasUniSingle,
          });
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
          if (receipt.status !== 'success') throw new Error(`swap reverted ${hash}`);
          console.log(
            `[swapExactIn] ${metaIn.symbol}→${metaOut.symbol} fee=${route.fee} min=${minOut} round=${round}`,
          );
          return { hash, txLink: txUrl(chainId, hash), amountIn };
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      throw new Error(`swapExactIn local round ${round} failed: ${lastErr.slice(0, 200)}`);
      },
      { times: 3, backoffMs: 900, label: 'swapExactInLocal' },
    );
    await recordTelemetry({ ok: true, txHash: result.hash });
    return result;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    await recordTelemetry({ ok: false, errorMsg });
    throw e;
  }
}

/**
 * Exact-in tokenIn → tokenOut.
 * Prefers Uniswap Trading API (v2/v3/v4 multi-hop), falls back to local SwapRouter02.
 */
export async function swapExactIn(
  chainId: SupportedChainId,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps = 500, // 5% for stable/WETH pairs
): Promise<{ hash: Hash; txLink: string; amountIn: bigint }> {
  if (amountIn <= 0n) throw new Error('amountIn is 0');
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error('tokenIn === tokenOut');
  }

  const { hasTradingApiKey, swapViaTradingApi } = await import('./tradingApi.js');
  let apiErr = '';
  if (hasTradingApiKey()) {
    try {
      const slipPct = Math.min(50, Math.max(0.1, slippageBps / 100));
      const r = await swapViaTradingApi({
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        slippagePercent: slipPct,
      });
      return { hash: r.hash, txLink: r.txLink, amountIn: r.amountIn };
    } catch (e) {
      apiErr = e instanceof Error ? e.message : String(e);
      console.warn('[swapExactIn] Trading API failed, local fallback:', apiErr.slice(0, 240));
      // If impact too high, local may also fail — still try alternate multi-hop path
    }
  }

  try {
    return await swapExactInLocal(chainId, tokenIn, tokenOut, amountIn, slippageBps);
  } catch (e) {
    const localErr = e instanceof Error ? e.message : String(e);
    if (apiErr && /price impact/i.test(apiErr)) {
      throw new Error(
        `${apiErr} Local route also failed: ${localErr.slice(0, 160)}`,
      );
    }
    throw e;
  }
}

const CORE_SYMBOLS = new Set([
  'WETH',
  'WBNB',
  'ETH',
  'BNB',
  'USDG',
  'USDC',
  'USDT',
  'DAI',
]);

export function isCoreToken(
  chainId: SupportedChainId,
  address: Address,
  symbol?: string,
): boolean {
  const c = CHAINS[chainId];
  const lower = address.toLowerCase();
  if (lower === c.wrapped.toLowerCase()) return true;
  if (c.usdg && lower === c.usdg.toLowerCase()) return true;
  if (c.usdt && lower === c.usdt.toLowerCase()) return true;
  if (c.usdc && lower === c.usdc.toLowerCase()) return true;
  if (lower === ZERO) return true;
  if (symbol && CORE_SYMBOLS.has(symbol.toUpperCase())) return true;
  return false;
}

export type CloseSwapMode = 'eth' | 'usdg';

async function tokenBalance(chainId: SupportedChainId, token: Address): Promise<bigint> {
  const client = getPublicClient(chainId);
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getHotWalletAddress()],
  });
}

async function isDust(
  chainId: SupportedChainId,
  token: Address,
  bal: bigint,
): Promise<{ dust: boolean; symbol: string; note?: string }> {
  const meta = await getTokenMeta(chainId, token).catch(() => null);
  const symbol = meta?.symbol ?? token.slice(0, 10);
  if (bal === 0n) return { dust: true, symbol };
  const human = meta ? humanToFloat(bal, meta.decimals) : 0;
  const px = (await getTokenPriceUsd(chainId, token)) ?? 0;
  if (px > 0 && human * px < 0.05) {
    return { dust: true, symbol, note: `skip dust ${symbol} (~$${(human * px).toFixed(3)})` };
  }
  // No price: still try if raw is non-trivial
  if (px === 0 && meta && bal < 10n ** BigInt(Math.max(0, meta.decimals - 4))) {
    return { dust: true, symbol, note: `skip dust ${symbol}` };
  }
  return { dust: false, symbol };
}

export type RecoveredToken = {
  address: Address;
  symbol: string;
  /** Raw amount recovered from THIS close (cap — never sweep whole wallet) */
  amount: bigint;
};

/**
 * After close auto-swap — only swaps amounts from this position, not full balances.
 *
 * GMGN only sells **to native ETH/BNB** (output is always native). It is not used
 * as a direct meme→USDG router.
 *
 * - eth: memes + stables → native via GMGN; WETH/WBNB → local unwrap
 * - usdg (→ primary stable):
 *     meme   → GMGN sell to native → wrap delta → Uniswap WETH→stable
 *     WETH   → Uniswap WETH→stable (no GMGN)
 *     stable → keep
 */
export async function swapAfterClose(
  chainId: SupportedChainId,
  mode: CloseSwapMode,
  recovered: RecoveredToken[],
): Promise<{ lines: string[] }> {
  const lines: string[] = [];
  const c = CHAINS[chainId];
  const stable = primaryStable(chainId);
  const wrapped = c.wrapped;
  const nativeSym = c.nativeSymbol;
  const stableSym = primaryStableSymbol(chainId);

  const { gmgnSellAmount } = await import('../gmgn/swap.js');
  const { getNativeBalance, wrapNative, getWrappableNative } = await import('./wrap.js');
  const destLabel = mode === 'usdg' ? stableSym : nativeSym;

  // Merge duplicate tokens (token0/token1 same address edge case)
  const merged = new Map<string, RecoveredToken>();
  for (const t of recovered) {
    if (t.amount <= 0n) continue;
    const key = t.address.toLowerCase();
    const prev = merged.get(key);
    if (prev) {
      prev.amount += t.amount;
    } else {
      merged.set(key, { ...t });
    }
  }

  /**
   * Convert a known native wei amount (from this zapout only) into primary stable.
   * Snapshots WETH balance so we only swap what we wrap — never reserved wallet ETH.
   */
  const nativeDeltaToStable = async (
    nativeWei: bigint,
    label: string,
  ): Promise<void> => {
    if (!stable || nativeWei <= 0n) return;
    // Leave a tiny dust for gas if this was a full-ish sell
    const wrappable = await getWrappableNative(chainId);
    const toWrap = nativeWei < wrappable ? nativeWei : wrappable;
    if (toWrap <= 0n) {
      lines.push(`${label}: nothing wrappable for ${stableSym} leg`);
      return;
    }
    const wBefore = await tokenBalance(chainId, wrapped);
    const w = await wrapNative(chainId, toWrap);
    const wAfter = await tokenBalance(chainId, wrapped);
    const wethUse =
      wAfter > wBefore
        ? wAfter - wBefore
        : toWrap; // fallback if balance read races
    const spend = wethUse < toWrap ? wethUse : toWrap;
    if (spend <= 0n) {
      lines.push(`${label}: wrap ok but no WETH to swap (${txUrl(chainId, w.hash)})`);
      return;
    }
    const r = await swapExactIn(chainId, wrapped, stable, spend, 800);
    lines.push(
      `${label}: wrap ${formatUnits(toWrap, 18)} ${nativeSym} → ` +
        `${stableSym} ${r.txLink}`,
    );
  };

  for (const t of merged.values()) {
    const addr = t.address;
    const key = addr.toLowerCase();
    const isWrapped = key === wrapped.toLowerCase();
    const isStable =
      (c.usdg && key === c.usdg.toLowerCase()) ||
      (c.usdt && key === c.usdt.toLowerCase()) ||
      (c.usdc && key === c.usdc.toLowerCase());
    const isMeme = !isWrapped && !isStable && !isCoreToken(chainId, addr, t.symbol);

    let bal: bigint;
    try {
      bal = await tokenBalance(chainId, addr);
    } catch {
      continue;
    }
    // Cap to recovered amount — never touch reserved funds from other deposits
    const use = t.amount < bal ? t.amount : bal;
    if (use <= 0n) continue;

    const d = await isDust(chainId, addr, use);
    if (d.dust) {
      if (d.note) lines.push(d.note);
      continue;
    }

    try {
      if (mode === 'eth') {
        // WETH/WBNB from this position → local unwrap (not a GMGN swap)
        if (isWrapped) {
          const { unwrapNative } = await import('./wrap.js');
          const r = await unwrapNative(chainId, use);
          lines.push(
            `unwrapped ${formatUnits(use, 18)} ${d.symbol} → ${nativeSym}: ${txUrl(chainId, r.hash)}`,
          );
          continue;
        }
        // GMGN only sells to native
        if (isMeme || isStable) {
          const meta = await getTokenMeta(chainId, addr);
          const r = await gmgnSellAmount(chainId, addr, use, 'eth');
          lines.push(
            `GMGN ${formatUnits(use, meta.decimals)} ${d.symbol} → ${nativeSym}: ${r.txLink}`,
          );
        }
      } else {
        // ── Close→stable: GMGN only does meme→ETH; ETH→stable is Uniswap ──
        if (!stable) {
          lines.push(`no stable on chain — skip ${d.symbol}`);
          continue;
        }
        if (isStable) {
          lines.push(`keep ${d.symbol} (already stable)`);
          continue;
        }

        if (isWrapped) {
          // Position returned WETH already — no GMGN, direct Uniswap → stable
          const r = await swapExactIn(chainId, wrapped, stable, use, 800);
          lines.push(
            `UNI ${formatUnits(use, 18)} ${d.symbol} → ${stableSym}: ${r.txLink}`,
          );
          continue;
        }

        if (isMeme) {
          const meta = await getTokenMeta(chainId, addr);
          // 1) GMGN: meme → native only
          const natBefore = await getNativeBalance(chainId);
          const sold = await gmgnSellAmount(chainId, addr, use, 'eth');
          const natAfter = await getNativeBalance(chainId);
          // Prefer balance delta (realised out); fall back to quoted amount
          let ethGot =
            natAfter > natBefore ? natAfter - natBefore : 0n;
          if (ethGot <= 0n && sold.amountOutQuoted > 0n) {
            ethGot = sold.amountOutQuoted;
          }
          lines.push(
            `GMGN ${formatUnits(use, meta.decimals)} ${d.symbol} → ${nativeSym}: ${sold.txLink}`,
          );
          // 2) Uniswap: native (from this sell only) → wrap → stable
          if (ethGot > 0n) {
            await nativeDeltaToStable(ethGot, d.symbol);
          } else {
            lines.push(
              `${d.symbol}: GMGN sold but could not measure ${nativeSym} delta — ` +
                `manual ${nativeSym}→${stableSym} may be needed`,
            );
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(`zapout ${d.symbol} → ${destLabel} failed: ${msg.slice(0, 200)}`);
      console.error('[autoSwap close]', d.symbol, mode, msg);
    }
  }

  return { lines };
}

/** @deprecated use swapAfterClose with recovered amounts */
export async function swapMemeTokensToNative(
  chainId: SupportedChainId,
  tokens: { address: Address; symbol: string; amount?: bigint }[],
): Promise<{ lines: string[] }> {
  return swapAfterClose(
    chainId,
    'eth',
    tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      // Legacy callers without amount: refuse full-wallet sweep — amount 0
      amount: t.amount ?? 0n,
    })),
  );
}

/** Convert ETH wei → stable raw assuming stable ≈ $1 (USDG/USDC). */
function ethWeiToStableRaw(ethWei: bigint, ethPxUsd: number, stableDecimals: number): bigint {
  if (ethWei <= 0n || ethPxUsd <= 0) return 0n;
  // stableHuman = ethHuman * ethPx; scale without full float blow-up
  // ethWei / 1e18 * px * 10^dec = ethWei * px * 10^dec / 1e18
  const pxBps = BigInt(Math.max(1, Math.round(ethPxUsd * 10_000))); // $3500.12 → 35001200
  const dec = BigInt(Math.min(Math.max(stableDecimals, 0), 18));
  // ethWei * pxBps * 10^dec / (1e18 * 10000)
  return (ethWei * pxBps * 10n ** dec) / (10n ** 18n * 10_000n);
}

/**
 * Ensure enough stable (USDG/USDC) for mint by swapping WETH/native → stable.
 * Throws on failure (caller must not silently continue to mint with 0 stable).
 */
export async function ensureStableFromEth(params: {
  chainId: SupportedChainId;
  stableToken: Address;
  /** Minimum stable balance desired after this call */
  needAmount: bigint;
}): Promise<{ swapped: boolean; lines: string[]; hash?: Hash }> {
  const { chainId, stableToken, needAmount } = params;
  const client = getPublicClient(chainId);
  const owner = getHotWalletAddress();
  const wrapped = CHAINS[chainId].wrapped;
  const lines: string[] = [];

  const bal = await client.readContract({
    address: stableToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  if (needAmount <= 0n || bal >= needAmount) {
    return { swapped: false, lines: [] };
  }

  const shortfall = needAmount - bal;
  const stableMeta = await getTokenMeta(chainId, stableToken);

  // Estimate WETH needed: shortfall ≈ USD (stable ~$1), eth = usd / ethPrice * buffer
  let ethPx = (await getTokenPriceUsd(chainId, wrapped)) ?? 0;
  // Fallback: quote 0.01 WETH → stable on deepest v3 pool if DexScreener fails
  if (ethPx <= 0) {
    try {
      const pool = await findBestPool(chainId, wrapped, stableToken);
      if (pool) {
        const testIn = 10n ** 16n; // 0.01 ETH
        const out = await estimateAmountOut(
          chainId,
          pool.pool,
          wrapped,
          testIn,
          18,
          stableMeta.decimals,
        );
        if (out > 0n) {
          ethPx = humanToFloat(out, stableMeta.decimals) / 0.01;
          lines.push(`priced ${CHAINS[chainId].wrappedSymbol} via pool ~$${ethPx.toFixed(2)}`);
        }
      }
    } catch {
      /* */
    }
  }
  if (ethPx <= 0) {
    throw new Error(
      `Need ${formatUnits(shortfall, stableMeta.decimals)} more ${stableMeta.symbol} ` +
        `but can't price ${CHAINS[chainId].wrappedSymbol} for auto-swap (DexScreener/pool)`,
    );
  }

  const shortfallHuman = humanToFloat(shortfall, stableMeta.decimals);
  // +5% buffer for fees/slippage
  const ethNeededHuman = (shortfallHuman / ethPx) * 1.05;
  let ethNeeded = humanToRaw(ethNeededHuman, 18);
  if (ethNeeded < 10_000_000_000_000n) ethNeeded = 10_000_000_000_000n; // min ~0.00001

  const { ensureWrappedBalance, getEffectiveDepositBalance } = await import('./wrap.js');
  const eff = await getEffectiveDepositBalance(chainId, wrapped);
  if (eff.effective <= 0n) {
    throw new Error(
      `Need ${stableMeta.symbol} for this pool but wallet has 0 ${CHAINS[chainId].nativeSymbol}/WETH ` +
        `(after gas reserve). Fund native or ${stableMeta.symbol}.`,
    );
  }

  // Spend up to available ETH (may still leave soft shortfall for percent mints)
  if (ethNeeded > eff.effective) {
    lines.push(
      `note: need ~${formatUnits(ethNeeded, 18)} WETH for full size, ` +
        `using available ${formatUnits(eff.effective, 18)}`,
    );
    ethNeeded = eff.effective;
  }

  const wrapResult = await ensureWrappedBalance(chainId, wrapped, ethNeeded);
  if (wrapResult) {
    lines.push(
      `wrapped ${formatUnits(wrapResult.amount, 18)} native → ${CHAINS[chainId].wrappedSymbol}`,
    );
  }

  const wbal = await client.readContract({
    address: wrapped,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const useAmt = wbal < ethNeeded ? wbal : ethNeeded;
  if (useAmt <= 0n) throw new Error('No WETH to swap for stable after wrap');

  try {
    const r = await swapExactIn(chainId, wrapped, stableToken, useAmt, 800); // 8% slip — stable pairs
    lines.push(
      `swapped ${formatUnits(useAmt, 18)} ${CHAINS[chainId].wrappedSymbol} → ${stableMeta.symbol}: ${r.txLink}`,
    );

    const balAfter = await client.readContract({
      address: stableToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });
    if (balAfter <= bal) {
      throw new Error(
        `Swap mined but ${stableMeta.symbol} balance did not increase ` +
          `(before ${formatUnits(bal, stableMeta.decimals)}, after ${formatUnits(balAfter, stableMeta.decimals)})`,
      );
    }
    if (balAfter < needAmount) {
      lines.push(
        `got ${formatUnits(balAfter, stableMeta.decimals)} ${stableMeta.symbol} ` +
          `(wanted ${formatUnits(needAmount, stableMeta.decimals)}) — minting with available`,
      );
    }
    return { swapped: true, lines, hash: r.hash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `ETH→${stableMeta.symbol} swap failed: ${msg.slice(0, 220)}. ` +
        `Fund ${stableMeta.symbol} directly or check WETH/${stableMeta.symbol} pool liquidity.`,
    );
  }
}

/**
 * Full mint prep: if deposit is stable and short, auto-swap ETH→stable.
 * Hard-fails when autoSwap is on and we still can't fund; clear errors when off.
 */
export async function prepareStableDepositForMint(params: {
  chainId: SupportedChainId;
  stableToken: Address;
  sizeMode: 'percent' | 'fixed';
  balancePercent: number;
  fixedAmountHuman: number;
  autoSwap: boolean;
}): Promise<{ lines: string[] }> {
  const { chainId, stableToken, sizeMode, balancePercent, fixedAmountHuman, autoSwap } = params;
  const wrapped = CHAINS[chainId].wrapped;
  const stableMeta = await getTokenMeta(chainId, stableToken);
  const { getEffectiveDepositBalance } = await import('./wrap.js');
  const { parsePercentOfBalance } = await import('./tokens.js');

  const stableBal = (await getEffectiveDepositBalance(chainId, stableToken)).erc20;
  const ethEff = await getEffectiveDepositBalance(chainId, wrapped);
  let ethPx = (await getTokenPriceUsd(chainId, wrapped)) ?? 0;

  // Desired stable raw amount
  let need = 0n;
  if (sizeMode === 'fixed') {
    need = humanToRaw(fixedAmountHuman, stableMeta.decimals);
    // If fixed is tiny vs eth wealth (user likely means ~fixed ETH not fixed USDG),
    // also consider eth-budget conversion as the size.
    if (ethEff.effective > 0n && ethPx > 0) {
      const ethBudget = humanToRaw(fixedAmountHuman, 18);
      const cap = ethBudget > ethEff.effective ? ethEff.effective : ethBudget;
      const asStable = ethWeiToStableRaw(cap, ethPx, stableMeta.decimals);
      // Only lift target when fixed looks like an ETH size (e.g. 0.05–2) not $50 USDG
      if (fixedAmountHuman > 0 && fixedAmountHuman <= 5 && asStable > need) {
        need = asStable;
      }
    }
  } else {
    // percent of stable if any; else percent of ETH converted to stable
    if (stableBal > 0n) {
      need = parsePercentOfBalance(stableBal, balancePercent);
    }
    if (ethEff.effective > 0n) {
      if (ethPx <= 0) {
        // still try swap path later with pool pricing inside ensureStableFromEth
        ethPx = 2000; // provisional floor so we set a non-zero target; real price in swap step
      }
      const ethBudget = parsePercentOfBalance(ethEff.effective, balancePercent);
      const asStable = ethWeiToStableRaw(ethBudget, ethPx, stableMeta.decimals);
      if (asStable > need) need = asStable;
    }
  }

  if (need <= 0n) {
    if (stableBal > 0n) return { lines: [] };
    throw new Error(
      `No ${stableMeta.symbol} and no ${CHAINS[chainId].nativeSymbol}/WETH to fund it. ` +
        `Fund wallet or pick a WETH pool.`,
    );
  }

  if (stableBal >= need) {
    return { lines: [] };
  }

  // Short of stable
  if (!autoSwap) {
    throw new Error(
      `Pool needs ${stableMeta.symbol} but balance is ${formatUnits(stableBal, stableMeta.decimals)}. ` +
        `You have ${formatUnits(ethEff.effective, 18)} ETH/WETH — turn ON "Mint→${stableMeta.symbol}" in /settings ` +
        `to auto-swap, or buy ${stableMeta.symbol} first.`,
    );
  }

  if (ethEff.effective <= 0n) {
    throw new Error(
      `Need ${formatUnits(need - stableBal, stableMeta.decimals)} more ${stableMeta.symbol} ` +
        `and no ETH/WETH available to swap.`,
    );
  }

  const prep = await ensureStableFromEth({
    chainId,
    stableToken,
    needAmount: need,
  });
  return { lines: prep.lines };
}

/** Chain stable used for auto-swap (USDG → USDT → USDC) */
export function primaryStable(chainId: SupportedChainId): Address | null {
  const c = CHAINS[chainId];
  const list = [c.usdg, c.usdt, c.usdc].filter((a): a is Address => !!a);
  return list[0] ?? null;
}

export function isStableToken(chainId: SupportedChainId, token: Address): boolean {
  const c = CHAINS[chainId];
  const lower = token.toLowerCase();
  if (c.usdg && c.usdg.toLowerCase() === lower) return true;
  if (c.usdt && c.usdt.toLowerCase() === lower) return true;
  if (c.usdc && c.usdc.toLowerCase() === lower) return true;
  return false;
}

/** Native gas token sentinel (Uniswap Trading API convention) */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000' as Address;

export type FlexibleSwapLeg = {
  /** ERC-20 address, or NATIVE_TOKEN for gas token */
  token: Address;
  isNative: boolean;
  symbol: string;
  decimals: number;
};

/**
 * Exact-in any→any for /swap custom CA.
 * Prefers Trading API; local fallback: wrap/unwrap + v3 multi-hop.
 */
export async function swapFlexible(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fromIsNative?: boolean;
  toIsNative?: boolean;
  slippageBps?: number;
}): Promise<{ hash: Hash; txLink: string; amountIn: bigint; routeLabel: string }> {
  const {
    chainId,
    amountIn,
    slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
  } = params;
  if (amountIn <= 0n) throw new Error('amountIn is 0');

  const fromIsNative = params.fromIsNative === true;
  const toIsNative = params.toIsNative === true;
  let tokenIn = params.tokenIn;
  let tokenOut = params.tokenOut;
  if (fromIsNative) tokenIn = NATIVE_TOKEN;
  if (toIsNative) tokenOut = NATIVE_TOKEN;

  if (tokenIn.toLowerCase() === tokenOut.toLowerCase() && fromIsNative === toIsNative) {
    throw new Error('tokenIn === tokenOut');
  }

  const { hasTradingApiKey, swapViaTradingApi } = await import('./tradingApi.js');
  if (hasTradingApiKey()) {
    try {
      const slipPct = Math.min(50, Math.max(0.1, slippageBps / 100));
      const r = await swapViaTradingApi({
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        slippagePercent: slipPct,
      });
      return {
        hash: r.hash,
        txLink: r.txLink,
        amountIn: r.amountIn,
        routeLabel: r.routeLabel,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[swapFlexible] Trading API failed, local fallback:', msg.slice(0, 240));
    }
  }

  // ── Local fallback ────────────────────────────────────────────────────
  const wrapped = CHAINS[chainId].wrapped;

  // native → token: wrap then swap WETH→token
  if (fromIsNative && !toIsNative) {
    const { wrapNative } = await import('./wrap.js');
    await wrapNative(chainId, amountIn);
    const r = await swapExactInLocal(
      chainId,
      wrapped,
      tokenOut,
      amountIn,
      slippageBps,
    );
    return { ...r, routeLabel: 'local · wrap + v3' };
  }

  // token → native
  if (!fromIsNative && toIsNative) {
    const r = await swapTokenToNative(chainId, tokenIn, amountIn, slippageBps);
    return {
      hash: r.hash,
      txLink: r.txLink,
      amountIn: r.amountIn,
      routeLabel: 'local · v3 → unwrap',
    };
  }

  // ERC-20 → ERC-20
  if (!fromIsNative && !toIsNative) {
    const r = await swapExactInLocal(chainId, tokenIn, tokenOut, amountIn, slippageBps);
    return { ...r, routeLabel: 'local · v3 multi-hop' };
  }

  // native → native nonsense
  throw new Error('Cannot swap native to native');
}

/**
 * Soft quote for custom CA swap (Trading API preferred; else rough local estimate).
 */
export async function previewFlexibleSwap(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fromIsNative?: boolean;
  toIsNative?: boolean;
  fromSymbol: string;
  toSymbol: string;
  fromDecimals: number;
  toDecimals: number;
  slippageBps?: number;
}): Promise<{
  amountIn: bigint;
  amountInHuman: string;
  estimatedOut?: bigint;
  estimatedOutHuman?: string;
  routeLabel: string;
  text: string;
}> {
  const {
    chainId,
    amountIn,
    fromSymbol,
    toSymbol,
    fromDecimals,
    toDecimals,
    slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
  } = params;
  const fromIsNative = params.fromIsNative === true;
  const toIsNative = params.toIsNative === true;
  let tokenIn = params.tokenIn;
  let tokenOut = params.tokenOut;
  if (fromIsNative) tokenIn = NATIVE_TOKEN;
  if (toIsNative) tokenOut = NATIVE_TOKEN;

  const amountInHuman = formatUnits(amountIn, fromDecimals);
  let estimatedOut: bigint | undefined;
  let routeLabel = 'local estimate';

  const { hasTradingApiKey } = await import('./tradingApi.js');
  if (hasTradingApiKey()) {
    try {
      // Lightweight quote via Trading API /quote only (no broadcast)
      const { TRADING_API_URL } = await import('./tradingApi.js');
      const key = process.env.UNISWAP_API_KEY!.trim();
      const owner = getHotWalletAddress();
      const slipPct = Math.min(50, Math.max(0.1, slippageBps / 100));
      const res = await fetch(`${TRADING_API_URL}/quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'x-universal-router-version': '2.0',
        },
        body: JSON.stringify({
          swapper: owner,
          tokenIn,
          tokenOut,
          tokenInChainId: String(chainId),
          tokenOutChainId: String(chainId),
          amount: amountIn.toString(),
          type: 'EXACT_INPUT',
          slippageTolerance: slipPct,
          protocols: ['V2', 'V3', 'V4'],
          routingPreference: 'CLASSIC',
        }),
      });
      const json = (await res.json()) as {
        routing?: string;
        quote?: { output?: { amount?: string }; route?: unknown[] };
        detail?: string;
      };
      if (!res.ok) throw new Error(json.detail ?? `quote ${res.status}`);
      if (json.quote?.output?.amount) {
        estimatedOut = BigInt(json.quote.output.amount);
      }
      const hops = Array.isArray(json.quote?.route) ? json.quote!.route!.length : 0;
      routeLabel = `Uniswap API · ${json.routing ?? 'CLASSIC'}${hops ? ` · ${hops} hop(s)` : ''}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[previewFlexibleSwap] API quote failed:', msg.slice(0, 160));
    }
  }

  // Local rough estimate if no API out
  if (estimatedOut == null) {
    try {
      const inAddr = fromIsNative ? CHAINS[chainId].wrapped : tokenIn;
      const outAddr = toIsNative ? CHAINS[chainId].wrapped : tokenOut;
      const route = await findRouteTokenToToken(chainId, inAddr, outAddr);
      if (route?.kind === 'single') {
        estimatedOut = await estimateAmountOut(
          chainId,
          route.poolAddress,
          inAddr,
          amountIn,
          fromDecimals,
          toDecimals,
        );
        routeLabel = `local v3 · fee ${(route.fee / 10000).toFixed(2)}%`;
      } else if (route?.kind === 'multi') {
        const midMeta = await getTokenMeta(chainId, route.mid);
        const midOut = await estimateAmountOut(
          chainId,
          route.poolIn,
          inAddr,
          amountIn,
          fromDecimals,
          midMeta.decimals,
        );
        if (midOut > 0n) {
          estimatedOut = await estimateAmountOut(
            chainId,
            route.poolOut,
            route.mid,
            midOut,
            midMeta.decimals,
            toDecimals,
          );
        }
        routeLabel = `local v3 · via ${route.midSymbol}`;
      } else {
        routeLabel = 'no local v3 route (needs UNISWAP_API_KEY or liquidity)';
      }
    } catch {
      routeLabel = 'estimate unavailable';
    }
  }

  const outHuman =
    estimatedOut != null ? formatUnits(estimatedOut, toDecimals) : undefined;
  const slip = (slippageBps / 100).toFixed(1);
  const lines = [
    `💱 Swap · ${CHAINS[chainId].name}`,
    `${fromSymbol} → ${toSymbol}`,
    ``,
    `Send: ${amountInHuman} ${fromSymbol}`,
    outHuman != null
      ? `Recv: ~${outHuman} ${toSymbol}`
      : `Recv: (quote at confirm — multi-hop / v4)`,
    `Route: ${routeLabel}`,
    `Slippage: ${slip}%`,
    ``,
    `Quotes move fast — confirm soon.`,
  ];

  return {
    amountIn,
    amountInHuman,
    estimatedOut,
    estimatedOutHuman: outHuman,
    routeLabel,
    text: lines.join('\n'),
  };
}

