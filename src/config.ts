import 'dotenv/config';
import { type Address, isAddress } from 'viem';
import { resolvePrivateKey } from './wallet/keys.js';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

/**
 * Phase 4.6.6: fail-closed validation for an environment-supplied RPC URL.
 * Only http/https are accepted — the only schemes this codebase's actual
 * transport (viem's `http()`, see chain/clients.ts's getPublicClient/
 * getWalletClient) can use; anything else would silently never work.
 * Absent env vars are untouched here — callers only invoke this when the
 * variable is actually present, so a missing (optional) RPC override
 * still falls through to the existing hardcoded default unchanged.
 */
export function assertValidRpcUrl(varName: string, raw: string): string {
  if (raw !== raw.trim() || raw.trim() === '') {
    throw new Error(
      `Invalid ${varName}: value is empty or has leading/trailing whitespace`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${varName}: not a valid URL (expected http:// or https://)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Invalid ${varName}: unsupported protocol "${url.protocol}" (expected http:// or https://)`,
    );
  }
  return raw;
}

/** Reads an RPC env var if present, validating it; returns the default unvalidated (trusted, hardcoded) if absent. */
function resolveRpcUrl(varName: string, defaultUrl: string): string {
  const raw = process.env[varName];
  if (raw == null) return defaultUrl;
  return assertValidRpcUrl(varName, raw);
}

/**
 * Phase 4.6.6: fail-closed validation for an environment-supplied EVM
 * address, using viem's own `isAddress` (already a dependency — no new
 * validation library added). Absent env vars are untouched — this is
 * only invoked when the variable is actually present.
 */
export function assertValidOptionalAddress(varName: string, raw: string): Address {
  if (raw !== raw.trim() || raw.trim() === '') {
    throw new Error(`Invalid ${varName}: value is empty or has leading/trailing whitespace`);
  }
  if (!isAddress(raw)) {
    throw new Error(`Invalid ${varName}: not a valid EVM address`);
  }
  return raw as Address;
}

/** Reads an optional address env var if present, validating it; undefined if absent (existing behavior preserved). */
function resolveOptionalAddressEnv(varName: string): Address | undefined {
  const raw = process.env[varName];
  if (raw == null) return undefined;
  return assertValidOptionalAddress(varName, raw);
}

function parseUserIds(raw: string | undefined): Set<number> {
  if (!raw?.trim()) throw new Error('Missing env: TELEGRAM_USER_IDS');
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (ids.some((n) => !Number.isFinite(n))) {
    throw new Error('TELEGRAM_USER_IDS must be comma-separated numbers');
  }
  return new Set(ids);
}

/**
 * Phase 4.7.1 — global non-trading staging/dry-run gate.
 *
 * 'live' (default, existing behavior unchanged) — every write path behaves
 * exactly as before this phase; nothing here alters production behavior
 * when TRADING_MODE is unset or explicitly 'live'.
 *
 * 'staging' — the ENTIRE application (main(), instance lock, startup
 * recovery, health, Telegram, TP/SL watcher, MULTI's read-only discovery)
 * may run normally, but the single, centralized broadcast choke point
 * (chain/clients.ts's journalledSend — the sole place `createWalletClient`
 * is ever constructed, wrapping every sendTransaction/writeContract call in
 * this codebase) refuses to call the real RPC send and throws a dedicated,
 * typed StagingBlockedError instead. See chain/clients.ts for the
 * enforcement; this file only parses/validates the mode name, exactly
 * mirroring strategy/multiConfig.ts's STRATEGY pattern (assertValidEnv at
 * startup, a separate never-throwing live getter for hot-path reads).
 */
export type TradingMode = 'live' | 'staging';

const VALID_TRADING_MODES: readonly TradingMode[] = ['live', 'staging'];

/**
 * Live, uncached read — called on every send inside journalledSend (a hot
 * path), so this stays a cheap string compare with no I/O, mirroring
 * strategy/multiConfig.ts's getActiveStrategyName(). MISSING (unset) is
 * intentionally NOT an error — it is the existing, documented default
 * ('live'), so a deployment that predates this phase (or simply never sets
 * TRADING_MODE) sees byte-for-byte the same behavior as before this phase.
 */
export function getTradingMode(): TradingMode {
  const raw = (process.env.TRADING_MODE ?? 'live').trim().toLowerCase();
  return raw === 'staging' ? 'staging' : 'live';
}

/**
 * Authoritative startup-time TRADING_MODE validation — a present-but-
 * unrecognized value (typo, garbage) is rejected outright rather than
 * silently absorbed into 'live', exactly like assertValidStrategyEnv's
 * treatment of STRATEGY. Call once, early at process startup, before any
 * transaction-capable service starts; a thrown error here is expected to
 * propagate to the top-level startup failure handler. Deliberately
 * separate from getTradingMode() above, which stays unchanged and must
 * keep never throwing — it is read on every send, not just once at
 * startup.
 */
export function assertValidTradingModeEnv(): void {
  const raw = process.env.TRADING_MODE;
  if (raw == null) return; // unset — existing 'live' default applies, not an error
  const normalized = raw.trim().toLowerCase();
  if ((VALID_TRADING_MODES as readonly string[]).includes(normalized)) return;
  throw new Error(
    `Invalid TRADING_MODE "${raw}": expected one of ${VALID_TRADING_MODES.join(', ')} (or unset, which defaults to 'live')`,
  );
}

export const SUPPORTED_CHAIN_IDS = [4663, 56, 8453] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export function isSupportedChainId(id: number): id is SupportedChainId {
  return (SUPPORTED_CHAIN_IDS as readonly number[]).includes(id);
}

/** Canonical Permit2 (same on most EVM chains Uniswap deploys to) */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;

/** AMM venue for v3 concentrated-liquidity positions */
export type DexId = 'uniswap' | 'pancakeswap';

export type V3Contracts = {
  factory: Address;
  npm: Address;
  swapRouter: Address;
};

/** PancakeSwap V3 fee tiers (medium is 2500 = 0.25%, not Uniswap's 3000) */
export const PCS_FEE_TIERS = [100, 500, 2500, 10000] as const;

/** Short label for UI (pool picker, /list, PnL) */
export function dexLabel(dex: DexId | undefined): string {
  return dex === 'pancakeswap' ? 'PCS' : 'UNI';
}

/** Callback-safe short code */
export function dexCode(dex: DexId | undefined): 'uni' | 'pcs' {
  return dex === 'pancakeswap' ? 'pcs' : 'uni';
}

export function parseDexCode(code: string | undefined): DexId {
  if (code === 'pcs' || code === 'pancakeswap') return 'pancakeswap';
  return 'uniswap';
}

export function isDexId(v: unknown): v is DexId {
  return v === 'uniswap' || v === 'pancakeswap';
}

/** Official Uniswap v3 + v4 + known tokens per chain (+ optional PancakeSwap V3) */
export const CHAINS = {
  4663: {
    id: 4663 as const,
    name: 'Robinhood',
    nativeSymbol: 'ETH',
    wrappedSymbol: 'WETH',
    dexscreenerSlug: 'robinhood',
    explorer: 'https://robinhoodchain.blockscout.com',
    rpcEnv: 'RPC_4663',
    // Public endpoint often blocked; override via RPC_4663 if needed
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
    npm: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address,
    swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2' as Address,
    wrapped: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
    /** Primary stable on Robinhood */
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
    usdc: resolveOptionalAddressEnv('USDC_4663'),
    usdt: undefined as Address | undefined,
    // Uniswap v4 (official deployments)
    v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address,
    v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7' as Address,
    v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address,
    pancakeswapV3: undefined as V3Contracts | undefined,
  },
  56: {
    id: 56 as const,
    name: 'BSC',
    nativeSymbol: 'BNB',
    wrappedSymbol: 'WBNB',
    dexscreenerSlug: 'bsc',
    explorer: 'https://bscscan.com',
    rpcEnv: 'RPC_56',
    // binance.org seeds often blocked; 1rpc is more reachable
    defaultRpc: 'https://1rpc.io/bnb',
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7' as Address,
    npm: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613' as Address,
    swapRouter02: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2' as Address,
    wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address,
    usdg: undefined as Address | undefined,
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as Address,
    /** Binance-Peg BSC-USD (USDT) */
    usdt: '0x55d398326f99059fF775485246999027B3197955' as Address,
    // Uniswap v4 (official deployments)
    v4PoolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df' as Address,
    v4PositionManager: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b' as Address,
    v4StateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4' as Address,
    // PancakeSwap V3: https://developer.pancakeswap.finance/contracts/v3/addresses
    pancakeswapV3: {
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address,
      npm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as Address,
      swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14' as Address,
    } satisfies V3Contracts,
  },
  8453: {
    id: 8453 as const,
    name: 'Base',
    nativeSymbol: 'ETH',
    wrappedSymbol: 'WETH',
    dexscreenerSlug: 'base',
    explorer: 'https://basescan.org',
    rpcEnv: 'RPC_8453',
    defaultRpc: 'https://mainnet.base.org',
    // Uniswap v3 (official): https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
    npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1' as Address,
    swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address,
    wrapped: '0x4200000000000000000000000000000000000006' as Address,
    usdg: undefined as Address | undefined,
    /** Circle native USDC on Base */
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    usdt: undefined as Address | undefined,
    // Uniswap v4 (official): https://developers.uniswap.org/docs/protocols/v4/deployments
    v4PoolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b' as Address,
    v4PositionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc' as Address,
    v4StateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71' as Address,
    pancakeswapV3: undefined as V3Contracts | undefined,
  },
} as const;

export type ProtocolVersion = 'v3' | 'v4';

/** Which v3 venues are available on a chain */
export function availableV3Dexes(chainId: SupportedChainId): DexId[] {
  const out: DexId[] = ['uniswap'];
  if (CHAINS[chainId].pancakeswapV3) out.push('pancakeswap');
  return out;
}

/** Resolve factory / NPM / swap router for a v3 venue */
export function resolveV3Contracts(chainId: SupportedChainId, dex: DexId = 'uniswap'): V3Contracts {
  const c = CHAINS[chainId];
  if (dex === 'pancakeswap') {
    if (!c.pancakeswapV3) {
      throw new Error(`PancakeSwap V3 not deployed on ${c.name}`);
    }
    return c.pancakeswapV3;
  }
  return {
    factory: c.factory,
    npm: c.npm,
    swapRouter: c.swapRouter02,
  };
}

export const RANGE_PRESETS = [20, 30, 50] as const;
export type RangePreset = number;

export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Fee tiers to probe for multi-hop routing on a venue */
export function feeTiersForDex(dex: DexId): readonly number[] {
  return dex === 'pancakeswap' ? PCS_FEE_TIERS : FEE_TIERS;
}

type AppConfig = {
  telegramToken: string;
  allowedUserIds: Set<number>;
  privateKey: `0x${string}`;
  walletAddress: string;
  walletSource: 'env' | 'file' | 'generated';
  walletPath: string;
  dbPath: string;
  rpc: Record<SupportedChainId, string>;
};

let _config: AppConfig | null = null;

/**
 * Lazy secrets — only throws when first accessed (bot start / wallet ops).
 * Active wallet from multi-wallet store (data/wallets.json):
 * PRIVATE_KEY / legacy hot-wallet.json / auto-generate on first run.
 * Switch wallets via /wallet in Telegram — use getActiveWallet() for live key.
 */
export function getConfig(): AppConfig {
  if (_config) return _config;
  const wallet = resolvePrivateKey();
  _config = {
    telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: parseUserIds(process.env.TELEGRAM_USER_IDS),
    privateKey: wallet.privateKey,
    walletAddress: wallet.address,
    walletSource: wallet.source,
    walletPath: wallet.walletPath,
    dbPath: process.env.DB_PATH ?? './data/bot.json',
    rpc: {
      4663: resolveRpcUrl('RPC_4663', CHAINS[4663].defaultRpc),
      56: resolveRpcUrl('RPC_56', CHAINS[56].defaultRpc),
      8453: resolveRpcUrl('RPC_8453', CHAINS[8453].defaultRpc),
    },
  };
  return _config;
}

/** @deprecated use getConfig() — kept for fewer call-site edits */
export const config = new Proxy({} as AppConfig, {
  get(_t, prop: keyof AppConfig) {
    return getConfig()[prop];
  },
});

export function assertAddress(addr: string): Address {
  if (!isAddress(addr)) throw new Error(`Invalid address: ${addr}`);
  return addr as Address;
}

/** Deposit assets available on a chain (address + label) */
export function depositAssets(chainId: SupportedChainId): { address: Address; symbol: string }[] {
  const c = CHAINS[chainId];
  const out: { address: Address; symbol: string }[] = [
    { address: c.wrapped, symbol: c.wrappedSymbol },
  ];
  if (c.usdg) out.push({ address: c.usdg, symbol: 'USDG' });
  if (c.usdt) out.push({ address: c.usdt, symbol: 'USDT' });
  if (c.usdc) out.push({ address: c.usdc, symbol: 'USDC' });
  return out;
}

/** Prefer USDG (Robinhood) → USDT (BSC) → USDC (Base) */
export function primaryStableAddress(chainId: SupportedChainId): Address | undefined {
  const c = CHAINS[chainId];
  const list = [c.usdg, c.usdt, c.usdc].filter((a): a is Address => !!a);
  return list[0];
}

/** Human label for the primary stable on a chain */
export function primaryStableSymbol(chainId: SupportedChainId): string {
  const c = CHAINS[chainId];
  if (c.usdg) return 'USDG';
  if (c.usdt) return 'USDT';
  if (c.usdc) return 'USDC';
  return 'stable';
}

export function txUrl(chainId: SupportedChainId, hash: string): string {
  return `${CHAINS[chainId].explorer}/tx/${hash}`;
}

export function addressUrl(chainId: SupportedChainId, addr: string): string {
  return `${CHAINS[chainId].explorer}/address/${addr}`;
}
