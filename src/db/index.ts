import fs from 'node:fs';
import path from 'node:path';
import {
  config,
  type DexId,
  isDexId,
  isSupportedChainId,
  type SupportedChainId,
} from '../config.js';

export type LedgerKind = 'deposit' | 'withdrawal' | 'fee_claim';

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
};

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
};

let store: Store | null = null;
let storePath = '';

function load(): Store {
  if (store) return store;
  storePath = path.resolve(config.dbPath.replace(/\.db$/i, '.json'));
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  if (fs.existsSync(storePath)) {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Store;
  } else {
    store = { positions: [], ledger: [], nextLedgerId: 1, prefs: {} };
    persist();
  }
  if (!store.prefs) store.prefs = {};
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

function persist(): void {
  if (!store) return;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

/** Initialize store (call on boot). */
export function getDb(): Store {
  return load();
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

export function recordLedger(entry: {
  chainId: SupportedChainId;
  tokenId: string;
  kind: LedgerKind;
  tokenAddress?: string;
  amountRaw?: string;
  amountHuman?: number;
  usd: number;
  txHash?: string;
}): void {
  const s = load();
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
  });
  persist();
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
  chainId: number;
  tokenId: string;
  kind: LedgerKind;
  tokenAddress: string | null;
  amountRaw: string | null;
  amountHuman: number | null;
  usd: number;
  txHash: string | null;
  createdAt: number;
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
      chainId: l.chain_id,
      tokenId: l.token_id,
      kind: l.kind,
      tokenAddress: l.token_address,
      amountRaw: l.amount_raw,
      amountHuman: l.amount_human,
      usd: l.usd,
      txHash: l.tx_hash,
      createdAt: l.created_at,
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
