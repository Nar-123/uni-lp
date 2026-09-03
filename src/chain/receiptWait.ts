import { WaitForTransactionReceiptTimeoutError } from 'viem';

/**
 * Phase 4.6.13: explicit, codebase-owned deadline for every
 * execution-path `client.waitForTransactionReceipt({ hash, ... })` call
 * (mint/close/collect/swap/revoke/wrap/transfer/bridge — see
 * PHASE4_6_13_RECEIPT_DEADLINE_FIX_REPORT.md for the full call-site
 * inventory).
 *
 * IMPORTANT CONTEXT: these calls were previously described as
 * "unbounded," but that was not quite accurate — viem's own
 * `waitForTransactionReceipt` already has a default `timeout` of
 * 180_000ms (confirmed directly from viem's source:
 * node_modules/viem/actions/public/waitForTransactionReceipt.ts,
 * `timeout = 180_000`), after which it throws
 * `WaitForTransactionReceiptTimeoutError` regardless of what the
 * underlying RPC/provider is doing. So a genuine infinite hang was never
 * actually possible here.
 *
 * The real gap was that this 180s bound was IMPLICIT — an unstated
 * dependency on a third-party library's current default, which could
 * silently change on a future viem version bump with no code in this
 * repository ever needing to change, and with nothing here documenting,
 * testing, or asserting that specific number as an intentional choice.
 * This constant makes that same, already-safe boundary explicit,
 * codebase-owned, greppable, and directly testable — deliberately kept
 * at the EXACT same value viem already used, so this change has zero
 * effect on when a timeout fires (verified: passing `timeout: 180_000`
 * explicitly is byte-identical to viem's own destructured default).
 *
 * A timeout here throws viem's own `WaitForTransactionReceiptTimeoutError`
 * — it is never caught and reclassified into a fabricated success or
 * failure by this constant's introduction. Every one of these receipt
 * waits happens strictly AFTER `journalledSend` (src/chain/clients.ts,
 * unmodified) has already broadcast the transaction and journaled it as
 * `SUBMITTED` with a real hash — so a thrown timeout here simply
 * propagates as an ordinary exception to each call site's existing,
 * unmodified error handling, exactly as any other exception during this
 * wait already did (e.g. a genuine RPC failure during polling). No
 * ledger row, position-closed flag, or "confirmed"/"failed" state is
 * ever written from these functions except on a path that already
 * required this call to resolve successfully first — so a thrown
 * timeout here can never fabricate an accounting entry. The journal
 * entry remains exactly as it was (`SUBMITTED`, recoverable) and is
 * resolved later by the existing, unmodified txRecovery mechanism
 * (src/chain/txRecovery.ts) — on the next startup pass, or the next
 * pre-send recovery check for that wallet.
 */
export const EXECUTION_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Type guard distinguishing "we waited the full deadline with no
 * definitive outcome" (UNKNOWN — the transaction may still confirm or
 * revert later; recovery, not failure) from every other kind of error a
 * receipt wait can throw. Exported for callers/tests that want to branch
 * on this specifically; no existing call site's control flow was changed
 * to use it — see the phase report for why letting it propagate
 * unmodified is already the correct, safe behavior.
 */
export function isReceiptWaitTimeout(e: unknown): e is WaitForTransactionReceiptTimeoutError {
  return e instanceof WaitForTransactionReceiptTimeoutError;
}
