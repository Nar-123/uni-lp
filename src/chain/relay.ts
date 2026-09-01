/**
 * Relay Protocol client — quote + execute bridges and same-chain swaps.
 * API: https://docs.relay.link/references/api/get-quote-v2
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
  primaryStableSymbol,
} from '../config.js';
import {
  getAccount,
  getHotWalletAddress,
  getPublicClient,
  getWalletClient,
} from './clients.js';
import { formatUnits, humanToRaw, parsePercentOfBalance } from './tokens.js';
import { getNativeBalance, getWrappableNative, GAS_RESERVE_WEI } from './wrap.js';
import { sleep } from './retry.js';
import { erc20Abi } from './abis.js';

export const RELAY_API = 'https://api.relay.link';
/** Zero address = native gas token on Relay */
export const RELAY_NATIVE = '0x0000000000000000000000000000000000000000' as Address;

export type BridgeAsset = {
  address: Address;
  symbol: string;
  decimals: number;
  /** true when address is RELAY_NATIVE */
  isNative: boolean;
};

/** Bridgeable assets per chain (stable + native + wrapped). */
export const BRIDGE_ASSETS: Record<SupportedChainId, BridgeAsset[]> = {
  4663: [
    {
      address: RELAY_NATIVE,
      symbol: 'ETH',
      decimals: 18,
      isNative: true,
    },
    {
      address: CHAINS[4663].wrapped,
      symbol: 'WETH',
      decimals: 18,
      isNative: false,
    },
    {
      address: CHAINS[4663].usdg!,
      symbol: 'USDG',
      decimals: 6,
      isNative: false,
    },
  ],
  56: [
    {
      address: RELAY_NATIVE,
      symbol: 'BNB',
      decimals: 18,
      isNative: true,
    },
    {
      address: CHAINS[56].wrapped,
      symbol: 'WBNB',
      decimals: 18,
      isNative: false,
    },
    {
      address: CHAINS[56].usdt!,
      symbol: 'USDT',
      decimals: 18,
      isNative: false,
    },
  ],
  8453: [
    {
      address: RELAY_NATIVE,
      symbol: 'ETH',
      decimals: 18,
      isNative: true,
    },
    {
      address: CHAINS[8453].wrapped,
      symbol: 'WETH',
      decimals: 18,
      isNative: false,
    },
    {
      address: CHAINS[8453].usdc!,
      symbol: 'USDC',
      decimals: 6,
      isNative: false,
    },
  ],
};

/** Suggested destination when picking a same-kind pair. */
export function suggestedDestSymbol(
  fromChain: SupportedChainId,
  fromSymbol: string,
  toChain: SupportedChainId,
): string {
  const map: Record<string, Partial<Record<SupportedChainId, string>>> = {
    USDG: { 56: 'USDT', 8453: 'USDC' },
    USDT: { 4663: 'USDG', 8453: 'USDC' },
    USDC: { 4663: 'USDG', 56: 'USDT' },
    ETH: { 56: 'BNB', 8453: 'ETH', 4663: 'ETH' },
    BNB: { 4663: 'ETH', 8453: 'ETH' },
    WETH: { 56: 'WBNB', 8453: 'WETH', 4663: 'WETH' },
    WBNB: { 4663: 'WETH', 8453: 'WETH' },
  };
  return map[fromSymbol.toUpperCase()]?.[toChain] ?? BRIDGE_ASSETS[toChain][0]!.symbol;
}

export function getBridgeAsset(
  chainId: SupportedChainId,
  symbol: string,
): BridgeAsset {
  const a = BRIDGE_ASSETS[chainId].find(
    (x) => x.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  if (!a) throw new Error(`Unknown bridge asset ${symbol} on chain ${chainId}`);
  return a;
}

export function isBridgeAssetSymbol(chainId: SupportedChainId, symbol: string): boolean {
  return BRIDGE_ASSETS[chainId].some(
    (x) => x.symbol.toUpperCase() === symbol.toUpperCase(),
  );
}

/** Same-chain swap pairs: native ↔ primary stable (also wrapped variants). */
export type SwapPair = {
  fromSymbol: string;
  toSymbol: string;
  /** short button label */
  label: string;
};

export function swapPairs(chainId: SupportedChainId): SwapPair[] {
  const c = CHAINS[chainId];
  const native = c.nativeSymbol; // ETH | BNB
  const wrapped = c.wrappedSymbol; // WETH | WBNB
  // Primary stable per chain (matches depositAssets priority)
  const stable = primaryStableSymbol(chainId);
  return [
    { fromSymbol: native, toSymbol: stable, label: `${native} → ${stable}` },
    { fromSymbol: stable, toSymbol: native, label: `${stable} → ${native}` },
    { fromSymbol: wrapped, toSymbol: stable, label: `${wrapped} → ${stable}` },
    { fromSymbol: stable, toSymbol: wrapped, label: `${stable} → ${wrapped}` },
  ];
}

export function isSwapAssetSymbol(chainId: SupportedChainId, symbol: string): boolean {
  return isBridgeAssetSymbol(chainId, symbol);
}

// ── Quote types (subset of Relay quote/v2) ──────────────────────────────────

export type RelayCurrencyAmount = {
  currency?: {
    chainId?: number;
    address?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
  };
  amount?: string;
  amountFormatted?: string;
  amountUsd?: string;
  minimumAmount?: string;
};

export type RelayFee = {
  amount?: string;
  amountFormatted?: string;
  amountUsd?: string;
  currency?: RelayCurrencyAmount['currency'];
};

export type RelayStepItem = {
  status?: string;
  data?: Record<string, unknown>;
  check?: { endpoint?: string; method?: string };
};

export type RelayStep = {
  id?: string;
  action?: string;
  description?: string;
  kind?: 'transaction' | 'signature' | string;
  requestId?: string;
  items?: RelayStepItem[];
};

export type RelayQuote = {
  steps?: RelayStep[];
  fees?: {
    gas?: RelayFee;
    relayer?: RelayFee;
    relayerGas?: RelayFee;
    relayerService?: RelayFee;
    app?: RelayFee;
  };
  details?: {
    operation?: string;
    timeEstimate?: number;
    currencyIn?: RelayCurrencyAmount;
    currencyOut?: RelayCurrencyAmount;
    totalImpact?: { percent?: string; usd?: string };
    swapImpact?: { percent?: string; usd?: string };
    rate?: string;
  };
  balances?: {
    userBalance?: string;
    requiredToSolve?: string;
  };
};

export type RelayStatus = {
  status?: string;
  inTxHashes?: string[];
  txHashes?: string[];
  originChainId?: number;
  destinationChainId?: number;
  updatedAt?: number;
  failReason?: string;
};

function apiKeyHeaders(): Record<string, string> {
  const key = process.env.RELAY_API_KEY?.trim();
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (key) h['x-api-key'] = key;
  return h;
}

async function relayFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = path.startsWith('http') ? path : `${RELAY_API}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...apiKeyHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Relay ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = body as { message?: string; error?: string; errors?: unknown };
    const msg =
      err.message ||
      err.error ||
      (typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : text.slice(0, 200));
    throw new Error(`Relay ${res.status}: ${msg}`);
  }
  return body as T;
}

export type GetQuoteParams = {
  originChainId: SupportedChainId;
  destinationChainId: SupportedChainId;
  originCurrency: Address;
  destinationCurrency: Address;
  amount: bigint;
  /** default EXACT_INPUT */
  tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
  recipient?: Address;
  slippageBps?: number;
};

export async function getRelayQuote(params: GetQuoteParams): Promise<RelayQuote> {
  const user = getHotWalletAddress();
  const body = {
    user,
    recipient: params.recipient ?? user,
    originChainId: params.originChainId,
    destinationChainId: params.destinationChainId,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency,
    amount: params.amount.toString(),
    tradeType: params.tradeType ?? 'EXACT_INPUT',
    ...(params.slippageBps != null
      ? { slippageTolerance: String(params.slippageBps) }
      : {}),
  };
  return relayFetch<RelayQuote>('/quote/v2', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getRelayStatus(requestId: string): Promise<RelayStatus> {
  const q = new URLSearchParams({ requestId });
  return relayFetch<RelayStatus>(`/intents/status/v3?${q}`);
}

/** Available balance for bridging (native keeps gas reserve). */
export async function getBridgeableBalance(
  chainId: SupportedChainId,
  asset: BridgeAsset,
): Promise<bigint> {
  if (asset.isNative) {
    return getWrappableNative(chainId);
  }
  const client = getPublicClient(chainId);
  return client.readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getHotWalletAddress()],
  });
}

export function resolveBridgeAmount(
  balance: bigint,
  opts: { mode: 'percent' | 'fixed'; percent?: number; fixedHuman?: number; decimals: number },
): bigint {
  if (opts.mode === 'percent') {
    const p = opts.percent ?? 100;
    const amt = parsePercentOfBalance(balance, p);
    if (amt <= 0n) throw new Error('Amount is 0 — fund wallet or pick a lower %');
    return amt;
  }
  const human = opts.fixedHuman ?? 0;
  const amt = humanToRaw(human, opts.decimals);
  if (amt <= 0n) throw new Error('Enter a positive amount');
  if (amt > balance) {
    throw new Error(
      `Need ${human} but only ~${formatUnits(balance, opts.decimals)} available`,
    );
  }
  return amt;
}

// ── Step execution ──────────────────────────────────────────────────────────

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
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return fallback;
}

function extractRequestId(quote: RelayQuote, steps: RelayStep[]): string | undefined {
  for (const step of steps) {
    if (step.requestId) return step.requestId;
    for (const item of step.items ?? []) {
      const ep = item.check?.endpoint;
      if (ep) {
        const m = /requestId=([^&]+)/.exec(ep);
        if (m?.[1]) return m[1];
      }
    }
  }
  return undefined;
}

async function executeTransactionItem(
  item: RelayStepItem,
  onProgress?: (msg: string) => void,
): Promise<{ hash: Hash; chainId: SupportedChainId }> {
  const data = item.data ?? {};
  const chainIdRaw = Number(data.chainId);
  if (!isSupportedChainId(chainIdRaw)) {
    throw new Error(`Relay step on unsupported chain ${chainIdRaw}`);
  }
  const chainId = chainIdRaw;
  const to = asAddress(data.to, 'to');
  const value = asBigInt(data.value, 0n);
  const txData = asHex(data.data, 'data');
  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);
  const account = getAccount();

  onProgress?.(`Submitting ${CHAINS[chainId].name} tx…`);

  const gas = data.gas != null ? asBigInt(data.gas) : undefined;
  const maxFeePerGas =
    data.maxFeePerGas != null ? asBigInt(data.maxFeePerGas) : undefined;
  const maxPriorityFeePerGas =
    data.maxPriorityFeePerGas != null ? asBigInt(data.maxPriorityFeePerGas) : undefined;
  const gasPrice = data.gasPrice != null ? asBigInt(data.gasPrice) : undefined;

  // Build params without mixing legacy gasPrice + EIP-1559 fields (viem discriminated union)
  const base = {
    account,
    chain: wallet.chain,
    to,
    data: txData,
    value,
    ...(gas != null && gas > 0n ? { gas } : {}),
  } as const;

  const hash =
    maxFeePerGas != null && maxFeePerGas > 0n
      ? await wallet.sendTransaction({
          ...base,
          maxFeePerGas,
          ...(maxPriorityFeePerGas != null && maxPriorityFeePerGas > 0n
            ? { maxPriorityFeePerGas }
            : {}),
        })
      : gasPrice != null && gasPrice > 0n
        ? await wallet.sendTransaction({
            ...base,
            gasPrice,
          })
        : await wallet.sendTransaction(base);

  onProgress?.(`Waiting receipt ${hash.slice(0, 12)}…`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`Tx reverted: ${hash}`);
  }
  return { hash, chainId };
}

async function executeSignatureItem(
  item: RelayStepItem,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const data = item.data ?? {};
  const sign = data.sign as Record<string, unknown> | undefined;
  const post = data.post as
    | { endpoint?: string; method?: string; body?: Record<string, unknown> }
    | undefined;
  if (!sign || !post?.endpoint) {
    throw new Error('Signature step missing sign/post data');
  }

  const account = getAccount();
  const kind = String(sign.signatureKind ?? '').toLowerCase();
  let signature: Hex;

  if (kind === 'eip191') {
    const message = sign.message;
    if (typeof message !== 'string') throw new Error('eip191 missing message');
    onProgress?.('Signing message…');
    // Prefer chain that owns the wallet — use origin from domain if present, else RH
    const wallet = getWalletClient(4663);
    signature = await wallet.signMessage({
      account,
      message: message.startsWith('0x') && isHex(message)
        ? { raw: message as Hex }
        : message,
    });
  } else if (kind === 'eip712') {
    const domain = sign.domain as Record<string, unknown>;
    const types = sign.types as Record<string, { name: string; type: string }[]>;
    const primaryType = String(sign.primaryType ?? '');
    const message = (sign.value ?? sign.message) as Record<string, unknown>;
    if (!domain || !types || !primaryType || !message) {
      throw new Error('eip712 missing domain/types/value');
    }
    const chainId =
      typeof domain.chainId === 'number'
        ? domain.chainId
        : Number(domain.chainId ?? 4663);
    const cid = isSupportedChainId(chainId) ? chainId : 4663;
    const wallet = getWalletClient(cid);
    onProgress?.('Signing typed data…');
    // strip EIP712Domain from types if present (viem adds it)
    const { EIP712Domain: _d, ...typesNoDomain } = types as Record<
      string,
      { name: string; type: string }[]
    >;
    signature = await wallet.signTypedData({
      account,
      domain: domain as {
        name?: string;
        version?: string;
        chainId?: number;
        verifyingContract?: Address;
      },
      types: typesNoDomain,
      primaryType,
      message,
    });
  } else {
    throw new Error(`Unsupported signatureKind: ${kind || 'unknown'}`);
  }

  const endpoint = post.endpoint.startsWith('http')
    ? post.endpoint
    : `${RELAY_API}${post.endpoint.startsWith('/') ? '' : '/'}${post.endpoint}`;
  const method = (post.method ?? 'POST').toUpperCase();
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${sep}signature=${encodeURIComponent(signature)}`;

  onProgress?.('Submitting signature…');
  await relayFetch(url, {
    method,
    body: method === 'GET' ? undefined : JSON.stringify(post.body ?? {}),
  });
}

async function pollCheck(
  check: { endpoint?: string; method?: string } | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; onProgress?: (msg: string) => void } = {},
): Promise<RelayStatus | null> {
  if (!check?.endpoint) return null;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 1500;
  const start = Date.now();
  let lastStatus = '';

  while (Date.now() - start < timeoutMs) {
    const path = check.endpoint.startsWith('http')
      ? check.endpoint
      : check.endpoint.startsWith('/')
        ? check.endpoint
        : `/${check.endpoint}`;
    try {
      const st = await relayFetch<RelayStatus>(path, {
        method: (check.method ?? 'GET').toUpperCase(),
      });
      const status = (st.status ?? '').toLowerCase();
      if (status && status !== lastStatus) {
        lastStatus = status;
        opts.onProgress?.(`Status: ${status}`);
      }
      if (
        status === 'success' ||
        status === 'completed' ||
        status === 'complete' ||
        status === 'filled'
      ) {
        return st;
      }
      if (
        status === 'failure' ||
        status === 'failed' ||
        status === 'refund' ||
        status === 'refunded'
      ) {
        throw new Error(
          `Bridge ${status}${st.failReason ? `: ${st.failReason}` : ''}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // only rethrow terminal failures; network blips retry
      if (/Bridge (failure|failed|refund)/i.test(msg)) throw e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Bridge status timeout after ${Math.round(timeoutMs / 1000)}s`);
}

export type BridgeExecuteResult = {
  requestId?: string;
  originTxs: { chainId: SupportedChainId; hash: Hash; link: string }[];
  destTxHashes: string[];
  status?: RelayStatus;
  quote: RelayQuote;
};

/**
 * Execute all steps from a fresh quote (approve → deposit / signatures).
 * Polls Relay until destination fill succeeds.
 */
export async function executeRelayQuote(
  quote: RelayQuote,
  onProgress?: (msg: string) => void,
): Promise<BridgeExecuteResult> {
  const steps = quote.steps ?? [];
  if (!steps.length) throw new Error('Quote has no steps');

  const requestId = extractRequestId(quote, steps);
  const originTxs: BridgeExecuteResult['originTxs'] = [];
  let lastCheck: { endpoint?: string; method?: string } | undefined;

  for (const step of steps) {
    const items = step.items ?? [];
    if (!items.length) continue;
    onProgress?.(step.description ?? step.action ?? step.id ?? 'step');

    for (const item of items) {
      if ((item.status ?? '').toLowerCase() === 'complete') continue;
      const kind = (step.kind ?? '').toLowerCase();

      if (kind === 'transaction') {
        const { hash, chainId } = await executeTransactionItem(item, onProgress);
        originTxs.push({ chainId, hash, link: txUrl(chainId, hash) });
        if (item.check) lastCheck = item.check;
        // For approve, wait for local receipt is enough; deposit needs solver poll
        if (step.id === 'deposit' || step.id === 'swap' || step.id === 'send') {
          if (item.check) {
            onProgress?.('Waiting for Relay fill…');
            await pollCheck(item.check, { onProgress });
          }
        }
      } else if (kind === 'signature') {
        await executeSignatureItem(item, onProgress);
        if (item.check) {
          lastCheck = item.check;
          onProgress?.('Waiting for Relay fill…');
          await pollCheck(item.check, { onProgress });
        }
      } else {
        throw new Error(`Unsupported Relay step kind: ${step.kind}`);
      }
    }
  }

  let status: RelayStatus | undefined;
  if (requestId) {
    try {
      status = await getRelayStatus(requestId);
      if (!['success', 'completed', 'complete', 'filled'].includes(
        (status.status ?? '').toLowerCase(),
      )) {
        // final poll if not done
        status =
          (await pollCheck(
            { endpoint: `/intents/status/v3?requestId=${requestId}`, method: 'GET' },
            { onProgress, timeoutMs: 120_000 },
          )) ?? status;
      }
    } catch {
      /* optional final status */
    }
  } else if (lastCheck) {
    status = (await pollCheck(lastCheck, { onProgress })) ?? undefined;
  }

  return {
    requestId,
    originTxs,
    destTxHashes: status?.txHashes ?? [],
    status,
    quote,
  };
}

export type BridgePreview = {
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  from: BridgeAsset;
  to: BridgeAsset;
  amountIn: bigint;
  quote: RelayQuote;
  amountInFormatted: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  /** seconds */
  timeEstimate?: number;
  /** origin gas fee USD (network cost) */
  networkCostUsd?: string;
  /** relayer / service fee USD */
  feeUsd?: string;
  /** totalImpact.percent from Relay, e.g. "-0.51" */
  priceImpactPercent?: string;
  rate?: string;
};

/**
 * Quote a Relay trade: cross-chain bridge or same-chain swap.
 * Pass equal chain ids for native↔stable (and wrapped) swaps.
 */
export async function previewRelayTrade(params: {
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<BridgePreview> {
  if (params.amount <= 0n) throw new Error('Amount must be > 0');

  const from = getBridgeAsset(params.fromChain, params.fromSymbol);
  const to = getBridgeAsset(params.toChain, params.toSymbol);

  // Sanity: balance
  const bal = await getBridgeableBalance(params.fromChain, from);
  if (params.amount > bal) {
    throw new Error(
      `Insufficient ${from.symbol}: need ${formatUnits(params.amount, from.decimals)}, have ${formatUnits(bal, from.decimals)}` +
        (from.isNative ? ` (gas reserve kept)` : ''),
    );
  }

  // Native gas check when spending ERC-20 (need gas for approve+swap/deposit)
  if (!from.isNative) {
    const native = await getNativeBalance(params.fromChain);
    if (native < GAS_RESERVE_WEI[params.fromChain] / 2n) {
      throw new Error(
        `Low ${CHAINS[params.fromChain].nativeSymbol} for gas on ${CHAINS[params.fromChain].name}`,
      );
    }
  }

  const quote = await getRelayQuote({
    originChainId: params.fromChain,
    destinationChainId: params.toChain,
    originCurrency: from.address,
    destinationCurrency: to.address,
    amount: params.amount,
  });

  const cin = quote.details?.currencyIn;
  const cout = quote.details?.currencyOut;
  const networkCostUsd = quote.fees?.gas?.amountUsd;
  const feeUsd = quote.fees?.relayer?.amountUsd;
  const priceImpactPercent = quote.details?.totalImpact?.percent;

  return {
    fromChain: params.fromChain,
    toChain: params.toChain,
    from,
    to,
    amountIn: params.amount,
    quote,
    amountInFormatted:
      cin?.amountFormatted ?? formatUnits(params.amount, from.decimals),
    amountOutFormatted:
      cout?.amountFormatted ??
      (cout?.amount && cout.currency?.decimals != null
        ? formatUnits(BigInt(cout.amount), cout.currency.decimals)
        : '?'),
    amountOutUsd: cout?.amountUsd,
    timeEstimate: quote.details?.timeEstimate,
    networkCostUsd,
    feeUsd,
    priceImpactPercent,
    rate: quote.details?.rate,
  };
}

/** Cross-chain bridge only (rejects same-chain). */
export async function previewBridge(params: {
  fromChain: SupportedChainId;
  toChain: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<BridgePreview> {
  if (params.fromChain === params.toChain) {
    throw new Error('Origin and destination must differ — use /swap for same-chain');
  }
  return previewRelayTrade(params);
}

/** Same-chain native/stable swap via Relay. */
export async function previewSwap(params: {
  chainId: SupportedChainId;
  fromSymbol: string;
  toSymbol: string;
  amount: bigint;
}): Promise<BridgePreview> {
  if (params.fromSymbol.toUpperCase() === params.toSymbol.toUpperCase()) {
    throw new Error('From and to tokens must differ');
  }
  return previewRelayTrade({
    fromChain: params.chainId,
    toChain: params.chainId,
    fromSymbol: params.fromSymbol,
    toSymbol: params.toSymbol,
    amount: params.amount,
  });
}

function formatUsdMoney(raw: string | undefined, digits = 2): string | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  // small network costs: show 2–4 decimals
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(digits)}`;
}

function formatPriceImpact(percent: string | undefined): string | undefined {
  if (percent == null || percent === '') return undefined;
  const n = Number(percent);
  if (!Number.isFinite(n)) return `${percent}%`;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function formatRelayQuoteLines(p: BridgePreview, title: string, routeLine: string): string {
  const lines = [
    title,
    routeLine,
    ``,
    `Send: ${p.amountInFormatted} ${p.from.symbol}`,
    `Recv: ~${p.amountOutFormatted} ${p.to.symbol}` +
      (p.amountOutUsd ? ` (~$${Number(p.amountOutUsd).toFixed(2)})` : ''),
  ];
  if (p.rate) lines.push(`Rate: ${p.rate}`);

  lines.push(``);
  if (p.timeEstimate != null) {
    lines.push(`Estimated time`);
    lines.push(`~ ${p.timeEstimate}s`);
  }
  const netCost = formatUsdMoney(p.networkCostUsd);
  if (netCost) {
    lines.push(`Network cost`);
    lines.push(netCost);
  }
  const impact = formatPriceImpact(p.priceImpactPercent);
  if (impact) {
    lines.push(`Price Impact`);
    lines.push(impact);
  }

  lines.push(``, `Quotes expire quickly — confirm soon.`);
  return lines.join('\n');
}

export function formatBridgePreview(p: BridgePreview): string {
  return formatRelayQuoteLines(
    p,
    `🌉 Bridge via Relay`,
    `${CHAINS[p.fromChain].name} → ${CHAINS[p.toChain].name}`,
  );
}

export function formatSwapPreviewRelay(p: BridgePreview): string {
  return formatRelayQuoteLines(
    p,
    `💱 Swap via Relay`,
    `${CHAINS[p.fromChain].name} · ${p.from.symbol} → ${p.to.symbol}`,
  );
}

export function formatBridgeResult(r: BridgeExecuteResult, p: BridgePreview): string {
  const same = p.fromChain === p.toChain;
  const lines = [
    same
      ? `✅ Swapped ${p.amountInFormatted} ${p.from.symbol} → ~${p.amountOutFormatted} ${p.to.symbol}`
      : `✅ Bridged ${p.amountInFormatted} ${p.from.symbol} → ~${p.amountOutFormatted} ${p.to.symbol}`,
    same
      ? `${CHAINS[p.fromChain].name}`
      : `${CHAINS[p.fromChain].name} → ${CHAINS[p.toChain].name}`,
  ];
  for (const tx of r.originTxs) {
    lines.push(`Origin tx: ${tx.link}`);
  }
  if (r.destTxHashes.length) {
    const dest = r.status?.destinationChainId;
    for (const h of r.destTxHashes) {
      if (dest && isSupportedChainId(dest) && h.startsWith('0x')) {
        lines.push(`Dest tx: ${txUrl(dest, h)}`);
      } else {
        lines.push(`Dest: ${h}`);
      }
    }
  }
  if (r.requestId) lines.push(`Request: ${r.requestId.slice(0, 18)}…`);
  return lines.join('\n');
}

export const formatSwapResult = formatBridgeResult;
