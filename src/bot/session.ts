import type { Address } from 'viem';
import type { SupportedChainId } from '../config.js';
import type { ListedPool } from '../chain/pools.js';
import { getUserPrefs, type DepositMode, type SizeMode } from '../db/index.js';
import type { AggregatedPreview } from '../chain/aggregate.js';
import type { FoundApproval } from '../chain/revoke.js';
import type { MultiStrategyRun } from '../strategy/types.js';

export type FlowStep =
  | 'idle'
  | 'await_ca'
  | 'pick_pool'
  | 'pick_width'
  | 'pick_asset'
  | 'await_percent'
  | 'await_settings_percent'
  | 'await_settings_fixed'
  | 'await_settings_width'
  | 'await_settings_tp'
  | 'await_settings_sl'
  | 'confirm_mint'
  | 'confirm_create_v4'
  | 'pick_create_v4_fee'
  | 'await_create_v4_fee'
  | 'await_settings_mintvl'
  | 'pick_close'
  | 'await_bridge_amount'
  | 'bridge_confirm'
  | 'await_swap_amount'
  | 'swap_confirm'
  | 'await_swap_to_ca'
  | 'await_swap_from_ca'
  | 'revoke_list'
  | 'await_wrap_amount'
  | 'await_unwrap_amount'
  | 'await_import_pk'
  | 'await_wallet_label'
  | 'await_transfer_amount'
  | 'await_wallet_rename'
  | 'await_screener_vol'
  | 'await_screener_kol'
  | 'await_screener_fees'
  | 'await_screener_mcap'
  | 'await_screener_maxmcap'
  | 'await_screener_limit'
  | 'await_alert_vol'
  | 'await_alert_kol'
  | 'await_alert_fees'
  | 'await_alert_mcap'
  | 'await_alert_maxmcap';

/** /swap: Relay listed pairs vs Uniswap custom CA */
export type SwapKind = 'relay' | 'token';

export type UserSession = {
  chainId: SupportedChainId;
  widthPercent: number;
  balancePercent: number;
  sizeMode: SizeMode;
  fixedAmountHuman: number;
  depositMode: DepositMode;
  step: FlowStep;
  tokenCa?: Address;
  pools?: ListedPool[];
  selectedPool?: ListedPool;
  depositToken?: Address;
  depositSymbol?: string;
  /**
   * Mint confirm: pool/range far from DexScreener market.
   * First ✅ shows risk confirm; second (mint:confirm:force) actually mints.
   */
  mintPriceMismatch?: boolean;
  /** Pending create-v4 flow (no existing pool for this CA) */
  createV4Meme?: Address;
  createV4Quote?: Address;
  createV4PreviewText?: string;
  /** v4 fee in hundredths of a bip (10000 = 1%) */
  createV4Fee?: number;
  createV4TickSpacing?: number;
  /** true when user tapped Asset… (keep choice); false for Dep Auto re-pick */
  depositUserPicked?: boolean;
  closeTokenIds?: string[];
  /** /tokens list for swap buttons */
  walletTokens?: { address: Address; symbol: string }[];
  /** /bridge flow */
  bridgeFromChain?: SupportedChainId;
  bridgeToChain?: SupportedChainId;
  bridgeFromSymbol?: string;
  bridgeToSymbol?: string;
  bridgeAmount?: bigint;
  bridgePreview?: AggregatedPreview;
  /** /swap (Relay/Across same-chain native↔stable, or Uniswap custom CA) */
  swapChainId?: SupportedChainId;
  swapKind?: SwapKind;
  swapFromSymbol?: string;
  swapToSymbol?: string;
  /** ERC-20 addresses; native uses zero address when swapFromIsNative/to */
  swapFromToken?: Address;
  swapToToken?: Address;
  swapFromIsNative?: boolean;
  swapToIsNative?: boolean;
  swapAmount?: bigint;
  swapPreview?: AggregatedPreview;
  /** Uniswap custom quote lines (when swapKind=token) */
  swapTokenQuoteText?: string;
  /** /revoke scanned approvals */
  revokeApprovals?: FoundApproval[];
  /** /wrap · /unwrap pending amount (wei) */
  wrapAmount?: bigint;
  /** Multi-wallet: import / rename / transfer */
  walletPendingLabel?: string;
  walletRenameId?: string;
  /** After import or generate, optional label prompt target id */
  walletLabelTargetId?: string;
  transferFromId?: string;
  transferToId?: string;
  transferChainId?: SupportedChainId;
  /** 'native' or token address */
  transferAsset?: 'native' | Address;
  transferSymbol?: string;
  transferAmount?: bigint;
  /** /screener last result (pagination / mint buttons) */
  screenerTokens?: {
    address: Address;
    symbol: string;
    name: string;
    price: number;
    priceChangePct: number;
    volumeUsd: number;
    liquidityUsd: number;
    mcapUsd: number;
    holders: number;
    kol: number;
    totalFee: number;
    rank: number;
  }[];
  screenerPage?: number;
  /** /multi last dry-run result (candidates + intents) for the Execute buttons */
  multiRun?: MultiStrategyRun;
};

const sessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession {
  let s = sessions.get(userId);
  if (!s) {
    const prefs = getUserPrefs(userId);
    s = {
      chainId: prefs.chainId,
      widthPercent: prefs.widthPercent,
      balancePercent: prefs.balancePercent,
      sizeMode: prefs.sizeMode,
      fixedAmountHuman: prefs.fixedAmountHuman,
      depositMode: prefs.depositMode,
      step: 'idle',
    };
    sessions.set(userId, s);
  }
  return s;
}

/** Apply prefs into live session (after /settings change). */
export function syncSessionFromPrefs(userId: number): UserSession {
  const prefs = getUserPrefs(userId);
  const s = getSession(userId);
  s.chainId = prefs.chainId;
  s.widthPercent = prefs.widthPercent;
  s.balancePercent = prefs.balancePercent;
  s.sizeMode = prefs.sizeMode;
  s.fixedAmountHuman = prefs.fixedAmountHuman;
  s.depositMode = prefs.depositMode;
  return s;
}

/** Clear bridge-only session fields. */
export function clearBridgeSession(s: UserSession): void {
  s.bridgeFromChain = undefined;
  s.bridgeToChain = undefined;
  s.bridgeFromSymbol = undefined;
  s.bridgeToSymbol = undefined;
  s.bridgeAmount = undefined;
  s.bridgePreview = undefined;
}

export function clearSwapSession(s: UserSession): void {
  s.swapChainId = undefined;
  s.swapKind = undefined;
  s.swapFromSymbol = undefined;
  s.swapToSymbol = undefined;
  s.swapFromToken = undefined;
  s.swapToToken = undefined;
  s.swapFromIsNative = undefined;
  s.swapToIsNative = undefined;
  s.swapAmount = undefined;
  s.swapPreview = undefined;
  s.swapTokenQuoteText = undefined;
}

export function clearRevokeSession(s: UserSession): void {
  s.revokeApprovals = undefined;
}

export function clearWrapSession(s: UserSession): void {
  s.wrapAmount = undefined;
}

export function clearWalletSession(s: UserSession): void {
  s.walletPendingLabel = undefined;
  s.walletRenameId = undefined;
  s.walletLabelTargetId = undefined;
  s.transferFromId = undefined;
  s.transferToId = undefined;
  s.transferChainId = undefined;
  s.transferAsset = undefined;
  s.transferSymbol = undefined;
  s.transferAmount = undefined;
}

/** Reset mint/close/bridge/swap/revoke/wrap/wallet flow; keep persistent prefs. */
export function resetFlow(userId: number): void {
  const s = getSession(userId);
  const { chainId, widthPercent, balancePercent, sizeMode, fixedAmountHuman, depositMode } = s;
  s.step = 'idle';
  s.tokenCa = undefined;
  s.pools = undefined;
  s.selectedPool = undefined;
  s.depositToken = undefined;
  s.depositSymbol = undefined;
  s.depositUserPicked = undefined;
  s.closeTokenIds = undefined;
  clearBridgeSession(s);
  clearSwapSession(s);
  clearRevokeSession(s);
  clearWrapSession(s);
  clearWalletSession(s);
  s.chainId = chainId;
  s.widthPercent = widthPercent;
  s.balancePercent = balancePercent;
  s.sizeMode = sizeMode;
  s.fixedAmountHuman = fixedAmountHuman;
  s.depositMode = depositMode;
}

export function clearSession(userId: number): void {
  sessions.delete(userId);
}
