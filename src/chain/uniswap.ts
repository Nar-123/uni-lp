/**
 * Uniswap SDK ESM builds break under Node (directory imports).
 * Load via createRequire (CJS) for runtime compatibility.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const v3Sdk = require('@uniswap/v3-sdk') as typeof import('@uniswap/v3-sdk');
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const v4Sdk = require('@uniswap/v4-sdk') as typeof import('@uniswap/v4-sdk');
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const sdkCore = require('@uniswap/sdk-core') as typeof import('@uniswap/sdk-core');

export const {
  nearestUsableTick,
  TickMath,
  Pool,
  Position,
  FeeAmount,
  TICK_SPACINGS,
  tickToPrice,
  priceToClosestTick,
  encodeSqrtRatioX96,
} = v3Sdk;

export const {
  Pool: V4Pool,
  Position: V4Position,
  V4PositionManager,
} = v4Sdk;

export const { Token, Percent, Ether } = sdkCore;

/**
 * PancakeSwap V3 medium fee = 2500 (0.25%), tick spacing 50.
 * Uniswap SDK TICK_SPACINGS only knows Uniswap tiers; without this patch
 * Pool/Position math fails for PCS 0.25% pools (tickSpacing undefined).
 * https://developer.pancakeswap.finance/sdks/v3-sdk
 */
if (TICK_SPACINGS[2500 as keyof typeof TICK_SPACINGS] == null) {
  (TICK_SPACINGS as Record<number, number>)[2500] = 50;
}
