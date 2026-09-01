import { assertOutOfRange, computeSingleSidedRange } from '../chain/ticks.js';

export type MultiRangeResult =
  | { valid: true; tickLower: number; tickUpper: number; side: 'above' | 'below' }
  | { valid: false; rejectedReason: string };

/**
 * Computes a MULTI single-sided range using the existing protocol-correct
 * tick math (computeSingleSidedRange / assertOutOfRange) — never a naive
 * floating-point final tick calculation, and never a second range-computation
 * path. `usdgIsToken0` must reflect the pool's actual token ordering: when
 * USDG is token0, depositing USDG requires a range ABOVE market; when USDG is
 * token1, it requires a range BELOW market. Any tick-math failure (boundary
 * overflow, invalid width, would-require-both-tokens) fails closed.
 */
export function computeMultiRange(params: {
  currentTick: number;
  tickSpacing: number;
  widthPercent: number;
  usdgIsToken0: boolean;
}): MultiRangeResult {
  const { currentTick, tickSpacing, widthPercent, usdgIsToken0 } = params;
  try {
    const { tickLower, tickUpper, side } = computeSingleSidedRange({
      currentTick,
      tickSpacing,
      widthPercent,
      depositIsToken0: usdgIsToken0,
    });
    // Belt-and-suspenders: computeSingleSidedRange already asserts this internally,
    // but MULTI re-checks before trusting the result for risk-gate/dry-run reporting.
    assertOutOfRange({ currentTick, tickLower, tickUpper, depositIsToken0: usdgIsToken0 });
    if (tickLower >= tickUpper) {
      return { valid: false, rejectedReason: 'INVALID_RANGE' };
    }
    return { valid: true, tickLower, tickUpper, side };
  } catch {
    return { valid: false, rejectedReason: 'NOT_SINGLE_SIDED' };
  }
}
