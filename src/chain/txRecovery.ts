/**
 * Transaction recovery — Phase 2 Part 4.
 *
 * Problem: `sendTransaction`/`writeContract` can throw AFTER the RPC node
 * may already have received and relayed the transaction (timeout,
 * connection reset, load balancer hiccup). Treating that throw as "the
 * transaction failed, safe to retry" risks a duplicate broadcast — two
 * transactions competing for the same nonce, or worse, both eventually
 * landing if the first wasn't actually dropped. This module classifies
 * broadcast failures and, when ambiguous, tries to resolve them before any
 * caller is allowed to retry.
 *
 * States (see db/index.ts's `TxJournalState` for the persisted subset):
 * CREATED → SIMULATED → GAS_ESTIMATED (all pre-broadcast, never persisted —
 * nothing to recover if the process dies before a real network call) →
 * BROADCAST_UNKNOWN (persisted right before the broadcast RPC call) →
 * SUBMITTED (hash known) → MINED_SUCCESS | MINED_REVERT (receipt known) →
 * CONFIRMED, or RECOVERY_REQUIRED / NOT_SUBMITTED when the outcome had to
 * be inferred rather than directly observed.
 *
 * Everything in this file is pure / dependency-injected (mockable clients,
 * no config/db import) so it can be unit tested without live RPC — see
 * test/txRecovery.test.ts. The orchestration that actually persists state
 * (calling db/index.ts's journal functions) lives in clients.ts, the one
 * place every local send/write already funnels through.
 */
import type { Address, Hash } from 'viem';

export type RecoveryOutcome =
  | 'CONFIRMED'
  | 'MINED_REVERT'
  | 'NOT_SUBMITTED'
  | 'RECOVERY_REQUIRED'
  | 'SUBMITTED'; // still pending after bounded polling — unresolved, try again later

/** Marker attached to an error so it can never be retried, regardless of any caller's own shouldRetry logic. */
const NO_RETRY_KEY = '__txNoRetry';

export function markNoRetry(
  e: Error,
  meta: { journalId?: number; state: RecoveryOutcome | 'BROADCAST_UNKNOWN' },
): Error {
  (e as unknown as Record<string, unknown>)[NO_RETRY_KEY] = true;
  (e as unknown as Record<string, unknown>)['__txJournalId'] = meta.journalId;
  (e as unknown as Record<string, unknown>)['__txRecoveryState'] = meta.state;
  return e;
}

/** Used by retry.ts (and any other retry wrapper) to veto retrying a marked error. Duck-typed, no import cycle. */
export function isNoRetryTxError(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as Record<string, unknown>)[NO_RETRY_KEY] === true);
}

/**
 * Classify a thrown broadcast error. Fail-closed by default: anything that
 * isn't a clearly-local, pre-network rejection is treated as AMBIGUOUS
 * (i.e. "the node may have received it"). Do NOT extend the NOT_SUBMITTED
 * pattern list with anything that could plausibly happen after the node
 * already accepted the transaction.
 */
export function classifyBroadcastError(e: unknown): 'AMBIGUOUS' | 'NOT_SUBMITTED' {
  const msg = e instanceof Error ? e.message : String(e);
  // Local/pre-network validation rejections — the RPC layer rejected the
  // request before it could have been broadcast to the network at all.
  if (
    /insufficient funds|invalid address|invalid signature|invalid params|unknown account|does not match|intrinsic gas too low|nonce too low/i.test(
      msg,
    )
  ) {
    return 'NOT_SUBMITTED';
  }
  // Timeouts, connection resets, generic/unknown RPC errors: we cannot
  // prove the node never received or relayed the broadcast.
  return 'AMBIGUOUS';
}

export type MinimalReceiptClient = {
  getTransactionReceipt: (args: { hash: Hash }) => Promise<{ status: 'success' | 'reverted' } | null>;
};

export async function pollReceiptOnce(
  client: MinimalReceiptClient,
  hash: Hash,
): Promise<'MINED_SUCCESS' | 'MINED_REVERT' | 'PENDING'> {
  try {
    const r = await client.getTransactionReceipt({ hash });
    if (!r) return 'PENDING';
    return r.status === 'success' ? 'MINED_SUCCESS' : 'MINED_REVERT';
  } catch {
    // Not found / RPC hiccup reading the receipt — still unresolved, NOT a
    // failure signal. Never interpret a receipt-lookup error as "reverted".
    return 'PENDING';
  }
}

const RECEIPT_POLL_ATTEMPTS = 6;
const RECEIPT_POLL_BACKOFF_MS = 2_000;

export async function waitForReceiptBounded(
  client: MinimalReceiptClient,
  hash: Hash,
  attempts = RECEIPT_POLL_ATTEMPTS,
  backoffMs = RECEIPT_POLL_BACKOFF_MS,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<'MINED_SUCCESS' | 'MINED_REVERT' | 'PENDING'> {
  for (let i = 1; i <= attempts; i++) {
    const r = await pollReceiptOnce(client, hash);
    if (r !== 'PENDING') return r;
    if (i < attempts) await sleepFn(backoffMs * i);
  }
  return 'PENDING';
}

export type MinimalNonceClient = {
  getTransactionCount: (args: { address: Address; blockTag: 'pending' | 'latest' }) => Promise<number>;
};

/**
 * Compare the account's current pending nonce to the nonce this specific
 * attempt used. Never treats an RPC error as either outcome.
 */
export async function checkNonceConsumed(
  client: MinimalNonceClient,
  address: Address,
  attemptedNonce: number,
): Promise<'CONSUMED' | 'NOT_CONSUMED' | 'UNKNOWN'> {
  try {
    const pending = await client.getTransactionCount({ address, blockTag: 'pending' });
    return pending > attemptedNonce ? 'CONSUMED' : 'NOT_CONSUMED';
  } catch {
    return 'UNKNOWN';
  }
}

const NONCE_CHECK_ATTEMPTS = 5;
const NONCE_CHECK_BACKOFF_MS = 2_500;

export type RecoverableEntry = {
  txHash: Hash | null;
  nonce: number | null;
  wallet: Address;
};

/**
 * Resolve one ambiguous broadcast to a concrete outcome.
 *
 * Hash-first: if a hash is known, poll for its receipt (bounded). A
 * definitive success/revert resolves immediately; still-pending after the
 * bounded window stays SUBMITTED (unresolved — try again later, never
 * silently assumed either way).
 *
 * Nonce fallback: no hash known. Poll the account's pending nonce
 * (bounded, with backoff). Only a nonce that has NOT advanced across every
 * check in the bounded window is trusted as NOT_SUBMITTED — a single
 * "not yet visible" read does not prove non-submission (mempool
 * propagation can lag). If the nonce DID advance, we know something with
 * that nonce was broadcast — but with no hash we cannot tell success from
 * revert from "someone else's tx" (impossible in practice since sends for
 * one wallet are fully serialized upstream, but we still don't guess) —
 * RECOVERY_REQUIRED, halting automated retry.
 */
export async function resolveAmbiguousTx(
  client: MinimalReceiptClient & MinimalNonceClient,
  entry: RecoverableEntry,
  opts: {
    receiptAttempts?: number;
    receiptBackoffMs?: number;
    nonceAttempts?: number;
    nonceBackoffMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<RecoveryOutcome> {
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (entry.txHash) {
    const r = await waitForReceiptBounded(
      client,
      entry.txHash,
      opts.receiptAttempts ?? RECEIPT_POLL_ATTEMPTS,
      opts.receiptBackoffMs ?? RECEIPT_POLL_BACKOFF_MS,
      sleepFn,
    );
    if (r === 'MINED_SUCCESS') return 'CONFIRMED';
    if (r === 'MINED_REVERT') return 'MINED_REVERT';
    return 'SUBMITTED'; // still pending — unresolved, not a failure
  }

  if (entry.nonce == null) return 'RECOVERY_REQUIRED';

  const nonceAttempts = opts.nonceAttempts ?? NONCE_CHECK_ATTEMPTS;
  const nonceBackoffMs = opts.nonceBackoffMs ?? NONCE_CHECK_BACKOFF_MS;
  let notConsumedStreak = 0;
  for (let i = 1; i <= nonceAttempts; i++) {
    const r = await checkNonceConsumed(client, entry.wallet, entry.nonce);
    if (r === 'CONSUMED') return 'RECOVERY_REQUIRED';
    if (r === 'NOT_CONSUMED') {
      notConsumedStreak++;
      if (notConsumedStreak >= nonceAttempts) return 'NOT_SUBMITTED';
    } else {
      // RPC uncertainty resets the streak — a flaky read must not be
      // allowed to race its way to a false "safe to retry".
      notConsumedStreak = 0;
    }
    if (i < nonceAttempts) await sleepFn(nonceBackoffMs * i);
  }
  return 'RECOVERY_REQUIRED';
}

/**
 * Startup / opportunistic recovery over a set of unresolved journal
 * entries. Dependency-injected so it's testable without db/config, and
 * reusable both at bot boot and as a pre-send gate (clients.ts).
 */
/**
 * Phase 4.6.3: entries are recovered CONCURRENTLY, not one-at-a-time.
 * Each entry's check (`resolveAmbiguousTx` — a bounded receipt poll or
 * pending-nonce poll) is an independent, read-only RPC lookup keyed on
 * that entry's own txHash/nonce: none of them share mutable state, none
 * can submit a transaction, and none can affect another entry's
 * classification. Running N of them sequentially costs O(sum of their
 * latencies) — with a slow/flaky RPC this turned "check 5 unresolved
 * transactions before sending" into a multi-minute stall even though the
 * checks don't depend on each other. Concurrently, it costs
 * O(max of their latencies) instead. This changes WHEN the reads happen,
 * not WHAT they check or how outcomes are classified: `resolveAmbiguousTx`
 * itself is completely unchanged, and every entry is still classified
 * independently and explicitly — a slow/failing entry can never affect
 * another entry's result, and never gets silently upgraded past its own
 * true outcome.
 *
 * Each entry's recovery attempt catches its own error internally (exactly
 * matching the prior sequential loop's per-entry try/catch) so `Promise.all`
 * here can never reject — one entry throwing is isolated to that entry
 * (logged, treated as "still unresolved"), never lost track of and never
 * misattributed to a different entry.
 */
export async function recoverUnresolvedEntries<
  E extends RecoverableEntry & { id: number; chainId: number; action: string },
>(
  entries: E[],
  getClientForChain: (chainId: number) => MinimalReceiptClient & MinimalNonceClient,
  onResolved: (id: number, outcome: RecoveryOutcome) => void,
  resolveOpts?: Parameters<typeof resolveAmbiguousTx>[2],
): Promise<{ resolved: number; stillUnresolved: number }> {
  const results = await Promise.all(
    entries.map(async (entry): Promise<boolean> => {
      try {
        const client = getClientForChain(entry.chainId);
        const outcome = await resolveAmbiguousTx(client, entry, resolveOpts);
        onResolved(entry.id, outcome);
        console.log(`[tx-recovery] #${entry.id} (${entry.action}) -> ${outcome}`);
        return outcome !== 'SUBMITTED';
      } catch (e) {
        console.error(`[tx-recovery] #${entry.id} recovery attempt threw:`, e);
        return false;
      }
    }),
  );
  const resolved = results.filter(Boolean).length;
  return { resolved, stillUnresolved: entries.length - resolved };
}
