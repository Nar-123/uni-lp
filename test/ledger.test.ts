/**
 * Ledger / accounting integrity tests — Phase 3.
 *
 * These exercise the real db/index.ts JSON-file store (not mocked), so a
 * scratch DB_PATH/WALLETS_PATH is set up BEFORE any db/config-touching
 * import runs, isolating this suite from the project's real data/ files.
 * `TELEGRAM_BOT_TOKEN` is set to a dummy value only because config.ts's
 * lazy getConfig() requires it to be present — no network/Telegram call
 * is ever made by these tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-ledger-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  recordLedger,
  getLedgerEntries,
  sumLedger,
  createTxJournalEntry,
  updateTxJournalEntry,
  __resetStoreForTests,
} = await import('../src/db/index.js');
const { reconcileAccounting } = await import('../src/pnl/reconcile.js');

const CHAIN = 8453;

function freshTokenId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── Duplicate event prevention (§4/§5) ───────────────────────────────────

test('ledger: recording the same (chainId, txHash, kind) twice results in exactly one row', () => {
  const tokenId = freshTokenId();
  const hash = '0xaaaa000000000000000000000000000000000000000000000000000000aa';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 100, txHash: hash });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 100, txHash: hash });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 100, txHash: hash });
  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(rows.length, 1, 'importing the same event 3 times must leave exactly one row');
});

test('ledger: duplicate import does not double-count PnL-feeding sums', () => {
  const tokenId = freshTokenId();
  const hash = '0xbbbb000000000000000000000000000000000000000000000000000000bb';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 10, txHash: hash });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 10, txHash: hash });
  const total = sumLedger(CHAIN, tokenId, 'fee_claim');
  assert.equal(total, 10, 'sumLedger must reflect the single unique event, not 20 from a duplicate');
});

test('ledger: different kinds sharing the same txHash are both recorded (a close often produces withdrawal + fee_claim)', () => {
  const tokenId = freshTokenId();
  const hash = '0xcccc000000000000000000000000000000000000000000000000000000cc';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 90, txHash: hash });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 10, txHash: hash });
  const all = getLedgerEntries(CHAIN, tokenId);
  assert.equal(all.length, 2, 'two distinct kinds from the same tx are NOT duplicates of each other');
});

test('ledger: a genuinely different transaction (different txHash) is never treated as a duplicate', () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 5, txHash: '0x1111000000000000000000000000000000000000000000000000000011' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 7, txHash: '0x2222000000000000000000000000000000000000000000000000000022' });
  const rows = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  assert.equal(rows.length, 2);
  assert.equal(sumLedger(CHAIN, tokenId, 'fee_claim'), 12);
});

// ── Append-only / restart (§3, §26) ─────────────────────────────────────

test('restart: ledger entries survive a simulated process restart (store reload) unchanged', () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 1000, txHash: '0xdead000000000000000000000000000000000000000000000000000dead' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 1150, txHash: '0xbeef000000000000000000000000000000000000000000000000000beef' });

  __resetStoreForTests(); // simulate restart: drop in-memory cache, force reload from disk

  const rows = getLedgerEntries(CHAIN, tokenId);
  assert.equal(rows.length, 2, 'both events must survive the reload');
  assert.equal(sumLedger(CHAIN, tokenId, 'deposit'), 1000);
  assert.equal(sumLedger(CHAIN, tokenId, 'withdrawal'), 1150);
});

test('restart: re-importing an already-recorded event after restart still does not duplicate (crash-safety, §27)', () => {
  const tokenId = freshTokenId();
  const hash = '0xf00d000000000000000000000000000000000000000000000000000f00d';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 500, txHash: hash });

  __resetStoreForTests(); // simulate crash-then-restart

  // A recovery/reconciliation pass re-processing the same on-chain receipt
  // after restart must not create a second row.
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 500, txHash: hash });

  const rows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(rows.length, 1);
});

// ── Reconciliation (§29) ─────────────────────────────────────────────────

test('reconciliation: a clean ledger with no journal issues reports RECONCILIATION_OK', () => {
  const tokenId = freshTokenId();
  const hash = '0x0ace000000000000000000000000000000000000000000000000000ace0';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 200, txHash: hash });
  const journalId = createTxJournalEntry({ chainId: CHAIN, wallet: '0x1000000000000000000000000000000000dead', nonce: 1, action: 'writeContract:test' });
  updateTxJournalEntry(journalId, { state: 'CONFIRMED', tx_hash: hash });

  const report = reconcileAccounting(CHAIN);
  const relevant = report.findings.filter((f) => f.txHash.toLowerCase() === hash.toLowerCase());
  assert.equal(relevant.length, 0, 'a confirmed, uniquely-recorded event must not be flagged');
});

test('reconciliation: a ledger event for a transaction the journal recorded as MINED_REVERT is flagged', () => {
  const tokenId = freshTokenId();
  const hash = '0xbad0000000000000000000000000000000000000000000000000000bad0';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 300, txHash: hash });
  const journalId = createTxJournalEntry({ chainId: CHAIN, wallet: '0x2000000000000000000000000000000000dead', nonce: 2, action: 'writeContract:test' });
  updateTxJournalEntry(journalId, { state: 'MINED_REVERT', tx_hash: hash });

  const report = reconcileAccounting(CHAIN);
  assert.equal(report.status, 'RECONCILIATION_REQUIRED');
  const found = report.findings.find((f) => f.kind === 'LEDGER_EVENT_FOR_REVERTED_TX' && f.txHash.toLowerCase() === hash.toLowerCase());
  assert.ok(found, 'a ledger event backed by a reverted tx must be surfaced, not silently accepted');
});

test('reconciliation: a ledger event for a still-unresolved (RECOVERY_REQUIRED) transaction is flagged', () => {
  const tokenId = freshTokenId();
  const hash = '0xace1000000000000000000000000000000000000000000000000000ace1';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 400, txHash: hash });
  const journalId = createTxJournalEntry({ chainId: CHAIN, wallet: '0x3000000000000000000000000000000000dead', nonce: 3, action: 'writeContract:test' });
  updateTxJournalEntry(journalId, { state: 'RECOVERY_REQUIRED', tx_hash: hash });

  const report = reconcileAccounting(CHAIN);
  assert.equal(report.status, 'RECONCILIATION_REQUIRED');
  const found = report.findings.find((f) => f.kind === 'LEDGER_EVENT_FOR_UNRESOLVED_TX');
  assert.ok(found);
});

test('reconciliation: a ledger event with no matching journal entry (predates journal, or untracked) is not flagged by itself', () => {
  const tokenId = freshTokenId();
  const hash = '0x9999000000000000000000000000000000000000000000000000000999';
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 50, txHash: hash });
  const report = reconcileAccounting(CHAIN);
  const found = report.findings.find((f) => f.txHash.toLowerCase() === hash.toLowerCase());
  assert.equal(found, undefined, 'absence of a journal entry is not itself evidence of a problem');
});

// ── Decimal safety across different token decimals (§31/§32) ────────────

test('decimals: 18/6/9-decimal raw amounts convert to human units without a 10^N scaling error', async () => {
  const { humanToFloat } = await import('../src/chain/tokens.js');
  // 1 whole token at each decimals count
  assert.equal(humanToFloat(10n ** 18n, 18), 1);
  assert.equal(humanToFloat(10n ** 6n, 6), 1);
  assert.equal(humanToFloat(10n ** 9n, 9), 1);
  // 1,000,000 raw units of a 6-decimal token (e.g. USDC) is $1, not $1,000,000
  assert.equal(humanToFloat(1_000_000n, 6), 1);
  // Cross-decimals sanity: 1 unit of an 18-decimal token must not be
  // reported at a 6-decimal token's scale or vice versa.
  const eighteen = humanToFloat(1_500_000_000_000_000_000n, 18); // 1.5
  const six = humanToFloat(1_500_000n, 6); // 1.5
  assert.equal(eighteen, six);
});

// ── Immutable ledger (§3) ────────────────────────────────────────────────

test('ledger: recordLedger has no update/mutate API — historical rows are append-only by construction', async () => {
  const dbModule = await import('../src/db/index.js');
  const exportNames = Object.keys(dbModule);
  const mutators = exportNames.filter((n) => /updateLedger|editLedger|setLedger|mutateLedger/i.test(n));
  assert.equal(mutators.length, 0, 'no function should exist that mutates an existing ledger row in place');
});
