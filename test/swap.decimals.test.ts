import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateAmountOut } from '../src/chain/swap.js';
import type { MinimalReadClient } from '../src/chain/quote.js';

const TOKEN0 = '0x1000000000000000000000000000000000000001' as const;
const TOKEN1 = '0x2000000000000000000000000000000000000002' as const;
const POOL = '0x3000000000000000000000000000000000000003' as const;

/**
 * Regression tests for the decimals bug found during Phase 2 Part 3's
 * integration testing (see PHASE2_PART3_AUDIT.md §9): estimateAmountOut()
 * applied a RAW (unadjusted) token1/token0 sqrtPrice ratio directly to
 * human-unit amounts, which is only correct when decimalsIn === decimalsOut.
 * For a WETH(18)/USDC(6) pair the old formula was wrong by a factor of
 * 10^12. Fixed by delegating to quote.ts's already-tested,
 * decimals-adjusted sqrtPriceRatio() helper.
 */
function mockClient(sqrtPriceX96: bigint): MinimalReadClient {
  return {
    readContract: async (args) => {
      if (args.functionName === 'token0') return TOKEN0;
      if (args.functionName === 'slot0') return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
      throw new Error(`unexpected call: ${args.functionName}`);
    },
  };
}

/** sqrtPriceX96 for a 1:1 raw price (price1Per0 = 1). */
const SQRT_PRICE_1_TO_1 = 2n ** 96n;

test('estimateAmountOut: same-decimals pair (18/18) — 1:1 raw price gives ~1:1 human output', async () => {
  const client = mockClient(SQRT_PRICE_1_TO_1);
  const amountIn = 10n ** 18n; // 1.0 token0
  const out = await estimateAmountOut(8453, POOL, TOKEN0, amountIn, 18, 18, client);
  // 1 token0 in -> ~1 token1 out (raw price 1:1, both 18 decimals)
  const outHuman = Number(out) / 1e18;
  assert.ok(Math.abs(outHuman - 1) < 1e-9, `expected ~1.0, got ${outHuman}`);
});

test('estimateAmountOut: WETH(18)->USDC(6), zeroForOne — must NOT be off by 10^12', async () => {
  // Raw price1Per0 = 1 (sqrtPriceX96 = 2^96) means: 1 raw-unit token0 = 1
  // raw-unit token1. With decimalsIn=18 (token0=WETH), decimalsOut=6
  // (token1=USDC), 1 WETH (10^18 raw) should yield 10^18 raw USDC units
  // BEFORE decimals adjustment is even considered — but 10^18 raw USDC
  // units is 10^12 USDC (6 decimals), an absurd, decimals-broken result.
  // The CORRECT decimals-adjusted answer for raw price1Per0=1 is:
  // outHuman = inHuman * 10^(decimalsIn - decimalsOut) = 1 * 10^12 ... no —
  // sqrtPriceRatio's decAdj = 10^(decimalsIn-decimalsOut) is applied to the
  // RAW ratio, giving a human/human ratio. We just assert the fix produces
  // a value in a SANE order of magnitude (not 10^12 off), by cross-checking
  // against sqrtPriceRatio directly rather than hand-deriving twice.
  const { sqrtPriceRatio } = await import('../src/chain/quote.js');
  const client = mockClient(SQRT_PRICE_1_TO_1);
  const amountIn = 10n ** 18n; // 1.0 WETH
  const out = await estimateAmountOut(8453, POOL, TOKEN0, amountIn, 18, 6, client);
  const outHuman = Number(out) / 1e6;

  const expectedRatio = sqrtPriceRatio(SQRT_PRICE_1_TO_1, 18, 6, true)!;
  const expectedOutHuman = 1 * expectedRatio;
  assert.ok(
    Math.abs(outHuman - expectedOutHuman) / expectedOutHuman < 1e-6,
    `expected ~${expectedOutHuman}, got ${outHuman}`,
  );
  // The old buggy formula (no decimals adjustment) would have produced
  // outHuman ≈ 1 (raw price1Per0=1 applied directly), off by the
  // magnitude sqrtPriceRatio's decAdj = 10^(18-6) = 10^12 corrects for.
  assert.ok(
    Math.abs(outHuman - 1) > 1e6,
    'fixed output must differ hugely from the old (decimals-unaware) ~1.0 result',
  );
});

test('estimateAmountOut: USDC(6)->WETH(18), !zeroForOne direction also decimals-correct', async () => {
  const { sqrtPriceRatio } = await import('../src/chain/quote.js');
  const client = mockClient(SQRT_PRICE_1_TO_1);
  const amountIn = 1_000n * 10n ** 6n; // 1000 USDC (token1, since tokenIn != token0)
  const out = await estimateAmountOut(8453, POOL, TOKEN1, amountIn, 6, 18, client);
  const outHuman = Number(out) / 1e18;

  const expectedRatio = sqrtPriceRatio(SQRT_PRICE_1_TO_1, 6, 18, false)!;
  const expectedOutHuman = 1000 * expectedRatio;
  assert.ok(
    Math.abs(outHuman - expectedOutHuman) / expectedOutHuman < 1e-6,
    `expected ~${expectedOutHuman}, got ${outHuman}`,
  );
});

test('estimateAmountOut: zero sqrtPriceX96 or zero amountIn -> 0, never a fabricated value', async () => {
  const zeroPrice = await estimateAmountOut(8453, POOL, TOKEN0, 10n ** 18n, 18, 6, mockClient(0n));
  assert.equal(zeroPrice, 0n);
  const zeroAmount = await estimateAmountOut(8453, POOL, TOKEN0, 0n, 18, 6, mockClient(SQRT_PRICE_1_TO_1));
  assert.equal(zeroAmount, 0n);
});
