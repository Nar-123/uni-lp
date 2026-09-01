/**
 * Across Protocol Swap API client — quote + execute crosschain bridge/swap.
 * Docs: https://docs.across.to/api-reference
 * Base: https://app.across.to/api
 *
 * Auth: Authorization: Bearer <ACROSS_API_KEY>
 * Query: integratorId=<ACROSS_INTEGRATOR_ID>
 */
import {
  type Address,
  type Hash,
  type Hex,
  isAddress,
  isHex,
} from 'viem';
import {
  CHAINS,
  type SupportedChainId,
  txUrl,
  isSupportedChainId,
} from '../config.js';
import {
  getAccount,
  getHotWalletAddress,
  getPublicClient,
  getWalletClient,
} from './clients.js';
import { formatUnits } from './tokens.js';
import { sleep } from './retry.js';
import {
  getBridgeAsset,
  getBridgeableBalance,
  type BridgeAsset,
  RELAY_NATIVE,
} from './relay.js';
import { getNativeBalance, GAS_RESERVE_WEI } from './wrap.js';

export const ACROSS_API = 'https://app.across.to/api';

/** Zero address = native gas token (ETH/BNB) on Across Swap API */
export const ACROSS_NATIVE = RELAY_NATIVE;

export function hasAcrossCredentials(): boolean {
  return Boolean(
    process.env.ACROSS_API_KEY?.trim() && process.env.ACROSS_INTEGRATOR_ID?.trim(),
  );
}

function acrossHeaders(): Record<string, string> {
  const key = process.env.ACROSS_API_KEY?.trim();
  if (!key) throw new Error('Missing ACROSS_API_KEY');
  return {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
}

function integratorId(): string {
  const id = process.env.ACROSS_INTEGRATOR_ID?.trim();
  if (!id) throw new Error('Missing ACROSS_INTEGRATOR_ID');
  return id;
}

// ── Response types (subset) ─────────────────────────────────────────────────

export type AcrossTokenRef = {
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  chainId?: number;
};

export type AcrossSwapStep = {
  tokenIn?: AcrossTokenRef;
  tokenOut?: AcrossTokenRef;
  inputAmount?: string;
  outputAmount?: string;
  minOutputAmount?: string;
  maxInputAmount?: string;
  slippage?: number;
  swapProvider?: { name?: string; sources?: string[] };
};

export type AcrossBridgeStep = {
  inputAmount?: string;
  outputAmount?: string;
  tokenIn?: AcrossTokenRef;
  tokenOut?: AcrossTokenRef;
  provider?: string;
  fees?: {
    amount?: string;
    pct?: string;
    token?: AcrossTokenRef;
  };
};

export type AcrossFeeBucket = {
  amount?: string;
  amountUsd?: string;
  pct?: string;
  token?: AcrossTokenRef;
};

export type AcrossApprovalTxn = {
  chainId?: number;
  to?: string;
  data?: string;
};

export type AcrossSwapTx = {
  ecosystem?: string;
  simulationSuccess?: boolean;
  chainId?: number;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
};

export type AcrossQuote = {
  crossSwapType?: string;
  amountType?: string;
  checks?: {
    allowance?: {
      token?: string;
      spender?: string;
      actual?: string;
      expected?: string;
    };
    balance?: {
      token?: string;
      actual?: string;
      expected?: string;
    };
  };
  approvalTxns?: AcrossApprovalTxn[];
  steps?: {
    originSwap?: AcrossSwapStep;
    bridge?: AcrossBridgeStep;
    destinationSwap?: AcrossSwapStep;
  };
  inputToken?: AcrossTokenRef;
  outputToken?: AcrossTokenRef;
  refundToken?: AcrossTokenRef;
  fees?: {
    total?: AcrossFeeBucket;
    totalMax?: AcrossFeeBucket;
    originGas?: AcrossFeeBucket;
  };
  inputAmount?: string;
  maxInputAmount?: string;
  expectedOutputAmount?: string;
  minOutputAmount?: string;
  expectedFillTime?: number;
  swapTx?: AcrossSwapTx;
  quoteExpiryTimestamp?: number;
  id?: string;
  // error shape
  type?: string;
  code?: string;
  status?: number;
  message?: string;
};

export type AcrossDepositStatus = {
  status?: string;
  fillTx?: string;
  fillTxHash?: string;
  depositTxHash?: string;
  depositId?: string | number;
  originChainId?: number;
  destinationChainId?: number;
  depositTxnRef?: string;
  fillTxnRef?: string;
  relayer?: string;
  message?: string;
  error?: string;
};

async function acrossFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = path.startsWith('http')
    ? path
    : `${ACROSS_API}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...acrossHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Across ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = body as AcrossQuote & { error?: string };
    const msg =
      err.message ||
      err.error ||
      (typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : text.slice(0, 200));
    throw new Error(`Across ${res.status}: ${msg}`);
  }
  return body as T;
}

export type GetAcrossQuoteParams = {
  originChainId: SupportedChainId;
  destinationChainId: SupportedChainId;
  inputToken: Address;
  outputToken: Address;
  amount: bigint;
  /** default exactInput */
  tradeType?: 'exactInput' | 'minOutput' | 'exactOutput';
  recipient?: Address;
  depositor?: Address;
  /** slippage as fraction e.g. 0.01 = 1% (Across API) */
  slippage?: number;
};

/**
 * GET /swap/approval — executable quote (approvals + swapTx).
 * Never cache: quotes change every block.
 */
export async function getAcrossQuote(
  params: GetAcrossQuoteParams,
): Promise<AcrossQuote> {
  if (!hasAcrossCredentials()) {
    throw new Error('Across not configured (ACROSS_API_KEY + ACROSS_INTEGRATOR_ID)');
  }
  const depositor = params.depositor ?? getHotWalletAddress();
  const q = new URLSearchParams({
    tradeType: params.tradeType ?? 'exactInput',
    originChainId: String(params.originChainId),
    destinationChainId: String(params.destinationChainId),
    inputToken: params.inputToken,
    outputToken: params.outputToken,
    amount: params.amount.toString(),
    depositor,
    integratorId: integratorId(),
  });
  if (params.recipient) q.set('recipient', params.recipient);
  if (params.slippage != null) q.set('slippage', String(params.slippage));

  const quote = await acrossFetch<AcrossQuote>(`/swap/approval?${q}`);
  if (!quote.swapTx?.to || !quote.swapTx?.data) {
    throw new Error(
      `Across quote missing swapTx: ${quote.message ?? quote.code ?? 'unknown'}`,
    );
  }
  return quote;
}

export async function getAcrossDepositStatus(params: {
  originChainId: number;
  depositTxHash: string;
}): Promise<AcrossDepositStatus> {
  const q = new URLSearchParams({
    originChainId: String(params.originChainId),
    depositTxHash: params.depositTxHash,
    integratorId: integratorId(),
  });
  return acrossFetch<AcrossDepositStatus>(`/deposit/status?${q}`);
}

/** Best-effort output amount (wei string) from Across quote. */
export function acrossOutputAmountRaw(quote: AcrossQuote): bigint {
  const candidates = [
    quote.expectedOutputAmount,
    quote.steps?.destinationSwap?.outputAmount,
    quote.steps?.bridge?.outputAmount,
    quote.minOutputAmount,
  ];
  for (const c of candidates) {
    if (c && /^\d+$/.test(c)) return BigInt(c);
  }
  return 0n;
}

export function acrossOutputDecimals(quote: AcrossQuote, fallback: number): number {
  return (
    quote.outputToken?.decimals ??
    quote.steps?.destinationSwap?.tokenOut?.decimals ??
    quote.steps?.bridge?.tokenOut?.decimals ??
    fallback
  );
}

// ── Execution ───────────────────────────────────────────────────────────────

function asHex(v: unknown, field: string): Hex {
  if (typeof v === 'string' && isHex(v)) return v;
  if (v === undefined || v === null || v === '' || v === '0x') return '0x';
  throw new Error(`Invalid hex for ${field}`);
}

function asAddress(v: unknown, field: string): Address {
  if (typeof v === 'string' && isAddress(v)) return v as Address;
  throw new Error(`Invalid address for ${field}: ${String(v)}`);
}

function asBigInt(v: unknown, fallback = 0n): bigint {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.floor(v));
  if (typeof v === 'string') {
    // accept decimal or hex
    if (/^\d+$/.test(v)) return BigInt(v);
    if (isHex(v)) return BigInt(v);
  }
  return fallback;
}

async function sendAndWait(
  chainId: SupportedChainId,
  tx: { to: Address; data: Hex; value?: bigint; gas?: bigint },
  onProgress?: (msg: string) => void,
): Promise<Hash> {
  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);
  const account = getAccount();

  onProgress?.(`Submitting ${CHAINS[chainId].name} tx…`);
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    ...(tx.gas != null && tx.gas > 0n ? { gas: tx.gas } : {}),
  });
  onProgress?.(`Waiting receipt ${hash.slice(0, 12)}…`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`Tx reverted: ${hash}`);
  }
  return hash;
}

async function pollAcrossFill(
  originChainId: SupportedChainId,
  depositTxHash: Hash,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<AcrossDepositStatus> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const start = Date.now();
  let lastStatus = '';

  while (Date.now() - start < timeoutMs) {
    try {
      const st = await getAcrossDepositStatus({
        originChainId,
        depositTxHash,
      });
      const status = (st.status ?? '').toLowerCase();
      if (status && status !== lastStatus) {
        lastStatus = status;
        opts.onProgress?.(`Across status: ${status}`);
      }
      if (
        status === 'filled' ||
        status === 'complete' ||
        status === 'completed' ||
        status === 'success'
      ) {
        return st;
      }
      if (
        status === 'expired' ||
        status === 'refunded' ||
        status === 'failed' ||
        status === 'failure'
      ) {
        throw new Error(
          `Across deposit ${status}${st.message ? `: ${st.message}` : ''}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Across deposit (expired|refunded|failed|failure)/i.test(msg)) throw e;
      // DepositNotFound early after broadcast is normal — keep polling
      if (!/Deposit not found|DepositNotFound/i.test(msg) && !/Across \d+/.test(msg)) {
        // transient
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Across fill timeout after ${Math.round(timeoutMs / 1000)}s (tx ${depositTxHash})`,
  );
}

export type AcrossExecuteResult = {
  originTxs: { chainId: SupportedChainId; hash: Hash; link: string }[];
  destTxHashes: string[];
  status?: AcrossDepositStatus;
  quote: AcrossQuote;
  depositTxHash?: Hash;
};

/**
 * Execute approvals then swapTx from a fresh Across quote.
 * Polls /deposit/status until filled (cross-chain) or returns after origin confirm (same-chain).
 */
export async function executeAcrossQuote(
  quote: AcrossQuote,
  onProgress?: (msg: string) => void,
): Promise<AcrossExecuteResult> {
  const swapTx = quote.swapTx;
  if (!swapTx?.to || !swapTx?.data) {
    throw new Error('Across quote has no swapTx');
  }

  const originChainRaw = Number(swapTx.chainId ?? quote.inputToken?.chainId);
  if (!isSupportedChainId(originChainRaw)) {
    throw new Error(`Across swap on unsupported chain ${originChainRaw}`);
  }
  const originChainId = originChainRaw;
  const originTxs: AcrossExecuteResult['originTxs'] = [];

  // 1) Approvals first
  for (const ap of quote.approvalTxns ?? []) {
    const cid = Number(ap.chainId ?? originChainId);
    if (!isSupportedChainId(cid)) {
      throw new Error(`Across approval on unsupported chain ${cid}`);
    }
    onProgress?.('Approving token for Across…');
    const hash = await sendAndWait(
      cid,
      {
        to: asAddress(ap.to, 'approval.to'),
        data: asHex(ap.data, 'approval.data'),
        value: 0n,
      },
      onProgress,
    );
    originTxs.push({ chainId: cid, hash, link: txUrl(cid, hash) });
  }

  // 2) Main deposit / swap
  onProgress?.('Submitting Across deposit…');
  const gas = asBigInt(swapTx.gas, 0n);
  const value = asBigInt(swapTx.value, 0n);
  const depositHash = await sendAndWait(
    originChainId,
    {
      to: asAddress(swapTx.to, 'swapTx.to'),
      data: asHex(swapTx.data, 'swapTx.data'),
      value,
      ...(gas > 0n ? { gas } : {}),
    },
    onProgress,
  );
  originTxs.push({
    chainId: originChainId,
    hash: depositHash,
    link: txUrl(originChainId, depositHash),
  });

  const destChain = quote.outputToken?.chainId ?? quote.steps?.bridge?.tokenOut?.chainId;
  const sameChain =
    destChain != null && Number(destChain) === originChainId;

  let status: AcrossDepositStatus | undefined;
  const destTxHashes: string[] = [];

  if (!sameChain) {
    onProgress?.('Waiting for Across fill…');
    status = await pollAcrossFill(originChainId, depositHash, { onProgress });
    const fill =
      status.fillTxHash ||
      status.fillTx ||
      status.fillTxnRef;
    if (fill) destTxHashes.push(fill);
  }

  return {
    originTxs,
    destTxHashes,
    status,
    quote,
    depositTxHash: depositHash,
  };
}

// ── Preview ─────────────────────────────────────────────────────────────────

export type AcrossBridgePreview = {
  provider: 'across';
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  from: BridgeAsset;
  to: BridgeAsset;
  amountIn: bigint;
  quote: AcrossQuote;
  amountInFormatted: string;
  amountOutFormatted: string;
  amountOutRaw: bigint;
  amountOutUsd?: string;
  timeEstimate?: number;
  networkCostUsd?: string;
  feeUsd?: string;
  priceImpactPercent?: string;
  rate?: string;
};

/**
 * Quote an Across trade (cross-chain preferred; same-chain may be unsupported).
 */
export async function previewAcrossTrade(params: {
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<AcrossBridgePreview> {
  if (params.amount <= 0n) throw new Error('Amount must be > 0');
  if (!hasAcrossCredentials()) {
    throw new Error('Across not configured');
  }

  const from = getBridgeAsset(params.fromChain, params.fromSymbol);
  const to = getBridgeAsset(params.toChain, params.toSymbol);

  const bal = await getBridgeableBalance(params.fromChain, from);
  if (params.amount > bal) {
    throw new Error(
      `Insufficient ${from.symbol}: need ${formatUnits(params.amount, from.decimals)}, have ${formatUnits(bal, from.decimals)}` +
        (from.isNative ? ' (gas reserve kept)' : ''),
    );
  }

  if (!from.isNative) {
    const native = await getNativeBalance(params.fromChain);
    if (native < GAS_RESERVE_WEI[params.fromChain] / 2n) {
      throw new Error(
        `Low ${CHAINS[params.fromChain].nativeSymbol} for gas on ${CHAINS[params.fromChain].name}`,
      );
    }
  }

  const quote = await getAcrossQuote({
    originChainId: params.fromChain,
    destinationChainId: params.toChain,
    inputToken: from.address,
    outputToken: to.address,
    amount: params.amount,
    tradeType: 'exactInput',
  });

  const amountOutRaw = acrossOutputAmountRaw(quote);
  const outDecimals = acrossOutputDecimals(quote, to.decimals);
  const feeUsd = quote.fees?.total?.amountUsd;
  const networkCostUsd = quote.fees?.originGas?.amountUsd;

  // fee pct is often 1e18-scaled (e.g. 52454657753379021 ≈ 5.24%)
  let priceImpactPercent: string | undefined;
  const pct = quote.fees?.total?.pct;
  if (pct && /^\d+$/.test(pct)) {
    const n = Number(BigInt(pct)) / 1e16; // → percent points
    if (Number.isFinite(n)) priceImpactPercent = (-Math.abs(n)).toFixed(2);
  }

  let rate: string | undefined;
  if (amountOutRaw > 0n && params.amount > 0n) {
    // human rate out/in
    const inHuman = Number(formatUnits(params.amount, from.decimals));
    const outHuman = Number(formatUnits(amountOutRaw, outDecimals));
    if (inHuman > 0 && Number.isFinite(outHuman / inHuman)) {
      rate = (outHuman / inHuman).toPrecision(6);
    }
  }

  return {
    provider: 'across',
    fromChain: params.fromChain,
    toChain: params.toChain,
    from,
    to,
    amountIn: params.amount,
    quote,
    amountInFormatted: formatUnits(params.amount, from.decimals),
    amountOutFormatted:
      amountOutRaw > 0n ? formatUnits(amountOutRaw, outDecimals) : '?',
    amountOutRaw,
    amountOutUsd: feeUsd != null ? undefined : undefined,
    timeEstimate: quote.expectedFillTime,
    networkCostUsd,
    feeUsd,
    priceImpactPercent,
    rate,
  };
}
