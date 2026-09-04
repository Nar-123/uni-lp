/**
 * Phase 4.7 audit (F-09) — V3 automated pool discovery must verify the
 * candidate pool address against the chain-specific v3 factory rather than
 * trusting DexScreener's pairAddress outright.
 *
 * isFactoryVerifiedPool is the pure comparison extracted from
 * listV3PoolsForToken (same split as F-08's classifyOnChainReserves) so the
 * security-critical decision is directly unit-testable.
 *
 * resolvePoolFromFactory (the actual function listV3PoolsForToken calls)
 * now also accepts an injectable client, mirroring the same pattern just
 * added for F-08's verifyOnChainPoolReserves/verifyV4PoolHasLiquidity — this
 * proves the RPC-failure fail-closed path deterministically.
 *
 * listV3PoolsForToken/listPoolsForToken themselves (the full integration,
 * including fetchV3PoolsForToken and dedup) are still not independently
 * injectable — they own their own client/fetcher construction internally —
 * so that full end-to-end path (as opposed to resolvePoolFromFactory's own
 * RPC-failure handling, which IS what runs inside its try/catch) is covered
 * instead by the live read-only validation, matching this codebase's
 * existing precedent for not unit-testing real-network chain calls (see
 * strategy.multiExecute.test.ts's docstring re: the mint happy path).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFactoryVerifiedPool, resolvePoolFromFactory } from '../src/chain/pools.js';
import { CHAINS, resolveV3Contracts } from '../src/config.js';

const CHAIN = 8453;
const TOKEN_A = '0x00000000000000000000000000000000000002' as `0x${string}`;
const TOKEN_B = '0x00000000000000000000000000000000000003' as `0x${string}`;
const FEE = 500;

const REAL_POOL = '0x2E7bA084e848fB5Af806eFAeCCFc9676A1a4C459';
const DIFFERENT_REAL_POOL = '0x929336C20682221f87b282E5626572a761A5f494';

// A. correct factory pool
test('A. factory returns the exact candidate address -> verified', () => {
  assert.equal(isFactoryVerifiedPool(REAL_POOL, REAL_POOL), true);
});

test('A. verification is case-insensitive (on-chain addresses are often lowercase)', () => {
  assert.equal(isFactoryVerifiedPool(REAL_POOL.toLowerCase(), REAL_POOL.toUpperCase()), true);
});

// B. wrong pool address / C. fake pool implementing expected methods —
// both collapse to the same outcome: the factory's real answer does not
// match the address being checked.
test('B/C. factory returns a DIFFERENT real pool than the candidate address -> not verified (catches both a wrong address and a fake/spoofed contract impersonating the interface)', () => {
  assert.equal(isFactoryVerifiedPool(DIFFERENT_REAL_POOL, REAL_POOL), false);
});

// D/E. wrong fee or wrong token pair reported by a fake contract — from
// this function's perspective these also show up as "factory result !=
// candidate address" (resolvePoolFromFactory was called with whatever the
// fake contract claimed, and the genuine canonical pool for that claim is
// never the fake's own address).
test('D/E. any mismatch between what the factory resolves and the candidate address is rejected, regardless of which field caused it', () => {
  assert.equal(isFactoryVerifiedPool(DIFFERENT_REAL_POOL, REAL_POOL), false);
});

// I. zero address / no pool found
test('I. factory returns null (no pool for that token/fee combination, or zero address already normalized to null upstream) -> not verified', () => {
  assert.equal(isFactoryVerifiedPool(null, REAL_POOL), false);
});

// F. wrong chain factory — config-level chain-awareness, not this function,
// but this is the guarantee the whole check depends on.
test('F. each supported chain has its own distinct, explicitly configured v3 factory — never assumed to be the same across chains', () => {
  const f4663 = resolveV3Contracts(4663, 'uniswap').factory;
  const f56 = resolveV3Contracts(56, 'uniswap').factory;
  const f8453 = resolveV3Contracts(8453, 'uniswap').factory;
  assert.notEqual(f4663.toLowerCase(), f56.toLowerCase());
  assert.notEqual(f4663.toLowerCase(), f8453.toLowerCase());
  assert.notEqual(f56.toLowerCase(), f8453.toLowerCase());
  assert.equal(f4663.toLowerCase(), CHAINS[4663].factory.toLowerCase());
});

test('F. PancakeSwap V3 factory is only available where explicitly configured (BSC) and fails closed (throws) elsewhere rather than falling back to a Uniswap factory', () => {
  assert.doesNotThrow(() => resolveV3Contracts(56, 'pancakeswap'));
  assert.throws(() => resolveV3Contracts(4663, 'pancakeswap'));
  assert.throws(() => resolveV3Contracts(8453, 'pancakeswap'));
});

// J. duplicate pool candidate — the address-equality check itself is a
// pure function of its two string inputs; two identical candidates simply
// both verify true or both verify false, deterministically. Actual dedup
// (Set-keyed on poolAddress+dex) is pre-existing, unmodified code in
// listV3PoolsForToken, not part of this fix.
test('J. the comparison is a pure function of its inputs — identical inputs always produce identical (deterministic) verdicts', () => {
  const a = isFactoryVerifiedPool(REAL_POOL, REAL_POOL);
  const b = isFactoryVerifiedPool(REAL_POOL, REAL_POOL);
  assert.equal(a, b);
  assert.equal(a, true);
});

// ── resolvePoolFromFactory (RPC-fetching wrapper), via injected client ────

test('G. factory RPC failure (readContract throws) propagates as a real error — the caller (listV3PoolsForToken) treats any thrown error as fail-closed/skip, never as "no pool"', async () => {
  await assert.rejects(
    () =>
      resolvePoolFromFactory(CHAIN, TOKEN_A, TOKEN_B, FEE, 'uniswap', {
        readContract: async () => {
          throw new Error('RPC timeout');
        },
      }),
    /RPC timeout/,
  );
});

test('A (via wrapper). factory returns the exact candidate address -> resolved, verified true', async () => {
  const REAL = '0x00000000000000000000000000000000000099' as `0x${string}`;
  const factoryResult = await resolvePoolFromFactory(CHAIN, TOKEN_A, TOKEN_B, FEE, 'uniswap', {
    readContract: async () => REAL,
  });
  assert.equal(factoryResult, REAL);
  assert.equal(isFactoryVerifiedPool(factoryResult, REAL), true);
});

test('I (via wrapper). factory returns the zero address (no pool exists for this token/fee combination) -> null, never treated as verified', async () => {
  const factoryResult = await resolvePoolFromFactory(CHAIN, TOKEN_A, TOKEN_B, FEE, 'uniswap', {
    readContract: async () => '0x0000000000000000000000000000000000000000',
  });
  assert.equal(factoryResult, null);
  assert.equal(isFactoryVerifiedPool(factoryResult, '0x00000000000000000000000000000000000099'), false);
});

test('D/E (via wrapper). a different real pool returned for a mismatched fee/token-pair claim -> resolved but fails verification against the candidate address', async () => {
  const CANDIDATE = '0x00000000000000000000000000000000000099' as `0x${string}`;
  const GENUINE_DIFFERENT_POOL = '0x00000000000000000000000000000000000077' as `0x${string}`;
  const factoryResult = await resolvePoolFromFactory(CHAIN, TOKEN_A, TOKEN_B, FEE, 'uniswap', {
    readContract: async () => GENUINE_DIFFERENT_POOL,
  });
  assert.equal(isFactoryVerifiedPool(factoryResult, CANDIDATE), false);
});
