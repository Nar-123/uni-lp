import fs from 'node:fs';
import path from 'node:path';
import {
  config,
  type DexId,
  isDexId,
  isSupportedChainId,
  type SupportedChainId,
} from '../config.js';
import { computeRealizedSlippageBps } from '../chain/safety.js';
import type { MultiPositionMeta } from '../strategy/types.js';

export type LedgerKind = 'deposit' | 'withdrawal' | 'fee_claim';

/**
 * Phase 3.5: Accounting metadata staged in the transaction journal before
 * calling recordLedger(), so that a crash after tx success but before
 * recordLedger() completes can be detected and recovered automatically.
 *
 * usd=null means the USD value was not available at staging time —
 * recovery flags RECONCILIATION_REQUIRED rather than silently recording
 * zero or a fabricated amount.
 *
 * feeSplitIsEstimated=true on fee_claim entries from a combined close
 * where principal vs. fees could not be exactly separated from on-chain
 * events (see Phase 3.5 audit §11).
 */
export type JournalAccountingMeta = {
  kind: LedgerKind;
  tokenId: string;
  tokenAddress: string | null;
  amountRaw: string | null;
  amountHuman: number | null;
  /** null = USD unknown at staging time — RECONCILIATION_REQUIRED on recovery */
  usd: number | null;
  feeSplitIsEstimated?: boolean;
  /**
   * Phase 4.5.2: which strategy staged this entry (e.g. 'multi'). Omitted
   * for manual mints. Carried through so a ledger event reconstructed by
   * Phase 3.5 recovery (pnl/reconcile.ts) after a crash keeps the same
   * strategy attribution the immediate recordLedger() call would have
   * set — without this, a recovered MULTI-originated ledger row would
   * silently lose its 'multi' tag and become indistinguishable from
   * manual activity in PnL-by-strategy reporting.
   */
  strategy?: string;
};

export type DepositMode = 'auto' | 'wrapped' | 'stable';

/** After close: where to auto-swap recovered tokens */
export type CloseSwapTarget = 'off' | 'eth' | 'usdg';

/** percent of balance vs fixed deposit-token amount (e.g. 0.1 WETH) */
export type SizeMode = 'percent' | 'fixed';

export const FIXED_AMOUNT_PRESETS = [0.05, 0.1, 0.25, 0.5] as const;

/** GMGN market trending interval */
export type ScreenerInterval = '1m' | '5m' | '1h' | '6h' | '24h';

export const SCREENER_INTERVALS = ['1m', '5m', '1h', '6h', '24h'] as const;

export type UserPrefs = {
  chainId: SupportedChainId;
  /** Range width % (1–99). Presets 20/30/50 or custom. */
  widthPercent: number;
  balancePercent: number;
  /** percent = use balancePercent; fixed = use fixedAmountHuman of deposit token */
  sizeMode: SizeMode;
  /** Human units of deposit asset when sizeMode=fixed (e.g. 0.1 ETH/WETH) */
  fixedAmountHuman: number;
  /** auto = WETH if in pool else stable; wrapped = WETH/WBNB; stable = USDG/USDC */
  depositMode: DepositMode;
  /**
   * After close auto-swap (via GMGN — requires gmgn-cli + API key):
   * - off: leave tokens as received
   * - eth: memes → ETH + any USDG/USDC → ETH
   * - usdg: memes → USDG/USDC (stable left alone)
   */
  closeSwapTarget: CloseSwapTarget;
  /** Before mint: if deposit is USDG/USDC and short, swap ETH/WETH → stable */
  autoSwapEthToStable: boolean;
  /**
   * Experimental: global TP/SL watcher (30s poll).
   * Per-position still needs /tp #id to enroll.
   */
  tpSlEnabled: boolean;
  /** Default take-profit PnL % (e.g. 10 = close when PnL ≥ +10%) */
  tpPercent: number;
  /** Default stop-loss PnL % as positive magnitude (e.g. 15 = close when PnL ≤ -15%) */
  slPercent: number;
  /** If false, Close buttons skip confirmation and exit immediately */
  closeConfirm: boolean;
  /**
   * Min pool TVL (USD) for CA pool picker. 0 = show all discovered pools.
   * Default 2000.
   */
  minTvlUsd: number;
  // ── GMGN screener filters ──────────────────────────────────────────────
  /** market trending interval (default 6h) */
  screenerInterval: ScreenerInterval;
  /** min volume USD over the interval (default 300_000) */
  screenerMinVolumeUsd: number;
  /** min KOL / renowned wallet count (default 10) */
  screenerMinKol: number;
  /** min total fees / gas_fee (native units, default 0.5) */
  screenerMinTotalFee: number;
  /** min market cap USD (default 500_000) */
  screenerMinMcapUsd: number;
  /** max market cap USD (default 50_000_000; 0 = no cap) */
  screenerMaxMcapUsd: number;
  /** max tokens to show (default 20, API max 100) */
  screenerLimit: number;
  // ── 5m volume alerts (poll 60s) ─────────────────────────────────────────
  /** push Telegram alert when a new token hits 5m vol filters */
  alertEnabled: boolean;
  alertMinVolumeUsd: number;
  alertMinMcapUsd: number;
  /** 0 = no cap; default 50M */
  alertMaxMcapUsd: number;
  alertMinKol: number;
  alertMinTotalFee: number;
};

type PositionRow = {
  token_id: string;
  chain_id: number;
  pool_address: string | null;
  token0: string;
  token1: string;
  fee: number;
  tick_lower: number | null;
  tick_upper: number | null;
  status: 'open' | 'closed';
  opened_at: number;
  closed_at: number | null;
  /** optional display name / symbol for list */
  label?: string | null;
  /** uniswap version */
  protocol?: 'v3' | 'v4';
  /** v3 venue (uniswap default; pancakeswap on BSC) */
  dex?: DexId;
  /** Experimental TP/SL enrollment for this NFT */
  tp_sl_enabled?: boolean;
  /** Override defaults; null = use prefs */
  tp_percent?: number | null;
  sl_percent?: number | null;
  /** Phase 4: which strategy opened this position. Absent = pre-Phase-4 / manual. */
  strategy?: string;
};

type LedgerRow = {
  id: number;
  chain_id: number;
  token_id: string;
  kind: LedgerKind;
  token_address: string | null;
  amount_raw: string | null;
  amount_human: number | null;
  usd: number;
  tx_hash: string | null;
  created_at: number;
  /** Phase 4: which strategy produced this ledger event. Absent = pre-Phase-4 / manual. */
  strategy?: string;
};

export type ExecutionOpType =
  | 'swap'
  | 'close-v3'
  | 'close-v4'
  | 'mint-v3'
  | 'mint-v4'
  | 'claim-fees-v3'
  | 'claim-fees-v4';

export type ExecutionTelemetryLeg = {
  token: string;
  /** raw units (bigint as string) */
  estimatedRaw: string;
  minRaw: string;
  /** null when the actual amount received couldn't be independently measured */
  actualRaw: string | null;
  /**
   * bps worse (positive) / better (negative) actual was vs estimated, per
   * computeRealizedSlippageBps — computed at record time, null when
   * actualRaw is null. See safety.ts for the metric's exact definition.
   */
  realizedSlippageBps?: number | null;
};

/**
 * Gas telemetry for one broadcast tx. All fields are null ("UNKNOWN"), never
 * a fabricated 0, when the underlying value couldn't be measured (e.g. no
 * receipt yet, RPC failure reading it back) — see buildGasTelemetry in
 * chain/gas.ts.
 */
export type ExecutionTelemetryGas = {
  /** padded gas limit actually sent with the tx (estimateWriteGas's output, or the bounded fallback if estimation failed) */
  gasLimitSent: string | null;
  /** gas units actually consumed, from the mined receipt */
  gasUsed: string | null;
  /** effective gas price paid (wei), from the mined receipt */
  effectiveGasPriceWei: string | null;
  /** actual total gas cost in wei = gasUsed * effectiveGasPriceWei */
  actualGasCostWei: string | null;
};

type ExecutionTelemetryRow = {
  id: number;
  at: number;
  chain_id: number;
  op_type: ExecutionOpType;
  dex?: string;
  slippage_bps_used: number;
  /** null when a price-impact estimate wasn't available/computed for this op */
  price_impact_bps: number | null;
  /** e.g. 'v3-pool-simulation' (quote.ts) — how the estimated/min amounts were derived */
  quote_source?: string;
  /** ms epoch the quote (feeding estimated/min) was computed */
  quoted_at?: number;
  /** human-readable route label, e.g. "UNI direct · fee 0.30%" */
  route?: string;
  legs: ExecutionTelemetryLeg[];
  tx_hash: string | null;
  ok: boolean;
  error_msg?: string;
  /** absent for older rows recorded before Phase 2 Part 3's gas telemetry */
  gas?: ExecutionTelemetryGas | null;
};

/**
 * Transaction recovery journal (Phase 2 Part 4).
 *
 * `CREATED`/`SIMULATED`/`GAS_ESTIMATED` are deliberately NOT persisted
 * states — nothing has been broadcast yet at those points, so a crash
 * there has nothing to recover (the caller simply restarts the operation
 * from scratch). The journal only tracks the ambiguous window starting
 * right before a real broadcast attempt, through to a definitively known
 * outcome.
 */
export type TxJournalState =
  /** written before the broadcast RPC call; pessimistic default */
  | 'BROADCAST_UNKNOWN'
  /** hash obtained, receipt not yet confirmed */
  | 'SUBMITTED'
  /** receipt confirms success */
  | 'MINED_SUCCESS'
  /** receipt confirms revert */
  | 'MINED_REVERT'
  /** terminal success — set once MINED_SUCCESS is observed (this bot does not track confirmation depth) */
  | 'CONFIRMED'
  /** nonce-based check proved this specific attempt's nonce was never consumed — safe to retry */
  | 'NOT_SUBMITTED'
  /** ambiguity could not be resolved within bounded recovery attempts — automated retry halted */
  | 'RECOVERY_REQUIRED';

/** States that block a new send for the same (chainId, wallet) and require startup recovery. */
export const UNRESOLVED_TX_STATES: readonly TxJournalState[] = [
  'BROADCAST_UNKNOWN',
  'SUBMITTED',
  'RECOVERY_REQUIRED',
];

type TxJournalRow = {
  id: number;
  chain_id: number;
  /** wallet ADDRESS only — never a private key */
  wallet: string;
  nonce: number | null;
  tx_hash: string | null;
  /** short label, e.g. "writeContract:decreaseLiquidity" */
  action: string;
  state: TxJournalState;
  created_at: number;
  updated_at: number;
  error_msg?: string;
  /** Phase 3.5: ledger events to replay if process crashes before recordLedger() */
  accounting_meta?: JournalAccountingMeta[];
};

export type TxJournalEntry = {
  id: number;
  chainId: number;
  wallet: string;
  nonce: number | null;
  txHash: string | null;
  action: string;
  state: TxJournalState;
  createdAt: number;
  updatedAt: number;
  errorMsg?: string;
  /** Phase 3.5: staged accounting events for crash-recovery (see setJournalAccountingMeta) */
  accountingMeta?: JournalAccountingMeta[];
};

/** Bound the JSON store's size — oldest TERMINAL rows are trimmed past this count; unresolved rows are never trimmed. */
const MAX_TX_JOURNAL_ROWS = 2_000;

function toTxJournalEntry(r: TxJournalRow): TxJournalEntry {
  return {
    id: r.id,
    chainId: r.chain_id,
    wallet: r.wallet,
    nonce: r.nonce,
    txHash: r.tx_hash,
    action: r.action,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    errorMsg: r.error_msg,
    accountingMeta: r.accounting_meta,
  };
}

/**
 * Create a journal entry BEFORE the broadcast RPC call, so a crash right
 * after this point (before the RPC responds) still leaves a durable record
 * to recover from. Always starts in `BROADCAST_UNKNOWN` — the pessimistic
 * default — since we haven't attempted the network call yet at this point.
 */
export function createTxJournalEntry(entry: {
  chainId: number;
  wallet: string;
  nonce: number | null;
  action: string;
}): number {
  const s = load();
  if (!s.tx_journal) s.tx_journal = [];
  if (s.nextTxJournalId == null) s.nextTxJournalId = 1;
  const id = s.nextTxJournalId++;
  const now = Date.now();
  s.tx_journal.push({
    id,
    chain_id: entry.chainId,
    wallet: entry.wallet,
    nonce: entry.nonce,
    tx_hash: null,
    action: entry.action,
    state: 'BROADCAST_UNKNOWN',
    created_at: now,
    updated_at: now,
  });
  persist();
  return id;
}

export function updateTxJournalEntry(
  id: number,
  patch: Partial<Pick<TxJournalRow, 'state' | 'tx_hash' | 'nonce' | 'error_msg'>>,
): void {
  const s = load();
  const row = (s.tx_journal ?? []).find((r) => r.id === id);
  if (!row) return;
  Object.assign(row, patch, { updated_at: Date.now() });
  persist();
  pruneTxJournal();
}

export function getTxJournalEntry(id: number): TxJournalEntry | undefined {
  const s = load();
  const row = (s.tx_journal ?? []).find((r) => r.id === id);
  return row ? toTxJournalEntry(row) : undefined;
}

/** Unresolved entries — optionally filtered to one (chainId, wallet). */
export function listUnresolvedTxJournal(filters: {
  chainId?: number;
  wallet?: string;
} = {}): TxJournalEntry[] {
  const s = load();
  return (s.tx_journal ?? [])
    .filter((r) => UNRESOLVED_TX_STATES.includes(r.state))
    .filter((r) => filters.chainId == null || r.chain_id === filters.chainId)
    .filter(
      (r) =>
        filters.wallet == null || r.wallet.toLowerCase() === filters.wallet.toLowerCase(),
    )
    .map(toTxJournalEntry);
}

export function listAllTxJournal(limit?: number): TxJournalEntry[] {
  const s = load();
  const rows = (s.tx_journal ?? []).map(toTxJournalEntry);
  return limit != null ? rows.slice(Math.max(0, rows.length - limit)) : rows;
}

/** All CONFIRMED journal entries, optionally filtered to one chain. */
export function listConfirmedTxJournal(chainId?: number): TxJournalEntry[] {
  const s = load();
  return (s.tx_journal ?? [])
    .filter((r) => r.state === 'CONFIRMED')
    .filter((r) => chainId == null || r.chain_id === chainId)
    .map(toTxJournalEntry);
}

/**
 * Phase 3.5: Attach accounting metadata to the journal entry identified
 * by (chainId, txHash). Call this BEFORE recordLedger() so that a crash
 * between tx success and recordLedger() leaves enough information for
 * startup reconciliation to recreate the missing ledger event.
 *
 * Best-effort: returns false when the entry cannot be found (e.g. the
 * journal was pruned or this tx bypassed journalledSend). Caller must
 * call recordLedger() regardless of the return value.
 */
export function setJournalAccountingMeta(
  chainId: SupportedChainId,
  txHash: string,
  meta: JournalAccountingMeta[],
): boolean {
  const s = load();
  const lower = txHash.toLowerCase();
  const row = (s.tx_journal ?? []).find(
    (r) => r.chain_id === chainId && r.tx_hash?.toLowerCase() === lower,
  );
  if (!row) return false;
  row.accounting_meta = meta;
  persist();
  return true;
}

/** Trim oldest TERMINAL rows past MAX_TX_JOURNAL_ROWS — never drops an unresolved row. */
function pruneTxJournal(): void {
  const s = load();
  const rows = s.tx_journal;
  if (!rows || rows.length <= MAX_TX_JOURNAL_ROWS) return;
  let overflow = rows.length - MAX_TX_JOURNAL_ROWS;
  const kept: TxJournalRow[] = [];
  for (const r of rows) {
    if (overflow > 0 && !UNRESOLVED_TX_STATES.includes(r.state)) {
      overflow--;
      continue;
    }
    kept.push(r);
  }
  s.tx_journal = kept;
  persist();
}

/** Bound the JSON store's size — oldest rows are trimmed past this count. */
const MAX_EXECUTION_TELEMETRY_ROWS = 5_000;

type Store = {
  positions: PositionRow[];
  ledger: LedgerRow[];
  nextLedgerId: number;
  /** telegram user id → prefs */
  prefs: Record<string, UserPrefs>;
  /**
   * Set of v4 token IDs per chain that are confirmed empty (liquidity=0).
   * Key = chainId, Value = array of token_id strings.
   * These are skipped during v4 discovery to avoid re-scanning dead NFTs.
   */
  v4_empty_shells?: Record<string, string[]>;
  /**
   * Phase 2: per-execution record of slippage bound used vs estimated
   * price impact vs actually realized output. Write-mostly telemetry for
   * future data-driven slippage calibration — never read to gate a live
   * trading decision.
   */
  execution_telemetry?: ExecutionTelemetryRow[];
  nextTelemetryId?: number;
  /**
   * Phase 2 Part 4: journal of every local broadcast attempt, written
   * before/at the point of broadcast so a process crash, RPC timeout, or
   * restart can recover the true on-chain state instead of guessing. See
   * chain/txRecovery.ts and PHASE2_PART4_AUDIT.md.
   */
  tx_journal?: TxJournalRow[];
  nextTxJournalId?: number;
  /**
   * Phase 4: append-only historical entry metadata for MULTI-strategy
   * positions, keyed by (chainId, tokenId). Never mutated after entry —
   * used for auditability / the /multi report, not for trading decisions.
   */
  multi_position_meta?: MultiPositionMeta[];
};

let store: Store | null = null;
let storePath = '';

/**
 * Phase 4.6.1 — crash-safe persistence.
 *
 * The store is written via a write-temp-then-rename sequence (see
 * `persist()`) and a rotating single-generation backup (`<path>.bak`,
 * always the previous fully-committed generation, itself only ever
 * produced by a prior atomic rename — never a partial write). On load,
 * three sidecar files may exist next to the primary:
 *   `<path>.tmp` — a fully-written, fsynced new generation that hadn't yet
 *                  been promoted to primary when the process died.
 *   `<path>.bak` — the previous generation, moved aside right before the
 *                  new one was installed.
 *   `<path>.corrupt-<timestamp>` — a primary file this process found
 *                  unparseable and quarantined (never deleted) for
 *                  operator diagnosis.
 * Recovery preference when the primary is missing or corrupt is always
 * "most recent complete state first": `.tmp` (the newest fully-flushed
 * write) before `.bak` (one generation stale). A corrupt/absent primary
 * with no usable `.tmp`/`.bak` is a hard failure — this never falls back
 * to an empty store, since that would silently erase financial history
 * (crash-safety invariant B).
 */
function isValidStoreShape(v: unknown): v is Store {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as Store).positions) &&
    Array.isArray((v as Store).ledger)
  );
}

/** Read + parse a candidate store file. Returns null (never throws) on any
 * missing-file, read, or parse error, or if the parsed JSON doesn't look
 * like a Store — callers decide what "null" means in context. */
function tryReadStoreFile(candidatePath: string): Store | null {
  let raw: string;
  try {
    raw = fs.readFileSync(candidatePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `[db] ${candidatePath} exists but is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  if (!isValidStoreShape(parsed)) {
    console.error(`[db] ${candidatePath} parsed but does not look like a valid store (missing positions/ledger arrays)`);
    return null;
  }
  return parsed;
}

/** Move a file aside for diagnosis instead of ever deleting/overwriting it. */
function quarantineFile(candidatePath: string): string | null {
  try {
    if (!fs.existsSync(candidatePath)) return null;
    const quarantined = `${candidatePath}.corrupt-${Date.now()}`;
    fs.renameSync(candidatePath, quarantined);
    return quarantined;
  } catch (e) {
    console.error(`[db] failed to quarantine ${candidatePath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Try `.tmp` (most recent complete write) then `.bak` (previous generation). */
function recoverFromSidecars(primaryPath: string): Store | null {
  const tmpPath = `${primaryPath}.tmp`;
  const bakPath = `${primaryPath}.bak`;

  const fromTmp = tryReadStoreFile(tmpPath);
  if (fromTmp) {
    console.error(
      `[db] RECOVERED primary store from ${tmpPath} (a write that completed but was not yet promoted). ` +
        `RECONCILIATION RECOMMENDED — verify recent activity via /reconcile.`,
    );
    return fromTmp;
  }

  const fromBak = tryReadStoreFile(bakPath);
  if (fromBak) {
    console.error(
      `[db] RECOVERED primary store from ${bakPath} (the previous generation — this is ` +
        `at most one save behind the true last state). RECONCILIATION REQUIRED — run /reconcile ` +
        `and cross-check the most recent transaction(s) against on-chain history.`,
    );
    return fromBak;
  }

  return null;
}

function load(): Store {
  if (store) return store;
  storePath = path.resolve(config.dbPath.replace(/\.db$/i, '.json'));
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.tmp`;
  const bakPath = `${storePath}.bak`;

  if (fs.existsSync(storePath)) {
    const parsed = tryReadStoreFile(storePath);
    if (parsed) {
      store = parsed;
      // A leftover .tmp here means a prior persist() completed the write
      // but crashed/failed before or during the rename that installs it —
      // the primary we just loaded is already the authoritative state
      // (either that same generation, if the rename actually succeeded, or
      // an earlier one), so the stray tmp is superseded. Best-effort clean
      // up only; never let this block startup.
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* non-fatal */
      }
    } else {
      // Primary exists but is corrupt/unparseable. Preserve it for
      // diagnosis (never delete/overwrite it) and attempt deterministic
      // recovery from a sidecar before giving up.
      const quarantined = quarantineFile(storePath);
      const recovered = recoverFromSidecars(storePath);
      if (!recovered) {
        throw new Error(
          `[db] FATAL: primary store ${storePath} is corrupt` +
            (quarantined ? ` (preserved at ${quarantined})` : '') +
            ` and no usable backup/temp state was found. Refusing to start with an invented ` +
            `empty ledger/journal — this would silently erase financial history. Manual ` +
            `recovery required: inspect the quarantined file and any *.bak/*.tmp files next ` +
            `to ${storePath}.`,
        );
      }
      store = recovered;
      // Immediately re-commit the recovered state to the primary path via
      // the normal atomic path, so subsequent loads see it there too.
      persist();
    }
  } else {
    // No primary file. This is legitimate on a genuine first run, but it's
    // also exactly what a crash between the two renames in persist() would
    // leave behind — so check the sidecars before assuming "first run".
    const recovered = recoverFromSidecars(storePath);
    if (recovered) {
      store = recovered;
      persist();
    } else if (fs.existsSync(tmpPath) || fs.existsSync(bakPath)) {
      // A sidecar exists but neither is readable — this is corruption, not
      // an empty first run. Fail loud rather than inventing a fresh store.
      const badTmp = fs.existsSync(tmpPath) ? quarantineFile(tmpPath) : null;
      const badBak = fs.existsSync(bakPath) ? quarantineFile(bakPath) : null;
      throw new Error(
        `[db] FATAL: primary store ${storePath} is missing and the only recovery ` +
          `candidates found were unreadable/corrupt` +
          (badTmp ? ` (preserved at ${badTmp})` : '') +
          (badBak ? ` (preserved at ${badBak})` : '') +
          `. Refusing to start with an invented empty ledger/journal.`,
      );
    } else {
      store = { positions: [], ledger: [], nextLedgerId: 1, prefs: {} };
      persist();
    }
  }
  if (!store.prefs) store.prefs = {};
  if (!store.execution_telemetry) store.execution_telemetry = [];
  if (!store.nextTelemetryId) store.nextTelemetryId = 1;
  if (!store.multi_position_meta) store.multi_position_meta = [];
  return store;
}

export const DEFAULT_PREFS: UserPrefs = {
  chainId: 4663,
  widthPercent: 20,
  balancePercent: 50,
  sizeMode: 'percent',
  fixedAmountHuman: 0.1,
  depositMode: 'auto',
  closeSwapTarget: 'eth',
  autoSwapEthToStable: true,
  tpSlEnabled: false,
  tpPercent: 10,
  slPercent: 15,
  closeConfirm: true,
  minTvlUsd: 2_000,
  screenerInterval: '6h',
  screenerMinVolumeUsd: 300_000,
  screenerMinKol: 10,
  screenerMinTotalFee: 0.5,
  screenerMinMcapUsd: 500_000,
  screenerMaxMcapUsd: 50_000_000,
  screenerLimit: 20,
  alertEnabled: true,
  alertMinVolumeUsd: 300_000,
  alertMinMcapUsd: 300_000,
  alertMaxMcapUsd: 50_000_000,
  alertMinKol: 3,
  alertMinTotalFee: 0.5,
};

export const MIN_TVL_PRESETS = [0, 500, 2_000, 5_000, 10_000] as const;

export function parseMinTvlUsd(v: unknown, fallback = DEFAULT_PREFS.minTvlUsd): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) return fallback;
  return Math.round(n);
}

/** Range width 1–99 inclusive */
export function parseWidthPercent(v: unknown, fallback = 20): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return fallback;
  // keep one decimal max for custom e.g. 12.5
  return Math.round(n * 10) / 10;
}

function parseTpSlPercent(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 500) return fallback;
  return Math.round(n * 100) / 100;
}

function parseDepositMode(v: unknown): DepositMode {
  if (v === 'wrapped' || v === 'stable' || v === 'auto') return v;
  return 'auto';
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

function parseCloseSwapTarget(p: Partial<UserPrefs> | undefined): CloseSwapTarget {
  if (!p) return 'eth';
  // New field
  if (p.closeSwapTarget === 'off' || p.closeSwapTarget === 'eth' || p.closeSwapTarget === 'usdg') {
    return p.closeSwapTarget;
  }
  // Migrate legacy boolean
  if ('autoSwapToEthOnClose' in p) {
    return parseBool((p as { autoSwapToEthOnClose?: boolean }).autoSwapToEthOnClose, true)
      ? 'eth'
      : 'off';
  }
  return 'eth';
}

function parseSizeMode(v: unknown): SizeMode {
  return v === 'fixed' ? 'fixed' : 'percent';
}

function parseFixedAmount(v: unknown): number {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0 && n <= 1_000_000) return n;
  return DEFAULT_PREFS.fixedAmountHuman;
}

function parseScreenerInterval(v: unknown): ScreenerInterval {
  if (typeof v === 'string' && (SCREENER_INTERVALS as readonly string[]).includes(v)) {
    return v as ScreenerInterval;
  }
  return DEFAULT_PREFS.screenerInterval;
}

function parseNonNeg(v: unknown, fallback: number, max = 1e15): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return fallback;
  return n;
}

export function getUserPrefs(telegramUserId: number): UserPrefs {
  const s = load();
  const p = s.prefs[String(telegramUserId)] as Partial<UserPrefs> | undefined;
  if (!p) return { ...DEFAULT_PREFS };
  return {
    chainId: (isSupportedChainId(Number(p.chainId)) ? (p.chainId as SupportedChainId) : 4663),
    widthPercent: parseWidthPercent(p.widthPercent, 20),
    balancePercent:
      typeof p.balancePercent === 'number' && p.balancePercent > 0 && p.balancePercent <= 100
        ? p.balancePercent
        : 50,
    sizeMode: parseSizeMode(p.sizeMode),
    fixedAmountHuman: parseFixedAmount(p.fixedAmountHuman),
    depositMode: parseDepositMode(p.depositMode),
    closeSwapTarget: parseCloseSwapTarget(p),
    autoSwapEthToStable: parseBool(p.autoSwapEthToStable, true),
    tpSlEnabled: parseBool(p.tpSlEnabled, false),
    tpPercent: parseTpSlPercent(p.tpPercent, DEFAULT_PREFS.tpPercent),
    slPercent: parseTpSlPercent(p.slPercent, DEFAULT_PREFS.slPercent),
    closeConfirm: parseBool(p.closeConfirm, true),
    minTvlUsd: parseMinTvlUsd(p.minTvlUsd, DEFAULT_PREFS.minTvlUsd),
    screenerInterval: parseScreenerInterval(p.screenerInterval),
    screenerMinVolumeUsd: parseNonNeg(
      p.screenerMinVolumeUsd,
      DEFAULT_PREFS.screenerMinVolumeUsd,
    ),
    screenerMinKol: Math.round(
      parseNonNeg(p.screenerMinKol, DEFAULT_PREFS.screenerMinKol, 10_000),
    ),
    screenerMinTotalFee: parseNonNeg(
      p.screenerMinTotalFee,
      DEFAULT_PREFS.screenerMinTotalFee,
      1e9,
    ),
    screenerMinMcapUsd: parseNonNeg(p.screenerMinMcapUsd, DEFAULT_PREFS.screenerMinMcapUsd),
    screenerMaxMcapUsd: parseNonNeg(
      p.screenerMaxMcapUsd,
      DEFAULT_PREFS.screenerMaxMcapUsd,
    ),
    screenerLimit: Math.min(
      100,
      Math.max(1, Math.round(parseNonNeg(p.screenerLimit, DEFAULT_PREFS.screenerLimit, 100))),
    ),
    alertEnabled: parseBool(p.alertEnabled, DEFAULT_PREFS.alertEnabled),
    alertMinVolumeUsd: parseNonNeg(p.alertMinVolumeUsd, DEFAULT_PREFS.alertMinVolumeUsd),
    alertMinMcapUsd: parseNonNeg(p.alertMinMcapUsd, DEFAULT_PREFS.alertMinMcapUsd),
    alertMaxMcapUsd: parseNonNeg(p.alertMaxMcapUsd, DEFAULT_PREFS.alertMaxMcapUsd),
    alertMinKol: Math.round(
      parseNonNeg(p.alertMinKol, DEFAULT_PREFS.alertMinKol, 10_000),
    ),
    alertMinTotalFee: parseNonNeg(p.alertMinTotalFee, DEFAULT_PREFS.alertMinTotalFee, 1e9),
  };
}

/** Users who have 5m volume alerts enabled (for the background poller). */
export function listPrefsWithAlertsEnabled(): { userId: number; prefs: UserPrefs }[] {
  const s = load();
  const out: { userId: number; prefs: UserPrefs }[] = [];
  for (const key of Object.keys(s.prefs ?? {})) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const prefs = getUserPrefs(id);
    if (prefs.alertEnabled) out.push({ userId: id, prefs });
  }
  return out;
}

/** Human-readable size line for settings / previews */
export function formatSizePref(p: Pick<UserPrefs, 'sizeMode' | 'balancePercent' | 'fixedAmountHuman'>): string {
  if (p.sizeMode === 'fixed') return `${p.fixedAmountHuman} (fixed)`;
  return `${p.balancePercent}% of balance`;
}

export function setUserPrefs(
  telegramUserId: number,
  patch: Partial<UserPrefs>,
): UserPrefs {
  const s = load();
  const cur = getUserPrefs(telegramUserId);
  const next: UserPrefs = { ...cur, ...patch };
  s.prefs[String(telegramUserId)] = next;
  persist();
  return next;
}

export function getPositionOpenedAt(chainId: SupportedChainId, tokenId: string): number | null {
  const s = load();
  const row = s.positions.find((p) => p.chain_id === chainId && p.token_id === tokenId);
  return row?.opened_at ?? null;
}

export function setPositionLabel(
  chainId: SupportedChainId,
  tokenId: string,
  label: string,
): void {
  const s = load();
  const row = s.positions.find((p) => p.chain_id === chainId && p.token_id === tokenId);
  if (row) {
    row.label = label;
    persist();
  }
}

/**
 * Best-effort directory fsync so the rename below is durable against a
 * following power loss, not just crash-consistent against a process kill.
 * Not supported the same way on every platform (Windows does not expose
 * directory-fd fsync via Node's fs API the way POSIX does) — this is
 * intentionally best-effort and silent on unsupported platforms rather
 * than pretending a guarantee it can't make there.
 */
function fsyncDirBestEffort(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Expected on platforms/filesystems that don't support opening a
    // directory for fsync (notably Windows) — no durability regression
    // versus before this phase, since the previous code never attempted
    // this at all; the file-level fsync in persist() below still applies.
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed / nothing more to do */
      }
    }
  }
}

/**
 * Crash-safe write: serialize -> write+fsync a temp file in the SAME
 * directory -> rotate the current primary to `.bak` -> atomically rename
 * the temp file over the primary. Every step that can fail throws
 * explicitly (never silently reports success on a failed write — crash-
 * safety invariant A) except the `.bak` rotation, which is a best-effort
 * safety net: failing to rotate the backup must not block installing the
 * new state, since the atomic rename immediately below is what actually
 * provides the durability/atomicity guarantee.
 *
 * The temp file is never the target path itself, the target is never
 * truncated in place, and the target is never deleted before its
 * replacement is ready — at every point before the final rename, a
 * concurrent reader (or a crash) sees either the complete old primary or
 * nothing changed yet; at every point after, it sees the complete new
 * primary. There is no window where the primary is partially written
 * (crash-safety invariant F).
 */
function persist(): void {
  if (!store) return;
  const data = JSON.stringify(store, null, 2);
  const tmpPath = `${storePath}.tmp`;
  const bakPath = `${storePath}.bak`;

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, data, 0, 'utf8');
    fs.fsyncSync(fd);
  } catch (e) {
    throw new Error(
      `[db] persist: failed to write temp file ${tmpPath} — existing state on disk is unchanged: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  try {
    if (fs.existsSync(storePath)) {
      fs.renameSync(storePath, bakPath);
    }
  } catch (e) {
    console.error(
      `[db] persist: backup rotation failed (continuing — this only reduces the recovery ` +
        `sidecar's freshness, it does not block installing the new state): ${
          e instanceof Error ? e.message : String(e)
        }`,
    );
  }

  try {
    fs.renameSync(tmpPath, storePath);
  } catch (e) {
    throw new Error(
      `[db] persist: failed to install new state — the fully-written new generation is at ` +
        `${tmpPath} and can be recovered from there on next start: ${
          e instanceof Error ? e.message : String(e)
        }`,
    );
  }

  fsyncDirBestEffort(path.dirname(storePath));
}

/** Initialize store (call on boot). */
export function getDb(): Store {
  return load();
}

/**
 * Test-only: drop the in-memory cached store so the next call to any db
 * function re-reads from disk via `load()` — simulates a process
 * restart's cold-load without spawning a child process. Not used by any
 * production code path.
 */
export function __resetStoreForTests(): void {
  store = null;
  storePath = '';
}

export function recordOpenPosition(row: {
  chainId: SupportedChainId;
  tokenId: string;
  poolAddress: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  protocol?: 'v3' | 'v4';
  dex?: DexId;
  /** Phase 4: which strategy opened this position (e.g. 'multi'). Omit for manual mints. */
  strategy?: string;
}): void {
  const s = load();
  const protocol = row.protocol ?? 'v3';
  const dex: DexId = row.dex ?? 'uniswap';
  const existing = s.positions.find(
    (p) =>
      p.chain_id === row.chainId &&
      p.token_id === row.tokenId &&
      (p.protocol ?? 'v3') === protocol &&
      (p.dex ?? 'uniswap') === dex,
  );
  if (existing) {
    // Don't re-open a position that was already closed — it may just be an NFT
    // the wallet still holds but with no active liquidity.  If the position was
    // re-minted later (new deposit), the mint handler will re-open it with a
    // fresh opened_at.  Auto-discovery only adds new positions.
    if (existing.status === 'closed' && existing.closed_at != null) return;
    // Update stale metadata (tick/pool) but keep existing status
    existing.pool_address = row.poolAddress;
    existing.tick_lower = row.tickLower;
    existing.tick_upper = row.tickUpper;
    existing.protocol = protocol;
    existing.dex = dex;
  } else {
    s.positions.push({
      token_id: row.tokenId,
      chain_id: row.chainId,
      pool_address: row.poolAddress,
      token0: row.token0,
      token1: row.token1,
      fee: row.fee,
      tick_lower: row.tickLower,
      tick_upper: row.tickUpper,
      status: 'open',
      opened_at: Date.now(),
      closed_at: null,
      protocol,
      dex,
      strategy: row.strategy,
    });
  }
  persist();
}

export function getPositionProtocol(
  chainId: SupportedChainId,
  tokenId: string,
): 'v3' | 'v4' {
  const s = load();
  const row = s.positions.find((p) => p.chain_id === chainId && p.token_id === tokenId);
  return row?.protocol === 'v4' ? 'v4' : 'v3';
}

export function getPositionDex(
  chainId: SupportedChainId,
  tokenId: string,
  protocol: 'v3' | 'v4' = 'v3',
): DexId {
  const s = load();
  const row = s.positions.find(
    (p) =>
      p.chain_id === chainId &&
      p.token_id === tokenId &&
      (p.protocol ?? 'v3') === protocol,
  );
  return isDexId(row?.dex) ? row.dex : 'uniswap';
}

/**
 * Deterministic identity for a ledger event: (chainId, txHash, kind). A
 * single on-chain transaction produces at most one ledger row per kind in
 * this codebase's existing call sites (e.g. one close tx yields at most
 * one 'withdrawal' row and one 'fee_claim' row, never two of the same
 * kind) — this is the "protocol-appropriate equivalent" of
 * chainId+txHash+logIndex+eventType for a bot that doesn't track
 * per-log granularity. `tokenId` is deliberately NOT part of the key:
 * the same (chainId, txHash) can only ever belong to one token's
 * transaction, so including it would just be redundant, not more precise.
 */
function ledgerEventKey(chainId: number, txHash: string, kind: LedgerKind): string {
  return `${chainId}:${txHash.toLowerCase()}:${kind}`;
}

/**
 * Record one ledger event — idempotent by (chainId, txHash, kind).
 * Calling this twice for the same on-chain transaction (e.g. a caller
 * accidentally re-processing a receipt, or a future reconciliation pass
 * re-importing something already recorded) must NOT double-count in
 * sumLedger()/computePositionPnl() — the duplicate call is a no-op
 * (logged, not silently swallowed) rather than a second row.
 *
 * Entries with no txHash (none of this codebase's current call sites omit
 * it, but the field is optional) have no identity to dedupe against and
 * are always recorded — matches the pre-existing behavior for those.
 */
export function recordLedger(entry: {
  chainId: SupportedChainId;
  tokenId: string;
  kind: LedgerKind;
  tokenAddress?: string;
  amountRaw?: string;
  amountHuman?: number;
  usd: number;
  txHash?: string;
  /** Phase 4: which strategy produced this event (e.g. 'multi'). Omit for manual ops. */
  strategy?: string;
}): void {
  const s = load();
  if (entry.txHash) {
    const key = ledgerEventKey(entry.chainId, entry.txHash, entry.kind);
    const dup = s.ledger.find(
      (r) => r.tx_hash != null && ledgerEventKey(r.chain_id, r.tx_hash, r.kind) === key,
    );
    if (dup) {
      console.warn(
        `[ledger] duplicate ${entry.kind} event ignored: chain=${entry.chainId} tx=${entry.txHash} ` +
          `(already recorded as ledger id ${dup.id} at ${new Date(dup.created_at).toISOString()})`,
      );
      return;
    }
  }
  s.ledger.push({
    id: s.nextLedgerId++,
    chain_id: entry.chainId,
    token_id: entry.tokenId,
    kind: entry.kind,
    token_address: entry.tokenAddress ?? null,
    amount_raw: entry.amountRaw ?? null,
    amount_human: entry.amountHuman ?? null,
    usd: entry.usd,
    tx_hash: entry.txHash ?? null,
    created_at: Date.now(),
    strategy: entry.strategy,
  });
  persist();
}

/**
 * Record one execution's slippage bound vs estimated price impact vs
 * actually realized output. Best-effort, never throws — a telemetry
 * write failure must not fail the trade it's describing.
 */
export function recordExecutionTelemetry(entry: {
  chainId: SupportedChainId;
  opType: ExecutionOpType;
  dex?: string;
  slippageBpsUsed: number;
  priceImpactBps?: number | null;
  quoteSource?: string;
  quotedAt?: number;
  route?: string;
  legs: ExecutionTelemetryLeg[];
  txHash?: string | null;
  ok: boolean;
  errorMsg?: string;
  gas?: ExecutionTelemetryGas | null;
}): void {
  try {
    const s = load();
    const rows = s.execution_telemetry!;
    const legsWithRealized = entry.legs.map((leg) => ({
      ...leg,
      realizedSlippageBps: computeRealizedSlippageBps(
        BigInt(leg.estimatedRaw),
        leg.actualRaw == null ? null : BigInt(leg.actualRaw),
      ),
    }));
    rows.push({
      id: s.nextTelemetryId!++,
      at: Date.now(),
      chain_id: entry.chainId,
      op_type: entry.opType,
      dex: entry.dex,
      slippage_bps_used: entry.slippageBpsUsed,
      price_impact_bps: entry.priceImpactBps ?? null,
      quote_source: entry.quoteSource,
      quoted_at: entry.quotedAt,
      route: entry.route,
      legs: legsWithRealized,
      tx_hash: entry.txHash ?? null,
      ok: entry.ok,
      error_msg: entry.errorMsg,
      gas: entry.gas ?? null,
    });
    if (rows.length > MAX_EXECUTION_TELEMETRY_ROWS) {
      rows.splice(0, rows.length - MAX_EXECUTION_TELEMETRY_ROWS);
    }
    persist();
  } catch (e) {
    console.warn('[telemetry] record failed', e instanceof Error ? e.message : e);
  }
}

export type ExecutionTelemetryEntry = {
  id: number;
  at: number;
  chainId: number;
  opType: ExecutionOpType;
  dex?: string;
  slippageBpsUsed: number;
  priceImpactBps: number | null;
  quoteSource?: string;
  quotedAt?: number;
  route?: string;
  legs: ExecutionTelemetryLeg[];
  txHash: string | null;
  ok: boolean;
  errorMsg?: string;
  gas?: ExecutionTelemetryGas | null;
};

export function listExecutionTelemetry(filters: {
  chainId?: SupportedChainId;
  opType?: ExecutionOpType;
  limit?: number;
} = {}): ExecutionTelemetryEntry[] {
  const s = load();
  const rows = (s.execution_telemetry ?? [])
    .filter((r) => filters.chainId == null || r.chain_id === filters.chainId)
    .filter((r) => filters.opType == null || r.op_type === filters.opType)
    .map((r) => ({
      id: r.id,
      at: r.at,
      chainId: r.chain_id,
      opType: r.op_type,
      dex: r.dex,
      slippageBpsUsed: r.slippage_bps_used,
      priceImpactBps: r.price_impact_bps,
      quoteSource: r.quote_source,
      quotedAt: r.quoted_at,
      route: r.route,
      legs: r.legs,
      txHash: r.tx_hash,
      ok: r.ok,
      errorMsg: r.error_msg,
      gas: r.gas,
    }));
  const limit = filters.limit ?? rows.length;
  return rows.slice(Math.max(0, rows.length - limit));
}

export function markClosed(chainId: SupportedChainId, tokenId: string): void {
  const s = load();
  const row = s.positions.find((p) => p.chain_id === chainId && p.token_id === tokenId);
  if (row) {
    row.status = 'closed';
    row.closed_at = Date.now();
    row.tp_sl_enabled = false;
    persist();
  }
}

export type PositionTpSl = {
  tokenId: string;
  chainId: number;
  protocol: 'v3' | 'v4';
  dex: DexId;
  label: string | null;
  status: 'open' | 'closed';
  tpSlEnabled: boolean;
  tpPercent: number | null;
  slPercent: number | null;
};

function findPositionRow(
  chainId: SupportedChainId | null,
  tokenId: string,
): PositionRow | undefined {
  const s = load();
  const id = tokenId.replace(/^#/, '').trim();
  if (chainId != null) {
    const on = s.positions.find((p) => p.chain_id === chainId && p.token_id === id);
    if (on) return on;
  }
  return s.positions.find((p) => p.token_id === id);
}

/** Enable/disable experimental TP/SL on a tracked position. */
export function setPositionTpSl(
  chainId: SupportedChainId | null,
  tokenId: string,
  opts: { enabled: boolean; tpPercent?: number | null; slPercent?: number | null },
): PositionTpSl | null {
  const row = findPositionRow(chainId, tokenId);
  if (!row) return null;
  row.tp_sl_enabled = opts.enabled;
  if (opts.tpPercent !== undefined) {
    row.tp_percent =
      opts.tpPercent == null ? null : parseTpSlPercent(opts.tpPercent, DEFAULT_PREFS.tpPercent);
  }
  if (opts.slPercent !== undefined) {
    row.sl_percent =
      opts.slPercent == null ? null : parseTpSlPercent(opts.slPercent, DEFAULT_PREFS.slPercent);
  }
  if (!opts.enabled) {
    row.tp_percent = row.tp_percent ?? null;
    row.sl_percent = row.sl_percent ?? null;
  }
  persist();
  return {
    tokenId: row.token_id,
    chainId: row.chain_id,
    protocol: row.protocol === 'v4' ? 'v4' : 'v3',
    dex: isDexId(row.dex) ? row.dex : 'uniswap',
    label: row.label ?? null,
    status: row.status,
    tpSlEnabled: !!row.tp_sl_enabled,
    tpPercent: row.tp_percent ?? null,
    slPercent: row.sl_percent ?? null,
  };
}

export function getPositionTpSl(
  chainId: SupportedChainId | null,
  tokenId: string,
): PositionTpSl | null {
  const row = findPositionRow(chainId, tokenId);
  if (!row) return null;
  return {
    tokenId: row.token_id,
    chainId: row.chain_id,
    protocol: row.protocol === 'v4' ? 'v4' : 'v3',
    dex: isDexId(row.dex) ? row.dex : 'uniswap',
    label: row.label ?? null,
    status: row.status,
    tpSlEnabled: !!row.tp_sl_enabled,
    tpPercent: row.tp_percent ?? null,
    slPercent: row.sl_percent ?? null,
  };
}

/** Open positions with TP/SL enrolled (any chain). */
export function listTpSlEnrolledPositions(): PositionTpSl[] {
  const s = load();
  return s.positions
    .filter((p) => p.status === 'open' && p.tp_sl_enabled)
    .map((p) => ({
      tokenId: p.token_id,
      chainId: p.chain_id,
      protocol: (p.protocol === 'v4' ? 'v4' : 'v3') as 'v3' | 'v4',
      dex: (isDexId(p.dex) ? p.dex : 'uniswap') as DexId,
      label: p.label ?? null,
      status: p.status,
      tpSlEnabled: true,
      tpPercent: p.tp_percent ?? null,
      slPercent: p.sl_percent ?? null,
    }));
}

/** Any user prefs with experimental watcher on (for defaults + notify). */
export function listPrefsWithTpSlEnabled(): { userId: number; prefs: UserPrefs }[] {
  const s = load();
  const out: { userId: number; prefs: UserPrefs }[] = [];
  for (const [uid, raw] of Object.entries(s.prefs ?? {})) {
    const id = Number(uid);
    if (!Number.isFinite(id)) continue;
    const prefs = getUserPrefs(id);
    if (prefs.tpSlEnabled) out.push({ userId: id, prefs });
  }
  return out;
}

export function sumLedger(
  chainId: SupportedChainId,
  tokenId: string,
  kind: LedgerKind,
): number {
  const s = load();
  return s.ledger
    .filter((l) => l.chain_id === chainId && l.token_id === tokenId && l.kind === kind)
    .reduce((a, b) => a + (b.usd || 0), 0);
}

export type LedgerEntry = {
  id: number;
  chainId: number;
  tokenId: string;
  kind: LedgerKind;
  tokenAddress: string | null;
  amountRaw: string | null;
  amountHuman: number | null;
  usd: number;
  txHash: string | null;
  createdAt: number;
  strategy?: string;
};

export function getLedgerEntries(
  chainId: SupportedChainId | null,
  tokenId?: string,
  kind?: LedgerKind,
): LedgerEntry[] {
  const s = load();
  return s.ledger
    .filter((l) => {
      if (chainId != null && l.chain_id !== chainId) return false;
      if (tokenId != null && l.token_id !== tokenId) return false;
      if (kind != null && l.kind !== kind) return false;
      return true;
    })
    .map((l) => ({
      id: l.id,
      chainId: l.chain_id,
      tokenId: l.token_id,
      kind: l.kind,
      tokenAddress: l.token_address,
      amountRaw: l.amount_raw,
      amountHuman: l.amount_human,
      usd: l.usd,
      txHash: l.tx_hash,
      createdAt: l.created_at,
      strategy: l.strategy,
    }));
}

export function sumAllLedger(chainId: SupportedChainId | null, kind: LedgerKind): number {
  const s = load();
  return s.ledger
    .filter((l) => l.kind === kind && (chainId == null || l.chain_id === chainId))
    .reduce((a, b) => a + (b.usd || 0), 0);
}

export function listTrackedTokenIds(
  chainId: SupportedChainId,
  status: 'open' | 'closed' | 'all' = 'open',
): string[] {
  const s = load();
  return s.positions
    .filter((p) => p.chain_id === chainId && (status === 'all' || p.status === status))
    .map((p) => p.token_id);
}

export type TrackedPosition = {
  tokenId: string;
  chainId: number;
  poolAddress: string | null;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number | null;
  tickUpper: number | null;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  label: string | null;
  protocol: 'v3' | 'v4';
  dex: DexId;
  strategy?: string;
};

function mapPositionRow(p: PositionRow): TrackedPosition {
  return {
    tokenId: p.token_id,
    chainId: p.chain_id,
    poolAddress: p.pool_address,
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickLower: p.tick_lower,
    tickUpper: p.tick_upper,
    status: p.status,
    openedAt: p.opened_at,
    closedAt: p.closed_at,
    label: p.label ?? null,
    protocol: (p.protocol === 'v4' ? 'v4' : 'v3') as 'v3' | 'v4',
    dex: isDexId(p.dex) ? p.dex : 'uniswap',
    strategy: p.strategy,
  };
}

/** Positions tracked in the local ledger DB (open + closed). */
export function listTrackedPositions(
  chainId: SupportedChainId | null,
  status: 'open' | 'closed' | 'all' = 'all',
): TrackedPosition[] {
  const s = load();
  return s.positions
    .filter((p) => {
      if (chainId != null && p.chain_id !== chainId) return false;
      if (status !== 'all' && p.status !== status) return false;
      return true;
    })
    .map(mapPositionRow)
    // newest activity first (closed_at, else opened_at)
    .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
}

/** Lookup one tracked position by token id (prefer chain, else any). */
export function getTrackedPosition(
  tokenId: string,
  chainId?: SupportedChainId | null,
): TrackedPosition | null {
  const id = tokenId.replace(/^#/, '').trim();
  if (!id) return null;
  const s = load();
  const match = (p: PositionRow) => p.token_id === id;
  if (chainId != null) {
    const onChain = s.positions.find((p) => match(p) && p.chain_id === chainId);
    if (onChain) return mapPositionRow(onChain);
  }
  const any = s.positions.find(match);
  return any ? mapPositionRow(any) : null;
}

/**
 * Auto-close DB positions whose NFTs no longer exist on-chain (zombie cleanup).
 * @returns number of zombie positions that were marked closed.
 */
export function markZombieClosed(
  chainId: SupportedChainId,
  activeTokenIds: Set<string>,
): number {
  const s = load();
  let cleaned = 0;
  for (const p of s.positions) {
    if (
      p.chain_id === chainId &&
      p.status === 'open' &&
      !activeTokenIds.has(p.token_id)
    ) {
      p.status = 'closed';
      p.closed_at = Date.now();
      p.tp_sl_enabled = false;
      cleaned++;
    }
  }
  if (cleaned > 0) persist();
  return cleaned;
}

// ── Empty-shell tracking (v4 NFTs with liquidity=0) ──

/**
 * Mark a v4 NFT as empty-shell so it's skipped during future discovery scans.
 * These are NFTs held by the wallet but with zero liquidity (closed but not burned).
 */
export function markEmptyShell(
  chainId: SupportedChainId,
  tokenId: string,
): void {
  const s = load();
  if (!s.v4_empty_shells) s.v4_empty_shells = {};
  const key = String(chainId);
  if (!s.v4_empty_shells[key]) s.v4_empty_shells[key] = [];
  const list = s.v4_empty_shells[key]!;
  if (!list.includes(tokenId)) {
    list.push(tokenId);
    persist();
  }
}

/**
 * Get all known empty-shell v4 token IDs for a chain.
 */
export function getEmptyShells(chainId: SupportedChainId): Set<string> {
  const s = load();
  const key = String(chainId);
  return new Set(s.v4_empty_shells?.[key] ?? []);
}

/**
 * Remove a token from empty-shell tracking (e.g. it was reminted).
 */
export function clearEmptyShell(
  chainId: SupportedChainId,
  tokenId: string,
): void {
  const s = load();
  if (!s.v4_empty_shells) return;
  const key = String(chainId);
  const list = s.v4_empty_shells[key];
  if (!list) return;
  const idx = list.indexOf(tokenId);
  if (idx >= 0) {
    list.splice(idx, 1);
    persist();
  }
}

/**
 * Count tracked open + empty-shell positions for a chain.
 * This represents the total number of NFTs we expect the wallet to hold.
 * Used for balanceOf fast-path comparison.
 */
export function trackedNftCount(chainId: SupportedChainId): {
  open: number;
  emptyShells: number;
  total: number;
} {
  const s = load();
  const key = String(chainId);
  const open = s.positions.filter(
    (p) => p.chain_id === chainId && p.status === 'open',
  ).length;
  const emptyShells = s.v4_empty_shells?.[key]?.length ?? 0;
  return { open, emptyShells, total: open + emptyShells };
}

// ── Phase 4: MULTI strategy position metadata ──

/**
 * Persist historical entry metadata for a MULTI-opened position. Append-only:
 * if metadata already exists for (chainId, tokenId), it is left untouched
 * (never overwrite historical entry data) and this call is a no-op.
 */
export function recordMultiPositionMeta(meta: MultiPositionMeta): void {
  const s = load();
  if (!s.multi_position_meta) s.multi_position_meta = [];
  const exists = s.multi_position_meta.some(
    (m) => m.chainId === meta.chainId && m.tokenId === meta.tokenId,
  );
  if (exists) return;
  s.multi_position_meta.push(meta);
  persist();
}

export function getMultiPositionMeta(
  chainId: number,
  tokenId: string,
): MultiPositionMeta | undefined {
  const s = load();
  return (s.multi_position_meta ?? []).find(
    (m) => m.chainId === chainId && m.tokenId === tokenId,
  );
}

/** Open positions, optionally filtered to one chain — used by MULTI risk gates. */
export function listOpenPositions(chainId?: number): TrackedPosition[] {
  const s = load();
  return s.positions
    .filter((p) => p.status === 'open' && (chainId == null || p.chain_id === chainId))
    .map(mapPositionRow);
}
