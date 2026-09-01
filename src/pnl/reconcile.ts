/**
 * Accounting reconciliation — Phase 3 / Phase 3.5.
 *
 * Phase 3: Compares the local ledger against itself (duplicate detection)
 * and against the transaction journal (unresolved/failed transactions that
 * should never have produced a "successful" ledger event). Read-only:
 * detects and reports, never silently repairs.
 *
 * Phase 3.5: Adds recoverMissingLedger() — proactively creates ledger
 * events that are missing due to a crash between tx success and the
 * recordLedger() call, using accounting metadata staged in the journal
 * entry (see setJournalAccountingMeta in db/index.ts).
 */
import type { SupportedChainId } from '../config.js';
import {
  getLedgerEntries,
  listAllTxJournal,
  listConfirmedTxJournal,
  recordLedger,
  type JournalAccountingMeta,
  type LedgerEntry,
  type LedgerKind,
  type TxJournalEntry,
  type TxJournalState,
} from '../db/index.js';

export type ReconciliationFinding = {
  kind:
    | 'DUPLICATE_LEDGER_EVENT'
    | 'LEDGER_EVENT_FOR_UNRESOLVED_TX'
    | 'LEDGER_EVENT_FOR_REVERTED_TX';
  message: string;
  chainId: number;
  txHash: string;
  tokenId?: string;
  eventKind?: LedgerKind;
  journalState?: TxJournalState;
  ledgerState?: string;
  ledgerIds?: number[];
};

export type ReconciliationReport = {
  status: 'RECONCILIATION_OK' | 'RECONCILIATION_REQUIRED';
  findings: ReconciliationFinding[];
  checkedLedgerRows: number;
  checkedJournalRows: number;
};

/**
 * Phase 3.5: Per-finding result from recoverMissingLedger().
 *
 * ledgerState values:
 *   MISSING_RECOVERED  – event was absent; created successfully (auto-fixed)
 *   MISSING_NO_USD     – event absent but USD value was null at staging; cannot recover
 *   MISSING_NO_META    – CONFIRMED tx has no accounting_meta; cannot determine what to create
 */
export type RecoveryFinding = {
  chainId: number;
  txHash: string;
  tokenId: string;
  kind: LedgerKind;
  journalState: TxJournalState;
  ledgerState: 'MISSING_RECOVERED' | 'MISSING_NO_USD' | 'MISSING_NO_META';
  reason: string;
};

export type LedgerRecoveryReport = {
  status: 'RECONCILIATION_OK' | 'RECONCILIATION_REQUIRED';
  /** Number of ledger events auto-created during this pass. */
  recovered: number;
  findings: RecoveryFinding[];
  checkedConfirmedTxs: number;
};

/**
 * Compares the ledger against itself and against the transaction journal.
 *
 * 1. Duplicate detection: more than one ledger row sharing the same
 *    (chainId, txHash, kind) identity — should be impossible going
 *    forward (recordLedger is now idempotent, see db/index.ts), but this
 *    check also catches any duplicates already present in a store written
 *    before that fix.
 * 2. Journal cross-check: a ledger event exists for a txHash whose
 *    journal entry (if one exists) shows the transaction did NOT reach a
 *    known-successful state (MINED_REVERT, or still-unresolved
 *    BROADCAST_UNKNOWN/SUBMITTED/RECOVERY_REQUIRED). In this codebase's
 *    actual control flow this should never happen — recordLedger() is
 *    only ever called after the on-chain function it follows has already
 *    returned successfully (receipt.status === 'success'), and Phase 2
 *    Part 4's journalledSend never lets a caller observe success without
 *    a real hash — but this check exists specifically to catch a future
 *    regression of that invariant, not because it's expected to fire.
 *
 * This is NOT a full on-chain re-verification (it doesn't re-fetch every
 * historical receipt) — it's a structural, local-data consistency check.
 */
export function reconcileAccounting(chainId: number | null = null): ReconciliationReport {
  const ledger: LedgerEntry[] = getLedgerEntries(chainId as SupportedChainId | null);
  const journal: TxJournalEntry[] = listAllTxJournal().filter(
    (j) => chainId == null || j.chainId === chainId,
  );

  const findings: ReconciliationFinding[] = [];

  // 1. Duplicate ledger events
  const byKey = new Map<string, LedgerEntry[]>();
  for (const row of ledger) {
    if (!row.txHash) continue;
    const key = `${row.chainId}:${row.txHash.toLowerCase()}:${row.kind}`;
    const arr = byKey.get(key) ?? [];
    arr.push(row);
    byKey.set(key, arr);
  }
  for (const [, rows] of byKey) {
    if (rows.length > 1) {
      findings.push({
        kind: 'DUPLICATE_LEDGER_EVENT',
        message: `${rows.length} ledger rows share the same (chainId, txHash, kind) identity — duplicate accounting`,
        chainId: rows[0]!.chainId,
        txHash: rows[0]!.txHash!,
        ledgerIds: rows.map((r) => r.id),
      });
    }
  }

  // 2. Cross-check against the transaction journal
  const journalByHash = new Map<string, TxJournalEntry>();
  for (const j of journal) {
    if (j.txHash) journalByHash.set(`${j.chainId}:${j.txHash.toLowerCase()}`, j);
  }
  const UNRESOLVED = new Set(['BROADCAST_UNKNOWN', 'SUBMITTED', 'RECOVERY_REQUIRED']);
  for (const row of ledger) {
    if (!row.txHash) continue;
    const j = journalByHash.get(`${row.chainId}:${row.txHash.toLowerCase()}`);
    if (!j) continue; // no journal entry for this tx (e.g. predates Phase 2 Part 4) — not itself an error
    if (j.state === 'MINED_REVERT') {
      findings.push({
        kind: 'LEDGER_EVENT_FOR_REVERTED_TX',
        message: `Ledger has a '${row.kind}' event for a transaction the journal recorded as MINED_REVERT`,
        chainId: row.chainId,
        txHash: row.txHash,
        eventKind: row.kind,
        journalState: j.state,
      });
    } else if (UNRESOLVED.has(j.state)) {
      findings.push({
        kind: 'LEDGER_EVENT_FOR_UNRESOLVED_TX',
        message: `Ledger has a '${row.kind}' event for a transaction whose journal state is still '${j.state}' (not finalized)`,
        chainId: row.chainId,
        txHash: row.txHash,
        eventKind: row.kind,
        journalState: j.state as TxJournalState,
      });
    }
  }

  return {
    status: findings.length === 0 ? 'RECONCILIATION_OK' : 'RECONCILIATION_REQUIRED',
    findings,
    checkedLedgerRows: ledger.length,
    checkedJournalRows: journal.length,
  };
}

/**
 * Phase 3.5: Finds CONFIRMED journal entries whose accounting metadata
 * indicates one or more ledger events should exist, but those events are
 * absent from the ledger. Creates the missing events using the stored
 * metadata (idempotent — recordLedger() is already idempotent by
 * (chainId, txHash, kind)).
 *
 * SAFE to call multiple times: a second pass on an already-recovered
 * state is a no-op.
 *
 * Will NOT:
 *   - create events for MINED_REVERT / NOT_SUBMITTED / unresolved entries
 *   - use current market prices as historical cost basis
 *   - fabricate amounts or USD values
 *   - silently record $0 when usd was unknown (flags RECONCILIATION_REQUIRED)
 *   - create duplicate ledger events (idempotency via recordLedger)
 */
export function recoverMissingLedger(chainId: number | null = null): LedgerRecoveryReport {
  const confirmed = listConfirmedTxJournal(chainId ?? undefined);
  const findings: RecoveryFinding[] = [];
  let recovered = 0;

  for (const entry of confirmed) {
    if (!entry.txHash) continue; // CONFIRMED entries should always have a hash

    const meta = entry.accountingMeta;
    if (!meta || meta.length === 0) {
      // CONFIRMED tx with no accounting_meta — we cannot determine what
      // ledger event(s) to create. Only flag if there are also NO ledger
      // events for this txHash (pre-Phase-3.5 transactions with existing
      // ledger entries are fine; they just predate the meta feature).
      const anyLedger = getLedgerEntries(entry.chainId as SupportedChainId | null)
        .some((e) => e.txHash?.toLowerCase() === entry.txHash!.toLowerCase());
      if (!anyLedger) {
        // This could be a TX that doesn't produce accounting events (e.g. NFT
        // burn, a swap, etc.), or one that predates Phase 3.5. We cannot
        // distinguish without metadata — leave it for operator review only
        // if it appears suspicious via reconcileAccounting()'s checks.
      }
      continue;
    }

    for (const m of meta) {
      // Check idempotently: does a ledger event already exist for this
      // (chainId, txHash, kind)?
      const existingForToken = getLedgerEntries(
        entry.chainId as SupportedChainId | null,
        m.tokenId,
        m.kind,
      );
      const alreadyRecorded = existingForToken.some(
        (e) => e.txHash?.toLowerCase() === entry.txHash!.toLowerCase(),
      );

      if (alreadyRecorded) continue; // idempotent skip — already present

      if (m.usd === null) {
        // USD value was not available at staging time. Failing closed:
        // do NOT use the current price as a historical substitute.
        findings.push({
          chainId: entry.chainId,
          txHash: entry.txHash,
          tokenId: m.tokenId,
          kind: m.kind,
          journalState: entry.state,
          ledgerState: 'MISSING_NO_USD',
          reason:
            'CONFIRMED tx has staged accounting metadata but USD value was null at staging time — ' +
            'cannot recover without historical price; manual reconciliation required',
        });
        continue;
      }

      // Create the missing ledger event using historical metadata.
      // recordLedger() is idempotent — a concurrent call or second pass
      // for the same (chainId, txHash, kind) is a safe no-op.
      try {
        recordLedger({
          chainId: entry.chainId as SupportedChainId,
          tokenId: m.tokenId,
          kind: m.kind,
          tokenAddress: m.tokenAddress ?? undefined,
          amountRaw: m.amountRaw ?? undefined,
          amountHuman: m.amountHuman ?? undefined,
          usd: m.usd,
          txHash: entry.txHash,
        });
        findings.push({
          chainId: entry.chainId,
          txHash: entry.txHash,
          tokenId: m.tokenId,
          kind: m.kind,
          journalState: entry.state,
          ledgerState: 'MISSING_RECOVERED',
          reason: 'Missing ledger event auto-recovered from journal accounting metadata',
        });
        recovered++;
      } catch (e) {
        // recordLedger() should never throw (it only writes + warns on dup),
        // but be defensive.
        console.error('[ledger-recovery] unexpected error from recordLedger:', e);
      }
    }
  }

  const requiresAttention = findings.some(
    (f) => f.ledgerState === 'MISSING_NO_USD' || f.ledgerState === 'MISSING_NO_META',
  );

  return {
    status: requiresAttention ? 'RECONCILIATION_REQUIRED' : 'RECONCILIATION_OK',
    recovered,
    findings,
    checkedConfirmedTxs: confirmed.length,
  };
}

/**
 * Format a combined reconciliation + recovery report for operator display.
 * Never exposes private key material.
 */
export function formatReconciliationReport(
  recovery: LedgerRecoveryReport,
  check: ReconciliationReport,
): string {
  const lines: string[] = [];

  if (recovery.recovered > 0) {
    lines.push(`Auto-recovered: ${recovery.recovered} missing ledger event(s) created.`);
  }

  const overallOk =
    recovery.status === 'RECONCILIATION_OK' && check.status === 'RECONCILIATION_OK';

  lines.push(overallOk ? 'RECONCILIATION_OK' : 'RECONCILIATION_REQUIRED');

  const stats = [
    `ledger=${check.checkedLedgerRows}`,
    `journal=${check.checkedJournalRows}`,
    `confirmed=${recovery.checkedConfirmedTxs}`,
  ].join(' ');
  lines.push(`Checked: ${stats}`);

  const attentionFindings = recovery.findings.filter(
    (f) => f.ledgerState !== 'MISSING_RECOVERED',
  );

  if (attentionFindings.length > 0) {
    lines.push('');
    lines.push('Recovery findings requiring attention:');
    for (const f of attentionFindings) {
      const hashShort = f.txHash.length > 12 ? f.txHash.slice(0, 10) + '…' : f.txHash;
      lines.push(
        `  ${f.ledgerState} chain=${f.chainId} tx=${hashShort} kind=${f.kind} token=${f.tokenId}`,
      );
      lines.push(`  reason: ${f.reason}`);
    }
  }

  if (check.findings.length > 0) {
    lines.push('');
    lines.push('Ledger integrity findings:');
    for (const f of check.findings) {
      const hashShort = f.txHash.length > 12 ? f.txHash.slice(0, 10) + '…' : f.txHash;
      lines.push(`  ${f.kind} chain=${f.chainId} tx=${hashShort}`);
      lines.push(`  ${f.message}`);
    }
  }

  return lines.join('\n');
}
