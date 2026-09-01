/**
 * Real executable V3 swap quote — Phase 2 Part 2.
 *
 * Replaces the rough slot0-only estimate (`estimateAmountOut` in swap.ts,
 * "amountIn * sqrtPrice^2" with no tick-crossing) as the source of the
 * amountOut fed into minOut/price-impact for LOCAL capital execution.
 *
 * Mechanism: simulate the swap using the actual protocol math
 * (`@uniswap/v3-sdk`'s `Pool.getOutputAmount`, the same math the on-chain
 * pool contract runs) fed with LIVE, on-demand-fetched tick data — a
 * `TickDataProvider` that calls the pool's own `tickBitmap`/`ticks` views
 * only for the ticks this specific trade actually needs to cross (typically
 * 0-3 for a normal-sized trade), bounded by MAX_WORD_FETCHES so a
 * pathological trade fails closed instead of hammering the RPC endpoint.
 *
 * No Quoter/QuoterV2 contract address exists anywhere in this repo's
 * config for any of the three chains it targets, and per the hardening
 * brief a contract address must never be invented from assumption — so
 * this uses the protocol-native SIMULATION approach instead of a live
 * Quoter contract call. See PHASE2_PART2_QUOTE_AUDIT.md for the audit that
 * established this.
 */
import type { Address } from 'viem';
import { type SupportedChainId } from '../config.js';
import { poolAbi } from './abis.js';
import { getPublicClient } from './clients.js';
import { CurrencyAmount, Pool, Token, type TickDataProvider } from './uniswap.js';
import {
  bitmapPosition,
  compressTick,
  computeNextInitializedTickWithinOneWord,
} from './tickBitmap.js';
import { SafetyError } from './safety.js';

export type QuoteErrorCode =
  | 'TRANSIENT_RPC_ERROR'
  | 'QUOTE_UNAVAILABLE'
  | 'INVALID_QUOTE'
  | 'POOL_STATE_ERROR'
  | 'CONTRACT_REVERT'
  | 'SAFETY_ERROR';

export type QuoteResult =
  | {
      ok: true;
      amountOut: bigint;
      quotedAt: number;
      source: 'v3-pool-simulation';
      poolAddress: Address;
      tokenIn: Address;
      tokenOut: Address;
      fee: number;
      amountIn: bigint;
      sqrtPriceX96Before: bigint;
      sqrtPriceX96After: bigint;
      tickBefore: number;
      tickAfter: number;
    }
  | {
      ok: false;
      code: QuoteErrorCode;
      reason: string;
    };

/**
 * Conservative starting point — NOT OOS-calibrated. A local quote older
 * than this (e.g. because an approval transaction took a while between
 * quoting and sending) must be refreshed rather than used. Revisit once
 * Phase 2 Part 1's execution telemetry has enough real fill data to show
 * how much on-chain price actually moves over a given window for the
 * pools this bot trades.
 */
export const LOCAL_QUOTE_MAX_AGE_MS = 20_000;

export function isQuoteStale(
  quotedAt: number,
  maxAgeMs: number = LOCAL_QUOTE_MAX_AGE_MS,
  now: number = Date.now(),
): boolean {
  return now - quotedAt > maxAgeMs;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Bounds RPC cost: abort rather than fetch unboundedly many empty bitmap words. */
const MAX_WORD_FETCHES = 20;

/**
 * Deliberately loose (not viem's exact overloaded readContract type) so a
 * hand-written mock can satisfy it in tests without fighting generics —
 * every call site already narrows/casts the result explicitly.
 */
export type MinimalReadClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract: (args: {
    address: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: any;
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
};

/**
 * On-demand TickDataProvider backed by live RPC reads of the pool's own
 * `tickBitmap`/`ticks` views — fetches only what this specific swap
 * simulation actually walks (word-by-word, tick-by-tick), never a
 * whole-pool upfront scan.
 */
class RpcTickDataProvider implements TickDataProvider {
  private readonly wordCache = new Map<number, bigint>();
  private wordFetches = 0;

  constructor(
    private readonly client: MinimalReadClient,
    private readonly poolAddress: Address,
  ) {}

  private async getWord(wordPos: number): Promise<bigint> {
    const cached = this.wordCache.get(wordPos);
    if (cached !== undefined) return cached;
    if (this.wordFetches >= MAX_WORD_FETCHES) {
      throw new SafetyError(
        `[safety] quote: exceeded max tick-bitmap word fetches (${MAX_WORD_FETCHES}) — ` +
          `trade is too large relative to available on-chain liquidity depth to quote safely`,
      );
    }
    this.wordFetches++;
    const word = (await this.client.readContract({
      address: this.poolAddress,
      abi: poolAbi,
      functionName: 'tickBitmap',
      args: [wordPos],
    })) as bigint;
    this.wordCache.set(wordPos, word);
    return word;
  }

  async nextInitializedTickWithinOneWord(
    tick: number,
    lte: boolean,
    tickSpacing: number,
  ): Promise<[number, boolean]> {
    const compressed = compressTick(tick, tickSpacing);
    const { wordPos } = lte
      ? bitmapPosition(compressed)
      : bitmapPosition(compressed + 1);
    const word = await this.getWord(wordPos);
    const { next, initialized } = computeNextInitializedTickWithinOneWord(
      tick,
      tickSpacing,
      lte,
      word,
    );
    return [next, initialized];
  }

  async getTick(tick: number): Promise<{ liquidityNet: string }> {
    const raw = await this.client.readContract({
      address: this.poolAddress,
      abi: poolAbi,
      functionName: 'ticks',
      args: [tick],
    });
    return { liquidityNet: ((raw as readonly unknown[])[1] as bigint).toString() };
  }
}

/**
 * Real executable quote for a single V3 pool leg. Never falls back to a
 * rough estimate — any failure returns `{ok:false}` with a classified
 * reason; the caller must abort, not substitute a display-only number.
 */
export async function getExecutableQuoteV3(params: {
  chainId: SupportedChainId;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  decimalsIn: number;
  decimalsOut: number;
  symbolIn: string;
  symbolOut: string;
  nameIn: string;
  nameOut: string;
  fee: number;
  amountIn: bigint;
  /**
   * Injectable read client — defaults to getPublicClient(chainId).
   * Exists so RPC-failure paths can be unit tested with a mock (see
   * test/quote.test.ts) without requiring live network access. Production
   * call sites never pass this.
   */
  client?: MinimalReadClient;
}): Promise<QuoteResult> {
  const {
    chainId,
    poolAddress,
    tokenIn,
    tokenOut,
    decimalsIn,
    decimalsOut,
    symbolIn,
    symbolOut,
    nameIn,
    nameOut,
    fee,
    amountIn,
  } = params;

  if (amountIn <= 0n) {
    return { ok: false, code: 'INVALID_QUOTE', reason: 'amountIn must be > 0' };
  }
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return { ok: false, code: 'INVALID_QUOTE', reason: 'tokenIn === tokenOut' };
  }

  const client = params.client ?? getPublicClient(chainId);

  let sqrtPriceX96: bigint;
  let tickCurrent: number;
  let liquidity: bigint;
  let tickSpacing: number;
  let poolToken0: Address;
  let poolToken1: Address;
  let poolFee: number;
  try {
    const [slot0, liq, spacing, t0, t1, feeOnChain] = await Promise.all([
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'tickSpacing' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' }),
    ]);
    const slot0Tuple = slot0 as readonly unknown[];
    sqrtPriceX96 = slot0Tuple[0] as bigint;
    tickCurrent = Number(slot0Tuple[1]);
    liquidity = liq as bigint;
    tickSpacing = Number(spacing);
    poolToken0 = t0 as Address;
    poolToken1 = t1 as Address;
    poolFee = Number(feeOnChain);
  } catch (e) {
    return {
      ok: false,
      code: 'POOL_STATE_ERROR',
      reason: `pool state read failed: ${errMsg(e)}`,
    };
  }

  if (sqrtPriceX96 <= 0n) {
    return { ok: false, code: 'POOL_STATE_ERROR', reason: 'pool sqrtPriceX96 is 0 (uninitialized)' };
  }

  // Quote/execution consistency: the pool we're about to simulate against
  // must actually be the tokenIn/tokenOut/fee pair the caller intends to
  // execute — never quote pool A and let the caller execute pool B.
  const t0Lower = poolToken0.toLowerCase();
  const t1Lower = poolToken1.toLowerCase();
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const zeroForOne = inLower === t0Lower && outLower === t1Lower;
  const oneForZero = inLower === t1Lower && outLower === t0Lower;
  if (!zeroForOne && !oneForZero) {
    return {
      ok: false,
      code: 'INVALID_QUOTE',
      reason: `pool ${poolAddress} token pair (${poolToken0}/${poolToken1}) does not match requested ${tokenIn}→${tokenOut}`,
    };
  }
  if (poolFee !== fee) {
    return {
      ok: false,
      code: 'INVALID_QUOTE',
      reason: `pool ${poolAddress} fee ${poolFee} does not match requested fee ${fee}`,
    };
  }

  const tIn = new Token(chainId, tokenIn, decimalsIn, symbolIn, nameIn);
  const tOut = new Token(chainId, tokenOut, decimalsOut, symbolOut, nameOut);
  const provider = new RpcTickDataProvider(client, poolAddress);

  let pool: InstanceType<typeof Pool>;
  try {
    pool = new Pool(
      tIn,
      tOut,
      fee,
      sqrtPriceX96.toString(),
      liquidity.toString(),
      tickCurrent,
      provider,
    );
  } catch (e) {
    return { ok: false, code: 'POOL_STATE_ERROR', reason: `pool construction failed: ${errMsg(e)}` };
  }

  let amountOut: bigint;
  let sqrtPriceX96After: bigint;
  let tickAfter: number;
  try {
    const inputCurrency = CurrencyAmount.fromRawAmount(tIn, amountIn.toString());
    const [outputCurrency, poolAfter] = await pool.getOutputAmount(inputCurrency);
    amountOut = BigInt(outputCurrency.quotient.toString());
    sqrtPriceX96After = BigInt(poolAfter.sqrtRatioX96.toString());
    tickAfter = poolAfter.tickCurrent;
  } catch (e) {
    if (e instanceof SafetyError) {
      return { ok: false, code: 'QUOTE_UNAVAILABLE', reason: e.message };
    }
    return {
      ok: false,
      code: 'QUOTE_UNAVAILABLE',
      reason: `swap simulation failed: ${errMsg(e)}`,
    };
  }

  if (amountOut <= 0n || !Number.isFinite(Number(sqrtPriceX96After))) {
    return { ok: false, code: 'INVALID_QUOTE', reason: 'simulated amountOut is 0 or non-finite' };
  }

  // Coarse sanity ceiling: catches a gross unit/direction/decimal bug, not
  // a slippage/impact judgement (that's priceImpact.ts's job, unchanged).
  // Execution price shouldn't be off from the pool's OWN mid price by more
  // than 6 orders of magnitude for a within-liquidity simulation.
  const midPriceRatio = sqrtPriceRatio(sqrtPriceX96, decimalsIn, decimalsOut, zeroForOne);
  const execPriceRatio = executionRatio(amountIn, amountOut, decimalsIn, decimalsOut);
  if (isImplausibleExecutionPrice(execPriceRatio, midPriceRatio)) {
    return {
      ok: false,
      code: 'INVALID_QUOTE',
      reason: `simulated execution price implausibly far from pool mid price (exec=${execPriceRatio}, mid=${midPriceRatio})`,
    };
  }

  return {
    ok: true,
    amountOut,
    quotedAt: Date.now(),
    source: 'v3-pool-simulation',
    poolAddress,
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    sqrtPriceX96Before: sqrtPriceX96,
    sqrtPriceX96After,
    tickBefore: tickCurrent,
    tickAfter,
  };
}

/** token-out-per-token-in mid price implied by sqrtPriceX96, decimals-adjusted. Pure. */
export function sqrtPriceRatio(
  sqrtPriceX96: bigint,
  decimalsIn: number,
  decimalsOut: number,
  zeroForOne: boolean,
): number | null {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  if (!Number.isFinite(sqrtP) || sqrtP <= 0) return null;
  const price1Per0 = sqrtP * sqrtP; // raw token1 per raw token0
  const decAdj = 10 ** (decimalsIn - decimalsOut);
  const price = zeroForOne ? price1Per0 * decAdj : (1 / price1Per0) * decAdj;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** actual-output-per-actual-input ratio from a quote, decimals-adjusted. Pure. */
export function executionRatio(
  amountIn: bigint,
  amountOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
): number | null {
  if (amountIn <= 0n) return null;
  const inHuman = Number(amountIn) / 10 ** decimalsIn;
  const outHuman = Number(amountOut) / 10 ** decimalsOut;
  const ratio = outHuman / inHuman;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * Coarse "malformed quote" sanity gate — NOT a slippage/impact judgement
 * (priceImpact.ts owns that, unchanged threshold). Catches a gross
 * unit/direction/decimal bug in the quote pipeline itself: a legitimate
 * simulated execution price, however bad the slippage, should never land
 * more than 6 orders of magnitude from the pool's own mid price. Returns
 * `false` (not implausible) whenever either ratio is unavailable — this
 * gate only fires on a positive mismatch, it never blocks a quote for
 * missing data (that's INVALID_QUOTE's `amountOut<=0` check elsewhere).
 */
export function isImplausibleExecutionPrice(
  execPriceRatio: number | null,
  midPriceRatio: number | null,
): boolean {
  if (execPriceRatio == null || midPriceRatio == null) return false;
  return execPriceRatio > midPriceRatio * 1e6 || execPriceRatio < midPriceRatio / 1e6;
}
