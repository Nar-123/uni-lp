/**
 * Uniswap Trading API client — multi-hop v2/v3/v4 best-route swaps.
 * https://trade-api.gateway.uniswap.org/v1
 *
 * Backend hot-wallet flow:
 *   1. POST /check_approval  → broadcast approval if needed
 *   2. POST /quote           → CLASSIC route preferred
 *   3. POST /swap            → sign Permit2 if present → broadcast
 */
import {
  type Address,
  type Hash,
  type Hex,
  isAddress,
  isHex,
} from 'viem';
import { type SupportedChainId, txUrl } from '../config.js';
import {
  getHotWalletAddress,
  getPublicClient,
  getWalletClient,
} from './clients.js';
import { EXECUTION_RECEIPT_TIMEOUT_MS } from './receiptWait.js';

export const TRADING_API_URL = 'https://trade-api.gateway.uniswap.org/v1';

/** Official Universal Router (v2.0) — used only for docs/fallback display */
export const UNIVERSAL_ROUTER: Record<SupportedChainId, Address> = {
  4663: '0x8876789976decbfcbbbe364623c63652db8c0904',
  56: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
  8453: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
};

const NATIVE = '0x0000000000000000000000000000000000000000';

export function hasTradingApiKey(): boolean {
  return Boolean(process.env.UNISWAP_API_KEY?.trim());
}

function apiKey(): string {
  const k = process.env.UNISWAP_API_KEY?.trim();
  if (!k) throw new Error('Missing UNISWAP_API_KEY');
  return k;
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey(),
    'x-universal-router-version': '2.0',
  };
}

async function tradingFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${TRADING_API_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Trading API ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail =
      typeof json === 'object' && json && 'detail' in json
        ? String((json as { detail: unknown }).detail)
        : typeof json === 'object' && json && 'errorCode' in json
          ? `${(json as { errorCode: unknown }).errorCode}: ${
              (json as { detail?: unknown }).detail ?? text.slice(0, 180)
            }`
          : text.slice(0, 240);
    throw new Error(`Trading API ${path} ${res.status}: ${detail}`);
  }
  return json as T;
}

// ── Types (subset) ──────────────────────────────────────────────────────────

export type TradingTx = {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId?: number;
  gasLimit?: string;
};

type ApprovalResponse = {
  approval: TradingTx | null;
  cancel?: TradingTx | null;
};

type ClassicQuoteBody = {
  routing: 'CLASSIC' | 'WRAP' | 'UNWRAP' | string;
  quote: {
    input?: { token?: string; amount?: string };
    output?: { token?: string; amount?: string };
    route?: unknown[];
    gasFeeUSD?: string;
    gasUseEstimate?: string;
    slippage?: number;
  };
  permitData?: Record<string, unknown> | null;
  permitTransaction?: unknown;
};

type SwapResponse = {
  swap: TradingTx;
};

export type TradingSwapResult = {
  hash: Hash;
  txLink: string;
  amountIn: bigint;
  amountOutEstimated?: bigint;
  routing: string;
  routeLabel: string;
};

function isUniswapXRouting(routing: string): boolean {
  return (
    routing === 'DUTCH_V2' ||
    routing === 'DUTCH_V3' ||
    routing === 'PRIORITY' ||
    routing === 'DUTCH_LIMIT'
  );
}

function prepareSwapRequest(
  quoteResponse: ClassicQuoteBody,
  signature?: string,
): Record<string, unknown> {
  const { permitData, permitTransaction, ...cleanQuote } = quoteResponse;
  const request: Record<string, unknown> = { ...cleanQuote };

  if (isUniswapXRouting(quoteResponse.routing)) {
    if (signature) request.signature = signature;
    // UniswapX: permitData is for local signing only — never send to /swap
  } else if (signature && permitData && typeof permitData === 'object') {
    request.signature = signature;
    request.permitData = permitData;
  }
  return request;
}

function validateSwapTx(swap: TradingTx): void {
  if (!swap?.data || swap.data === '' || swap.data === '0x') {
    throw new Error('swap.data is empty — quote may have expired');
  }
  if (!isHex(swap.data)) throw new Error('swap.data is not valid hex');
  if (!swap.to || !isAddress(swap.to)) throw new Error('swap.to invalid');
  if (!swap.from || !isAddress(swap.from)) throw new Error('swap.from invalid');
  if (swap.value === undefined || swap.value === null) {
    throw new Error('swap.value missing');
  }
}

async function broadcastTx(
  chainId: SupportedChainId,
  tx: TradingTx,
  gasPad = 1.2,
): Promise<Hash> {
  validateSwapTx(tx);
  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);
  const value = BigInt(tx.value || '0');
  let gas: bigint | undefined;
  if (tx.gasLimit) {
    try {
      const g = BigInt(tx.gasLimit);
      gas = (g * BigInt(Math.round(gasPad * 100))) / 100n;
    } catch {
      /* ignore */
    }
  }
  const sendParams = {
    to: tx.to as Address,
    data: tx.data as Hex,
    value,
    account: wallet.account!,
    chain: wallet.chain,
    ...(gas != null ? { gas } : {}),
  };

  // Simulation must succeed before we broadcast — a dry-run `call` catches
  // a revert without spending gas, instead of learning about it only from
  // a mined-and-failed transaction.
  try {
    await client.call({ to: sendParams.to, data: sendParams.data, value, account: wallet.account });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Trading API tx would revert (simulation failed): ${msg.slice(0, 240)}`);
  }

  const hash = await wallet.sendTransaction(sendParams);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new Error(`Trading API tx reverted: ${hash}`);
  }
  return hash;
}

async function ensureTradingApproval(
  chainId: SupportedChainId,
  token: Address,
  amount: bigint,
): Promise<void> {
  // Native needs no approval
  if (token.toLowerCase() === NATIVE) return;

  const owner = getHotWalletAddress();
  const res = await tradingFetch<ApprovalResponse>('/check_approval', {
    walletAddress: owner,
    token,
    amount: amount.toString(),
    chainId,
  });
  if (!res.approval) return;

  console.log('[tradingApi] sending approval…');
  await broadcastTx(chainId, res.approval, 1.15);
}

function routeLabelFromQuote(q: ClassicQuoteBody): string {
  const hops =
    Array.isArray(q.quote?.route) && q.quote.route.length
      ? `${q.quote.route.length} hop(s)`
      : 'route';
  return `Uniswap API · ${q.routing} · ${hops}`;
}

/**
 * Exact-in swap via Uniswap Trading API (multi-hop v2/v3/v4).
 * Prefer CLASSIC so the hot wallet executes on-chain without UniswapX fillers.
 */
export async function swapViaTradingApi(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Percent 0–100 (API unit). Default 15 for memes. */
  slippagePercent?: number;
}): Promise<TradingSwapResult> {
  const { chainId, tokenIn, tokenOut, amountIn } = params;
  if (amountIn <= 0n) throw new Error('amountIn is 0');
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error('tokenIn === tokenOut');
  }
  if (!hasTradingApiKey()) throw new Error('UNISWAP_API_KEY not set');

  const owner = getHotWalletAddress();
  const slippage =
    params.slippagePercent != null && params.slippagePercent > 0
      ? params.slippagePercent
      : 15;

  await ensureTradingApproval(chainId, tokenIn, amountIn);

  // Prefer CLASSIC; include V2/V3/V4 for best multi-hop coverage
  const quoteBody = {
    swapper: owner,
    tokenIn,
    tokenOut,
    tokenInChainId: String(chainId),
    tokenOutChainId: String(chainId),
    amount: amountIn.toString(),
    type: 'EXACT_INPUT' as const,
    slippageTolerance: slippage,
    protocols: ['V2', 'V3', 'V4'],
    routingPreference: 'CLASSIC' as const,
  };

  console.log(
    `[tradingApi] quote ${tokenIn.slice(0, 10)}…→${tokenOut.slice(0, 10)}… ` +
      `amt=${amountIn} slip=${slippage}% chain=${chainId}`,
  );

  let quote = await tradingFetch<ClassicQuoteBody>('/quote', quoteBody);

  // If API still returns UniswapX, re-quote with BEST_PRICE then reject UX paths
  if (isUniswapXRouting(quote.routing)) {
    console.warn(`[tradingApi] got ${quote.routing}, retrying without UniswapX bias`);
    quote = await tradingFetch<ClassicQuoteBody>('/quote', {
      ...quoteBody,
      routingPreference: 'FASTEST',
    });
  }
  if (isUniswapXRouting(quote.routing)) {
    throw new Error(
      `Trading API returned ${quote.routing} (UniswapX) — bot needs CLASSIC on-chain route`,
    );
  }

  const amountOutEstimated = quote.quote?.output?.amount
    ? BigInt(quote.quote.output.amount)
    : undefined;

  // Max 10% adverse vs market USD (e.g. $100 fair → reject ~$80 quote)
  if (amountOutEstimated != null && amountOutEstimated > 0n) {
    const { assertMaxPriceImpact, MAX_PRICE_IMPACT_BPS } = await import(
      './priceImpact.js'
    );
    try {
      await assertMaxPriceImpact({
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: amountOutEstimated,
        maxImpactBps: MAX_PRICE_IMPACT_BPS,
      });
    } catch (impactErr) {
      // Retry once with BEST_PRICE in case CLASSIC path was thin
      console.warn(
        '[tradingApi] impact reject, retry BEST_PRICE:',
        impactErr instanceof Error ? impactErr.message : impactErr,
      );
      const quote2 = await tradingFetch<ClassicQuoteBody>('/quote', {
        ...quoteBody,
        routingPreference: 'BEST_PRICE',
      });
      if (isUniswapXRouting(quote2.routing)) {
        throw impactErr instanceof Error
          ? impactErr
          : new Error(String(impactErr));
      }
      const out2 = quote2.quote?.output?.amount
        ? BigInt(quote2.quote.output.amount)
        : 0n;
      await assertMaxPriceImpact({
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: out2,
        maxImpactBps: MAX_PRICE_IMPACT_BPS,
      });
      quote = quote2;
    }
  }

  const amountOutFinal = quote.quote?.output?.amount
    ? BigInt(quote.quote.output.amount)
    : amountOutEstimated;

  // Sign Permit2 if present (CLASSIC path)
  let signature: string | undefined;
  const permitData = quote.permitData;
  if (permitData && typeof permitData === 'object') {
    const domain = (permitData as { domain?: unknown }).domain;
    const types = (permitData as { types?: unknown }).types;
    const values =
      (permitData as { values?: unknown }).values ??
      (permitData as { message?: unknown }).message;
    if (domain && types && values) {
      // EIP-712: strip EIP712Domain from types if present (viem handles domain separately)
      const typesObj = { ...(types as Record<string, unknown>) };
      delete typesObj.EIP712Domain;
      const preferred = [
        'PermitSingle',
        'PermitBatch',
        'PermitTransferFrom',
        'PermitBatchTransferFrom',
        'PermitWitnessTransferFrom',
      ];
      const primaryType =
        (permitData as { primaryType?: string }).primaryType ??
        preferred.find((k) => k in typesObj) ??
        Object.keys(typesObj)[0] ??
        'PermitSingle';
      const wallet = getWalletClient(chainId);
      // Trading API returns standard EIP-712; dynamic shape needs loose cast
      signature = await (
        wallet.signTypedData as (args: {
          account: typeof wallet.account;
          domain: object;
          types: Record<string, unknown>;
          primaryType: string;
          message: Record<string, unknown>;
        }) => Promise<Hex>
      )({
        account: wallet.account!,
        domain: domain as object,
        types: typesObj,
        primaryType,
        message: values as Record<string, unknown>,
      });
      console.log('[tradingApi] signed Permit2', primaryType);
    }
  }

  const swapRequest = prepareSwapRequest(quote, signature);
  const swapRes = await tradingFetch<SwapResponse>('/swap', swapRequest);
  if (!swapRes.swap) throw new Error('Trading API /swap returned no swap tx');

  const hash = await broadcastTx(chainId, swapRes.swap, 1.25);
  const label = routeLabelFromQuote(quote);
  console.log(`[tradingApi] ok ${label} tx=${hash}`);

  return {
    hash,
    txLink: txUrl(chainId, hash),
    amountIn,
    amountOutEstimated: amountOutFinal,
    routing: quote.routing,
    routeLabel: label,
  };
}

/** Convenience: swap ERC-20 → chain native (ETH/BNB) via API. */
export async function swapTokenToNativeViaApi(
  chainId: SupportedChainId,
  tokenIn: Address,
  amountIn: bigint,
  slippagePercent = 15,
): Promise<TradingSwapResult> {
  // Use zero address for native out so UR unwraps
  return swapViaTradingApi({
    chainId,
    tokenIn,
    tokenOut: NATIVE as Address,
    amountIn,
    slippagePercent,
  });
}

export function tradingApiConfiguredLabel(): string {
  return hasTradingApiKey()
    ? 'Uniswap Trading API (v2/v3/v4 multi-hop)'
    : 'local SwapRouter02 (v3 only)';
}
