/**
 * Phase 4.7 audit (F-10 follow-up) — per-token MULTI execution-intent lock,
 * and (F-11) a GLOBAL (chain+wallet-scoped) execution reservation sharing
 * the exact same underlying primitive.
 *
 * Distinct from chain/txLock.ts's withTxLock, which QUEUES concurrent sends
 * (every caller eventually runs, serialized). This lock REJECTS a second
 * concurrent attempt outright — the correct semantics for "has a human
 * already pressed Execute for this exact token and it hasn't finished yet",
 * where the right answer to a duplicate press is "no, wait for the first
 * one", not "queue behind it and mint twice".
 *
 * This does not replace, wrap, or otherwise touch instanceLock, txLock, or
 * journalledSend — it runs entirely before any of them are ever reached,
 * as an additional, independent guard against the specific race where two
 * concurrent Execute attempts both pass their own risk-gate checks before
 * either has written a journal entry (risk-gate/journal state only reflects
 * reality once a send has actually begun — see multiRisk.ts's
 * checkPendingTransaction/checkDoubleEntry, which read the DB, not any
 * in-memory intent).
 *
 * A plain in-memory Set is sufficient and correct here: Node's event loop
 * is single-threaded, so `has()` immediately followed by `add()` with no
 * `await` in between can never be interleaved by another call — the
 * check-and-set is atomic in practice, not just in appearance.
 *
 * F-11 finding: the per-token key (chain:wallet:token) means two DIFFERENT
 * tokens never contend for the same lock, so this alone cannot serialize
 * decisions that depend on GLOBAL, wallet-wide state — specifically
 * multiRisk.ts's checkPositionLimits (MULTI_MAX_OPEN_POSITIONS /
 * MULTI_MAX_EXPOSURE_USD), which reads listOpenPositions() with no
 * reservation. Two different tokens could both read "0 open positions,
 * limit not yet reached" before either had durably recorded one.
 * globalReservationKey() produces a second, distinct key namespace — one
 * per (chain, wallet), with no token component — reusing the exact same
 * tryAcquireExecutionLock/releaseExecutionLock functions below (same reject-
 * on-collision semantics, same Set, same release guarantees) rather than
 * introducing a second lock implementation. The sentinel token slot value
 * can never collide with a real token address (always validated as
 * `0x` + 40 hex elsewhere, e.g. bot/multiExecuteResolver.ts's callback regex).
 */

const inFlight = new Set<string>();

/** Deterministic key — same shape for every caller, chain-aware, wallet-aware, token-aware. */
export function executionLockKey(chainId: number, wallet: string, token: string): string {
  return `${chainId}:${wallet.toLowerCase()}:${token.toLowerCase()}`;
}

/**
 * F-11 — one reservation per (chain, wallet), covering every MULTI token.
 * Held for the same interval as the per-token lock (acquired alongside it,
 * released in the same `finally`) so that the entire window during which
 * runRiskGate's global checks (open-position count, exposure sum) could
 * observe stale state is serialized across ALL tokens, not just the one
 * currently being executed.
 */
export function globalReservationKey(chainId: number, wallet: string): string {
  return `${chainId}:${wallet.toLowerCase()}:__GLOBAL_RESERVATION__`;
}

/** Returns true if the lock was acquired; false if another execution for this exact key is already in flight. Never blocks, never queues, never retries. */
export function tryAcquireExecutionLock(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

/** Idempotent — safe to call even if the key was never held (defensive, never throws). */
export function releaseExecutionLock(key: string): void {
  inFlight.delete(key);
}

export function __resetExecutionLocksForTests(): void {
  inFlight.clear();
}

export function __executionLockSizeForTests(): number {
  return inFlight.size;
}
