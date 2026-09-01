import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, bsc } from 'viem/chains';
import { config, type SupportedChainId, CHAINS } from '../config.js';
import {
  getActiveWallet,
  getWalletById,
  onActiveWalletChange,
  type StoredWallet,
} from '../wallet/keys.js';

export const robinhood = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [CHAINS[4663].defaultRpc] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: CHAINS[4663].explorer },
  },
  // Present on-chain; required so viem client.multicall() works (speeds up /list)
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 0,
    },
  },
} as const satisfies Chain;

const chainMap: Record<SupportedChainId, Chain> = {
  4663: robinhood,
  56: bsc,
  8453: base,
};

type AppPublicClient = PublicClient<Transport, Chain>;
type AppWalletClient = WalletClient<Transport, Chain, Account>;

const publicClients = new Map<SupportedChainId, AppPublicClient>();
/** key = `${chainId}:${walletId}` */
const walletClients = new Map<string, AppWalletClient>();
const accountCache = new Map<string, Account>();

const RPC_TIMEOUT_MS = 12_000;

function accountForWallet(w: StoredWallet): Account {
  let acc = accountCache.get(w.id);
  if (!acc) {
    acc = privateKeyToAccount(w.privateKey);
    accountCache.set(w.id, acc);
  }
  return acc;
}

/** Drop cached wallet clients (call after active wallet switch). */
export function invalidateWalletClients(): void {
  walletClients.clear();
  // Keep accountCache — keys unchanged; active id changes only.
}

onActiveWalletChange(() => {
  invalidateWalletClients();
});

export function getPublicClient(chainId: SupportedChainId): AppPublicClient {
  let c = publicClients.get(chainId);
  if (!c) {
    c = createPublicClient({
      chain: chainMap[chainId],
      transport: http(config.rpc[chainId], {
        timeout: RPC_TIMEOUT_MS,
        retryCount: 1,
        retryDelay: 500,
      }),
    });
    publicClients.set(chainId, c);
  }
  return c;
}

/**
 * Wallet client for a specific stored wallet, or the active wallet if omitted.
 * Used for transfers from a non-active source wallet.
 */
export function getWalletClient(
  chainId: SupportedChainId,
  walletId?: string,
): AppWalletClient {
  const w = walletId ? getWalletById(walletId) : getActiveWallet();
  if (!w) throw new Error(walletId ? `Wallet not found: ${walletId}` : 'No active wallet');
  const key = `${chainId}:${w.id}`;
  let c = walletClients.get(key);
  if (!c) {
    c = createWalletClient({
      account: accountForWallet(w),
      chain: chainMap[chainId],
      transport: http(config.rpc[chainId], {
        timeout: RPC_TIMEOUT_MS,
        retryCount: 1,
        retryDelay: 500,
      }),
    });
    walletClients.set(key, c);
  }
  return c;
}

export function getHotWalletAddress(walletId?: string): Address {
  if (walletId) {
    const w = getWalletById(walletId);
    if (!w) throw new Error(`Wallet not found: ${walletId}`);
    return w.address;
  }
  return getActiveWallet().address;
}

export function getAccount(walletId?: string): Account {
  const w = walletId ? getWalletById(walletId) : getActiveWallet();
  if (!w) throw new Error(walletId ? `Wallet not found: ${walletId}` : 'No active wallet');
  return accountForWallet(w);
}

export type { Hex };
