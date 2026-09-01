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
import { config, type SupportedChainId, CHAINS, isSupportedChainId } from '../config.js';
import {
  getActiveWallet,
  getWalletById,
  onActiveWalletChange,
  type StoredWallet,
} from '../wallet/keys.js';
import { withTxLock } from './txLock.js';
import {
  classifyBroadcastError,
  markNoRetry,
  resolveAmbiguousTx,
  type MinimalNonceClient,
  type MinimalReceiptClient,
} from './txRecovery.js';
import {
  createTxJournalEntry,
  getTxJournalEntry,
  listUnresolvedTxJournal,
  updateTxJournalEntry,
} from '../db/index.js';

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

function deriveActionLabel(kind: 'sendTransaction' | 'writeContract', firstArg: unknown): string {
  const a = (firstArg ?? {}) as Record<string, unknown>;
  if (kind === 'writeContract') {
    return `writeContract:${typeof a.functionName === 'string' ? a.functionName : 'unknown'}`;
  }
  return `sendTransaction:${a.data ? 'data' : 'native'}`;
}

/**
 * Transaction recovery wrapper (Phase 2 Part 4) — wired around the same
 * choke point txLock already uses, so every local send/write (mint, close,
 * swap, TP/SL, bridging, revoke, transfer, wrap/unwrap) is covered with no
 * per-call-site changes. See txRecovery.ts for the classification/recovery
 * logic (kept pure/testable there); this function only orchestrates it
 * against the real journal persistence and real clients.
 *
 * Flow: refuse if unresolved journal entries exist for this (chainId,
 * wallet) → attempt opportunistic recovery on them first → still
 * unresolved after that → refuse the new send (never open a new position
 * or retry while a prior broadcast's outcome is unknown). Otherwise:
 * explicit pending nonce fetched up front (so a mid-flight throw still
 * tells us what nonce was attempted) → journal entry written
 * (BROADCAST_UNKNOWN) BEFORE the broadcast RPC call → raw send. Success ⇒
 * SUBMITTED + hash. Throw ⇒ classify: a clearly local/pre-network
 * rejection (NOT_SUBMITTED) is rethrown as-is so existing caller retry
 * logic is unaffected; anything else is AMBIGUOUS ⇒ immediate bounded
 * recovery attempt, then the result is either rethrown plainly (resolved
 * NOT_SUBMITTED — safe for the caller's own retry policy to act on) or
 * rethrown marked no-retry (resolved to anything else — a duplicate send
 * would risk double-executing a trade).
 */
async function journalledSend<Args extends unknown[]>(
  chainId: SupportedChainId,
  walletAddress: Address,
  kind: 'sendTransaction' | 'writeContract',
  raw: (...args: Args) => Promise<Hex>,
  args: Args,
): Promise<Hex> {
  const publicClient = getPublicClient(chainId);
  const recoveryClient = publicClient as unknown as MinimalReceiptClient & MinimalNonceClient;

  const unresolved = listUnresolvedTxJournal({ chainId, wallet: walletAddress });
  if (unresolved.length > 0) {
    for (const entry of unresolved) {
      try {
        const outcome = await resolveAmbiguousTx(recoveryClient, {
          txHash: entry.txHash as Hex | null,
          nonce: entry.nonce,
          wallet: walletAddress,
        });
        if (outcome !== 'SUBMITTED') {
          updateTxJournalEntry(entry.id, {
            state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome,
          });
        }
      } catch (e) {
        console.error(`[tx-recovery] pre-send recovery attempt failed for #${entry.id}:`, e);
      }
    }
    const stillUnresolved = listUnresolvedTxJournal({ chainId, wallet: walletAddress });
    if (stillUnresolved.length > 0) {
      throw new Error(
        `[tx-recovery] refusing new ${kind} for ${walletAddress} on chain ${chainId}: ` +
          `${stillUnresolved.length} unresolved prior transaction(s) (journal id(s): ` +
          `${stillUnresolved.map((e) => e.id).join(',')}) — resolve or quarantine before continuing`,
      );
    }
  }

  let nonce: number | null = null;
  try {
    nonce = await publicClient.getTransactionCount({ address: walletAddress, blockTag: 'pending' });
  } catch {
    // Proceed without an explicit nonce — the raw call will fetch its own.
    // We simply lose nonce-based recovery if this specific attempt throws
    // ambiguously (hash-first recovery is unaffected).
  }

  const action = deriveActionLabel(kind, args[0]);
  const journalId = createTxJournalEntry({ chainId, wallet: walletAddress, nonce, action });

  const firstArg = (args[0] ?? {}) as Record<string, unknown>;
  const argsWithNonce =
    nonce != null && firstArg.nonce == null
      ? ([{ ...firstArg, nonce }, ...args.slice(1)] as unknown as Args)
      : args;

  try {
    const hash = await raw(...argsWithNonce);
    // The broadcast itself succeeded — that is ground truth. A journal
    // write failure here (e.g. disk I/O error) must NOT turn a genuine
    // success into a thrown error the caller could mistake for a failure
    // and retry (which would risk a duplicate broadcast); it only means
    // this journal entry stays BROADCAST_UNKNOWN until the next
    // opportunistic/startup recovery pass resolves it via the hash we
    // still return here.
    try {
      updateTxJournalEntry(journalId, { state: 'SUBMITTED', tx_hash: hash });
    } catch (persistErr) {
      console.error(`[tx-recovery] journal write failed after successful broadcast (hash=${hash}):`, persistErr);
    }
    return hash;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cls = classifyBroadcastError(e);
    // Journal writes below are wrapped defensively: a persist failure
    // (e.g. disk I/O error) must never mask the real classification result
    // or swap out the error/marking that actually propagates to the
    // caller — it only means the journal itself may be out of date until
    // the next recovery pass.
    const safeUpdate = (id: number, patch: Parameters<typeof updateTxJournalEntry>[1]) => {
      try {
        updateTxJournalEntry(id, patch);
      } catch (persistErr) {
        console.error(`[tx-recovery] journal write failed for #${id}:`, persistErr);
      }
    };
    if (cls === 'NOT_SUBMITTED') {
      safeUpdate(journalId, { state: 'NOT_SUBMITTED', error_msg: msg.slice(0, 300) });
      throw e;
    }
    // AMBIGUOUS — do not retry until resolved.
    safeUpdate(journalId, { error_msg: msg.slice(0, 300) });
    const entry = getTxJournalEntry(journalId) ?? {
      id: journalId,
      txHash: null,
      nonce,
      wallet: walletAddress,
    };
    const outcome = await resolveAmbiguousTx(recoveryClient, {
      txHash: entry.txHash as Hex | null,
      nonce: entry.nonce,
      wallet: walletAddress,
    });
    safeUpdate(journalId, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
    if (outcome === 'NOT_SUBMITTED') {
      // Definitively confirmed via nonce check that this attempt never
      // landed — safe for the caller's own retry policy to act on.
      throw e;
    }
    // CONFIRMED / MINED_REVERT / RECOVERY_REQUIRED / still-SUBMITTED
    // (pending) — never let a retry loop re-send.
    throw markNoRetry(e instanceof Error ? e : new Error(msg), {
      journalId,
      state: outcome,
    });
  }
}

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

    // Serialize sends per (chain, wallet) so two concurrent operations
    // (e.g. two TP/SL closes triggering together) can never race on the
    // same account's nonce, AND run every send through the transaction
    // recovery journal (journalledSend, Phase 2 Part 4) so an ambiguous
    // broadcast is classified and resolved before any retry can occur.
    // Wrapping here covers every existing call site — mint/close/swap/
    // TP-SL/bridging/revoke/transfer — with no changes needed anywhere
    // else. See txLock.ts for why the lock itself is safe/non-reentrant.
    const rawSendTransaction = c.sendTransaction.bind(c);
    const rawWriteContract = c.writeContract.bind(c);
    const walletAddress = w.address;
    c.sendTransaction = ((...args: Parameters<typeof rawSendTransaction>) =>
      withTxLock(key, () =>
        journalledSend(chainId, walletAddress, 'sendTransaction', rawSendTransaction, args),
      )) as typeof c.sendTransaction;
    c.writeContract = ((...args: Parameters<typeof rawWriteContract>) =>
      withTxLock(key, () =>
        journalledSend(chainId, walletAddress, 'writeContract', rawWriteContract, args),
      )) as typeof c.writeContract;

    walletClients.set(key, c);
  }
  return c;
}

/**
 * Startup recovery (Phase 2 Part 4, §6). Call once at boot, before the bot
 * starts handling commands or the TP/SL watcher starts polling — every
 * unresolved journal entry from a prior crash/restart/RPC-outage is
 * resolved (or left RECOVERY_REQUIRED, which the pre-send gate in
 * journalledSend continues to enforce on the next attempted send for that
 * wallet/chain either way, so there's no unsafe window even if this is
 * skipped or partially fails).
 */
export async function runStartupTxRecovery(): Promise<{ resolved: number; stillUnresolved: number }> {
  const unresolved = listUnresolvedTxJournal();
  if (unresolved.length === 0) return { resolved: 0, stillUnresolved: 0 };
  console.log(`[tx-recovery] startup: ${unresolved.length} unresolved transaction(s) to check`);
  let resolved = 0;
  for (const entry of unresolved) {
    try {
      if (!isSupportedChainId(entry.chainId)) continue;
      const client = getPublicClient(entry.chainId as SupportedChainId) as unknown as MinimalReceiptClient &
        MinimalNonceClient;
      const outcome = await resolveAmbiguousTx(client, {
        txHash: entry.txHash as Hex | null,
        nonce: entry.nonce,
        wallet: entry.wallet as Address,
      });
      if (outcome !== 'SUBMITTED') {
        updateTxJournalEntry(entry.id, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
        resolved++;
      }
      console.log(`[tx-recovery] startup: #${entry.id} (${entry.action}) -> ${outcome}`);
    } catch (e) {
      console.error(`[tx-recovery] startup: #${entry.id} recovery attempt threw:`, e);
    }
  }
  const stillUnresolved = unresolved.length - resolved;
  if (stillUnresolved > 0) {
    console.warn(
      `[tx-recovery] startup: ${stillUnresolved} transaction(s) still unresolved — ` +
        `new sends for the affected wallet(s) will be refused until resolved`,
    );
  }
  return { resolved, stillUnresolved };
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
