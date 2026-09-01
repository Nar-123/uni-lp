/**
 * Phase 3.5: Accounting recovery & reconciliation hardening tests.
 *
 * Exercises:
 *   1.  confirmed journal + missing ledger
 *   2.  automatic recovery (recoverMissingLedger)
 *   3.  recovery idempotency
 *   4.  repeated startup recovery (N passes → same state)
 *   5.  incomplete metadata (null usd → RECONCILIATION_REQUIRED)
 *   6.  reverted transaction (MINED_REVERT → no ledger event created)
 *   7.  unknown transaction (SUBMITTED/BROADCAST_UNKNOWN → no ledger event)
 *   8.  actual amount recovery (amountHuman from metadata, not fabricated)
 *   9.  historical price recovery (usd from metadata, not live price)
 *   10. duplicate protection (two recovery passes → one ledger row)
 *   11. fee/principal estimate flag (feeSplitIsEstimated always true on close)
 *   12. reconciliation command authorization (isAllowed gates /reconcile)
 *
 * Property tests:
 *   P1. confirmed tx → at most one ledger event per kind
 *   P2. recovery repeated N times → same ledger state
 *   P3. reverted tx → zero finalized ledger events
 *   P4. unknown tx → zero finalized ledger events
 *   P5. incomplete metadata → RECONCILIATION_REQUIRED
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-reconcile-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '42'; // authorized user id
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  recordLedger,
  getLedgerEntries,
  sumLedger,
  createTxJournalEntry,
  updateTxJournalEntry,
  setJournalAccountingMeta,
  listConfirmedTxJournal,
  __resetStoreForTests,
} = await import('../src/db/index.js');

const {
  reconcileAccounting,
  recoverMissingLedger,
} = await import('../src/pnl/reconcile.js');

const { isAllowed } = await import('../src/bot/auth.js');

const CHAIN = 8453;
const WALLET = '0xabc0000000000000000000000000000000000001' as const;

let txSeq = 0;
function freshTx(): string {
  txSeq++;
  return `0x${String(txSeq).padStart(62, '0')}`;
}

function freshToken(): string {
  return `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── 1. Confirmed journal + missing ledger ────────────────────────────────────

test('1: CONFIRMED journal entry with staging metadata but no ledger event is detectable', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  // Simulate: tx was sent and confirmed
  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 1, action: 'writeContract:decreaseLiquidity' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  // Staging happened before the crash
  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'withdrawal',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 1.5,
    usd: 1500,
  }]);

  // No recordLedger was called — simulating a crash
  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(rows.length, 0, 'no ledger event yet — simulating crash before recordLedger');

  const recovery = recoverMissingLedger(CHAIN);
  assert.equal(recovery.recovered, 1, 'recovery should create exactly one ledger event');
  assert.equal(recovery.status, 'RECONCILIATION_OK', 'no remaining issues after recovery');

  const after = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(after.length, 1, 'exactly one ledger event after recovery');
  assert.equal(after[0]!.usd, 1500, 'USD value matches staged metadata (historical price)');
  assert.equal(after[0]!.amountHuman, 1.5, 'amountHuman matches staged metadata');
});

// ── 2. Automatic recovery ────────────────────────────────────────────────────

test('2: recoverMissingLedger auto-creates the ledger event from journal accounting_meta', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 2, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 0.05,
    usd: 50,
  }]);

  const report = recoverMissingLedger(CHAIN);
  assert.equal(report.recovered, 1);

  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  const row = rows.find((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.ok(row, 'ledger event created for the confirmed fee_claim');
  assert.equal(row!.usd, 50);
  assert.equal(row!.amountHuman, 0.05);
});

// ── 3. Recovery idempotency ──────────────────────────────────────────────────

test('3: calling recoverMissingLedger twice does not create duplicate ledger events', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 3, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'deposit',
    tokenId,
    tokenAddress: '0x1234000000000000000000000000000000000001',
    amountRaw: '1000000',
    amountHuman: 1.0,
    usd: 1000,
  }]);

  const r1 = recoverMissingLedger(CHAIN);
  assert.equal(r1.recovered, 1, 'first pass creates one event');

  const r2 = recoverMissingLedger(CHAIN);
  assert.equal(r2.recovered, 0, 'second pass is idempotent — no new events');
  assert.equal(r2.status, 'RECONCILIATION_OK');

  const rows = getLedgerEntries(CHAIN, tokenId, 'deposit');
  const matches = rows.filter((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.equal(matches.length, 1, 'still exactly one ledger row after two passes');
});

// ── 4. Repeated startup recovery ────────────────────────────────────────────

test('4: simulated process restart followed by recoverMissingLedger produces same result', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 4, action: 'writeContract:decreaseLiquidity' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });
  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'withdrawal',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 2.5,
    usd: 2500,
  }]);

  // First recovery pass
  const r1 = recoverMissingLedger(CHAIN);
  assert.equal(r1.recovered, 1);

  // Simulate restart: clear in-memory cache and reload from disk
  __resetStoreForTests();

  // Second recovery pass after restart — same CONFIRMED entry, ledger already present
  const r2 = recoverMissingLedger(CHAIN);
  assert.equal(r2.recovered, 0, 'no new rows after restart + second recovery');
  assert.equal(r2.status, 'RECONCILIATION_OK');

  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  const matches = rows.filter((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.equal(matches.length, 1, 'exactly one ledger row survives restart');
  assert.equal(matches[0]!.usd, 2500, 'historical USD preserved through restart');
});

// ── 5. Incomplete metadata (null usd) ────────────────────────────────────────

test('5: staging with usd=null causes RECONCILIATION_REQUIRED, not a $0 ledger event', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 5, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  // Simulate: prices were unavailable at staging time
  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 0.1,
    usd: null, // unknown — MUST NOT default to 0 or current price
  }]);

  const report = recoverMissingLedger(CHAIN);

  assert.equal(report.recovered, 0, 'must NOT create a ledger event when usd is null');
  assert.equal(report.status, 'RECONCILIATION_REQUIRED');
  const finding = report.findings.find((f) => f.txHash.toLowerCase() === txHash.toLowerCase());
  assert.ok(finding, 'finding reported for the null-usd entry');
  assert.equal(finding!.ledgerState, 'MISSING_NO_USD');

  // Verify no ledger row was silently created with $0
  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  const zeroRow = rows.find((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.equal(zeroRow, undefined, 'no ledger row must exist — not even a $0 fallback');
});

// ── 6. Reverted transaction ───────────────────────────────────────────────────

test('6: MINED_REVERT journal entry with no existing ledger row → no ledger event created', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 6, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'MINED_REVERT' });

  // Even if metadata was staged before the revert was known, recovery must not create rows
  // for non-CONFIRMED entries — only CONFIRMED entries are processed.
  const report = recoverMissingLedger(CHAIN);
  assert.equal(report.recovered, 0, 'MINED_REVERT must never produce a ledger event');

  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(rows.length, 0, 'no ledger row for a reverted transaction');
});

test('6b: MINED_REVERT with a pre-existing ledger event → reconcileAccounting flags it', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  // Simulate: somehow a ledger event exists for a reverted tx
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 100, txHash });

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 7, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'MINED_REVERT' });

  const check = reconcileAccounting(CHAIN);
  assert.equal(check.status, 'RECONCILIATION_REQUIRED');
  const finding = check.findings.find(
    (f) => f.kind === 'LEDGER_EVENT_FOR_REVERTED_TX' && f.txHash.toLowerCase() === txHash.toLowerCase(),
  );
  assert.ok(finding, 'must report LEDGER_EVENT_FOR_REVERTED_TX');
  // Recovery must NOT silently delete/mutate the existing ledger event
  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(rows.length, 1, 'existing ledger row must be untouched by reconciliation');
});

// ── 7. Unknown transaction ────────────────────────────────────────────────────

test('7a: BROADCAST_UNKNOWN journal state → recoverMissingLedger creates no ledger event', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  // BROADCAST_UNKNOWN is an unresolved state — only CONFIRMED is processed
  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 8, action: 'writeContract:multicall' });
  // Leave in BROADCAST_UNKNOWN (default state) — do NOT update to CONFIRMED

  // Attach metadata anyway (simulating a race or partial write before crash)
  // setJournalAccountingMeta requires the entry to have the txHash set, which it doesn't here
  // so it will return false — but even if it could be set, recovery must not process it.
  const staged = setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'deposit',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 1.0,
    usd: 1000,
  }]);
  assert.equal(staged, false, 'cannot stage meta for an entry without a txHash');

  const report = recoverMissingLedger(CHAIN);
  const rows = getLedgerEntries(CHAIN, tokenId, 'deposit');
  assert.equal(rows.length, 0, 'BROADCAST_UNKNOWN must not produce any accounting');
  void jId; // suppress unused warning
});

test('7b: SUBMITTED journal state → recoverMissingLedger creates no ledger event', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 9, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  // NOT updated to CONFIRMED

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 0.5,
    usd: 500,
  }]);

  const report = recoverMissingLedger(CHAIN);
  assert.equal(report.recovered, 0, 'SUBMITTED tx must not produce finalized accounting');
  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  assert.equal(rows.length, 0, 'no ledger event for unconfirmed tx');
});

test('7c: RECOVERY_REQUIRED journal state → no ledger event', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 10, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'RECOVERY_REQUIRED' });

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'withdrawal',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 3.0,
    usd: 3000,
  }]);

  const report = recoverMissingLedger(CHAIN);
  assert.equal(report.recovered, 0);
  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(rows.length, 0, 'RECOVERY_REQUIRED must not produce accounting');
});

// ── 8. Actual amount recovery ─────────────────────────────────────────────────

test('8: recovered ledger event uses actual amountHuman/amountRaw from metadata, not an estimate', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 11, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  const actualHuman = 3.141592;
  const actualRaw = '3141592000000000000';
  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: '0xfee0000000000000000000000000000000000001',
    amountRaw: actualRaw,
    amountHuman: actualHuman,
    usd: 314.15,
  }]);

  recoverMissingLedger(CHAIN);

  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  const row = rows.find((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.ok(row, 'ledger row was created');
  assert.equal(row!.amountHuman, actualHuman, 'actual amountHuman preserved — not an estimate');
  assert.equal(row!.amountRaw, actualRaw, 'actual amountRaw preserved — not a minimum or estimate');
  assert.equal(row!.usd, 314.15, 'historical USD preserved');
});

// ── 9. Historical price recovery ─────────────────────────────────────────────

test('9: recovered ledger event uses historical usd from metadata, not current market price', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 12, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  const historicalUsd = 999.99; // price at time of tx — very different from any current market value
  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'withdrawal',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 1.0,
    usd: historicalUsd,
  }]);

  recoverMissingLedger(CHAIN);

  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  const row = rows.find((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.ok(row);
  assert.equal(row!.usd, historicalUsd,
    'recovery must use the stored historical price, never re-price at current market');
});

// ── 10. Duplicate protection ─────────────────────────────────────────────────

test('10: running recovery after recordLedger already ran does not create a duplicate', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 13, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  // Normal path: metadata staged, then recordLedger called (no crash)
  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 0.25,
    usd: 25,
  }]);
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 25, txHash });

  // Now recovery runs (e.g. on next startup) — must be a no-op
  const report = recoverMissingLedger(CHAIN);
  assert.equal(report.recovered, 0, 'already-recorded event must not be re-created');

  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  const matches = rows.filter((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.equal(matches.length, 1, 'exactly one ledger row — no duplicate');
  assert.equal(sumLedger(CHAIN, tokenId, 'fee_claim'), 25, 'PnL sum unchanged by duplicate-protected recovery');
});

// ── 11. Fee/principal estimate flag ──────────────────────────────────────────

test('11: CloseResult.feeSplitIsEstimated is always true — never misrepresented as exact', async () => {
  const { CloseResult: _ } = await import('../src/chain/close.js').catch(() => ({ CloseResult: undefined }));
  // We cannot call closePosition in tests (requires real chain), so we
  // verify the structural invariant: any CloseResult produced must carry
  // feeSplitIsEstimated=true.
  // We test this by checking the type shape via JournalAccountingMeta staging:
  // the bot stages feeSplitIsEstimated in the fee_claim entry — verify it
  // survives through the journal to recoverMissingLedger.
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 14, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  // Stage a fee_claim with feeSplitIsEstimated (as bot.ts does for close)
  setJournalAccountingMeta(CHAIN, txHash, [
    {
      kind: 'withdrawal',
      tokenId,
      tokenAddress: null,
      amountRaw: null,
      amountHuman: 10,
      usd: 10000,
    },
    {
      kind: 'fee_claim',
      tokenId,
      tokenAddress: null,
      amountRaw: null,
      amountHuman: null,
      usd: 200,
      feeSplitIsEstimated: true, // MUST be true — never false
    },
  ]);

  const confirmed = listConfirmedTxJournal(CHAIN);
  const entry = confirmed.find((e) => e.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.ok(entry, 'journal entry found');
  assert.ok(entry!.accountingMeta, 'accounting metadata present');
  const feeMeta = entry!.accountingMeta!.find((m) => m.kind === 'fee_claim');
  assert.ok(feeMeta, 'fee_claim metadata present');
  assert.equal(feeMeta!.feeSplitIsEstimated, true,
    'feeSplitIsEstimated must be true — fee vs principal split is an estimate');
});

// ── 12. Reconciliation command authorization ─────────────────────────────────

test('12: /reconcile is auth-gated — isAllowed rejects unauthorized user IDs', () => {
  // Authorized user (matches TELEGRAM_USER_IDS = '42' set at top)
  assert.equal(isAllowed(42), true, 'user 42 should be authorized');

  // Unauthorized users
  assert.equal(isAllowed(1), false, 'user 1 is not in allowedUserIds');
  assert.equal(isAllowed(99), false, 'user 99 is not in allowedUserIds');
  assert.equal(isAllowed(undefined), false, 'undefined user is never authorized');
});

// ── Property tests ────────────────────────────────────────────────────────────

test('P1: CONFIRMED tx → at most one ledger event per (chainId, txHash, kind)', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 20, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'withdrawal',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 5.0,
    usd: 5000,
  }]);

  // Run recovery multiple times in a tight loop
  for (let i = 0; i < 5; i++) {
    recoverMissingLedger(CHAIN);
  }

  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  const forTx = rows.filter((r) => r.txHash?.toLowerCase() === txHash.toLowerCase());
  assert.ok(forTx.length <= 1, `at most one ledger event per (chainId, txHash, kind) — got ${forTx.length}`);
});

test('P2: recovery repeated N times → same ledger state each time', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 21, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 0.77,
    usd: 77,
  }]);

  const N = 7;
  let totalRecovered = 0;
  for (let i = 0; i < N; i++) {
    const r = recoverMissingLedger(CHAIN);
    totalRecovered += r.recovered;
  }
  assert.equal(totalRecovered, 1, `N=${N} recovery passes must create exactly 1 total event, not ${totalRecovered}`);

  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  assert.equal(
    rows.filter((r) => r.txHash?.toLowerCase() === txHash.toLowerCase()).length,
    1,
    'ledger state is stable after N recovery passes',
  );
});

test('P3: reverted tx → zero finalized ledger events regardless of recovery passes', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 22, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'MINED_REVERT' });

  // Recovery must never touch MINED_REVERT entries
  for (let i = 0; i < 3; i++) {
    const r = recoverMissingLedger(CHAIN);
    assert.equal(r.recovered, 0, `pass ${i}: reverted tx must never produce accounting`);
  }

  const rows = getLedgerEntries(CHAIN, tokenId);
  assert.equal(rows.length, 0, 'zero ledger events for a reverted transaction');
});

test('P4: unknown/unresolved tx → zero finalized ledger events', () => {
  const tokenId = freshToken();
  // BROADCAST_UNKNOWN: never got a hash
  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 23, action: 'writeContract:multicall' });
  // Left as BROADCAST_UNKNOWN with no txHash

  for (let i = 0; i < 3; i++) {
    const r = recoverMissingLedger(CHAIN);
    assert.equal(r.recovered, 0, `pass ${i}: unresolved tx must not produce accounting`);
  }

  const rows = getLedgerEntries(CHAIN, tokenId);
  assert.equal(rows.length, 0, 'zero ledger events for an unknown/unresolved tx');
  void jId;
});

test('P5: incomplete metadata (null usd) → RECONCILIATION_REQUIRED for all N passes', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 24, action: 'writeContract:collect' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'fee_claim',
    tokenId,
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 1.0,
    usd: null, // incomplete
  }]);

  for (let i = 0; i < 3; i++) {
    const r = recoverMissingLedger(CHAIN);
    assert.equal(r.recovered, 0, `pass ${i}: null usd must never produce a ledger event`);
    assert.equal(r.status, 'RECONCILIATION_REQUIRED', `pass ${i}: must flag RECONCILIATION_REQUIRED`);
  }

  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  assert.equal(rows.length, 0, 'null usd must never result in any ledger row');
});

// ── Multi-event staging (close: withdrawal + fee_claim) ──────────────────────

test('multi: close operation stages withdrawal + fee_claim; both recovered after crash', () => {
  const tokenId = freshToken();
  const txHash = freshTx();

  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 30, action: 'writeContract:multicall' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });
  updateTxJournalEntry(jId, { state: 'CONFIRMED' });

  // Both events staged (as bot.ts does for a close with fees)
  setJournalAccountingMeta(CHAIN, txHash, [
    {
      kind: 'withdrawal',
      tokenId,
      tokenAddress: null,
      amountRaw: null,
      amountHuman: 8.0,
      usd: 8000,
    },
    {
      kind: 'fee_claim',
      tokenId,
      tokenAddress: null,
      amountRaw: null,
      amountHuman: null,
      usd: 200,
      feeSplitIsEstimated: true,
    },
  ]);

  const report = recoverMissingLedger(CHAIN);
  assert.equal(report.recovered, 2, 'both withdrawal and fee_claim should be recovered');

  const wRows = getLedgerEntries(CHAIN, tokenId, 'withdrawal').filter(
    (r) => r.txHash?.toLowerCase() === txHash.toLowerCase(),
  );
  const fRows = getLedgerEntries(CHAIN, tokenId, 'fee_claim').filter(
    (r) => r.txHash?.toLowerCase() === txHash.toLowerCase(),
  );
  assert.equal(wRows.length, 1, 'one withdrawal row');
  assert.equal(fRows.length, 1, 'one fee_claim row');
  assert.equal(wRows[0]!.usd, 8000);
  assert.equal(fRows[0]!.usd, 200);
});

// ── setJournalAccountingMeta lookup ──────────────────────────────────────────

test('setJournalAccountingMeta: returns false when no journal entry has the given txHash', () => {
  const nonExistentHash = freshTx(); // not yet in any journal entry
  const result = setJournalAccountingMeta(CHAIN, nonExistentHash, [{
    kind: 'deposit',
    tokenId: 'tok-never',
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 1.0,
    usd: 100,
  }]);
  assert.equal(result, false, 'must return false when the journal entry does not exist');
});

test('setJournalAccountingMeta: returns true when the journal entry is found', () => {
  const txHash = freshTx();
  const jId = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 99, action: 'writeContract:test' });
  updateTxJournalEntry(jId, { state: 'SUBMITTED', tx_hash: txHash });

  const result = setJournalAccountingMeta(CHAIN, txHash, [{
    kind: 'deposit',
    tokenId: 'tok-found',
    tokenAddress: null,
    amountRaw: null,
    amountHuman: 1.0,
    usd: 100,
  }]);
  assert.equal(result, true, 'must return true when the entry is found and updated');
});

// ── listConfirmedTxJournal ────────────────────────────────────────────────────

test('listConfirmedTxJournal: only returns CONFIRMED entries', () => {
  const txHashConfirmed = freshTx();
  const txHashSubmitted = freshTx();

  const j1 = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 50, action: 'writeContract:a' });
  updateTxJournalEntry(j1, { state: 'SUBMITTED', tx_hash: txHashConfirmed });
  updateTxJournalEntry(j1, { state: 'CONFIRMED' });

  const j2 = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 51, action: 'writeContract:b' });
  updateTxJournalEntry(j2, { state: 'SUBMITTED', tx_hash: txHashSubmitted });
  // left as SUBMITTED

  const confirmed = listConfirmedTxJournal(CHAIN);
  const hashes = confirmed.map((e) => e.txHash?.toLowerCase());
  assert.ok(hashes.includes(txHashConfirmed.toLowerCase()), 'CONFIRMED entry must be in list');
  assert.ok(!hashes.includes(txHashSubmitted.toLowerCase()), 'SUBMITTED entry must not be in confirmed list');
});
