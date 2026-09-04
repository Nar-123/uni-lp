/**
 * Uniswap v4 helpers: PoolKey, pool load, mint, list, close.
 */
import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  maxUint256,
  type Address,
  type Hash,
  type Hex,
  decodeEventLog,
} from 'viem';
import {
  CHAINS,
  PERMIT2,
  primaryStableAddress,
  type SupportedChainId,
  txUrl,
} from '../config.js';
import {
  erc20Abi,
  permit2Abi,
  stateViewAbi,
  v4PositionManagerAbi,
} from './abis.js';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients.js';
import type { MinimalReadClient } from './quote.js';
import { estimateWriteGas } from './gas.js';
import {
  Token,
  Ether,
  V4Pool,
  V4Position,
  nearestUsableTick,
  TickMath,
  encodeSqrtRatioX96,
} from './uniswap.js';
import {
  fetchUniswapV4PoolsForToken,
  type DexPair,
  getTokenPriceUsd,
  getCriticalTokenPriceUsd,
  formatUsd,
} from '../price/dexscreener.js';
import { fetchTopV4Pools } from '../price/uniswapExplore.js';
import {
  getTokenMeta,
  getTokenBalance,
  getTokenTotalSupply,
  formatUnits,
  humanToFloat,
  resolveDepositAmount,
  type SizeMode,
} from './tokens.js';
import {
  ensureWrappedBalance,
  getEffectiveDepositBalance,
  type WrapResult,
} from './wrap.js';
import { assertOutOfRange, computeSingleSidedRange } from './ticks.js';
import {
  describeSingleSidedSide,
  evaluatePriceMismatch,
  formatAge,
  formatCompactRange,
  formatEthVal,
  formatMcapRange,
  isStableSymbol,
  mcapAtOrientedPrice,
  orientedPriceAtTick,
  resolvePriceOrientation,
  uniswapPositionUrl,
  type MintPreviewResult,
} from './prices.js';
import type { OnChainPosition } from './positions.js';
import {
  getPositionOpenedAt,
  listTrackedTokenIds,
  markEmptyShell,
  getEmptyShells,
  trackedNftCount,
  clearEmptyShell,
} from '../db/index.js';
import { computePositionPnl } from '../pnl/compute.js';
import { config } from '../config.js';
import {
  CLOSE_SLIPPAGE_BPS,
  classifyOwnershipError,
  computeWithdrawalMins,
  priceCompleteFor,
  resolveReceivedAmount,
} from './safety.js';
import { EXECUTION_RECEIPT_TIMEOUT_MS } from './receiptWait.js';

export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type V4PoolInfo = {
  protocol: 'v4';
  poolId: Hex;
  poolKey: V4PoolKey;
  token0: Awaited<ReturnType<typeof getTokenMeta>>;
  token1: Awaited<ReturnType<typeof getTokenMeta>>;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tvlUsd?: number;
  dexUrl?: string;
};

export type ListedV4Pool = {
  protocol: 'v4';
  pair: DexPair;
  /** PoolId (bytes32 hex) — used as identifier in UI/session */
  poolAddress: string;
  poolId: Hex;
  poolKey: V4PoolKey;
  fee: number;
  tvlUsd: number;
  token0: Address;
  token1: Address;
  otherSymbol: string;
  otherAddress: Address;
  label: string;
};

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const HOOKS_ZERO = ZERO;

/** Standard fee → spacing (vanilla). Custom fees need POSM.poolKeys or spacing brute-force. */
const FEE_SPACING: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

/** Tick spacings to try when fee is known but POSM cache empty (Robinhood custom pools use odd values e.g. 644) */
const SPACING_CANDIDATES = [
  1, 10, 50, 60, 100, 200, 250, 300, 400, 500, 600, 644, 800, 1000, 2000,
];

/** Truncate full poolId (bytes32) to bytes25 for PositionManager.poolKeys */
export function poolIdToBytes25(poolId: string): Hex {
  const hex = poolId.startsWith('0x') ? poolId.slice(2) : poolId;
  if (hex.length < 50) throw new Error(`Invalid poolId: ${poolId}`);
  return `0x${hex.slice(0, 50)}` as Hex;
}

export function computePoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** Default fee tier for newly created meme pools (1%, spacing 200) */
export const CREATE_V4_FEE = 10_000;
export const CREATE_V4_TICK_SPACING = 200;
/** Initialize pool this fraction below DexScreener market (1% = single-sided stable starts slightly below) */
export const CREATE_V4_BELOW_MARKET_BPS = 100; // 1%

/**
 * Uniswap v4 fee is in hundredths of a bip (1e-6):
 * 500 = 0.05%, 3000 = 0.3%, 10000 = 1%, 30000 = 3%.
 * Max practical for our UI: 50% = 500_000.
 */
export const CREATE_V4_FEE_PRESETS = [
  { fee: 10_000, label: '1%' },
  { fee: 20_000, label: '2%' },
  { fee: 30_000, label: '3%' },
  { fee: 50_000, label: '5%' },
  { fee: 100_000, label: '10%' },
] as const;

/** Fee pips (uint24) → human % string */
export function formatV4FeePercent(fee: number): string {
  const pct = fee / 10_000;
  if (pct >= 10) return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(4)}%`;
}

/**
 * Suggest tick spacing for a custom fee.
 * Vanilla tiers match Uniswap defaults; higher meme fees scale up.
 */
export function suggestTickSpacingForFee(fee: number): number {
  if (fee <= 100) return 1;
  if (fee <= 500) return 10;
  if (fee <= 3_000) return 60;
  if (fee <= 10_000) return 200;
  if (fee <= 20_000) return 400;
  if (fee <= 30_000) return 600;
  if (fee <= 50_000) return 1_000;
  if (fee <= 100_000) return 2_000;
  // very wide (up to 50%): keep ticks coarse
  return Math.min(10_000, Math.max(2_000, Math.round(fee / 50 / 100) * 100));
}

/**
 * Parse human fee percent → pips.
 * Accepts "1", "1%", "0.3", "3.66", "10%"
 */
export function parseV4FeePercent(raw: string): number {
  const s = raw.trim().replace(/%/g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 50) {
    throw new Error('Fee must be between 0 and 50 (percent), e.g. 1 or 3.66');
  }
  // pips = percent * 10000 (1% → 10000)
  const fee = Math.round(n * 10_000);
  if (fee < 1 || fee > 500_000) {
    throw new Error('Fee out of range for v4 uint24 pips');
  }
  return fee;
}

/**
 * Build PoolKey for meme CA + quote (stable preferred, else wrapped).
 * Currencies sorted by address (v4 rule). hooks = 0.
 * Custom fee is a v4 superpower — any fee pips + matching tickSpacing.
 */
export function buildCreateV4PoolKey(
  chainId: SupportedChainId,
  memeToken: Address,
  quoteToken?: Address,
  fee: number = CREATE_V4_FEE,
  tickSpacing?: number,
): V4PoolKey {
  const quote =
    quoteToken ??
    primaryStableAddress(chainId) ??
    CHAINS[chainId].wrapped;
  if (memeToken.toLowerCase() === quote.toLowerCase()) {
    throw new Error('Meme token equals quote token');
  }
  const feePips = Math.max(1, Math.min(500_000, Math.round(fee)));
  const spacing = tickSpacing ?? suggestTickSpacingForFee(feePips);
  if (spacing < 1 || spacing > 16_384) {
    throw new Error(`Invalid tickSpacing ${spacing}`);
  }
  const [currency0, currency1] = sortCurrencies(memeToken, quote);
  return {
    currency0,
    currency1,
    fee: feePips,
    tickSpacing: spacing,
    hooks: HOOKS_ZERO,
  };
}

/**
 * sqrtPriceX96 for currency1/currency0 from oriented price (quote USD units per 1 meme).
 * Below-market: pass orientedPrice already reduced.
 */
export function sqrtPriceX96FromMemeQuotePrice(params: {
  poolKey: V4PoolKey;
  memeToken: Address;
  /** Quote tokens per 1 meme (e.g. 0.001 USDT per VenusCoin) */
  quotePerMeme: number;
  decimals0: number;
  decimals1: number;
}): bigint {
  const { poolKey, memeToken, quotePerMeme, decimals0, decimals1 } = params;
  if (!(quotePerMeme > 0) || !Number.isFinite(quotePerMeme)) {
    throw new Error('Invalid quotePerMeme for pool init');
  }
  const memeIs0 = poolKey.currency0.toLowerCase() === memeToken.toLowerCase();
  // Use large fixed-point integers to avoid float dust
  const Q = 10n ** 18n;
  // human: 1 meme costs P quote
  // raw: amountMeme = 10^dM, amountQuote = P * 10^dQ
  const pQ = BigInt(Math.max(1, Math.round(quotePerMeme * 1e18)));
  if (memeIs0) {
    // token0=meme, token1=quote → price = quote/meme
    const amount0 = 10n ** BigInt(decimals0); // 1 meme
    const amount1 = (pQ * 10n ** BigInt(decimals1)) / Q;
    if (amount1 <= 0n) throw new Error('Init price too small for token decimals');
    return BigInt(encodeSqrtRatioX96(amount1.toString(), amount0.toString()).toString());
  }
  // token0=quote, token1=meme → price = meme/quote = 1/P
  const amount1 = 10n ** BigInt(decimals1); // 1 meme
  const amount0 = (pQ * 10n ** BigInt(decimals0)) / Q;
  if (amount0 <= 0n) throw new Error('Init price too small for token decimals');
  return BigInt(encodeSqrtRatioX96(amount1.toString(), amount0.toString()).toString());
}

/** DexScreener-oriented market: quote units per 1 meme */
export async function marketQuotePerMeme(
  chainId: SupportedChainId,
  memeToken: Address,
  quoteToken: Address,
): Promise<number> {
  const [memeUsd, quoteUsd] = await Promise.all([
    getTokenPriceUsd(chainId, memeToken),
    getTokenPriceUsd(chainId, quoteToken),
  ]);
  if (memeUsd == null || memeUsd <= 0) {
    throw new Error('No DexScreener USD price for meme — cannot set init price');
  }
  const q = quoteUsd != null && quoteUsd > 0 ? quoteUsd : 1;
  return memeUsd / q;
}

/**
 * Initialize a new Uniswap v4 pool (no hooks) at ~1% below DexScreener market,
 * then mint single-sided LP with deposit token (usually stable).
 */
export async function createV4PoolAndMintSingleSided(params: {
  chainId: SupportedChainId;
  memeToken: Address;
  /** Defaults to primary stable or WETH/WBNB */
  quoteToken?: Address;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  edgeBufferPercent?: number;
  /** bps below market for init (default 100 = 1%) */
  belowMarketBps?: number;
  /** v4 fee in hundredths of a bip (e.g. 10000 = 1%). Default 1%. */
  fee?: number;
  /** Optional override; default from suggestTickSpacingForFee(fee) */
  tickSpacing?: number;
}): Promise<V4MintResult & { created: true; initSqrtPriceX96: bigint; marketQuotePerMeme: number }> {
  const {
    chainId,
    memeToken,
    depositToken,
    balancePercent,
    sizeMode,
    fixedAmountHuman,
    widthPercent,
    edgeBufferPercent,
    belowMarketBps = CREATE_V4_BELOW_MARKET_BPS,
    fee = CREATE_V4_FEE,
    tickSpacing,
  } = params;

  const poolKey = buildCreateV4PoolKey(
    chainId,
    memeToken,
    params.quoteToken,
    fee,
    tickSpacing,
  );
  const quoteToken =
    poolKey.currency0.toLowerCase() === memeToken.toLowerCase()
      ? poolKey.currency1
      : poolKey.currency0;

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(chainId, poolKey.currency0),
    getTokenMeta(chainId, poolKey.currency1),
  ]);

  const market = await marketQuotePerMeme(chainId, memeToken, quoteToken);
  const initPrice = market * (1 - belowMarketBps / 10_000);
  if (!(initPrice > 0)) throw new Error('Init price invalid after below-market adjust');

  const sqrtPriceX96 = sqrtPriceX96FromMemeQuotePrice({
    poolKey,
    memeToken,
    quotePerMeme: initPrice,
    decimals0: meta0.decimals,
    decimals1: meta1.decimals,
  });

  const poolId = computePoolId(poolKey);
  const posm = CHAINS[chainId].v4PositionManager;
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const account = getHotWalletAddress();

  // Skip init if pool already exists
  let already = false;
  try {
    const slot = await client.readContract({
      address: CHAINS[chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getSlot0',
      args: [poolId],
    });
    const sp = slot[0] as bigint;
    if (sp > 0n) already = true;
  } catch {
    /* not initialized */
  }

  if (!already) {
    console.log(
      `[v4 create] init pool ${poolId.slice(0, 18)}… fee=${poolKey.fee} ` +
        `market=${market} init=${initPrice} (${belowMarketBps}bps below)`,
    );
    try {
      await client.simulateContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'initializePool',
        args: [
          {
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            fee: poolKey.fee,
            tickSpacing: poolKey.tickSpacing,
            hooks: poolKey.hooks,
          },
          sqrtPriceX96,
        ],
        account,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Already initialized race
      if (!/already|initialized|PoolAlreadyInitialized/i.test(msg)) {
        throw new Error(`v4 initializePool would revert: ${msg.slice(0, 280)}`);
      }
      already = true;
    }

    if (!already) {
      const initArgs = [
        {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks: poolKey.hooks,
        },
        sqrtPriceX96,
      ] as const;
      const initGas = await estimateWriteGas({
        client,
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'initializePool',
        args: initArgs,
        account: wallet.account!.address,
        fallbackGas: 500_000n,
        context: 'v4 initializePool',
      });
      const hash = await wallet.writeContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'initializePool',
        args: initArgs,
        account: wallet.account!,
        chain: wallet.chain,
        gas: initGas,
      });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
      if (receipt.status !== 'success') {
        throw new Error(`initializePool tx reverted: ${hash}`);
      }
      console.log(`[v4 create] initialized tx=${hash}`);
    }
  }

  const mint = await mintV4SingleSided({
    chainId,
    poolId,
    poolKey,
    depositToken,
    balancePercent,
    sizeMode,
    fixedAmountHuman,
    widthPercent,
    edgeBufferPercent,
  });

  return {
    ...mint,
    created: true,
    initSqrtPriceX96: sqrtPriceX96,
    marketQuotePerMeme: market,
  };
}

/** Preview text for create-v4 confirm (no on-chain write) */
export async function describeCreateV4Preview(params: {
  chainId: SupportedChainId;
  memeToken: Address;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  belowMarketBps?: number;
  fee?: number;
  tickSpacing?: number;
}): Promise<{ text: string; poolKey: V4PoolKey; market: number; initPrice: number }> {
  const fee = params.fee ?? CREATE_V4_FEE;
  const poolKey = buildCreateV4PoolKey(
    params.chainId,
    params.memeToken,
    undefined,
    fee,
    params.tickSpacing,
  );
  const quoteToken =
    poolKey.currency0.toLowerCase() === params.memeToken.toLowerCase()
      ? poolKey.currency1
      : poolKey.currency0;
  const [memeMeta, quoteMeta, depMeta] = await Promise.all([
    getTokenMeta(params.chainId, params.memeToken),
    getTokenMeta(params.chainId, quoteToken),
    getTokenMeta(params.chainId, params.depositToken),
  ]);
  const market = await marketQuotePerMeme(params.chainId, params.memeToken, quoteToken);
  const bps = params.belowMarketBps ?? CREATE_V4_BELOW_MARKET_BPS;
  const initPrice = market * (1 - bps / 10_000);
  const eff = await getEffectiveDepositBalance(params.chainId, params.depositToken);
  const amount = resolveDepositAmount(eff.effective, {
    sizeMode: params.sizeMode ?? 'percent',
    balancePercent: params.balancePercent,
    fixedAmountHuman: params.fixedAmountHuman ?? 0.1,
    decimals: depMeta.decimals,
    symbol: depMeta.symbol,
  });
  const sizeLabel =
    (params.sizeMode ?? 'percent') === 'fixed'
      ? `${params.fixedAmountHuman ?? 0.1} fixed`
      : `${params.balancePercent}%`;
  const px = (await getTokenPriceUsd(params.chainId, params.depositToken)) ?? 0;
  const valueUsd = humanToFloat(amount, depMeta.decimals) * px;

  const text =
    `🆕 Create Uniswap v4 pool + mint\n` +
    `Pair: ${memeMeta.symbol}/${quoteMeta.symbol}\n` +
    `Fee ${formatV4FeePercent(poolKey.fee)} (${poolKey.fee} pips) · spacing ${poolKey.tickSpacing} · no hooks\n` +
    `Market (DexScreener): ${market.toPrecision(6)} ${memeMeta.symbol}/${quoteMeta.symbol}\n` +
    `Init price: ${initPrice.toPrecision(6)} (${bps / 100}% below market)\n` +
    `Width ${params.widthPercent}% single-sided ${depMeta.symbol}\n` +
    `Deposit: ${formatUnits(amount, depMeta.decimals)} ${depMeta.symbol} (${sizeLabel}` +
    (px > 0 ? ` · ${formatUsd(valueUsd)}` : '') +
    `)\n` +
    `⚠️ New empty pool — you set the first price; use at your own risk.`;

  return { text, poolKey, market, initPrice };
}

/**
 * Recover PoolKey from PositionManager.poolKeys cache only (no token pair guess).
 * Works after any POSM interaction / when session lost poolKey but poolId is known.
 */
export async function resolveV4PoolKeyFromId(
  chainId: SupportedChainId,
  poolId: Hex,
): Promise<V4PoolKey | null> {
  const client = getPublicClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  try {
    const key = await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'poolKeys',
      args: [poolIdToBytes25(poolId)],
    });
    const tickSpacing = Number(key[3]);
    if (tickSpacing === 0) return null;
    return {
      currency0: key[0] as Address,
      currency1: key[1] as Address,
      fee: Number(key[2]),
      tickSpacing,
      hooks: key[4] as Address,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve full PoolKey for a known poolId.
 * Prefer PositionManager.poolKeys (works for any fee/spacing once a position was minted).
 * Fallback: match poolId by trying fee+spacing candidates with token currencies.
 */
export async function resolveV4PoolKey(
  chainId: SupportedChainId,
  poolId: Hex,
  tokenA: Address,
  tokenB: Address,
  knownFee?: number,
): Promise<V4PoolKey | null> {
  const fromCache = await resolveV4PoolKeyFromId(chainId, poolId);
  if (fromCache) return fromCache;

  // Currency pair variants: ERC20 as given, and native (0x0) if one side is wrapped
  const wrapped = CHAINS[chainId].wrapped.toLowerCase();
  const pairVariants: [Address, Address][] = [sortCurrencies(tokenA, tokenB)];
  for (const [a, b] of [[tokenA, tokenB], [tokenB, tokenA]] as [Address, Address][]) {
    if (a.toLowerCase() === wrapped) {
      pairVariants.push(sortCurrencies(ZERO, b));
    }
  }

  const feesToTry =
    knownFee != null && knownFee > 0
      ? [knownFee, ...FEE_SPACING.map(([f]) => f)]
      : FEE_SPACING.map(([f]) => f);
  const uniqueFees = [...new Set(feesToTry)];

  for (const [c0, c1] of pairVariants) {
    for (const fee of uniqueFees) {
      const spacings =
        knownFee != null && fee === knownFee
          ? SPACING_CANDIDATES
          : FEE_SPACING.filter(([f]) => f === fee).map(([, s]) => s).concat(SPACING_CANDIDATES);
      const uniqueSp = [...new Set(spacings)];
      for (const spacing of uniqueSp) {
        const candidate: V4PoolKey = {
          currency0: c0,
          currency1: c1,
          fee,
          tickSpacing: spacing,
          hooks: HOOKS_ZERO,
        };
        const id = computePoolId(candidate);
        if (id.toLowerCase() === poolId.toLowerCase()) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function syntheticDexPair(params: {
  poolId: string;
  chainSlug: string;
  symbol0: string;
  symbol1: string;
  addr0: string;
  addr1: string;
  tvlUsd: number;
}): DexPair {
  return {
    chainId: params.chainSlug,
    dexId: 'uniswap',
    pairAddress: params.poolId,
    labels: ['v4'],
    baseToken: {
      address: params.addr0,
      symbol: params.symbol0,
      name: params.symbol0,
    },
    quoteToken: {
      address: params.addr1,
      symbol: params.symbol1,
      name: params.symbol1,
    },
    liquidity: { usd: params.tvlUsd },
  };
}

export async function listV4PoolsForToken(
  chainId: SupportedChainId,
  tokenCa: Address,
): Promise<ListedV4Pool[]> {
  const out: ListedV4Pool[] = [];
  const ca = tokenCa.toLowerCase();
  const wrapped = CHAINS[chainId].wrapped;
  const slug = CHAINS[chainId].dexscreenerSlug;

  // 1) Primary: Uniswap explore GraphQL (same source as app.uniswap.org)
  try {
    const explore = await fetchTopV4Pools(chainId, tokenCa);
    console.log(`[v4] explore found ${explore.length} pools for ${tokenCa.slice(0, 10)}…`);
    for (const ep of explore) {
      try {
        const tokenA = (ep.currency0 ?? ZERO) as Address;
        const tokenB = (ep.currency1 ?? ZERO) as Address;
        // For resolve: pass actual ERC20 when native is null
        const resolveA =
          ep.currency0 ??
          (ep.symbol0 === 'ETH' || ep.symbol0 === 'BNB' ? wrapped : ZERO);
        const resolveB =
          ep.currency1 ??
          (ep.symbol1 === 'ETH' || ep.symbol1 === 'BNB' ? wrapped : ZERO);

        const poolKey = await resolveV4PoolKey(
          chainId,
          ep.poolId,
          resolveA,
          resolveB,
          ep.fee,
        );
        if (!poolKey) {
          console.warn('[v4] could not resolve PoolKey', ep.poolId.slice(0, 18), 'fee', ep.fee);
          continue;
        }

        const client = getPublicClient(chainId);
        const slot0 = await client.readContract({
          address: CHAINS[chainId].v4StateView,
          abi: stateViewAbi,
          functionName: 'getSlot0',
          args: [ep.poolId],
        });
        if ((slot0[0] as bigint) === 0n) continue;

        // "other" side relative to pasted CA
        const c0 = poolKey.currency0.toLowerCase();
        const c1 = poolKey.currency1.toLowerCase();
        const caIs0 =
          c0 === ca ||
          (c0 === ZERO && (wrapped.toLowerCase() === ca || resolveA.toLowerCase() === ca));
        // better: check if token is CA
        let otherAddress: Address;
        let otherSymbol: string;
        if (c0 === ca || (ep.currency0 && ep.currency0.toLowerCase() === ca)) {
          otherAddress = poolKey.currency1.toLowerCase() === ZERO ? wrapped : poolKey.currency1;
          otherSymbol =
            poolKey.currency1.toLowerCase() === ZERO
              ? CHAINS[chainId].wrappedSymbol
              : ep.symbol1;
        } else if (c1 === ca || (ep.currency1 && ep.currency1.toLowerCase() === ca)) {
          otherAddress = poolKey.currency0.toLowerCase() === ZERO ? wrapped : poolKey.currency0;
          otherSymbol =
            poolKey.currency0.toLowerCase() === ZERO
              ? CHAINS[chainId].wrappedSymbol
              : ep.symbol0;
        } else if (c0 === ZERO || c1 === ZERO) {
          // native pool: other is WETH side if CA is the meme
          otherAddress = wrapped;
          otherSymbol = CHAINS[chainId].wrappedSymbol;
        } else {
          otherAddress = poolKey.currency0.toLowerCase() === ca ? poolKey.currency1 : poolKey.currency0;
          otherSymbol = otherAddress.toLowerCase() === c0 ? ep.symbol0 : ep.symbol1;
        }

        // Prefer human symbols for native
        if (otherAddress.toLowerCase() === wrapped.toLowerCase()) {
          otherSymbol = CHAINS[chainId].wrappedSymbol;
        }
        if (c0 === ZERO && otherAddress.toLowerCase() === wrapped.toLowerCase()) {
          otherSymbol = CHAINS[chainId].nativeSymbol === 'ETH' ? 'WETH' : CHAINS[chainId].wrappedSymbol;
        }

        const feeLabel = `${(poolKey.fee / 10000).toFixed(2)}%`;
        const tvlUsd = ep.tvlUsd;
        const pair = syntheticDexPair({
          poolId: ep.poolId,
          chainSlug: slug,
          symbol0: ep.symbol0,
          symbol1: ep.symbol1,
          addr0: (ep.currency0 ?? ZERO) as string,
          addr1: (ep.currency1 ?? ZERO) as string,
          tvlUsd,
        });

        void tokenA;
        void tokenB;
        void caIs0;

        out.push({
          protocol: 'v4',
          pair,
          poolAddress: ep.poolId,
          poolId: ep.poolId,
          poolKey,
          fee: poolKey.fee,
          tvlUsd,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          otherSymbol,
          otherAddress,
          label: `v4 · ${otherSymbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
        });
      } catch (e) {
        console.warn(
          '[v4 explore skip]',
          ep.poolId.slice(0, 18),
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.warn('[v4] explore failed', e instanceof Error ? e.message : e);
  }

  // 2) Secondary: DexScreener (often empty for v4 on Robinhood)
  try {
    const pairs = await fetchUniswapV4PoolsForToken(chainId, tokenCa);
    for (const pair of pairs) {
      const poolId = (pair.pairAddress.startsWith('0x')
        ? pair.pairAddress
        : `0x${pair.pairAddress}`) as Hex;
      if (poolId.length !== 66) continue;
      if (out.some((p) => p.poolId.toLowerCase() === poolId.toLowerCase())) continue;

      const base = pair.baseToken.address as Address;
      const quote = pair.quoteToken.address as Address;
      if (base.toLowerCase() !== ca && quote.toLowerCase() !== ca) continue;

      try {
        const poolKey = await resolveV4PoolKey(chainId, poolId, base, quote);
        if (!poolKey) continue;

        const client = getPublicClient(chainId);
        const slot0 = await client.readContract({
          address: CHAINS[chainId].v4StateView,
          abi: stateViewAbi,
          functionName: 'getSlot0',
          args: [poolId],
        });
        if ((slot0[0] as bigint) === 0n) continue;

        let otherAddress =
          poolKey.currency0.toLowerCase() === ca
            ? poolKey.currency1
            : poolKey.currency0;
        if (otherAddress.toLowerCase() === ZERO) otherAddress = wrapped;

        let otherSymbol = pair.baseToken.symbol;
        if (pair.quoteToken.address.toLowerCase() === otherAddress.toLowerCase()) {
          otherSymbol = pair.quoteToken.symbol;
        } else if (pair.baseToken.address.toLowerCase() === otherAddress.toLowerCase()) {
          otherSymbol = pair.baseToken.symbol;
        }

        const tvlUsd = pair.liquidity?.usd ?? 0;
        const feeLabel = `${(poolKey.fee / 10000).toFixed(2)}%`;
        out.push({
          protocol: 'v4',
          pair,
          poolAddress: poolId,
          poolId,
          poolKey,
          fee: poolKey.fee,
          tvlUsd,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          otherSymbol,
          otherAddress,
          label: `v4 · ${otherSymbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
        });
      } catch (e) {
        console.warn('[v4 ds skip]', poolId.slice(0, 18), e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[v4] dexscreener failed', e instanceof Error ? e.message : e);
  }

  const seen = new Set<string>();
  const unique = out.filter((p) => {
    const k = p.poolId.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return unique;
}

/**
 * Phase 4.7 audit (F-08), V4-specific counterpart to
 * pools.ts's verifyOnChainPoolReserves. Deliberately NOT the same
 * balanceOf-based reserve check used for V3: V4 uses a single shared
 * PoolManager singleton that custodies the combined funds of every pool on
 * the chain at once, so `balanceOf(poolManager)` for a currency says
 * nothing about any one specific pool's share of it — there is no
 * per-pool ERC20 balance to read for V4, and computing a true per-pool USD
 * TVL would require integrating LP liquidity across every initialized tick
 * range, which is not a formula this codebase already has any tested
 * implementation of. Per the audit's explicit instruction not to invent a
 * TVL formula and not to apply V3 semantics to V4, this intentionally stays
 * a narrower, non-invented check: does the pool identified by `poolId`
 * currently carry ANY active on-chain liquidity at its current price at
 * all (`StateView.getLiquidity`, the same authoritative call already used
 * elsewhere in this file for position/pool state — see getV4Position and
 * loadV4Pool)? A pool with zero current liquidity cannot back a real
 * position (a mint into it would either revert or receive worthless
 * liquidity), regardless of what DexScreener/the explore API separately
 * claim its TVL is — so this catches "fully drained/rugged/never-actually-
 * initialized pool" without needing a USD figure. It does NOT catch "real
 * but thin" liquidity, unlike V3's dollar-based floor; this residual gap is
 * a known, documented limitation of V4's architecture, not an oversight.
 */
export type V4LiquidityCheckResult =
  | { status: 'OK'; liquidity: bigint }
  | { status: 'ONCHAIN_VALIDATION_ERROR'; message: string }
  | { status: 'TVL_MISMATCH'; liquidity: bigint };

/**
 * Pure decision logic — see classifyOnChainReserves in pools.ts for why this
 * is split from the RPC read below. Takes `unknown` (not `bigint`) because
 * the RPC wrapper's `as bigint` cast is only a compile-time assertion — a
 * malformed response (wrong ABI decode, a mocked/buggy client) would
 * otherwise reach `liquidity <= 0n`, which JS resolves to `false` for any
 * non-bigint value including `undefined`, silently falling through to `OK`
 * instead of failing closed.
 */
export function classifyV4Liquidity(liquidity: unknown): V4LiquidityCheckResult {
  if (typeof liquidity !== 'bigint') {
    return {
      status: 'ONCHAIN_VALIDATION_ERROR',
      message: `StateView.getLiquidity returned a non-bigint value (${typeof liquidity}) — refusing to classify`,
    };
  }
  if (liquidity <= 0n) {
    return { status: 'TVL_MISMATCH', liquidity };
  }
  return { status: 'OK', liquidity };
}

export async function verifyV4PoolHasLiquidity(
  chainId: SupportedChainId,
  poolId: Hex,
  client: MinimalReadClient = getPublicClient(chainId),
): Promise<V4LiquidityCheckResult> {
  let liquidity: bigint;
  try {
    liquidity = (await client.readContract({
      address: CHAINS[chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getLiquidity',
      args: [poolId],
    })) as bigint;
  } catch (e) {
    return {
      status: 'ONCHAIN_VALIDATION_ERROR',
      message: `StateView.getLiquidity failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return classifyV4Liquidity(liquidity);
}

export async function loadV4Pool(
  chainId: SupportedChainId,
  poolIdOrKey: Hex | V4PoolKey,
): Promise<V4PoolInfo> {
  const client = getPublicClient(chainId);
  let poolKey: V4PoolKey;
  let poolId: Hex;

  if (typeof poolIdOrKey === 'string') {
    poolId = poolIdOrKey as Hex;
    // try poolKeys first
    try {
      const key = await client.readContract({
        address: CHAINS[chainId].v4PositionManager,
        abi: v4PositionManagerAbi,
        functionName: 'poolKeys',
        args: [poolIdToBytes25(poolId)],
      });
      if (Number(key[3]) !== 0) {
        poolKey = {
          currency0: key[0] as Address,
          currency1: key[1] as Address,
          fee: Number(key[2]),
          tickSpacing: Number(key[3]),
          hooks: key[4] as Address,
        };
      } else {
        throw new Error('empty');
      }
    } catch {
      throw new Error(
        `Cannot resolve v4 PoolKey for ${poolId}. Mint once via PositionManager or ensure pool is known.`,
      );
    }
  } else {
    poolKey = poolIdOrKey;
    poolId = computePoolId(poolKey);
  }

  const [slot0, liquidity] = await Promise.all([
    client.readContract({
      address: CHAINS[chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getSlot0',
      args: [poolId],
    }),
    client.readContract({
      address: CHAINS[chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getLiquidity',
      args: [poolId],
    }),
  ]);

  const addr0 =
    poolKey.currency0.toLowerCase() === ZERO
      ? CHAINS[chainId].wrapped
      : poolKey.currency0;
  const addr1 =
    poolKey.currency1.toLowerCase() === ZERO
      ? CHAINS[chainId].wrapped
      : poolKey.currency1;

  const [token0, token1] = await Promise.all([
    getTokenMeta(chainId, addr0),
    getTokenMeta(chainId, addr1),
  ]);
  // keep native symbol if currency is zero
  if (poolKey.currency0.toLowerCase() === ZERO) {
    token0.symbol = CHAINS[chainId].nativeSymbol;
    token0.address = ZERO;
  }
  if (poolKey.currency1.toLowerCase() === ZERO) {
    token1.symbol = CHAINS[chainId].nativeSymbol;
    token1.address = ZERO;
  }

  return {
    protocol: 'v4',
    poolId,
    poolKey,
    token0,
    token1,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: poolKey.hooks,
    sqrtPriceX96: slot0[0] as bigint,
    tick: Number(slot0[1]),
    liquidity: liquidity as bigint,
  };
}

// ── Permit2 ──────────────────────────────────────────────────────────

async function ensurePermit2Allowance(
  chainId: SupportedChainId,
  token: Address,
  amount: bigint,
): Promise<void> {
  if (token.toLowerCase() === ZERO) return;

  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const owner = getHotWalletAddress();
  const posm = CHAINS[chainId].v4PositionManager;

  // 1) ERC20 → Permit2
  const ercAllowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, PERMIT2],
  });
  if (ercAllowance < amount) {
    const hash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2, maxUint256],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  }

  // 2) Permit2 → PositionManager
  const now = Math.floor(Date.now() / 1000);
  const [allowedAmt, expiration] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, posm],
  });
  const need = amount > (1n << 160n) - 1n ? (1n << 160n) - 1n : amount;
  if (allowedAmt < need || Number(expiration) <= now + 60) {
    const max160 = (1n << 160n) - 1n;
    const exp = (1n << 48n) - 1n; // max uint48
    const hash = await wallet.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: 'approve',
      args: [token, posm, max160, Number(exp)],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  }
}

// ── Actions encoding ─────────────────────────────────────────────────

const Actions = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
} as const;

function encodeMintUnlockData(params: {
  poolKey: V4PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  recipient: Address;
  hookData?: Hex;
  useNative?: boolean;
}): Hex {
  const hookData = params.hookData ?? '0x';
  const actions = params.useNative
    ? encodePacked(
        ['uint8', 'uint8', 'uint8'],
        [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP],
      )
    : encodePacked(['uint8', 'uint8'], [Actions.MINT_POSITION, Actions.SETTLE_PAIR]);

  const mintParam = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [
      {
        currency0: params.poolKey.currency0,
        currency1: params.poolKey.currency1,
        fee: params.poolKey.fee,
        tickSpacing: params.poolKey.tickSpacing,
        hooks: params.poolKey.hooks,
      },
      params.tickLower,
      params.tickUpper,
      params.liquidity,
      params.amount0Max,
      params.amount1Max,
      params.recipient,
      hookData,
    ],
  );

  const settleParam = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [params.poolKey.currency0, params.poolKey.currency1],
  );

  const paramList: Hex[] = [mintParam, settleParam];
  if (params.useNative) {
    paramList.push(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [ZERO, params.recipient],
      ),
    );
  }

  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, paramList],
  );
}

function encodeBurnUnlockData(params: {
  tokenId: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8'],
    [Actions.BURN_POSITION, Actions.TAKE_PAIR],
  );
  const burnParam = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [params.tokenId, params.amount0Min, params.amount1Min, params.hookData ?? '0x'],
  );
  const takeParam = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [params.currency0, params.currency1, params.recipient],
  );
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [burnParam, takeParam]],
  );
}

/** DECREASE full liquidity + TAKE_PAIR (keeps NFT; more reliable than BURN on some pools) */
function encodeDecreaseTakeUnlockData(params: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8'],
    [Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR],
  );
  const decParam = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bytes' },
    ],
    [
      params.tokenId,
      params.liquidity,
      params.amount0Min,
      params.amount1Min,
      params.hookData ?? '0x',
    ],
  );
  const takeParam = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [params.currency0, params.currency1, params.recipient],
  );
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [decParam, takeParam]],
  );
}

/** Collect fees only: decrease 0 + take pair */
function encodeCollectFeesUnlockData(params: {
  tokenId: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}): Hex {
  return encodeDecreaseTakeUnlockData({
    tokenId: params.tokenId,
    liquidity: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
    currency0: params.currency0,
    currency1: params.currency1,
    recipient: params.recipient,
    hookData: params.hookData,
  });
}

// ── Mint ─────────────────────────────────────────────────────────────

export type V4MintParams = {
  chainId: SupportedChainId;
  poolId: Hex;
  poolKey: V4PoolKey;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  edgeBufferPercent?: number;
};

export type V4MintResult = {
  protocol: 'v4';
  hash: Hash;
  tokenId: bigint;
  amount0: bigint;
  amount1: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  depositToken: Address;
  depositAmount: bigint;
  txLink: string;
  poolAddress: string;
  poolId: Hex;
  fee: number;
  token0: Address;
  token1: Address;
  wrap?: WrapResult;
};

function currencyIsDeposit(currency: Address, deposit: Address, wrapped: Address): boolean {
  const c = currency.toLowerCase();
  const d = deposit.toLowerCase();
  if (c === d) return true;
  // native ↔ wrapped for deposit matching
  if (c === ZERO && d === wrapped.toLowerCase()) return true;
  if (d === ZERO && c === wrapped.toLowerCase()) return true;
  return false;
}

/**
 * Post-canary reconciliation (Phase 4.7): thrown by extractMintedTokenId
 * when the actually-minted tokenId cannot be determined from the mint
 * transaction's own receipt. Deliberately distinct from a generic Error so
 * callers (and tests) can recognize this specific failure mode and never
 * mistake it for a reverted/failed mint — the transaction already
 * succeeded on-chain by the time this can be thrown; only the tokenId is
 * unknown. The transaction hash remains recoverable via the tx journal
 * (journalledSend records it before this function is ever reached), so
 * failing closed here costs nothing but an extra manual lookup — it never
 * loses the ability to find the real position later.
 */
export class MintTokenIdExtractionError extends Error {
  constructor(context: string) {
    super(
      `Could not determine the minted tokenId from this mint transaction's own receipt (${context}). ` +
        `Refusing to guess or fall back to a pre-read counter value — the transaction hash is already ` +
        `recorded in the tx journal and can be used to recover the real tokenId manually.`,
    );
    this.name = 'MintTokenIdExtractionError';
  }
}

const ERC721_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Extracts the tokenId actually minted to `recipient` by `positionManager`
 * in THIS SPECIFIC transaction receipt, by decoding its own ERC-721
 * Transfer event (from the zero address — a mint — to `recipient`).
 *
 * Deliberately never derives a tokenId from `nextTokenId()`/any other
 * pre-broadcast counter read: that counter is shared/global across every
 * caller of the position manager, so another user's mint landing between
 * the counter read and this transaction's own confirmation makes any such
 * guess wrong. This is not theoretical — a real $50 canary mint
 * (0xce5ffd45497a23ef4a52ae7bf5651fd8e619049f3209175f2b10c90ce66e80f7) was
 * recorded under tokenId 1731172 (a pre-existing NFT owned by an unrelated
 * wallet) instead of the actually-minted 1731176, because four other
 * mints landed on the same shared PositionManager in between.
 *
 * Fails closed (throws MintTokenIdExtractionError) rather than fabricating
 * a value when zero or more than one matching mint-Transfer-to-recipient
 * event is found in this receipt's logs.
 */
export function extractMintedTokenId(
  receipt: { logs: readonly { address: string; data: Hex; topics: Hex[] }[] },
  positionManager: Address,
  recipient: Address,
): bigint {
  const posmLower = positionManager.toLowerCase();
  const recipientLower = recipient.toLowerCase();
  const matches: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== posmLower) continue;
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({
        abi: v4PositionManagerAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: unknown };
    } catch {
      continue; // not a Transfer (or any decodable event in this ABI) — skip, never guess
    }
    if (decoded.eventName !== 'Transfer') continue;
    const args = decoded.args as { from?: Address; to?: Address; tokenId?: bigint };
    if (typeof args.from !== 'string' || args.from.toLowerCase() !== ERC721_ZERO_ADDRESS) continue; // not a mint (a real transfer, not from=0x0)
    if (typeof args.to !== 'string' || args.to.toLowerCase() !== recipientLower) continue; // not to us
    if (typeof args.tokenId !== 'bigint') continue; // malformed decode — never guess
    matches.push(args.tokenId);
  }
  if (matches.length === 0) {
    throw new MintTokenIdExtractionError('no matching mint Transfer event (from=0x0, to=recipient) found in the receipt logs');
  }
  if (matches.length > 1) {
    throw new MintTokenIdExtractionError(
      `${matches.length} ambiguous mint Transfer events found (tokenIds: ${matches.join(', ')}) — refusing to arbitrarily pick one`,
    );
  }
  return matches[0]!;
}

export async function mintV4SingleSided(params: V4MintParams): Promise<V4MintResult> {
  const {
    chainId,
    poolId,
    poolKey,
    depositToken,
    balancePercent,
    sizeMode = 'percent',
    fixedAmountHuman = 0.1,
    widthPercent,
    edgeBufferPercent = 0,
  } = params;

  let pool = await loadV4Pool(chainId, poolKey);
  const wrapped = CHAINS[chainId].wrapped;
  const depositLower = depositToken.toLowerCase();

  const isToken0 = currencyIsDeposit(poolKey.currency0, depositToken, wrapped);
  const isToken1 = currencyIsDeposit(poolKey.currency1, depositToken, wrapped);
  if (!isToken0 && !isToken1) {
    throw new Error('Deposit token is not in the selected v4 pool');
  }

  // Prefer ERC20 wrapped over native for settlement simplicity unless currency is native
  const depositIsNativeCurrency =
    (isToken0 && poolKey.currency0.toLowerCase() === ZERO) ||
    (isToken1 && poolKey.currency1.toLowerCase() === ZERO);

  // Always fund via WETH+native effective balance; native pools spend msg.value
  const effToken = wrapped;
  const useWrappedErc20 = !depositIsNativeCurrency;
  const balToken = useWrappedErc20
    ? depositToken.toLowerCase() === wrapped.toLowerCase()
      ? wrapped
      : depositToken
    : wrapped;

  const eff = await getEffectiveDepositBalance(
    chainId,
    // WETH-side (incl. native) uses effective wrap balance; other ERC20 = raw balance
    balToken.toLowerCase() === wrapped.toLowerCase() ? wrapped : balToken,
  );
  if (eff.effective <= 0n) {
    throw new Error(
      balToken.toLowerCase() === wrapped.toLowerCase()
        ? 'Hot wallet has 0 WETH/WBNB and no native left to wrap (after gas reserve)'
        : 'Hot wallet balance is 0 for deposit token',
    );
  }

  const depMetaEarly = await getTokenMeta(
    chainId,
    balToken.toLowerCase() === wrapped.toLowerCase() ? wrapped : balToken,
  );
  const depositAmount = resolveDepositAmount(eff.effective, {
    sizeMode,
    balancePercent,
    fixedAmountHuman,
    decimals: depMetaEarly.decimals,
    symbol: depMetaEarly.symbol,
  });

  let wrap: WrapResult | undefined;
  if (depositIsNativeCurrency) {
    // Need native ETH/BNB as msg.value — unwrap WETH if short on native
    const { getNativeBalance, unwrapNative } = await import('./wrap.js');
    const nativeBal = await getNativeBalance(chainId);
    if (nativeBal < depositAmount) {
      const need = depositAmount - nativeBal;
      const wethBal = await getTokenBalance(chainId, wrapped);
      if (wethBal < need) {
        throw new Error(
          `Need ${formatUnits(depositAmount, 18)} native for this v4 ETH pool; ` +
            `have native ${formatUnits(nativeBal, 18)} + WETH ${formatUnits(wethBal, 18)}`,
        );
      }
      const u = await unwrapNative(chainId, need);
      wrap = u; // surface as wrap/unwrap activity
      console.log(`[v4 mint] unwrapped ${need} WETH → native for ETH pool`);
    }
  } else if (balToken.toLowerCase() === wrapped.toLowerCase()) {
    // ERC20 WETH currency: wrap native shortfall
    const wrapResult = await ensureWrappedBalance(chainId, wrapped, depositAmount);
    if (wrapResult) wrap = wrapResult;
  }

  pool = await loadV4Pool(chainId, poolKey);

  const { tickLower, tickUpper, edgeBufferTicks, side } = computeSingleSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    widthPercent,
    depositIsToken0: isToken0,
    edgeBufferPercent,
  });

  console.log(
    `[v4 mint] tick=${pool.tick} spacing=${pool.tickSpacing} edgeBuf=${edgeBufferTicks} ` +
      `range=[${tickLower},${tickUpper}] side=${side} deposit=${isToken0 ? 'token0' : 'token1'} amt=${depositAmount}`,
  );

  assertOutOfRange({
    currentTick: pool.tick,
    tickLower,
    tickUpper,
    depositIsToken0: isToken0,
  });

  // Build SDK currencies (native = Ether so poolKey order matches address-zero)
  const c0 =
    poolKey.currency0.toLowerCase() === ZERO
      ? Ether.onChain(chainId)
      : new Token(chainId, poolKey.currency0, pool.token0.decimals, pool.token0.symbol);
  const c1 =
    poolKey.currency1.toLowerCase() === ZERO
      ? Ether.onChain(chainId)
      : new Token(chainId, poolKey.currency1, pool.token1.decimals, pool.token1.symbol);

  const v4Pool = new V4Pool(
    c0,
    c1,
    pool.fee,
    pool.tickSpacing,
    poolKey.hooks,
    pool.sqrtPriceX96.toString(),
    pool.liquidity.toString(),
    pool.tick,
  );

  const amount0Desired = isToken0 ? depositAmount : 0n;
  const amount1Desired = isToken1 ? depositAmount : 0n;

  const position = V4Position.fromAmounts({
    pool: v4Pool,
    tickLower,
    tickUpper,
    amount0: amount0Desired.toString(),
    amount1: amount1Desired.toString(),
    useFullPrecision: true,
  });

  const liquidity = BigInt(position.liquidity.toString());
  if (liquidity === 0n) {
    throw new Error('Computed liquidity is 0 — check range / amount');
  }

  // Max amounts: deposit + small buffer (single-sided other side 0)
  const amount0Max = isToken0 ? depositAmount : 0n;
  const amount1Max = isToken1 ? depositAmount : 0n;
  // uint128 max check
  const U128_MAX = (1n << 128n) - 1n;
  if (amount0Max > U128_MAX || amount1Max > U128_MAX) {
    throw new Error('Amount exceeds uint128');
  }

  // Approvals
  if (!depositIsNativeCurrency) {
    await ensurePermit2Allowance(chainId, depositToken, depositAmount);
  } else {
    // Still may need wrap nothing; native sent as msg.value
  }

  // Refresh tick
  pool = await loadV4Pool(chainId, poolKey);
  let finalLower = tickLower;
  let finalUpper = tickUpper;
  try {
    assertOutOfRange({
      currentTick: pool.tick,
      tickLower: finalLower,
      tickUpper: finalUpper,
      depositIsToken0: isToken0,
    });
  } catch {
    const rebuilt = computeSingleSidedRange({
      currentTick: pool.tick,
      tickSpacing: pool.tickSpacing,
      widthPercent,
      depositIsToken0: isToken0,
      edgeBufferPercent,
    });
    finalLower = rebuilt.tickLower;
    finalUpper = rebuilt.tickUpper;
  }

  // Rebuild liquidity if ticks changed
  let finalLiquidity = liquidity;
  if (finalLower !== tickLower || finalUpper !== tickUpper) {
    const pos2 = V4Position.fromAmounts({
      pool: new V4Pool(
        c0,
        c1,
        pool.fee,
        pool.tickSpacing,
        poolKey.hooks,
        pool.sqrtPriceX96.toString(),
        pool.liquidity.toString(),
        pool.tick,
      ),
      tickLower: finalLower,
      tickUpper: finalUpper,
      amount0: amount0Desired.toString(),
      amount1: amount1Desired.toString(),
      useFullPrecision: true,
    });
    finalLiquidity = BigInt(pos2.liquidity.toString());
  }

  const recipient = getHotWalletAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const useNative = depositIsNativeCurrency;
  const unlockData = encodeMintUnlockData({
    poolKey,
    tickLower: finalLower,
    tickUpper: finalUpper,
    liquidity: finalLiquidity,
    amount0Max: amount0Max > 0n ? amount0Max : 0n,
    amount1Max: amount1Max > 0n ? amount1Max : 0n,
    recipient,
    useNative,
  });

  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const value = useNative ? depositAmount : 0n;

  try {
    await client.simulateContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline],
      account: recipient,
      value,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[v4 mint simulate failed]', msg);
    throw new Error(
      `v4 mint would revert. tick=${pool.tick} range=[${finalLower},${finalUpper}] ` +
        `deposit=${isToken0 ? 'token0' : 'token1'}. ${msg.slice(0, 240)}`,
    );
  }

  const mintGas = await estimateWriteGas({
    client,
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
    account: wallet.account!.address,
    value,
    fallbackGas: 1_200_000n,
    context: 'v4 mint',
  });

  const hash = await wallet.writeContract({
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
    account: wallet.account!,
    chain: wallet.chain,
    value,
    gas: mintGas,
  });

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new Error(`v4 mint tx reverted: ${hash}`);
  }

  // Phase 4.7 fix: the tokenId is derived exclusively from this transaction's
  // own receipt (its ERC-721 Transfer event) — never from a pre-broadcast
  // read of the position manager's shared `nextTokenId()` counter, which
  // can and did drift when other users' mints landed in between. See
  // extractMintedTokenId's own doc comment for the real incident this
  // fixes. A failure here throws (fail closed) rather than fabricating a
  // tokenId — the transaction hash is already durably recorded in the tx
  // journal by journalledSend, so the real position can still be found
  // and recovered manually even if this throws.
  const tokenId = extractMintedTokenId(receipt, posm, recipient);

  // Resolve display token addresses (map native → wrapped for ledger)
  const token0Addr =
    poolKey.currency0.toLowerCase() === ZERO ? wrapped : poolKey.currency0;
  const token1Addr =
    poolKey.currency1.toLowerCase() === ZERO ? wrapped : poolKey.currency1;

  // ACTUAL deposited amounts: amount0Desired/amount1Desired is the ceiling
  // offered to the mint call, not what the contract actually pulled in for
  // the fixed liquidity amount that was minted. v4's mint is liquidity-
  // first (unlike v3's amount-based mint, which refunds unused input) —
  // the position's real on-chain liquidity, re-priced against current pool
  // state, is the correct actual figure (same approach getV4Position()
  // already uses for any existing position's principal amounts).
  let actualAmount0 = amount0Desired;
  let actualAmount1 = amount1Desired;
  try {
    const mintedLiquidity = (await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    })) as bigint;
    if (mintedLiquidity > 0n) {
      const [meta0, meta1] = await Promise.all([
        getTokenMeta(chainId, token0Addr),
        getTokenMeta(chainId, token1Addr),
      ]);
      const actual = await computeV4AmountsForLiquidity({
        chainId,
        poolKey,
        poolId,
        token0Addr,
        token1Addr,
        decimals0: meta0.decimals,
        decimals1: meta1.decimals,
        symbol0: meta0.symbol,
        symbol1: meta1.symbol,
        tickLower: finalLower,
        tickUpper: finalUpper,
        liquidity: mintedLiquidity,
      });
      actualAmount0 = actual.amount0;
      actualAmount1 = actual.amount1;
    }
  } catch (e) {
    console.warn(`[v4 mint] #${tokenId} could not re-derive actual deposited amounts, using offered ceiling:`, e);
  }

  // Phase 4.7 defense-in-depth: actualAmount{0,1} is re-derived from this
  // position's own on-chain liquidity (now correctly keyed by the real
  // tokenId — see extractMintedTokenId above). It should never plausibly
  // exceed the ceiling this mint call itself offered (amount{0,1}Desired) —
  // a real single-sided mint cannot pull in more than what was offered. If
  // it does, something upstream (wrong tokenId, wrong pool state, a stale
  // read) has produced a number that does not describe this deposit, and
  // recording it as "actual" would be worse than not recording it at all.
  // This is observability-only: it never blocks the already-successful
  // mint, never changes accounting, and never touches the ledger, which
  // is sized from `depositAmount`/`resolveDepositAmount`, not from this
  // telemetry figure.
  const PLAUSIBILITY_MULTIPLE = 10n;
  if (amount0Desired > 0n && actualAmount0 > amount0Desired * PLAUSIBILITY_MULTIPLE) {
    console.warn(
      `[v4 mint] #${tokenId} telemetry sanity check failed for token0: actualAmount0=${actualAmount0} ` +
        `is implausibly larger than the offered ceiling amount0Desired=${amount0Desired} — discarding, using ceiling instead`,
    );
    actualAmount0 = amount0Desired;
  }
  if (amount1Desired > 0n && actualAmount1 > amount1Desired * PLAUSIBILITY_MULTIPLE) {
    console.warn(
      `[v4 mint] #${tokenId} telemetry sanity check failed for token1: actualAmount1=${actualAmount1} ` +
        `is implausibly larger than the offered ceiling amount1Desired=${amount1Desired} — discarding, using ceiling instead`,
    );
    actualAmount1 = amount1Desired;
  }

  // Gas telemetry (Phase 3 §17) — v4 mint previously had none at all.
  // Best-effort: never blocks/fails the already-successful mint.
  try {
    const { recordExecutionTelemetry } = await import('../db/index.js');
    const { buildGasTelemetry } = await import('./gas.js');
    const telemetryGas = await buildGasTelemetry(client, hash, mintGas);
    recordExecutionTelemetry({
      chainId,
      opType: 'mint-v4',
      dex: 'uniswap',
      slippageBpsUsed: 0,
      quoteSource: 'v4-mint-liquidity-repriced',
      legs: [
        { token: token0Addr, estimatedRaw: amount0Desired.toString(), minRaw: '0', actualRaw: actualAmount0.toString() },
        { token: token1Addr, estimatedRaw: amount1Desired.toString(), minRaw: '0', actualRaw: actualAmount1.toString() },
      ],
      txHash: hash,
      ok: true,
      gas: telemetryGas,
    });
  } catch {
    /* telemetry is best-effort only */
  }

  return {
    protocol: 'v4',
    hash,
    tokenId,
    amount0: actualAmount0,
    amount1: actualAmount1,
    tickLower: finalLower,
    tickUpper: finalUpper,
    currentTick: pool.tick,
    depositToken,
    depositAmount,
    txLink: txUrl(chainId, hash),
    poolAddress: poolId,
    poolId,
    fee: poolKey.fee,
    token0: token0Addr,
    token1: token1Addr,
    wrap,
  };
}

export async function describeV4MintPreview(params: {
  chainId: SupportedChainId;
  poolId: Hex;
  poolKey: V4PoolKey;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  edgeBufferPercent?: number;
}): Promise<MintPreviewResult> {
  const pool = await loadV4Pool(params.chainId, params.poolKey);
  const wrapped = CHAINS[params.chainId].wrapped;
  const isToken0 = currencyIsDeposit(params.poolKey.currency0, params.depositToken, wrapped);
  const depositIsNative =
    (isToken0 && params.poolKey.currency0.toLowerCase() === ZERO) ||
    (!isToken0 && params.poolKey.currency1.toLowerCase() === ZERO);
  const effToken = depositIsNative ? wrapped : params.depositToken;
  const depMeta = await getTokenMeta(params.chainId, effToken);
  const eff = await getEffectiveDepositBalance(params.chainId, effToken);
  const amount = resolveDepositAmount(eff.effective, {
    sizeMode: params.sizeMode ?? 'percent',
    balancePercent: params.balancePercent,
    fixedAmountHuman: params.fixedAmountHuman ?? 0.1,
    decimals: depMeta.decimals,
    symbol: depMeta.symbol,
  });
  const amountHuman = humanToFloat(amount, depMeta.decimals);
  const px = (await getTokenPriceUsd(params.chainId, effToken)) ?? 0;
  const valueUsd = amountHuman * px;
  const sizeLabel =
    (params.sizeMode ?? 'percent') === 'fixed'
      ? `${params.fixedAmountHuman ?? 0.1} fixed`
      : `${params.balancePercent}%`;

  const { tickLower, tickUpper, side } = computeSingleSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    widthPercent: params.widthPercent,
    depositIsToken0: isToken0,
    edgeBufferPercent: params.edgeBufferPercent ?? 0,
  });

  const t0Addr = (pool.token0.address === ZERO ? wrapped : pool.token0.address) as Address;
  const t1Addr = (pool.token1.address === ZERO ? wrapped : pool.token1.address) as Address;
  // Display symbols: native side as chain native (ETH/BNB), not WETH
  const sym0 =
    pool.token0.address.toLowerCase() === ZERO
      ? CHAINS[params.chainId].nativeSymbol
      : pool.token0.symbol;
  const sym1 =
    pool.token1.address.toLowerCase() === ZERO
      ? CHAINS[params.chainId].nativeSymbol
      : pool.token1.symbol;

  const tickParams = {
    chainId: params.chainId,
    token0: t0Addr,
    token1: t1Addr,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
    symbol0: sym0,
    symbol1: sym1,
  };

  const orientation = resolvePriceOrientation(tickParams);
  const poolSpot = orientedPriceAtTick({ ...tickParams, tick: pool.tick, orientation });
  const loO = orientedPriceAtTick({ ...tickParams, tick: tickLower, orientation });
  const hiO = orientedPriceAtTick({ ...tickParams, tick: tickUpper, orientation });
  const rangeLow = Math.min(loO.value, hiO.value);
  const rangeHigh = Math.max(loO.value, hiO.value);

  // Market: quote-per-base from USD prices
  const baseIs0 = sym0.toUpperCase() === orientation.baseSymbol.toUpperCase();
  const baseAddr = baseIs0 ? t0Addr : t1Addr;
  const quoteAddr = baseIs0 ? t1Addr : t0Addr;
  const [baseUsd, quoteUsd] = await Promise.all([
    getTokenPriceUsd(params.chainId, baseAddr),
    getTokenPriceUsd(params.chainId, quoteAddr),
  ]);
  const marketPrice =
    baseUsd != null && baseUsd > 0 && quoteUsd != null && quoteUsd > 0
      ? baseUsd / quoteUsd
      : null;

  const range = formatCompactRange({
    ...tickParams,
    tickLower,
    tickUpper,
    currentTick: pool.tick,
    marketPrice,
  });

  let mcapLine = '';
  try {
    const baseMeta = await getTokenMeta(params.chainId, baseAddr);
    const supplyRaw = await getTokenTotalSupply(params.chainId, baseAddr);
    if (supplyRaw == null) throw new Error('totalSupply unknown');
    const supplyHuman = humanToFloat(supplyRaw, baseMeta.decimals);
    let qUsd = 1;
    if (!isStableSymbol(orientation.quoteSymbol)) {
      qUsd =
        quoteUsd != null && quoteUsd > 0
          ? quoteUsd
          : ((await getTokenPriceUsd(params.chainId, quoteAddr)) ?? 0);
    }
    const mLo = mcapAtOrientedPrice({
      orientedPrice: rangeLow,
      quoteUsd: qUsd,
      baseSupplyHuman: supplyHuman,
    });
    const mHi = mcapAtOrientedPrice({
      orientedPrice: rangeHigh,
      quoteUsd: qUsd,
      baseSupplyHuman: supplyHuman,
    });
    if (mLo != null && mHi != null) {
      mcapLine = `Mcap range: ${formatMcapRange(mLo, mHi)}\n`;
    }
  } catch {
    /* optional */
  }

  const mismatch = evaluatePriceMismatch({
    poolPrice: poolSpot.value,
    marketPrice,
    rangeLow,
    rangeHigh,
    unitLabel: orientation.unitLabel,
  });

  const sideNote = describeSingleSidedSide({
    side,
    orientation,
    depositSymbol: depMeta.symbol,
    baseSymbol: orientation.baseSymbol,
    quoteSymbol: orientation.quoteSymbol,
  });
  const warnBlock = mismatch.mismatch ? `\n${mismatch.lines.join('\n')}\n` : '';

  const text =
    `Value deposited: ${formatUnits(amount, depMeta.decimals)} ${depMeta.symbol}` +
    ` (${sizeLabel} · ${formatUsd(valueUsd)})\n` +
    `Range: ${range}\n` +
    mcapLine +
    `${sideNote}\n` +
    `Pool: v4 ${sym0}/${sym1} ${(pool.fee / 10000).toFixed(2)}%` +
    warnBlock;

  return {
    text,
    priceMismatch: mismatch.mismatch,
    mismatch,
  };
}

// ── Positions ────────────────────────────────────────────────────────

function decodeSigned24(raw: bigint): number {
  const masked = raw & 0xffffffn;
  if (masked & 0x800000n) {
    return Number(masked - 0x1000000n);
  }
  return Number(masked);
}

export function decodeV4PositionInfo(info: bigint): {
  tickLower: number;
  tickUpper: number;
} {
  return {
    tickLower: decodeSigned24(info >> 8n),
    tickUpper: decodeSigned24(info >> 32n),
  };
}

/** Parallel ownerOf checks — prefer multicall (1 RTT), else chunked eth_calls. */
async function filterOwnedTokenIds(
  chainId: SupportedChainId,
  posm: Address,
  ownerLc: string,
  idStrs: Iterable<string>,
): Promise<bigint[]> {
  const client = getPublicClient(chainId);
  const list = [...idStrs];
  if (list.length === 0) return [];
  const owned: bigint[] = [];

  try {
    const results = await client.multicall({
      contracts: list.map((idStr) => ({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'ownerOf' as const,
        args: [BigInt(idStr)] as const,
      })),
      allowFailure: true,
    });
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status !== 'success') continue;
      if ((r.result as string).toLowerCase() === ownerLc) {
        owned.push(BigInt(list[i]!));
      }
    }
    return owned;
  } catch {
    /* multicall unavailable */
  }

  const batch = 20;
  for (let i = 0; i < list.length; i += batch) {
    const slice = list.slice(i, i + batch);
    const results = await Promise.all(
      slice.map(async (idStr) => {
        try {
          const id = BigInt(idStr);
          const o = await client.readContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'ownerOf',
            args: [id],
          });
          return (o as string).toLowerCase() === ownerLc ? id : null;
        } catch {
          return null;
        }
      }),
    );
    for (const id of results) {
      if (id != null) owned.push(id);
    }
  }
  return owned;
}

/** Parse tokenId from Alchemy transfer payloads. */
function parseAlchemyTokenId(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return BigInt(raw).toString();
  } catch {
    try {
      return BigInt(raw.startsWith('0x') ? raw : `0x${raw}`).toString();
    } catch {
      return null;
    }
  }
}

/**
 * Collect POSM tokenIds ever transferred to/from owner via Alchemy.
 * Includes empty-shell ids — caller decides what to load.
 */
async function alchemyPosmTransferIds(
  rpc: string,
  posm: Address,
  owner: Address,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const directions: Array<'to' | 'from'> = ['to', 'from'];

  for (const dir of directions) {
    let pageKey: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params: Record<string, unknown> = {
        fromBlock: '0x0',
        toBlock: 'latest',
        contractAddresses: [posm],
        category: ['erc721'],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: '0x3e8',
      };
      if (dir === 'to') params.toAddress = owner;
      else params.fromAddress = owner;
      if (pageKey) params.pageKey = pageKey;

      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getAssetTransfers',
          params: [params],
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const j = (await res.json()) as {
        result?: {
          transfers?: { tokenId?: string; erc721TokenId?: string }[];
          pageKey?: string;
        };
        error?: { message?: string };
      };
      if (j.error?.message) {
        console.warn(
          `[v4] alchemy_getAssetTransfers ${dir}:`,
          j.error.message.slice(0, 120),
        );
        break;
      }
      for (const tr of j.result?.transfers ?? []) {
        const id = parseAlchemyTokenId(tr.tokenId ?? tr.erc721TokenId);
        if (id) ids.add(id);
      }
      pageKey = j.result?.pageKey;
      if (!pageKey) break;
    }
  }
  return ids;
}

/**
 * Discover v4 PositionManager NFTs currently owned by the hot wallet.
 *
 * POSM is not ERC721Enumerable. Strategy:
 * 1) balanceOf
 * 2) DB open + closed + empty-shell candidates (never drop shells from discovery)
 * 3) Alchemy asset transfers (to+from) when RPC is Alchemy
 * 4) reverse-scan recent nextTokenId range if still short of balanceOf
 * 5) ownerOf filter → only currently held NFTs
 */
async function discoverV4TokenIds(chainId: SupportedChainId): Promise<bigint[]> {
  const t0 = Date.now();
  const owner = getHotWalletAddress();
  const posm = CHAINS[chainId].v4PositionManager;
  const client = getPublicClient(chainId);
  const ownerLc = owner.toLowerCase();

  let bal = 0n;
  try {
    bal = (await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint;
  } catch (e) {
    console.warn('[v4] balanceOf failed', e instanceof Error ? e.message : e);
  }

  const balNum = Number(bal);

  // Fast-path: verify known open+empty-shell IDs in one multicall
  // If the wallet only holds positions we already know about, skip full discovery
  const knownIds = new Set([
    ...listTrackedTokenIds(chainId, 'open'),
    ...getEmptyShells(chainId),
  ]);
  if (balNum > 0 && knownIds.size > 0) {
    const verified = await filterOwnedTokenIds(chainId, posm, ownerLc, knownIds);
    if (verified.length === balNum) {
      console.log(
        `[v4] fast-path perfect chain=${chainId} balanceOf=${balNum} verified=${verified.length} ${Date.now() - t0}ms`,
      );
      return verified;
    }
    // Fast-path partial: still need full discovery for missing ones
    console.log(
      `[v4] fast-path partial chain=${chainId} balanceOf=${balNum} verified=${verified.length} known=${knownIds.size} — full scan needed`,
    );
  }

  const ids = new Set<string>();

  // Always seed from local knowledge (incl. empty shells — may have been wrong)
  for (const id of listTrackedTokenIds(chainId, 'open')) ids.add(id);
  for (const id of listTrackedTokenIds(chainId, 'closed')) ids.add(id);
  for (const id of getEmptyShells(chainId)) ids.add(id);

  if (bal === 0n) {
    const owned = ids.size
      ? await filterOwnedTokenIds(chainId, posm, ownerLc, ids)
      : [];
    console.log(
      `[v4] discover chain=${chainId} balanceOf=0 candidates=${ids.size} owned=${owned.length} ${Date.now() - t0}ms`,
    );
    return owned;
  }

  // Alchemy: full transfer history (do NOT skip empty shells here)
  const rpc = config.rpc[chainId];
  if (rpc.includes('alchemy.com') || rpc.includes('g.alchemy.com')) {
    try {
      const alchemyIds = await alchemyPosmTransferIds(rpc, posm, owner);
      for (const id of alchemyIds) ids.add(id);
      console.log(
        `[v4] alchemy transfers chain=${chainId} uniqueIds=${alchemyIds.size}`,
      );
    } catch (e) {
      console.warn(
        '[v4] alchemy transfers failed',
        e instanceof Error ? e.message.slice(0, 80) : e,
      );
    }
  }

  // Verify current ownership of all candidates
  let owned = await filterOwnedTokenIds(chainId, posm, ownerLc, ids);

  // If still short of balanceOf, reverse-scan recent mints (wider than before)
  if (BigInt(owned.length) < bal) {
    let nextId = 0n;
    try {
      nextId = (await client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'nextTokenId',
      })) as bigint;
    } catch {
      nextId = 0n;
    }
    if (nextId > 1n) {
      // Up to 400 recent ids — cheap multicall ownerOf; needed when Alchemy incomplete
      const maxScan = 400n;
      const have = new Set(owned.map((x) => x.toString()));
      const toCheck: string[] = [];
      let scanned = 0n;
      for (let id = nextId - 1n; id > 0n && scanned < maxScan; id--, scanned++) {
        const s = id.toString();
        if (!have.has(s) && !ids.has(s)) toCheck.push(s);
      }
      if (toCheck.length) {
        const more = await filterOwnedTokenIds(chainId, posm, ownerLc, toCheck);
        for (const id of more) {
          if (!have.has(id.toString())) {
            owned.push(id);
            have.add(id.toString());
          }
        }
      }
      if (BigInt(owned.length) < bal) {
        console.warn(
          `[v4] discover incomplete chain=${chainId} balanceOf=${bal} owned=${owned.length} (scan≤${maxScan})`,
        );
      }
    }
  }

  console.log(
    `[v4] discover chain=${chainId} balanceOf=${balNum} candidates=${ids.size} owned=${owned.length} ${Date.now() - t0}ms`,
  );
  return owned;
}

/**
 * Cheap liquidity probe for many tokenIds (multicall). Used to revive
 * wrongly-marked empty shells without full getV4Position cost.
 */
async function filterLiveLiquidityIds(
  chainId: SupportedChainId,
  posm: Address,
  tokenIds: bigint[],
): Promise<bigint[]> {
  if (!tokenIds.length) return [];
  const client = getPublicClient(chainId);
  const live: bigint[] = [];

  try {
    const results = await client.multicall({
      contracts: tokenIds.map((id) => ({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPositionLiquidity' as const,
        args: [id] as const,
      })),
      allowFailure: true,
    });
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'success' && (r.result as bigint) > 0n) {
        live.push(tokenIds[i]!);
      }
    }
    return live;
  } catch {
    /* fall through */
  }

  const batch = 20;
  for (let i = 0; i < tokenIds.length; i += batch) {
    const slice = tokenIds.slice(i, i + batch);
    const results = await Promise.all(
      slice.map(async (id) => {
        try {
          const liq = (await client.readContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'getPositionLiquidity',
            args: [id],
          })) as bigint;
          return liq > 0n ? id : null;
        } catch {
          return null;
        }
      }),
    );
    for (const id of results) {
      if (id != null) live.push(id);
    }
  }
  return live;
}

export async function getV4Position(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<OnChainPosition | null> {
  const client = getPublicClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const hot = getHotWalletAddress().toLowerCase();

  let poolKeyRaw: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  let info: bigint;
  let liquidity: bigint;

  // Ownership first — never show another wallet's NFT (DB can lag after wallet switch)
  try {
    const owner = await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    });
    if ((owner as string).toLowerCase() !== hot) {
      return null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Burned / never minted
    if (classifyOwnershipError(msg) === 'gone') {
      return null;
    }
    // Rate-limit / RPC / timeout — rethrow so list-fast keeps DB row open
    throw e;
  }

  try {
    const [poolAndInfo, liq] = await Promise.all([
      client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPoolAndPositionInfo',
        args: [tokenId],
      }),
      client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
    ]);
    const pk = poolAndInfo[0];
    poolKeyRaw = {
      currency0: pk.currency0 as Address,
      currency1: pk.currency1 as Address,
      fee: Number(pk.fee),
      tickSpacing: Number(pk.tickSpacing),
      hooks: pk.hooks as Address,
    };
    info = poolAndInfo[1] as bigint;
    liquidity = liq as bigint;
  } catch (e) {
    // Real RPC errors rethrow so listPositionsFast does not zombie-close
    throw e;
  }

  if (liquidity === 0n) return null; // confirmed empty shell

  // Re-verify ownership — position may have been transferred to another
  // wallet since the first check. A failure here means ownership is
  // UNKNOWN; fail closed (rethrow) rather than assuming the position is
  // still valid — never "assume valid" on a verification failure.
  try {
    const owner = await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    });
    if ((owner as string).toLowerCase() !== getHotWalletAddress().toLowerCase()) {
      return null; // not ours — transferred elsewhere
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (classifyOwnershipError(msg) === 'gone') {
      return null; // burned since the first check — confirmed gone
    }
    throw e; // ownership unknown — fail closed
  }

  const { tickLower, tickUpper } = decodeV4PositionInfo(info);
  const wrapped = CHAINS[chainId].wrapped;
  const token0Addr =
    poolKeyRaw.currency0.toLowerCase() === ZERO ? wrapped : poolKeyRaw.currency0;
  const token1Addr =
    poolKeyRaw.currency1.toLowerCase() === ZERO ? wrapped : poolKeyRaw.currency1;

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(chainId, token0Addr),
    getTokenMeta(chainId, token1Addr),
  ]);

  const poolId = computePoolId({
    currency0: poolKeyRaw.currency0,
    currency1: poolKeyRaw.currency1,
    fee: poolKeyRaw.fee,
    tickSpacing: poolKeyRaw.tickSpacing,
    hooks: poolKeyRaw.hooks,
  });

  let currentTick = 0;
  let amount0 = 0n;
  let amount1 = 0n;
  let inRange = false;
  let sqrtPriceX96 = 0n;
  let poolLiq = 0n;

  try {
    const [slot0, liq] = await Promise.all([
      client.readContract({
        address: CHAINS[chainId].v4StateView,
        abi: stateViewAbi,
        functionName: 'getSlot0',
        args: [poolId],
      }),
      client.readContract({
        address: CHAINS[chainId].v4StateView,
        abi: stateViewAbi,
        functionName: 'getLiquidity',
        args: [poolId],
      }),
    ]);
    sqrtPriceX96 = slot0[0] as bigint;
    currentTick = Number(slot0[1]);
    poolLiq = liq as bigint;
    inRange = currentTick >= tickLower && currentTick < tickUpper;

    const t0 = new Token(chainId, token0Addr, meta0.decimals, meta0.symbol);
    const t1 = new Token(chainId, token1Addr, meta1.decimals, meta1.symbol);
    const v4Pool = new V4Pool(
      t0,
      t1,
      poolKeyRaw.fee,
      poolKeyRaw.tickSpacing,
      poolKeyRaw.hooks,
      sqrtPriceX96.toString(),
      poolLiq.toString(),
      currentTick,
    );
    const position = new V4Position({
      pool: v4Pool,
      liquidity: liquidity.toString(),
      tickLower,
      tickUpper,
    });
    amount0 = BigInt(position.amount0.quotient.toString());
    amount1 = BigInt(position.amount1.quotient.toString());
  } catch (e) {
    console.warn('[v4 position amounts]', tokenId.toString(), e instanceof Error ? e.message : e);
  }

  // Live unclaimed fees via StateView fee growth
  let tokensOwed0 = 0n;
  let tokensOwed1 = 0n;
  if (liquidity > 0n) {
    const { computeV4UnclaimedFees } = await import('./fees.js');
    const live = await computeV4UnclaimedFees({
      chainId,
      poolId,
      tokenId,
      tickLower,
      tickUpper,
      liquidity,
    });
    tokensOwed0 = live.fees0;
    tokensOwed1 = live.fees1;
  }

  const a0 = humanToFloat(amount0, meta0.decimals);
  const a1 = humanToFloat(amount1, meta1.decimals);
  const f0 = humanToFloat(tokensOwed0, meta0.decimals);
  const f1 = humanToFloat(tokensOwed1, meta1.decimals);
  // Critical path (feeds TP/SL via computePositionPnl → pnlPct) — see the
  // matching comment in positions.ts's getPosition(). Stale/unavailable
  // becomes null, which priceCompleteFor already treats as UNKNOWN.
  const [r0, r1] = await Promise.all([
    getCriticalTokenPriceUsd(chainId, token0Addr),
    getCriticalTokenPriceUsd(chainId, token1Addr),
  ]);
  const p0 = r0.ok ? r0.price : null;
  const p1 = r1.ok ? r1.price : null;
  const valueUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  const unclaimedFeesUsd = f0 * (p0 ?? 0) + f1 * (p1 ?? 0);
  const priceComplete = priceCompleteFor({ amount0: a0 + f0, amount1: a1 + f1, p0, p1 });

  return {
    tokenId,
    chainId,
    protocol: 'v4',
    token0: token0Addr,
    token1: token1Addr,
    fee: poolKeyRaw.fee,
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
    poolAddress: poolId as unknown as Address,
    valueUsd,
    unclaimedFeesUsd,
    amount0Human: a0,
    amount1Human: a1,
    priceComplete,
    poolKey: poolKeyRaw,
    poolId,
  };
}

export async function listV4Positions(chainId: SupportedChainId): Promise<OnChainPosition[]> {
  const t0 = Date.now();
  const ids = await discoverV4TokenIds(chainId);
  if (ids.length === 0) return [];

  const posm = CHAINS[chainId].v4PositionManager;
  const emptyShells = getEmptyShells(chainId);

  // Split: unknown / open vs previously-marked empty shells
  const fresh: bigint[] = [];
  const shelled: bigint[] = [];
  for (const id of ids) {
    if (emptyShells.has(id.toString())) shelled.push(id);
    else fresh.push(id);
  }

  // Revive wrongly-marked empty shells with a cheap liquidity multicall
  let revived: bigint[] = [];
  if (shelled.length > 0) {
    revived = await filterLiveLiquidityIds(chainId, posm, shelled);
    if (revived.length > 0) {
      console.log(
        `[list v4] chain=${chainId} revived ${revived.length}/${shelled.length} empty-shells with liquidity`,
      );
      for (const id of revived) clearEmptyShell(chainId, id.toString());
    }
  }

  const toScan = [...fresh, ...revived];
  const skipped = shelled.length - revived.length;

  if (toScan.length === 0) {
    console.log(
      `[list v4] chain=${chainId} all-empty-shells skipped=${skipped} ${Date.now() - t0}ms`,
    );
    return [];
  }

  // Parallel detail loads for candidates with possible liquidity
  const concurrency = 8;
  const out: OnChainPosition[] = [];
  for (let i = 0; i < toScan.length; i += concurrency) {
    const slice = toScan.slice(i, i + concurrency);
    const batch = await Promise.all(
      slice.map(async (id) => {
        try {
          return await getV4Position(chainId, id);
        } catch {
          // RPC error — don't mark as empty shell, will retry next scan
          return undefined;
        }
      }),
    );
    for (const [j, p] of batch.entries()) {
      const tokenIdStr = slice[j]!.toString();
      if (p === undefined) continue; // transient RPC error, skip
      if (p) {
        out.push(p);
        // Auto-record externally-minted positions
        try {
          const { recordOpenPosition } = await import('../db/index.js');
          recordOpenPosition({
            chainId,
            tokenId: tokenIdStr,
            poolAddress: p.poolAddress as string,
            token0: p.token0,
            token1: p.token1,
            fee: p.fee,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            protocol: 'v4',
          });
          clearEmptyShell(chainId, tokenIdStr);
        } catch { /* may already exist */ }
      } else {
        // Owned (discover filtered) but liq=0 → empty shell
        markEmptyShell(chainId, tokenIdStr);
        try {
          const { markClosed } = await import('../db/index.js');
          markClosed(chainId, tokenIdStr);
        } catch { /* may not exist */ }
      }
    }
  }
  console.log(
    `[list v4] chain=${chainId} active=${out.length}/${toScan.length} skippedShells=${skipped} owned=${ids.length} ${Date.now() - t0}ms`,
  );
  return out;
}

// ── Close ────────────────────────────────────────────────────────────

/**
 * Expected withdrawable amount0/amount1 for `liquidity` from *live* v4 pool
 * state (fresh StateView slot0 + liquidity). Throws on failure — used only
 * for the safety-critical close minOut calc; never falls back to zero.
 */
async function computeV4AmountsForLiquidity(params: {
  chainId: SupportedChainId;
  poolKey: V4PoolKey;
  poolId: Hex;
  token0Addr: Address;
  token1Addr: Address;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): Promise<{ amount0: bigint; amount1: bigint }> {
  const client = getPublicClient(params.chainId);
  const [slot0, poolLiq] = await Promise.all([
    client.readContract({
      address: CHAINS[params.chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getSlot0',
      args: [params.poolId],
    }),
    client.readContract({
      address: CHAINS[params.chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getLiquidity',
      args: [params.poolId],
    }),
  ]);
  const sqrtPriceX96 = slot0[0] as bigint;
  const currentTick = Number(slot0[1]);
  const t0 = new Token(params.chainId, params.token0Addr, params.decimals0, params.symbol0);
  const t1 = new Token(params.chainId, params.token1Addr, params.decimals1, params.symbol1);
  const v4Pool = new V4Pool(
    t0,
    t1,
    params.poolKey.fee,
    params.poolKey.tickSpacing,
    params.poolKey.hooks,
    sqrtPriceX96.toString(),
    (poolLiq as bigint).toString(),
    currentTick,
  );
  const position = new V4Position({
    pool: v4Pool,
    liquidity: params.liquidity.toString(),
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
  });
  return {
    amount0: BigInt(position.amount0.quotient.toString()),
    amount1: BigInt(position.amount1.quotient.toString()),
  };
}

export type V4CloseResult = {
  protocol: 'v4';
  hash: Hash;
  tokenId: bigint;
  /** ACTUAL amount received, measured via wallet/native balance delta — see Phase 3 accounting audit. */
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  /** Pre-close estimate (position-liquidity math, computed before the transaction) — kept for auditability. */
  expected0: bigint;
  expected1: bigint;
  withdrawalUsd: number;
  feesPortionUsd: number;
  txLink: string;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
};

export async function closeV4Position(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<V4CloseResult> {
  const pos = await getV4Position(chainId, tokenId);
  if (!pos || !pos.poolKey || !pos.poolId) {
    throw new Error(`v4 position #${tokenId} not found or empty`);
  }
  const poolKey = pos.poolKey;
  const poolId = pos.poolId;

  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const recipient = getHotWalletAddress();
  const c0 = poolKey.currency0;
  const c1 = poolKey.currency1;

  // Live liquidity is authoritative — an RPC failure here is a retryable
  // read, not a licence to close against stale/cached liquidity.
  const readLiveLiquidity = async (): Promise<bigint> =>
    (await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    })) as bigint;

  /**
   * Expected-withdrawal-derived amount0Min/amount1Min for `liquidity`,
   * bounded by CLOSE_SLIPPAGE_BPS. Throws (aborts) if live pool state can't
   * be read — never falls back to amount0Min=amount1Min=0.
   */
  const computeMins = async (
    liquidity: bigint,
  ): Promise<{
    amount0Min: bigint;
    amount1Min: bigint;
    expected0: bigint;
    expected1: bigint;
  }> => {
    if (liquidity <= 0n) {
      return { amount0Min: 0n, amount1Min: 0n, expected0: 0n, expected1: 0n };
    }
    const { amount0, amount1 } = await computeV4AmountsForLiquidity({
      chainId,
      poolKey,
      poolId,
      token0Addr: pos.token0,
      token1Addr: pos.token1,
      decimals0: pos.decimals0,
      decimals1: pos.decimals1,
      symbol0: pos.symbol0,
      symbol1: pos.symbol1,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity,
    });
    const mins = computeWithdrawalMins({
      expected0: amount0,
      expected1: amount1,
      slippageBps: CLOSE_SLIPPAGE_BPS,
      context: `closeV4Position #${tokenId}`,
    });
    return { ...mins, expected0: amount0, expected1: amount1 };
  };

  let liveLiq = await readLiveLiquidity();
  const initialMins = await computeMins(liveLiq);
  let lastMins = initialMins;

  console.log(
    `[close v4] #${tokenId} liveLiq=${liveLiq} fee=${poolKey.fee} ` +
      `c0=${c0.slice(0, 10)} c1=${c1.slice(0, 10)} ` +
      `min0=${initialMins.amount0Min} min1=${initialMins.amount1Min}`,
  );

  // TAKE_PAIR sends native (currency == 0x0) directly, ERC-20 otherwise.
  const readLegBalance = async (currency: Address): Promise<bigint> =>
    currency.toLowerCase() === ZERO
      ? client.getBalance({ address: recipient })
      : (client.readContract({
          address: currency,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [recipient],
        }) as Promise<bigint>);

  const leg0Before = await readLegBalance(c0);
  const leg1Before = await readLegBalance(c1);

  const recordTelemetry = async (params: {
    ok: boolean;
    txHash?: Hash;
    errorMsg?: string;
  }): Promise<void> => {
    try {
      const { recordExecutionTelemetry } = await import('../db/index.js');
      let actual0: string | null = null;
      let actual1: string | null = null;
      if (params.ok) {
        const [leg0After, leg1After] = await Promise.all([
          readLegBalance(c0),
          readLegBalance(c1),
        ]);
        actual0 = resolveReceivedAmount({
          balanceBefore: leg0Before,
          balanceAfter: leg0After,
        }).toString();
        actual1 = resolveReceivedAmount({
          balanceBefore: leg1Before,
          balanceAfter: leg1After,
        }).toString();
      }
      const { buildGasTelemetry } = await import('./gas.js');
      const gas = params.ok && params.txHash
        ? await buildGasTelemetry(client, params.txHash)
        : null;
      recordExecutionTelemetry({
        chainId,
        opType: 'close-v4',
        slippageBpsUsed: CLOSE_SLIPPAGE_BPS,
        quoteSource: 'v4-sdk-position-liquidity-math',
        legs: [
          {
            token: c0,
            estimatedRaw: lastMins.expected0.toString(),
            minRaw: lastMins.amount0Min.toString(),
            actualRaw: actual0,
          },
          {
            token: c1,
            estimatedRaw: lastMins.expected1.toString(),
            minRaw: lastMins.amount1Min.toString(),
            actualRaw: actual1,
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

  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1800);

  const { withRetries, sleep } = await import('./retry.js');
  let used = '';
  let hash: Hash;
  try {
    hash = await withRetries(
    async (round) => {
      // Refresh liq AND expected-withdrawal mins each round — a retry must
      // refresh data and rerun the safety gate, never reuse a stale minimum.
      const liq = await readLiveLiquidity();
      const mins = await computeMins(liq);
      lastMins = mins;
      const roundAttempts: { name: string; data: Hex; gas: bigint }[] = [
        {
          name: 'BURN+TAKE',
          data: encodeBurnUnlockData({
            tokenId,
            amount0Min: mins.amount0Min,
            amount1Min: mins.amount1Min,
            currency0: c0,
            currency1: c1,
            recipient,
          }),
          gas: 1_200_000n,
        },
      ];
      if (liq > 0n) {
        roundAttempts.push({
          name: 'DECREASE+TAKE',
          data: encodeDecreaseTakeUnlockData({
            tokenId,
            liquidity: liq,
            amount0Min: mins.amount0Min,
            amount1Min: mins.amount1Min,
            currency0: c0,
            currency1: c1,
            recipient,
          }),
          gas: 1_000_000n,
        });
      }
      roundAttempts.push({
        name: 'COLLECT_FEES',
        data: encodeCollectFeesUnlockData({
          tokenId,
          currency0: c0,
          currency1: c1,
          recipient,
        }),
        gas: 600_000n,
      });

      let lastErr = '';
      console.log(
        `[close v4] round ${round} liq=${liq} min0=${mins.amount0Min} min1=${mins.amount1Min} strategies=${roundAttempts.length}`,
      );
      for (const att of roundAttempts) {
        try {
          const dl = deadline();
          await client.simulateContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'modifyLiquidities',
            args: [att.data, dl],
            account: recipient,
          });
          const attGas = await estimateWriteGas({
            client,
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'modifyLiquidities',
            args: [att.data, dl],
            account: wallet.account!.address,
            fallbackGas: att.gas,
            context: `close-v4 #${tokenId} ${att.name}`,
          });
          const h = await wallet.writeContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'modifyLiquidities',
            args: [att.data, dl],
            account: wallet.account!,
            chain: wallet.chain,
            gas: attGas,
          });
          const receipt = await client.waitForTransactionReceipt({ hash: h, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
          if (receipt.status !== 'success') {
            throw new Error(`tx reverted ${h}`);
          }
          used = att.name;
          console.log(`[close v4] ok via ${used} round=${round} tx=${h}`);
          return h;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          console.warn(`[close v4] ${att.name} r${round}:`, lastErr.slice(0, 160));
          await sleep(400);
        }
      }
      throw new Error(
        `v4 close round ${round} failed. Last: ${lastErr.slice(0, 200)}`,
      );
    },
    {
      times: 3,
      backoffMs: 1200,
      label: 'close-v4',
      shouldRetry: (err) => {
        const m = err instanceof Error ? err.message : String(err);
        return !/not found|already empty|not authorized|NotApproved/i.test(m);
      },
    },
    );
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    await recordTelemetry({ ok: false, errorMsg });
    throw e;
  }
  await recordTelemetry({ ok: true, txHash: hash });

  // Best-effort burn shell if we only decreased
  if (used === 'DECREASE+TAKE' || used === 'COLLECT_FEES') {
    try {
      const liqLeft = (await client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      })) as bigint;
      if (liqLeft === 0n) {
        const burnData = encodeBurnUnlockData({
          tokenId,
          amount0Min: 0n,
          amount1Min: 0n,
          currency0: c0,
          currency1: c1,
          recipient,
        });
        // Only burn if it sim succeeds
        const burnDeadline = deadline();
        const burnArgs = [burnData, burnDeadline] as const;
        await client.simulateContract({
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: 'modifyLiquidities',
          args: burnArgs,
          account: recipient,
        });
        const burnGas = await estimateWriteGas({
          client,
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: 'modifyLiquidities',
          args: burnArgs,
          account: wallet.account!.address,
          fallbackGas: 400_000n,
          context: `close-v4 #${tokenId} empty-shell burn`,
        });
        const bh = await wallet.writeContract({
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: 'modifyLiquidities',
          args: burnArgs,
          account: wallet.account!,
          chain: wallet.chain,
          gas: burnGas,
        });
        await client.waitForTransactionReceipt({ hash: bh, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
      }
    } catch {
      /* NFT may remain empty — OK */
    }
  }

  // Pre-close estimate (position-liquidity math computed before the
  // transaction) — kept as `expected0`/`expected1` for auditability, never
  // used as the final realized withdrawal below.
  const expected0 = pos.amount0;
  const expected1 = pos.amount1;

  // ACTUAL amount received, measured via balance delta (native or ERC-20,
  // matching readLegBalance's own currency handling). The best-effort
  // empty-shell burn above never moves currency balances, so reading here
  // reflects exactly what the close transaction delivered. Falls back to
  // the pre-close estimate only if no delta was observed.
  const [leg0After, leg1After] = await Promise.all([readLegBalance(c0), readLegBalance(c1)]);
  const amount0 = resolveReceivedAmount({
    balanceBefore: leg0Before,
    balanceAfter: leg0After,
    fallbackEstimate: expected0,
  });
  const amount1 = resolveReceivedAmount({
    balanceBefore: leg1Before,
    balanceAfter: leg1After,
    fallbackEstimate: expected1,
  });
  const a0 = humanToFloat(amount0, pos.decimals0);
  const a1 = humanToFloat(amount1, pos.decimals1);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const withdrawalUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  // v4's BURN+TAKE/DECREASE+TAKE unlock path collects principal and fees
  // together in one transfer — there is no separate on-chain event that
  // splits them, same limitation v3's combined decrease+collect has. Use
  // the pre-close unclaimed-fee estimate as the fee portion (matching v3's
  // existing approach) rather than the previous hardcoded 0, which made
  // v4 closes never record a separate fee_claim ledger entry at all.
  const feesPortionUsd = pos.unclaimedFeesUsd;

  return {
    protocol: 'v4',
    hash,
    tokenId,
    amount0,
    amount1,
    amount0Human: a0,
    amount1Human: a1,
    expected0,
    expected1,
    withdrawalUsd,
    feesPortionUsd,
    txLink: txUrl(chainId, hash),
    token0: pos.token0,
    token1: pos.token1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
  };
}

/**
 * Claim unclaimed fees only (keep liquidity / NFT).
 * Uses DECREASE(0) + TAKE_PAIR unlock path.
 */
export async function claimV4Fees(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<{
  hash: Hash;
  tokenId: bigint;
  feesUsd: number;
  fees0: bigint;
  fees1: bigint;
  symbol0: string;
  symbol1: string;
  amount0Human: number;
  amount1Human: number;
  txLink: string;
}> {
  const pos = await getV4Position(chainId, tokenId);
  if (!pos || !pos.poolKey) throw new Error(`v4 position #${tokenId} not found`);

  const fees0 = pos.tokensOwed0;
  const fees1 = pos.tokensOwed1;
  if (fees0 === 0n && fees1 === 0n) {
    throw new Error(`No unclaimed fees on #${tokenId}`);
  }

  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const recipient = getHotWalletAddress();
  const c0 = pos.poolKey.currency0;
  const c1 = pos.poolKey.currency1;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const data = encodeCollectFeesUnlockData({
    tokenId,
    currency0: c0,
    currency1: c1,
    recipient,
  });

  console.log(
    `[claim v4] #${tokenId} fees0=${fees0} fees1=${fees1} estUsd=${pos.unclaimedFeesUsd}`,
  );

  const readLegBalance = async (currency: Address): Promise<bigint> =>
    currency.toLowerCase() === ZERO
      ? client.getBalance({ address: recipient })
      : (client.readContract({
          address: currency,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [recipient],
        }) as Promise<bigint>);

  const leg0Before = await readLegBalance(c0);
  const leg1Before = await readLegBalance(c1);

  const claimArgs = [data, deadline] as const;

  await client.simulateContract({
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: claimArgs,
    account: recipient,
  });

  const claimGas = await estimateWriteGas({
    client,
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: claimArgs,
    account: wallet.account!.address,
    fallbackGas: 700_000n,
    context: `claim-v4-fees #${tokenId}`,
  });

  const hash = await wallet.writeContract({
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: claimArgs,
    account: wallet.account!,
    chain: wallet.chain,
    gas: claimGas,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new Error(`claim-v4-fees #${tokenId} tx reverted: ${hash}`);
  }

  // ACTUAL collected amount via balance delta — fees0/fees1 (pos.tokensOwed0/1)
  // is the pre-claim estimate and must not be reported as the final claimed
  // amount. Falls back to that estimate only if no delta was observed.
  const [leg0After, leg1After] = await Promise.all([readLegBalance(c0), readLegBalance(c1)]);
  const actual0 = resolveReceivedAmount({
    balanceBefore: leg0Before,
    balanceAfter: leg0After,
    fallbackEstimate: fees0,
  });
  const actual1 = resolveReceivedAmount({
    balanceBefore: leg1Before,
    balanceAfter: leg1After,
    fallbackEstimate: fees1,
  });
  const a0 = humanToFloat(actual0, pos.decimals0);
  const a1 = humanToFloat(actual1, pos.decimals1);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const feesUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);

  // Gas telemetry (Phase 3 §17) — claim-v4-fees previously had none at
  // all. Best-effort: never blocks/fails the already-successful claim.
  try {
    const { recordExecutionTelemetry } = await import('../db/index.js');
    const { buildGasTelemetry } = await import('./gas.js');
    const gas = await buildGasTelemetry(client, hash, claimGas);
    recordExecutionTelemetry({
      chainId,
      opType: 'claim-fees-v4',
      dex: 'uniswap',
      slippageBpsUsed: 0,
      quoteSource: 'v4-position-tokensOwed-snapshot',
      legs: [
        { token: pos.token0, estimatedRaw: fees0.toString(), minRaw: '0', actualRaw: actual0.toString() },
        { token: pos.token1, estimatedRaw: fees1.toString(), minRaw: '0', actualRaw: actual1.toString() },
      ],
      txHash: hash,
      ok: true,
      gas,
    });
  } catch {
    /* telemetry is best-effort only */
  }

  return {
    hash,
    tokenId,
    feesUsd,
    fees0: actual0,
    fees1: actual1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
    amount0Human: a0,
    amount1Human: a1,
    txLink: txUrl(chainId, hash),
  };
}

// silence unused imports that may be useful later
void nearestUsableTick;
void TickMath;
void formatAge;
void formatEthVal;
void uniswapPositionUrl;
void getPositionOpenedAt;
void computePositionPnl;
