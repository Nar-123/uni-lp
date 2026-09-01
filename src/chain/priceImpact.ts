/**
 * Fair-value price impact checks for swaps (market USD vs quote USD).
 * Reject routes that sell > maxImpactBps worse than spot (default 10%).
 */
import type { Address } from 'viem';
import { CHAINS, type SupportedChainId } from '../config.js';
import { getTokenMeta, humanToFloat } from './tokens.js';
import { getTokenPriceUsd } from '../price/dexscreener.js';

/** Max allowed adverse impact: 10% (quote out ≥ 90% of fair in-value) */
export const MAX_PRICE_IMPACT_BPS = 1000;

const NATIVE = '0x0000000000000000000000000000000000000000';

function priceToken(chainId: SupportedChainId, token: Address): Address {
  if (token.toLowerCase() === NATIVE) return CHAINS[chainId].wrapped;
  return token;
}

export type PriceImpactResult = {
  ok: boolean;
  impactBps: number;
  inUsd: number;
  outUsd: number;
  reason?: string;
};

/**
 * Compare quote amountOut to fair market value of amountIn.
 * Skips check when prices missing or notional dust (&lt; $0.50).
 */
export async function checkPriceImpact(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  maxImpactBps?: number;
}): Promise<PriceImpactResult> {
  const maxBps = params.maxImpactBps ?? MAX_PRICE_IMPACT_BPS;
  const tIn = priceToken(params.chainId, params.tokenIn);
  const tOut = priceToken(params.chainId, params.tokenOut);

  const [metaIn, metaOut, pxIn, pxOut] = await Promise.all([
    getTokenMeta(params.chainId, tIn),
    getTokenMeta(params.chainId, tOut),
    getTokenPriceUsd(params.chainId, tIn),
    getTokenPriceUsd(params.chainId, tOut),
  ]);

  if (pxIn == null || pxOut == null || pxIn <= 0 || pxOut <= 0) {
    return { ok: true, impactBps: 0, inUsd: 0, outUsd: 0, reason: 'no price — skip' };
  }
  if (params.amountIn <= 0n || params.amountOut <= 0n) {
    return {
      ok: false,
      impactBps: 10_000,
      inUsd: 0,
      outUsd: 0,
      reason: 'zero amount',
    };
  }

  const inUsd = humanToFloat(params.amountIn, metaIn.decimals) * pxIn;
  const outUsd = humanToFloat(params.amountOut, metaOut.decimals) * pxOut;

  // Dust: don't block tiny swaps
  if (inUsd < 0.5) {
    return { ok: true, impactBps: 0, inUsd, outUsd, reason: 'dust' };
  }

  // impact = 1 - out/in  (positive = worse than fair)
  const ratio = outUsd / inUsd;
  const impactBps = Math.round((1 - ratio) * 10_000);

  if (impactBps > maxBps) {
    return {
      ok: false,
      impactBps,
      inUsd,
      outUsd,
      reason:
        `Price impact ${(impactBps / 100).toFixed(1)}% exceeds max ${(maxBps / 100).toFixed(0)}% ` +
        `(market ~$${inUsd.toFixed(2)} → quote ~$${outUsd.toFixed(2)}). Try another pool/route.`,
    };
  }

  return { ok: true, impactBps: Math.max(0, impactBps), inUsd, outUsd };
}

export async function assertMaxPriceImpact(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  maxImpactBps?: number;
}): Promise<void> {
  const r = await checkPriceImpact(params);
  if (!r.ok) {
    throw new Error(r.reason ?? 'Price impact too high');
  }
}
