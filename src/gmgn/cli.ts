import crossSpawn from 'cross-spawn';
import type { Address } from 'viem';
import { type SupportedChainId } from '../config.js';

/**
 * gmgn-cli wrapper.
 *
 * Security rules:
 * 1. Always invoke with a structured ARGUMENT ARRAY — never a shell string
 *    built by concatenating/interpolating values. `cross-spawn` is used
 *    instead of Node's raw `execFile()` because on Windows, a global npm
 *    install of gmgn-cli produces a `.cmd` shim, which `execFile()` cannot
 *    launch at all without a shell (confirmed: fails with ENOENT for a
 *    bare name, EINVAL even with the `.cmd` extension given explicitly —
 *    this is a genuine Windows/Node limitation, not a bug in this file).
 *    `cross-spawn` handles the required Windows shell layer AND correctly
 *    escapes each argument for cmd.exe's parsing rules — POSIX is
 *    unaffected (no shell is used there).
 * 2. `cross-spawn`'s escaping was verified empirically against a battery of
 *    shell-metacharacter payloads and closes most injection vectors, but
 *    one gap was found (a literal double-quote combined with `&` can still
 *    break out — see test/gmgnCli.test.ts). Because of that, rule 2 is not
 *    "trust the escaping" — it's `assertSafeCliArg()` below: every argument
 *    is validated against a strict allowlist before it ever reaches the
 *    process boundary, regardless of which spawn mechanism is used. No
 *    legitimate gmgn-cli argument in this file (chain name, 0x address,
 *    numeric value, order id, orderBy field name) ever needs a shell
 *    metacharacter or a quote, so rejecting them outright costs nothing.
 * 3. Credentials live in ~/.config/gmgn/ and are read by gmgn-cli itself.
 */

export type GmgnChainName = 'robinhood' | 'bsc' | 'base';

/** GMGN represents the chain's native asset as the zero address. */
export const GMGN_NATIVE = '0x0000000000000000000000000000000000000000' as Address;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Explicit, machine-checkable failure classification (spec: candidate
 * absence and candidate-source failure must be distinguishable — a source
 * failure must never be silently reported the same way as "genuinely zero
 * results").
 */
export type GmgnErrorCode =
  | 'GMGN_CLI_NOT_FOUND'
  | 'GMGN_CLI_TIMEOUT'
  | 'GMGN_CLI_NONZERO_EXIT'
  | 'GMGN_CLI_EXEC_FAILED'
  | 'GMGN_CLI_EMPTY_OUTPUT'
  | 'GMGN_CLI_MALFORMED_OUTPUT'
  | 'GMGN_CLI_RATE_LIMITED'
  | 'GMGN_CLI_AUTH_FAILED'
  | 'GMGN_CLI_INVALID_INPUT'
  | 'GMGN_ERROR';

export class GmgnError extends Error {
  readonly code: GmgnErrorCode;
  constructor(message: string, readonly stderr?: string, code: GmgnErrorCode = 'GMGN_ERROR') {
    super(message);
    this.name = 'GmgnError';
    this.code = code;
  }
}

/** 429. `resetAt` is a unix seconds timestamp when GMGN reports one. */
export class GmgnRateLimitError extends GmgnError {
  constructor(message: string, readonly resetAt: number | null) {
    super(message, undefined, 'GMGN_CLI_RATE_LIMITED');
    this.name = 'GmgnRateLimitError';
  }
}

/**
 * Defense-in-depth allowlist gate (see security rule 2 above). Every
 * gmgn-cli argument in this file is already validated at its own call
 * site (address regex, numeric coercion, order-id regex, hardcoded chain
 * enums) — this is a second, universal check applied right before the
 * process boundary so no future call site can accidentally skip it.
 */
const UNSAFE_ARG_RE = /["`$&|;<>^%!\r\n]/;

function assertSafeCliArg(arg: string): string {
  if (UNSAFE_ARG_RE.test(arg)) {
    throw new GmgnError(
      `Refusing to pass an unsafe character to gmgn-cli in argument: ${JSON.stringify(arg.slice(0, 80))}`,
      undefined,
      'GMGN_CLI_INVALID_INPUT',
    );
  }
  return arg;
}

type CliProcessError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
};

/**
 * Phase 4.6.2: bounded SIGTERM→SIGKILL escalation. A child that ignores
 * SIGTERM must not stay alive (and must not leave this wrapper's promise
 * unsettled) indefinitely. Both windows are short relative to
 * DEFAULT_TIMEOUT_MS (30s) — they only ever add latency on an already-
 * failing call, never on the happy path.
 */
const SIGTERM_GRACE_MS = 2_000;
/** Final bound after SIGKILL: settle even if the OS hasn't reaped the process yet, so the wrapper's own contract ("must not hang the caller") holds regardless of OS-level cleanup timing. */
const SIGKILL_WAIT_MS = 2_000;

/**
 * Minimal shape of a spawned child process this wrapper depends on —
 * lets tests inject a fully-controlled fake "child" to deterministically
 * and portably exercise the exact SIGTERM→SIGKILL escalation sequence
 * (real OS signal semantics differ enough between POSIX and Windows —
 * e.g. Windows has no real "ignore a signal" capability — that the exact
 * escalation *logic* is better proven this way, alongside a separate
 * real-OS-process test for genuine end-to-end coverage; see
 * test/gmgnCli.test.ts).
 */
export type SpawnedProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (err: CliProcessError) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

/**
 * Cross-platform process runner for gmgn-cli, replacing Node's raw
 * `execFile()` (see security rule 1). Mirrors `execFile`'s well-known
 * error shape (`.code`, `.killed`, `.signal`, `.stdout`, `.stderr`) so the
 * classification logic in `gmgnJson()` reads the same way.
 */
/** Exported for tests only — real cross-platform spawn coverage without requiring gmgn-cli to be installed (see test/gmgnCli.test.ts). */
export function runGmgnProcess(
  file: string,
  args: string[],
  opts: {
    timeoutMs: number;
    maxBufferBytes: number;
    env: NodeJS.ProcessEnv;
    /** Test-only injection point; defaults to the real cross-spawn call. */
    spawnFn?: (file: string, args: string[], env: NodeJS.ProcessEnv) => SpawnedProcess;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const spawnFn = opts.spawnFn ?? ((f, a, e) => crossSpawn(f, a, { env: e }) as unknown as SpawnedProcess);
    const child = spawnFn(file, args, opts.env);
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let processExited = false;

    let sigtermTimer: ReturnType<typeof setTimeout> | null = setTimeout(onTimeout, opts.timeoutMs);
    let sigkillGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let sigkillWaitTimer: ReturnType<typeof setTimeout> | null = null;

    function clearAllTimers(): void {
      if (sigtermTimer) clearTimeout(sigtermTimer);
      if (sigkillGraceTimer) clearTimeout(sigkillGraceTimer);
      if (sigkillWaitTimer) clearTimeout(sigkillWaitTimer);
      sigtermTimer = sigkillGraceTimer = sigkillWaitTimer = null;
    }

    // Never let a signal delivery race (process already exited between our
    // liveness check and this call) surface as an unexpected/fatal error —
    // ChildProcess#kill() throwing here means only "there's nothing left to
    // kill", which is a success condition for our purposes, not a failure.
    function safeKill(signal: NodeJS.Signals): void {
      try {
        child.kill(signal);
      } catch {
        /* already gone — nothing to do */
      }
    }

    function timeoutError(): CliProcessError {
      return Object.assign(new Error(`gmgn-cli timed out after ${opts.timeoutMs}ms`), {
        killed: true,
        signal: 'SIGTERM' as const,
        code: null,
      });
    }

    function onTimeout(): void {
      timedOut = true;
      safeKill('SIGTERM');
      // SIGKILL is uncatchable on POSIX, so a child that ignores SIGTERM
      // cannot ignore this escalation. On Windows there is no real signal
      // delivery — any kill() call already terminates the process
      // unconditionally (TerminateProcess) regardless of the signal name,
      // so this second call is a harmless no-op there if the first already
      // succeeded, and a safety net if it somehow didn't.
      sigkillGraceTimer = setTimeout(() => {
        if (processExited) return;
        safeKill('SIGKILL');
        sigkillWaitTimer = setTimeout(() => finish(timeoutError()), SIGKILL_WAIT_MS);
      }, SIGTERM_GRACE_MS);
    }

    const finish = (err: CliProcessError | null) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      if (err) {
        // Once a timeout has been declared, it is the final result — a
        // later/different error (e.g. a stream error racing the kill
        // escalation) must never override it with a raw, unclassified
        // error.
        const finalErr = timedOut ? timeoutError() : err;
        finalErr.stdout = stdout;
        finalErr.stderr = stderr;
        reject(finalErr);
      } else {
        resolve({ stdout, stderr });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxBufferBytes) {
        safeKill('SIGTERM');
        finish(Object.assign(new Error('gmgn-cli stdout exceeded maxBuffer'), { code: 'ERR_MAXBUFFER' }));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > opts.maxBufferBytes) {
        safeKill('SIGTERM');
        finish(Object.assign(new Error('gmgn-cli stderr exceeded maxBuffer'), { code: 'ERR_MAXBUFFER' }));
        return;
      }
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: CliProcessError) => finish(err));

    child.on('close', (code, signal) => {
      processExited = true;
      if (timedOut) {
        finish(timeoutError());
        return;
      }
      if (code !== 0) {
        finish(Object.assign(new Error(`gmgn-cli exited with code ${code}`), { code, signal }));
        return;
      }
      finish(null);
    });
  });
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
  opts: { timeoutMs?: number; maxBufferBytes?: number; runner?: typeof runGmgnProcess } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const runner = opts.runner ?? runGmgnProcess;
  const safeArgs = args.map(assertSafeCliArg);
  let stdout = '';
  let stderr = '';

  try {
    const r = await runner(cliPath(), safeArgs, { timeoutMs, maxBufferBytes, env: process.env });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    const err = e as CliProcessError;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    const blob = `${stdout}\n${stderr}\n${err.message}`;
    if (looksRateLimited(blob)) {
      throw new GmgnRateLimitError(
        `gmgn-cli rate limited (${args[0]} ${args[1] ?? ''})`.trim(),
        extractResetAt(blob),
      );
    }
    if (err.code === 'ENOENT') {
      throw new GmgnError(
        `gmgn-cli not found (tried "${cliPath()}"). Install it or set GMGN_CLI_PATH.\n` +
          `Zapout / screener / MULTI need gmgn-cli + a GMGN API key in ~/.config/gmgn/.`,
        stderr,
        'GMGN_CLI_NOT_FOUND',
      );
    }
    if (err.killed) {
      throw new GmgnError(
        `gmgn-cli ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs}ms`,
        stderr,
        'GMGN_CLI_TIMEOUT',
      );
    }
    // Auth / missing key — make the message actionable for zapout
    if (/api.?key|unauthorized|401|403|not configured|login|sign/i.test(blob)) {
      throw new GmgnError(
        `GMGN auth failed — configure API key in ~/.config/gmgn/ (gmgn-cli config).\n` +
          `Without a GMGN key, zapout, screener, and MULTI cannot run.\n` +
          `${(stderr || err.message).slice(0, 200)}`,
        stderr,
        'GMGN_CLI_AUTH_FAILED',
      );
    }
    if (typeof err.code === 'number') {
      throw new GmgnError(
        `gmgn-cli ${args.slice(0, 2).join(' ')} exited with code ${err.code}: ${(stderr || err.message).slice(0, 400)}`,
        stderr,
        'GMGN_CLI_NONZERO_EXIT',
      );
    }
    throw new GmgnError(
      `gmgn-cli ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).slice(0, 400)}`,
      stderr,
      'GMGN_CLI_EXEC_FAILED',
    );
  }

  if (looksRateLimited(stdout)) {
    throw new GmgnRateLimitError('gmgn-cli rate limited', extractResetAt(stdout));
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new GmgnError(
      `gmgn-cli ${args.slice(0, 2).join(' ')} returned no output`,
      stderr,
      'GMGN_CLI_EMPTY_OUTPUT',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new GmgnError(
      `gmgn-cli ${args.slice(0, 2).join(' ')} returned non-JSON: ${trimmed.slice(0, 300)}`,
      stderr,
      'GMGN_CLI_MALFORMED_OUTPUT',
    );
  }

  if (parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed) {
    const env = parsed as { code: number; data: unknown; msg?: string; message?: string };
    if (env.code !== 0) {
      const msg = env.msg ?? env.message ?? 'unknown';
      if (/api.?key|unauthorized|auth|401|403/i.test(String(msg))) {
        throw new GmgnError(
          `GMGN auth failed (${env.code}): ${msg}. Configure ~/.config/gmgn/ — no key means no zapout.`,
          stderr,
          'GMGN_CLI_AUTH_FAILED',
        );
      }
      throw new GmgnError(
        `gmgn-cli ${args.slice(0, 2).join(' ')} error ${env.code}: ${msg}`,
        stderr,
        'GMGN_CLI_NONZERO_EXIT',
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
