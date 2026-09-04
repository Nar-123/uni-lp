/**
 * Phase 4.7 audit (F-08), V4-specific counterpart to
 * chain.pools.onchainReserves.test.ts.
 *
 * V4 deliberately does NOT get the same balanceOf-based reserve check as
 * V3 (see verifyV4PoolHasLiquidity's doc comment in src/chain/v4.ts for
 * why — the singleton PoolManager holds every pool's funds together, so
 * there is no per-pool ERC20 balance to read, and no existing, tested
 * formula in this codebase converts StateView's tick-range liquidity units
 * into a true USD TVL without inventing one). This suite only covers the
 * narrower, non-invented check this codebase actually implements: does the
 * pool currently carry any active liquidity at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyV4Liquidity, verifyV4PoolHasLiquidity } from '../src/chain/v4.js';

const CHAIN = 4663;
const POOL_ID = ('0x' + '11'.repeat(32)) as `0x${string}`;

test('positive liquidity -> OK', () => {
  const result = classifyV4Liquidity(206_873_831_779_643n);
  assert.equal(result.status, 'OK');
  if (result.status === 'OK') assert.equal(result.liquidity, 206_873_831_779_643n);
});

test('zero liquidity (drained/never-active pool) -> TVL_MISMATCH', () => {
  const result = classifyV4Liquidity(0n);
  assert.equal(result.status, 'TVL_MISMATCH');
});

test('liquidity of exactly 1 (smallest possible positive unit) still passes — no invented minimum magnitude beyond "nonzero"', () => {
  const result = classifyV4Liquidity(1n);
  assert.equal(result.status, 'OK');
});

// ── verifyV4PoolHasLiquidity (RPC-fetching wrapper), via injected client ──

test('V4 RPC error: StateView.getLiquidity throws -> ONCHAIN_VALIDATION_ERROR, never fabricated as TVL_MISMATCH', async () => {
  const result = await verifyV4PoolHasLiquidity(CHAIN, POOL_ID, {
    readContract: async () => {
      throw new Error('RPC timeout');
    },
  });
  assert.equal(result.status, 'ONCHAIN_VALIDATION_ERROR');
});

test('V4 valid liquidity via wrapper: injected client returning a positive liquidity value -> OK', async () => {
  const result = await verifyV4PoolHasLiquidity(CHAIN, POOL_ID, {
    readContract: async () => 206_873_831_779_643n,
  });
  assert.equal(result.status, 'OK');
});

test('V4 zero liquidity via wrapper: injected client returning 0n -> TVL_MISMATCH', async () => {
  const result = await verifyV4PoolHasLiquidity(CHAIN, POOL_ID, {
    readContract: async () => 0n,
  });
  assert.equal(result.status, 'TVL_MISMATCH');
});

test('V4 malformed response: injected client returning undefined fails closed as ONCHAIN_VALIDATION_ERROR, never OK', async () => {
  // Regression test: `undefined <= 0n` evaluates to `false` in JS (not an
  // error), so a naive `liquidity <= 0n` check alone would silently fall
  // through to `{ status: 'OK', liquidity: undefined }` for any malformed,
  // non-bigint RPC response. classifyV4Liquidity must validate the type
  // first — found and fixed during this same audit.
  const result = await verifyV4PoolHasLiquidity(CHAIN, POOL_ID, {
    readContract: async () => undefined,
  });
  assert.equal(result.status, 'ONCHAIN_VALIDATION_ERROR');
});

test('classifyV4Liquidity: a non-bigint input (e.g. a string, or null) fails closed rather than being coerced', () => {
  assert.equal(classifyV4Liquidity('5' as unknown).status, 'ONCHAIN_VALIDATION_ERROR');
  assert.equal(classifyV4Liquidity(null).status, 'ONCHAIN_VALIDATION_ERROR');
  assert.equal(classifyV4Liquidity(NaN).status, 'ONCHAIN_VALIDATION_ERROR');
});
