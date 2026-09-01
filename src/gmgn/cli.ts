import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Address } from 'viem';
import { type SupportedChainId } from '../config.js';

const pExecFile = promisify(execFile);

/**
 * gmgn-cli wrapper.
 *
 * Security rules:
 * 1. Always invoke via execFile with an ARGUMENT ARRAY — never a shell string.
 * 2. Validate every address before it becomes an argv entry.
 * 3. Credentials live in ~/.config/gmgn/ and are read by gmgn-cli itself.
 */

export type GmgnChainName = 'robinhood' | 'bsc' | 'base';

/** GMGN represents the chain's native asset as the zero address. */
export const GMGN_NATIVE = '0x0000000000000000000000000000000000000000' as Address;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

export class GmgnError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = 'GmgnError';
  }
}

/** 429. `resetAt` is a unix seconds timestamp when GMGN reports one. */
export class GmgnRateLimitError extends GmgnError {
  constructor(message: string, readonly resetAt: number | null) {
    super(message);
    this.name = 'GmgnRateLimitError';
  }
}

export function gmgnChainName(chainId: SupportedChainId): GmgnChainName {
  if (chainId === 56) return 'bsc';
  if (chainId === 8453) return 'base';
  return 'robinhood';
}

export function assertGmgnAddress(value: string, label = 'address'): Address {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new GmgnError(
      `Invalid ${label} for gmgn-cli: ${JSON.stringify(String(value).slice(0, 64))}`,
    );
  }
  return value as Address;
}

/** Positive integer amount in the token's smallest unit. */
function assertRawAmount(value: bigint, label = 'amount'): string {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new GmgnError(`Invalid ${label} for gmgn-cli: ${String(value)}`);
  }
  return value.toString();
}

/** gmgn-cli takes slippage as an integer percent 0-100. */
function assertSlippagePct(pct: number): string {
  const n = Math.round(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new GmgnError(`Slippage must be an integer percent 0-100, got ${pct}`);
  }
  return String(n);
}

function cliPath(): string {
  return process.env.GMGN_CLI_PATH?.trim() || 'gmgn-cli';
}

function extractResetAt(text: string): number | null {
  const m = /"?reset_at"?\s*[:=]\s*"?(\d{9,13})"?/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

function looksRateLimited(text: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(text);
}

/**
 * Run gmgn-cli and parse the `--raw` JSON output.
 *
 * Some subcommands return the payload bare (`token info`), others wrap it in a
 * `{ code, data }` envelope (`market trending`). Both are unwrapped here.
 */
export async function gmgnJson<T>(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stdout = '';
  let stderr = '';

  try {
    const r = await pExecFile(cliPath(), args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string; code?: number };
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    const blob = `${stdout}\n${stderr}\n${err.message}`;
    if (looksRateLimited(blob)) {
      throw new GmgnRateLimitError(
        `gmgn-cli rate limited (${args[0]} ${args[1] ?? ''})`.trim(),
        extractResetAt(blob),
      );
    }
    if (/ENOENT/.test(err.message)) {
      throw new GmgnError(
        `gmgn-cli not found (tried "${cliPath()}"). Install it or set GMGN_CLI_PATH.\n` +
          `Zapout / screener need gmgn-cli + a GMGN API key in ~/.config/gmgn/.`,
      );
    }
    // Auth / missing key — make the message actionable for zapout
    if (/api.?key|unauthorized|401|403|not configured|login|sign/i.test(blob)) {
      throw new GmgnError(
        `GMGN auth failed — configure API key in ~/.config/gmgn/ (gmgn-cli config).\n` +
          `Without a GMGN key, zapout and screener cannot run.\n` +
          `${(stderr || err.message).slice(0, 200)}`,
        stderr,
      );
    }
    throw new GmgnError(
      `gmgn-cli ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).slice(0, 400)}`,
      stderr,
    );
  }

  if (looksRateLimited(stdout)) {
    throw new GmgnRateLimitError('gmgn-cli rate limited', extractResetAt(stdout));
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new GmgnError(`gmgn-cli ${args.slice(0, 2).join(' ')} returned no output`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new GmgnError(
      `gmgn-cli ${args.slice(0, 2).join(' ')} returned non-JSON: ${trimmed.slice(0, 300)}`,
    );
  }

  if (parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed) {
    const env = parsed as { code: number; data: unknown; msg?: string; message?: string };
    if (env.code !== 0) {
      const msg = env.msg ?? env.message ?? 'unknown';
      if (/api.?key|unauthorized|auth|401|403/i.test(String(msg))) {
        throw new GmgnError(
          `GMGN auth failed (${env.code}): ${msg}. Configure ~/.config/gmgn/ — no key means no zapout.`,
        );
      }
      throw new GmgnError(
        `gmgn-cli ${args.slice(0, 2).join(' ')} error ${env.code}: ${msg}`,
      );
    }
    return env.data as T;
  }

  return parsed as T;
}

// ── token info ────────────────────────────────────────────────────────────

export type GmgnTokenInfo = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  holder_count: number;
  total_supply: string;
  circulating_supply: string;
  liquidity: string;
  /** Cumulative LP fees (chain native units) — same metric as trending gas_fee */
  total_fee: string;
  trade_fee: string;
  biggest_pool_address: string;
  creation_timestamp: number;
  open_timestamp: number;
  launchpad: string;
  price: {
    price: string;
    price_1h: string;
    price_24h: string;
    buys_24h: number;
    sells_24h: number;
    swaps_24h: number;
    volume_1h: string;
    volume_24h: string;
  };
  pool?: {
    pool_address: string;
    quote_address: string;
    quote_symbol: string;
    exchange: string;
    token0_address: string;
    token1_address: string;
  };
};

export async function gmgnTokenInfo(
  chainId: SupportedChainId,
  token: Address,
): Promise<GmgnTokenInfo> {
  const addr = assertGmgnAddress(token, 'token');
  return gmgnJson<GmgnTokenInfo>([
    'token',
    'info',
    '--chain',
    gmgnChainName(chainId),
    '--address',
    addr,
    '--raw',
  ]);
}

// ── token security ────────────────────────────────────────────────────────

export type GmgnTokenSecurity = {
  address: string;
  is_honeypot: boolean;
  is_open_source: boolean;
  is_blacklist: boolean;
  is_renounced: boolean;
  can_not_sell: number;
  buy_tax: string;
  sell_tax: string;
  top_10_holder_rate: string;
  burn_ratio: string;
  rug_ratio?: string;
  flags?: string[];
};

export async function gmgnTokenSecurity(
  chainId: SupportedChainId,
  token: Address,
): Promise<GmgnTokenSecurity> {
  const addr = assertGmgnAddress(token, 'token');
  return gmgnJson<GmgnTokenSecurity>([
    'token',
    'security',
    '--chain',
    gmgnChainName(chainId),
    '--address',
    addr,
    '--raw',
  ]);
}

// ── swap quote ────────────────────────────────────────────────────────────

export type GmgnQuote = {
  input_token: string;
  output_token: string;
  input_amount: string;
  output_amount: string;
  min_output_amount: string;
  slippage: number;
  tx: {
    chain_id: number;
    to: string;
    from_address: string;
    value: string;
    data: string;
    gas_limit?: number;
    deadline?: number;
    amount_in: string;
    amount_out: string;
    amount_min_out: string;
    amount_in_usd?: number | string;
    amount_out_usd?: number | string;
    input_token_address: string;
    output_token_address: string;
    type?: string;
  };
};

/**
 * Quote a swap. Read-only — API key only, no private key, nothing broadcast.
 * Response carries a complete unsigned transaction for local signing.
 */
export async function gmgnQuote(params: {
  chainId: SupportedChainId;
  from: Address;
  inputToken: Address;
  outputToken: Address;
  amountRaw: bigint;
  slippagePct: number;
}): Promise<GmgnQuote> {
  const args = [
    'order',
    'quote',
    '--chain',
    gmgnChainName(params.chainId),
    '--from',
    assertGmgnAddress(params.from, 'from'),
    '--input-token',
    assertGmgnAddress(params.inputToken, 'input-token'),
    '--output-token',
    assertGmgnAddress(params.outputToken, 'output-token'),
    '--amount',
    assertRawAmount(params.amountRaw),
    '--slippage',
    assertSlippagePct(params.slippagePct),
    '--raw',
  ];
  return gmgnJson<GmgnQuote>(args);
}

// ── managed swap (GMGN signs) ─────────────────────────────────────────────

export type GmgnManagedSwapResult = {
  order_id?: string;
  orderId?: string;
  hash?: string;
  tx_hash?: string;
  status?: string;
};

export async function gmgnManagedSwap(params: {
  chainId: SupportedChainId;
  from: Address;
  inputToken: Address;
  outputToken: Address;
  amountRaw: bigint;
  slippagePct: number;
}): Promise<GmgnManagedSwapResult> {
  if (process.env.GMGN_ALLOW_AUTOMATED_TRADES !== '1') {
    throw new GmgnError(
      'Managed swap needs GMGN_ALLOW_AUTOMATED_TRADES=1 — gmgn-cli refuses non-interactive swaps otherwise.',
    );
  }
  const args = [
    'swap',
    '--chain',
    gmgnChainName(params.chainId),
    '--from',
    assertGmgnAddress(params.from, 'from'),
    '--input-token',
    assertGmgnAddress(params.inputToken, 'input-token'),
    '--output-token',
    assertGmgnAddress(params.outputToken, 'output-token'),
    '--amount',
    assertRawAmount(params.amountRaw),
    '--slippage',
    assertSlippagePct(params.slippagePct),
    '--yes',
    '--raw',
  ];
  return gmgnJson<GmgnManagedSwapResult>(args, { timeoutMs: 60_000 });
}

export type GmgnOrder = {
  status?: string;
  hash?: string;
  tx_hash?: string;
  report?: {
    input_amount?: string;
    output_amount?: string;
  };
};

export async function gmgnOrderGet(
  chainId: SupportedChainId,
  orderId: string,
): Promise<GmgnOrder> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    throw new GmgnError(`Invalid order id: ${orderId.slice(0, 64)}`);
  }
  return gmgnJson<GmgnOrder>([
    'order',
    'get',
    '--chain',
    gmgnChainName(chainId),
    '--order-id',
    orderId,
    '--raw',
  ]);
}

// ── market trending ───────────────────────────────────────────────────────

export type GmgnTrendingInterval = '1m' | '5m' | '1h' | '6h' | '24h';

export type GmgnTrendingToken = {
  address: string;
  symbol: string;
  name: string;
  price: number;
  price_change_percent?: number;
  price_change_percent1h?: number;
  volume: number;
  liquidity: number;
  market_cap: number;
  holder_count: number;
  swaps?: number;
  buys?: number;
  sells?: number;
  /** KOL / renowned wallet count */
  renowned_count: number;
  smart_degen_count?: number;
  /** Cumulative fees (native units) — same as token info total_fee */
  gas_fee: number;
  top_10_holder_rate?: number;
  is_honeypot?: number | boolean;
  chain?: string;
  logo?: string;
  twitter_username?: string;
  website?: string;
  launchpad_platform?: string;
  rank?: number;
};

export type GmgnMarketTrendingParams = {
  chainId: SupportedChainId;
  interval: GmgnTrendingInterval;
  limit?: number;
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
  minMarketcapUsd?: number;
  maxMarketcapUsd?: number;
  minRenownedCount?: number;
  /** Maps to --min-gas-fee (total fees metric) */
  minGasFee?: number;
  orderBy?: string;
  direction?: 'asc' | 'desc';
};

/**
 * `market trending` returns `{ rank: GmgnTrendingToken[] }` after envelope unwrap.
 */
export async function gmgnMarketTrending(
  params: GmgnMarketTrendingParams,
): Promise<GmgnTrendingToken[]> {
  const limit = Math.min(100, Math.max(1, Math.round(params.limit ?? 100)));
  const args: string[] = [
    'market',
    'trending',
    '--chain',
    gmgnChainName(params.chainId),
    '--interval',
    params.interval,
    '--limit',
    String(limit),
    '--raw',
  ];

  const pushNum = (flag: string, v: number | undefined) => {
    if (v == null || !Number.isFinite(v) || v < 0) return;
    // 0 max = “no cap” — skip
    if (v === 0 && flag.startsWith('--max-')) return;
    args.push(flag, String(v));
  };

  pushNum('--min-volume', params.minVolumeUsd);
  pushNum('--max-volume', params.maxVolumeUsd);
  pushNum('--min-marketcap', params.minMarketcapUsd);
  pushNum('--max-marketcap', params.maxMarketcapUsd);
  pushNum('--min-renowned-count', params.minRenownedCount);
  pushNum('--min-gas-fee', params.minGasFee);

  if (params.orderBy && /^[a-z0-9_]+$/i.test(params.orderBy)) {
    args.push('--order-by', params.orderBy);
  }
  if (params.direction === 'asc' || params.direction === 'desc') {
    args.push('--direction', params.direction);
  }

  const data = await gmgnJson<{ rank?: GmgnTrendingToken[] } | GmgnTrendingToken[]>(args, {
    timeoutMs: 45_000,
  });

  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.rank)) return data.rank;
  return [];
}
