/**
 * Phase 4.7 audit (F-08) — on-chain reserve verification for V3 pools.
 *
 * classifyOnChainReserves is the pure decision logic extracted from
 * verifyOnChainPoolReserves (same split as multiPool.ts's scoreMultiPool/
 * isValidMetric) so every numeric edge case is unit-testable without RPC.
 *
 * verifyOnChainPoolReserves itself (the RPC-fetching wrapper) is also
 * exercised here via its injectable `deps` parameter (mirrors the existing
 * optional-client pattern in swap.ts's estimateAmountOut) — this proves the
 * wrapper's own try/catch fail-closed behavior deterministically, without
 * live network access. Real end-to-end RPC behavior against a genuine chain
 * is separately confirmed by the Part 9 live read-only validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOnChainReserves,
  MIN_POOL_TVL_USD,
  verifyOnChainPoolReserves,
  type OnChainReserveDeps,
} from '../src/chain/pools.js';

const CHAIN = 8453;
const POOL = '0x00000000000000000000000000000000000001' as `0x${string}`;
const TOKEN_A = '0x00000000000000000000000000000000000002' as `0x${string}`;
const TOKEN_B = '0x00000000000000000000000000000000000003' as `0x${string}`;

const DEC = 18;

function usdToRaw(usd: number, price: number, decimals = DEC): bigint {
  return BigInt(Math.round((usd / price) * 10 ** decimals));
}

test('sanity: MIN_POOL_TVL_USD is the existing codebase constant, not a new invented number', () => {
  assert.equal(MIN_POOL_TVL_USD, 2_000);
});

// 1. matching TVL
test('1. on-chain reserves closely matching DexScreener TVL: OK', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(50_000, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: usdToRaw(50_000, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 100_000,
  });
  assert.equal(result.status, 'OK');
  if (result.status === 'OK') assert.ok(Math.abs(result.onchainTvlUsd - 100_000) < 1);
});

// 2. small normal divergence (still clears the bar)
test('2. small divergence from DexScreener TVL (price moved slightly) still passes as long as it clears MIN_POOL_TVL_USD', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(48_000, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: usdToRaw(49_000, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 100_000, // DexScreener claims more than on-chain shows right now
  });
  assert.equal(result.status, 'OK');
});

// 3. large divergence (on-chain reality does not support the claimed bar)
test('3. large divergence: on-chain reserves far below DexScreener claim and below MIN_POOL_TVL_USD -> TVL_MISMATCH', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(10, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: usdToRaw(10, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 500_000,
  });
  assert.equal(result.status, 'TVL_MISMATCH');
  if (result.status === 'TVL_MISMATCH') {
    assert.equal(result.dexscreenerTvlUsd, 500_000);
    assert.ok(result.onchainTvlUsd < MIN_POOL_TVL_USD);
  }
});

// 4. missing DexScreener TVL (null-ish, represented as 0 by the caller)
test('4. missing/zero DexScreener TVL input is carried through untouched, not fabricated — verdict still driven by real on-chain reserves', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(60_000, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: usdToRaw(60_000, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 0,
  });
  assert.equal(result.status, 'OK', 'a genuinely well-reserved pool must not be punished for DexScreener reporting 0');
});

// 5. missing on-chain liquidity (zero balances both sides)
test('5. zero on-chain liquidity on both sides -> TVL_MISMATCH regardless of what DexScreener claims', () => {
  const result = classifyOnChainReserves({
    balA: 0n,
    decimalsA: DEC,
    priceA: 1,
    balB: 0n,
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 1_000_000,
  });
  assert.equal(result.status, 'TVL_MISMATCH');
  if (result.status === 'TVL_MISMATCH') assert.equal(result.onchainTvlUsd, 0);
});

// 7. malformed price (null — unavailable) must fail closed, never coerced to $0
test('7. malformed/unavailable price for either side -> ONCHAIN_VALIDATION_ERROR, never silently treated as $0', () => {
  const resultA = classifyOnChainReserves({
    balA: usdToRaw(50_000, 1),
    decimalsA: DEC,
    priceA: null,
    balB: usdToRaw(50_000, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 100_000,
  });
  assert.equal(resultA.status, 'ONCHAIN_VALIDATION_ERROR');

  const resultB = classifyOnChainReserves({
    balA: usdToRaw(50_000, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: usdToRaw(50_000, 1),
    decimalsB: DEC,
    priceB: null,
    dexscreenerTvlUsd: 100_000,
  });
  assert.equal(resultB.status, 'ONCHAIN_VALIDATION_ERROR');
});

// 8. zero liquidity (duplicate of 5 from a single-sided angle — one side genuinely empty)
test('8. one side completely empty (single-sided-drained pool) still correctly reflected in a low onchainTvlUsd', () => {
  const result = classifyOnChainReserves({
    balA: 0n,
    decimalsA: DEC,
    priceA: 1,
    balB: usdToRaw(1, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 100_000,
  });
  assert.equal(result.status, 'TVL_MISMATCH');
});

// 9. NaN/Infinity guard on the computed result (defense in depth — should be unreachable via normal finite inputs, but must never pass through)
test('9. a non-finite computed TVL (corrupt price, e.g. Infinity) fails closed as ONCHAIN_VALIDATION_ERROR, never treated as a passing/huge TVL', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(50_000, 1),
    decimalsA: DEC,
    priceA: Infinity,
    balB: usdToRaw(50_000, 1),
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: 100_000,
  });
  assert.equal(result.status, 'ONCHAIN_VALIDATION_ERROR');
});

test('exactly at MIN_POOL_TVL_USD passes (boundary is inclusive)', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(MIN_POOL_TVL_USD, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: 0n,
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: MIN_POOL_TVL_USD,
  });
  assert.equal(result.status, 'OK');
});

test('clearly below MIN_POOL_TVL_USD fails as TVL_MISMATCH (boundary is strict, not >=-inclusive-both-ways)', () => {
  const result = classifyOnChainReserves({
    balA: usdToRaw(MIN_POOL_TVL_USD - 1, 1),
    decimalsA: DEC,
    priceA: 1,
    balB: 0n,
    decimalsB: DEC,
    priceB: 1,
    dexscreenerTvlUsd: MIN_POOL_TVL_USD,
  });
  assert.equal(result.status, 'TVL_MISMATCH');
});

// ── verifyOnChainPoolReserves (RPC-fetching wrapper), via injected deps ───

function deps(overrides: Partial<OnChainReserveDeps>): OnChainReserveDeps {
  return {
    getBalance: async () => usdToRaw(50_000, 1),
    getMeta: async () => ({ decimals: DEC, symbol: 'TOK', name: 'Token' }) as never,
    getPrice: async () => 1,
    ...overrides,
  };
}

test('V3 RPC error: balanceOf throws -> ONCHAIN_VALIDATION_ERROR, never fabricated as TVL=0 or TVL_MISMATCH', async () => {
  const result = await verifyOnChainPoolReserves(
    CHAIN,
    POOL,
    TOKEN_A,
    TOKEN_B,
    100_000,
    deps({ getBalance: async () => { throw new Error('RPC timeout'); } }),
  );
  assert.equal(result.status, 'ONCHAIN_VALIDATION_ERROR');
});

test('V3 RPC error: getTokenMeta (decimals) throws -> ONCHAIN_VALIDATION_ERROR', async () => {
  const result = await verifyOnChainPoolReserves(
    CHAIN,
    POOL,
    TOKEN_A,
    TOKEN_B,
    100_000,
    deps({ getMeta: async () => { throw new Error('RPC error reading decimals'); } }),
  );
  assert.equal(result.status, 'ONCHAIN_VALIDATION_ERROR');
});

test('V3 RPC error: getTokenPriceUsd throws -> ONCHAIN_VALIDATION_ERROR', async () => {
  const result = await verifyOnChainPoolReserves(
    CHAIN,
    POOL,
    TOKEN_A,
    TOKEN_B,
    100_000,
    deps({ getPrice: async () => { throw new Error('price API down'); } }),
  );
  assert.equal(result.status, 'ONCHAIN_VALIDATION_ERROR');
});

test('V3 valid: real-shaped deps producing a healthy pool -> OK, with the correct onchainTvlUsd', async () => {
  const result = await verifyOnChainPoolReserves(
    CHAIN,
    POOL,
    TOKEN_A,
    TOKEN_B,
    100_000,
    deps({}),
  );
  assert.equal(result.status, 'OK');
  if (result.status === 'OK') assert.ok(Math.abs(result.onchainTvlUsd - 100_000) < 1);
});

test('V3 mismatch via wrapper: healthy balances but below MIN_POOL_TVL_USD -> TVL_MISMATCH', async () => {
  const result = await verifyOnChainPoolReserves(
    CHAIN,
    POOL,
    TOKEN_A,
    TOKEN_B,
    100_000,
    deps({ getBalance: async () => usdToRaw(1, 1) }),
  );
  assert.equal(result.status, 'TVL_MISMATCH');
});

test('V3 decimal correctness: two tokens with very different decimals (6 vs 18) are converted to human units correctly before pricing', async () => {
  // token A: 6 decimals (like USDC), balance = 50,000 raw human units at price $1 -> $50,000
  // token B: 18 decimals (like WETH), balance = 25 raw human units at price $1 -> $25
  const result = await verifyOnChainPoolReserves(
    CHAIN,
    POOL,
    TOKEN_A,
    TOKEN_B,
    100_000,
    {
      getBalance: async (_chain, token) => (token === TOKEN_A ? 50_000_000_000n : 25_000_000_000_000_000_000n),
      getMeta: async (_chain, token) => ({ decimals: token === TOKEN_A ? 6 : 18, symbol: 'X', name: 'X' }) as never,
      getPrice: async () => 1,
    },
  );
  assert.equal(result.status, 'OK', 'total is ~$50,025 — well above MIN_POOL_TVL_USD, even though below the $100,000 DexScreener figure');
  if (result.status === 'OK') {
    assert.ok(Math.abs(result.onchainTvlUsd - 50_025) < 1, `decimals must be applied per-token, not assumed uniform (got ${result.onchainTvlUsd})`);
  }
});
