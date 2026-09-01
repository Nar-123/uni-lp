/**
 * Phase 1 capital-safety invariants.
 *
 * Core principle: UNKNOWN !== ZERO, UNKNOWN !== VALID, UNKNOWN !== SAFE.
 * When critical information (price, quote, ownership, position state,
 * simulation) cannot be verified, callers must ABORT — never fall back to
 * a zero-protection value or assume a best case.
 *
 * These helpers are intentionally pure / dependency-free so they can be
 * unit tested without an RPC connection — see test/safety.test.ts.
 */

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

/** Automated swap invariant: minOut must be a positive, real protection floor. */
export function requirePositiveMinOut(minOut: bigint, context: string): bigint {
  if (minOut <= 0n) {
    throw new SafetyError(
      `[safety] ${context}: minOut must be > 0 — refusing to send an unprotected swap`,
    );
  }
  return minOut;
}

/** Automated close/decrease invariant: at least one side's minimum must be enforced when expected. */
export function requirePositiveWithdrawalFloor(params: {
  amount0Min: bigint;
  amount1Min: bigint;
  expected0: bigint;
  expected1: bigint;
  context: string;
}): void {
  const { amount0Min, amount1Min, expected0, expected1, context } = params;
  if (expected0 > 0n && amount0Min <= 0n) {
    throw new SafetyError(
      `[safety] ${context}: amount0Min must be > 0 when expected0=${expected0} — refusing unprotected withdrawal`,
    );
  }
  if (expected1 > 0n && amount1Min <= 0n) {
    throw new SafetyError(
      `[safety] ${context}: amount1Min must be > 0 when expected1=${expected1} — refusing unprotected withdrawal`,
    );
  }
}

/** UNKNOWN price must not become a valid input to a trading decision. */
export function requireKnownPrice(
  price: number | null | undefined,
  context: string,
): number {
  if (price == null || !Number.isFinite(price) || price <= 0) {
    throw new SafetyError(`[safety] ${context}: price unknown/invalid — aborting`);
  }
  return price;
}

/** UNKNOWN quote/estimate must not become a valid input to a trading decision. */
export function requireKnownAmount(
  amount: bigint | null | undefined,
  context: string,
): bigint {
  if (amount == null || amount <= 0n) {
    throw new SafetyError(`[safety] ${context}: amount unknown/zero — aborting`);
  }
  return amount;
}

/**
 * Floor `amount` by a slippage tolerance in basis points (0-10000).
 * Pure integer math — no float precision loss on-chain amounts.
 */
export function computeMinWithSlippage(amount: bigint, slippageBps: number): bigint {
  if (amount <= 0n) return 0n;
  const bps = Math.max(0, Math.min(10_000, Math.round(slippageBps)));
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Single, non-degrading minOut for a swap: derived once from a fresh
 * positive quote. Never returns 0 for a positive estimate, and never
 * offers a caller a "try weaker protection" fallback list.
 */
export function computeSwapMinOut(params: {
  estimatedOut: bigint;
  slippageBps: number;
  context: string;
}): bigint {
  const estimatedOut = requireKnownAmount(params.estimatedOut, `${params.context} quote`);
  const minOut = computeMinWithSlippage(estimatedOut, params.slippageBps);
  return requirePositiveMinOut(minOut, params.context);
}

export type WithdrawalMins = { amount0Min: bigint; amount1Min: bigint };

/**
 * Minimum acceptable withdrawal amounts for a close/decrease-liquidity call,
 * derived from the current expected amounts (computed from live liquidity +
 * live pool price) with a bounded slippage tolerance.
 *
 * A side with a genuinely zero expected amount (single-sided position) keeps
 * a zero minimum on that side — that is a SAFE zero, not a fallback. A side
 * with a positive expected amount always gets a positive minimum.
 */
export function computeWithdrawalMins(params: {
  expected0: bigint;
  expected1: bigint;
  slippageBps: number;
  context: string;
}): WithdrawalMins {
  const { expected0, expected1, slippageBps, context } = params;
  if (expected0 < 0n || expected1 < 0n) {
    throw new SafetyError(`[safety] ${context}: negative expected amount — aborting`);
  }
  const amount0Min = computeMinWithSlippage(expected0, slippageBps);
  const amount1Min = computeMinWithSlippage(expected1, slippageBps);
  requirePositiveWithdrawalFloor({
    amount0Min,
    amount1Min,
    expected0,
    expected1,
    context,
  });
  return { amount0Min, amount1Min };
}

/** Default bounded slippage tolerance for automated close/decrease-liquidity withdrawals. */
export const CLOSE_SLIPPAGE_BPS = 1000; // 10%

/**
 * How much worse (positive) or better (negative) the ACTUAL received amount
 * was vs the pre-trade ESTIMATE, in basis points of the estimate.
 *
 * This is the metric Phase 2 telemetry records per trade so a future pass
 * can data-drive the flat slippage constants (DEFAULT_SWAP_SLIPPAGE_BPS,
 * CLOSE_SLIPPAGE_BPS, etc.) from real fill history instead of guessing —
 * e.g. "for pools with >$50k liquidity, realized slippage never exceeded
 * 180bps across N trades" would justify tightening that bucket's bound.
 * Returns null when there's nothing meaningful to compare (no estimate, or
 * actual wasn't measurable).
 */
export function computeRealizedSlippageBps(
  estimatedRaw: bigint,
  actualRaw: bigint | null,
): number | null {
  if (estimatedRaw <= 0n || actualRaw == null || actualRaw < 0n) return null;
  const diff = estimatedRaw - actualRaw; // positive = received less than estimated
  return Number((diff * 10_000n) / estimatedRaw);
}

/**
 * Classify an `ownerOf`-style revert message.
 *
 * 'gone' — the contract explicitly reverted with a "no such token" error
 *   (ERC721 nonexistent-token style). This is a confirmed, permanent state:
 *   the NFT was burned or never minted. Safe to treat as "not owned".
 *
 * 'unknown' — anything else (RPC timeout, rate limit, network error, an
 *   unrecognized revert reason). Ownership could not be verified — callers
 *   MUST fail closed (rethrow / abort) rather than assume not-owned OR
 *   assume still-owned.
 */
export function classifyOwnershipError(message: string): 'gone' | 'unknown' {
  return /ERC721.*nonexistent|invalid token ?id|nonexistent token|NOT_MINTED/i.test(message)
    ? 'gone'
    : 'unknown';
}

/**
 * Is valueUsd/unclaimedFeesUsd for a position trustworthy for an automated
 * decision? A side with a genuinely zero amount doesn't need a known price
 * (0 * unknown is still 0) — but a side with a nonzero amount does; a
 * missing price there means the computed USD value is UNKNOWN, not $0.
 */
export function priceCompleteFor(params: {
  amount0: number;
  amount1: number;
  p0: number | null | undefined;
  p1: number | null | undefined;
}): boolean {
  const { amount0, amount1, p0, p1 } = params;
  return (amount0 === 0 || (p0 != null && p0 > 0)) && (amount1 === 0 || (p1 != null && p1 > 0));
}

/**
 * Canonical "amount actually received from this operation" resolver.
 *
 * Never sweep/unwrap the wallet's pre-existing balance — only the delta
 * produced by the operation being accounted for (e.g. this swap's output).
 * Prefers the observed balance delta; falls back to a quoted/estimated
 * amount only when the delta can't be measured (e.g. a snapshot miss),
 * and even then never returns more than what's actually available now.
 */
export function resolveReceivedAmount(params: {
  balanceBefore: bigint;
  balanceAfter: bigint;
  fallbackEstimate?: bigint;
}): bigint {
  const { balanceBefore, balanceAfter, fallbackEstimate = 0n } = params;
  if (balanceAfter > balanceBefore) {
    return balanceAfter - balanceBefore;
  }
  if (fallbackEstimate > 0n) {
    return fallbackEstimate < balanceAfter ? fallbackEstimate : balanceAfter;
  }
  return 0n;
}
