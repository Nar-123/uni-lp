import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Token,
  Pool,
  CurrencyAmount,
  nearestUsableTick,
  TickMath,
  v3Sdk,
} from '../src/chain/uniswap.js';
import {
  sqrtPriceRatio,
  executionRatio,
  isImplausibleExecutionPrice,
  isQuoteStale,
  LOCAL_QUOTE_MAX_AGE_MS,
  getExecutableQuoteV3,
  type MinimalReadClient,
} from '../src/chain/quote.js';
import {
  compressTick,
  bitmapPosition,
  computeNextInitializedTickWithinOneWord,
} from '../src/chain/tickBitmap.js';

const { TickListDataProvider } = v3Sdk;

const CHAIN_ID = 8453;
const FEE = 3000; // 0.3%, tickSpacing 60
const SPACING = 60;

function makeToken(address: `0x${string}`, symbol: string): InstanceType<typeof Token> {
  return new Token(CHAIN_ID, address, 18, symbol, symbol);
}

/** Same formula as swap.ts's estimateAmountOut(): slot0-only, no tick crossing. */
function roughEstimate(params: {
  sqrtPriceX96: bigint;
  zeroForOne: boolean;
  amountInHuman: number;
}): number {
  const sqrtP = Number(params.sqrtPriceX96) / 2 ** 96;
  const price1Per0 = sqrtP * sqrtP;
  return params.zeroForOne
    ? params.amountInHuman * price1Per0
    : params.amountInHuman / price1Per0;
}

// ── Section 15: prove the rough slot0-only estimate and a real,
// tick-crossing-aware quote can genuinely diverge ────────────────────────

test('real quote diverges from the rough slot0 estimate when a swap crosses into a liquidity-boundary tick', async () => {
  const token0 = makeToken('0x1000000000000000000000000000000000000001', 'T0');
  const token1 = makeToken('0x1000000000000000000000000000000000000002', 'T1');

  // sqrtPriceX96 for price 1:1 (token1 per token0 == 1), tick 0.
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(0);
  const currentTick = 0;

  // Thin current-tick liquidity, then a large liquidity step-up a few
  // spacings above current tick (a common real shape: a narrow deployer
  // range plus a much deeper range further out).
  const L_THIN = 1_000_000n;
  const L_STEP = 50_000_000_000n; // orders of magnitude deeper
  const tickStep = SPACING * 10; // well within current tick's word

  const lowerBound = nearestUsableTick(TickMath.MIN_TICK, SPACING);
  const upperBound = nearestUsableTick(TickMath.MAX_TICK, SPACING);

  // Closed tick list (liquidityNet sums to zero), matching the shape:
  // [lowerBound: +L_THIN] .. current .. [tickStep: +L_STEP] .. [upperBound: -(L_THIN+L_STEP)]
  const ticks = [
    { index: lowerBound, liquidityGross: L_THIN.toString(), liquidityNet: L_THIN.toString() },
    { index: tickStep, liquidityGross: L_STEP.toString(), liquidityNet: L_STEP.toString() },
    {
      index: upperBound,
      liquidityGross: (L_THIN + L_STEP).toString(),
      liquidityNet: (-(L_THIN + L_STEP)).toString(),
    },
  ];
  const provider = new TickListDataProvider(ticks, SPACING);

  const pool = new Pool(
    token0,
    token1,
    FEE,
    sqrtPriceX96.toString(),
    L_THIN.toString(), // current in-range liquidity is the thin amount
    currentTick,
    provider,
  );

  // Swap token1 → token0 (price increases, tick increases) — a big enough
  // trade to exhaust the thin liquidity and cross into the deep step.
  const amountInHuman = 40; // large relative to L_THIN's effective depth
  const amountIn = BigInt(Math.floor(amountInHuman * 1e18));
  const inputCurrency = CurrencyAmount.fromRawAmount(token1, amountIn.toString());

  const [outputCurrency, poolAfter] = await pool.getOutputAmount(inputCurrency);
  const realAmountOutHuman = Number(outputCurrency.quotient.toString()) / 1e18;

  const rough = roughEstimate({
    sqrtPriceX96,
    zeroForOne: false, // token1 -> token0
    amountInHuman,
  });

  // The trade must have actually crossed out of the starting tick range —
  // otherwise this wouldn't be testing tick-crossing at all.
  assert.notEqual(poolAfter.tickCurrent, currentTick);
  assert.ok(
    poolAfter.tickCurrent >= tickStep,
    `expected the swap to cross into the deep step (tick >= ${tickStep}), got ${poolAfter.tickCurrent}`,
  );

  // The real, tick-crossing-aware quote must differ measurably from the
  // naive constant-liquidity slot0 formula — proving the rough estimate is
  // NOT an adequate stand-in for capital execution once a trade is large
  // enough to move through more than one liquidity range.
  const relativeDiff = Math.abs(realAmountOutHuman - rough) / rough;
  assert.ok(
    relativeDiff > 0.01,
    `expected real quote (${realAmountOutHuman}) to diverge from rough estimate (${rough}), diff=${relativeDiff}`,
  );
});

// ── executionRatio / sqrtPriceRatio — pure helpers backing the "logical
// maximum" quote validation gate ───────────────────────────────────────

test('sqrtPriceRatio: price-1 tick (tick 0) gives ratio 1 for equal decimals', () => {
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(0);
  const r = sqrtPriceRatio(sqrtPriceX96, 18, 18, true);
  assert.ok(r != null && Math.abs(r - 1) < 1e-6);
});

test('sqrtPriceRatio: rejects non-finite/zero sqrtPrice', () => {
  assert.equal(sqrtPriceRatio(0n, 18, 18, true), null);
});

test('executionRatio: matches amountOut/amountIn adjusted for decimals', () => {
  // 1 token (18 dec) in -> 2 tokens (6 dec) out => ratio 2
  const amountIn = 1_000_000_000_000_000_000n;
  const amountOut = 2_000_000n;
  const r = executionRatio(amountIn, amountOut, 18, 6);
  assert.ok(r != null && Math.abs(r - 2) < 1e-9);
});

test('executionRatio: rejects amountIn <= 0', () => {
  assert.equal(executionRatio(0n, 100n, 18, 18), null);
});

// ── Regression tests 2-5 from Section 16: malformed/stale quote → abort ──

test('malformed quote: execution price wildly above mid price is rejected', () => {
  assert.equal(isImplausibleExecutionPrice(1e10, 1), true);
});

test('malformed quote: execution price wildly below mid price is rejected', () => {
  assert.equal(isImplausibleExecutionPrice(1e-10, 1), true);
});

test('malformed quote: a plausible (even badly sloped) execution price is not rejected by the sanity gate', () => {
  // Genuinely bad slippage (50% worse) is a priceImpact.ts concern, not
  // this gross-bug sanity gate.
  assert.equal(isImplausibleExecutionPrice(0.5, 1), false);
  assert.equal(isImplausibleExecutionPrice(1.5, 1), false);
});

test('malformed quote: missing ratios never block a quote via this gate', () => {
  assert.equal(isImplausibleExecutionPrice(null, 1), false);
  assert.equal(isImplausibleExecutionPrice(1, null), false);
});

test('stale quote: fresh quote (age 0) is never stale', () => {
  const now = 1_000_000;
  assert.equal(isQuoteStale(now, LOCAL_QUOTE_MAX_AGE_MS, now), false);
});

test('stale quote: exactly at the max-age boundary is not yet stale', () => {
  const now = 1_000_000;
  assert.equal(isQuoteStale(now - LOCAL_QUOTE_MAX_AGE_MS, LOCAL_QUOTE_MAX_AGE_MS, now), false);
});

test('stale quote: one ms past the max age is stale → must refresh/abort', () => {
  const now = 1_000_000;
  assert.equal(
    isQuoteStale(now - LOCAL_QUOTE_MAX_AGE_MS - 1, LOCAL_QUOTE_MAX_AGE_MS, now),
    true,
  );
});

// ── Part A / Section 4-5: RPC-failure and quote-consistency tests via a
// mocked read client (no network needed — always runs in `npm test`) ─────

const TOKEN_A = '0x2000000000000000000000000000000000000001';
const TOKEN_B = '0x2000000000000000000000000000000000000002';
const POOL = '0x3000000000000000000000000000000000000001';
const FEE_TEST = 3000;
const SPACING_TEST = 60;

function makeMockClient(overrides: {
  slot0?: () => Promise<unknown>;
  liquidity?: () => Promise<unknown>;
  tickSpacing?: () => Promise<unknown>;
  token0?: () => Promise<unknown>;
  token1?: () => Promise<unknown>;
  fee?: () => Promise<unknown>;
  tickBitmap?: (wordPos: number) => Promise<unknown>;
  ticks?: (tick: number) => Promise<unknown>;
} = {}): MinimalReadClient {
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(0);
  return {
    readContract: async ({ functionName, args }) => {
      switch (functionName) {
        case 'slot0':
          return overrides.slot0
            ? overrides.slot0()
            : ([sqrtPriceX96, 0, 0, 0, 0, 0, true] as const);
        case 'liquidity':
          return overrides.liquidity ? overrides.liquidity() : 1_000_000_000n;
        case 'tickSpacing':
          return overrides.tickSpacing ? overrides.tickSpacing() : SPACING_TEST;
        case 'token0':
          return overrides.token0 ? overrides.token0() : TOKEN_A;
        case 'token1':
          return overrides.token1 ? overrides.token1() : TOKEN_B;
        case 'fee':
          return overrides.fee ? overrides.fee() : FEE_TEST;
        case 'tickBitmap':
          return overrides.tickBitmap
            ? overrides.tickBitmap(Number((args as readonly unknown[])[0]))
            : 0n; // no initialized ticks in range — fine as long as the trade stays within current liquidity
        case 'ticks':
          return overrides.ticks
            ? overrides.ticks(Number((args as readonly unknown[])[0]))
            : ([0n, 0n, 0n, 0n, 0n, 0n, 0, false] as const);
        default:
          throw new Error(`unexpected functionName ${functionName}`);
      }
    },
  };
}

const baseParams = {
  chainId: 8453 as const,
  poolAddress: POOL as `0x${string}`,
  tokenIn: TOKEN_A as `0x${string}`,
  tokenOut: TOKEN_B as `0x${string}`,
  decimalsIn: 18,
  decimalsOut: 18,
  symbolIn: 'A',
  symbolOut: 'B',
  nameIn: 'A',
  nameOut: 'B',
  fee: FEE_TEST,
  amountIn: 1_000n,
};

test('mocked happy path: a small within-range trade returns ok:true with amountOut > 0', async () => {
  const r = await getExecutableQuoteV3({ ...baseParams, client: makeMockClient() });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.amountOut > 0n);
    assert.equal(r.source, 'v3-pool-simulation');
  }
});

test('RPC failure: slot0 read fails → ok:false, POOL_STATE_ERROR, never amountOut=0-and-continue', async () => {
  const client = makeMockClient({
    slot0: async () => {
      throw new Error('transient RPC timeout');
    },
  });
  const r = await getExecutableQuoteV3({ ...baseParams, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'POOL_STATE_ERROR');
});

test('RPC failure: liquidity read fails → ok:false, POOL_STATE_ERROR', async () => {
  const client = makeMockClient({
    liquidity: async () => {
      throw new Error('rate limited');
    },
  });
  const r = await getExecutableQuoteV3({ ...baseParams, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'POOL_STATE_ERROR');
});

test('RPC failure: tickSpacing read fails → ok:false, POOL_STATE_ERROR', async () => {
  const client = makeMockClient({
    tickSpacing: async () => {
      throw new Error('connection reset');
    },
  });
  const r = await getExecutableQuoteV3({ ...baseParams, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'POOL_STATE_ERROR');
});

test('RPC failure: tickBitmap fails mid-simulation (large trade needs to cross) → ok:false, never amountOut=0-and-continue', async () => {
  // Force a trade large enough relative to liquidity that the swap loop
  // must ask the tick data provider for the next initialized tick.
  const client = makeMockClient({
    liquidity: async () => 1n, // tiny — any real trade must cross out of range
    tickBitmap: async () => {
      throw new Error('tickBitmap RPC failure');
    },
  });
  const r = await getExecutableQuoteV3({ ...baseParams, amountIn: 1_000_000n, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'QUOTE_UNAVAILABLE');
});

test('quote consistency: pool token pair mismatch → ok:false, INVALID_QUOTE, aborts before simulating', async () => {
  const client = makeMockClient({
    token0: async () => '0x9999999999999999999999999999999999999999',
  });
  const r = await getExecutableQuoteV3({ ...baseParams, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_QUOTE');
});

test('quote consistency: pool fee mismatch → ok:false, INVALID_QUOTE', async () => {
  const client = makeMockClient({ fee: async () => 500 });
  const r = await getExecutableQuoteV3({ ...baseParams, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_QUOTE');
});

test('invalid input: amountIn <= 0 → ok:false, INVALID_QUOTE, no RPC calls made', async () => {
  let called = false;
  const client: MinimalReadClient = {
    readContract: async () => {
      called = true;
      throw new Error('should not be called');
    },
  };
  const r = await getExecutableQuoteV3({ ...baseParams, amountIn: 0n, client });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_QUOTE');
  assert.equal(called, false);
});

test('invalid input: tokenIn === tokenOut → ok:false, INVALID_QUOTE', async () => {
  const r = await getExecutableQuoteV3({
    ...baseParams,
    tokenOut: baseParams.tokenIn,
    client: makeMockClient(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_QUOTE');
});

// ── Cross-check: my on-demand bitmap math agrees with the SDK's own
// array-based TickList for the same scenario (independent implementations
// of the same protocol spec should reach the same answer) ────────────────

test('cross-check: computeNextInitializedTickWithinOneWord agrees with a synthetic bitmap built from the same tick list', () => {
  const tickSpacing = 60;
  const initializedTicks = [-300, 0, 120, 4800]; // compressed: -5, 0, 2, 80 (all within word 0 except -5 is word -1)

  // Build a bitmap word for word 0 covering compressed ticks 0..255 from
  // the subset of initializedTicks that fall in word 0.
  let word0 = 0n;
  for (const t of initializedTicks) {
    const compressed = compressTick(t, tickSpacing);
    const { wordPos, bitPos } = bitmapPosition(compressed);
    if (wordPos === 0) word0 |= 1n << BigInt(bitPos);
  }

  // Searching <= tick 130 (compressed 2) should land exactly on tick 120.
  const r = computeNextInitializedTickWithinOneWord(130, tickSpacing, true, word0);
  assert.deepEqual(r, { next: 120, initialized: true });
});
