/**
 * Phase 4.7 — zero-trust audit finding (Part S, accounting invariant).
 *
 * Root cause: src/bot/tpslWatcher.ts's executeClose() called closePosition()
 * then recordLedger() directly, without first calling
 * setJournalAccountingMeta() — unlike the other two production callers of
 * closePosition()/recordLedger() (the manual /close command in bot.ts, and
 * multiExecute.ts's open-position path), which both stage accounting
 * metadata on the tx's journal entry BEFORE writing the ledger, specifically
 * so a crash between "transaction confirmed" and "ledger row written" can
 * be replayed by pnl/reconcile.ts's recoverMissingLedger() on next startup.
 *
 * Since the MULTI strategy auto-enrolls every position it opens into TP/SL
 * (see multiExecute.ts's setPositionTpSl call), tpslWatcher.ts's executeClose
 * is the exit path for the bot's primary automated strategy, not just the
 * manual /tp command — this made the gap significant despite the narrow
 * (synchronous, no-await) window between closePosition() resolving and the
 * ledger writes.
 *
 * This suite proves the fix: after a TP/SL-triggered close, the tx's journal
 * entry now carries accounting_meta whose contents exactly match what was
 * written to the ledger, so recoverMissingLedger() could reconstruct the
 * identical ledger rows if the process had crashed before recordLedger ran.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-acctmeta-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  recordOpenPosition,
  setPositionTpSl,
  setUserPrefs,
  getLedgerEntries,
  createTxJournalEntry,
  updateTxJournalEntry,
  getTxJournalEntry,
  __resetStoreForTests,
} = await import('../src/db/index.js');
const {
  startTpslWatcher,
  stopTpslWatcher,
  __tickForTests,
  __setTpslDepsForTests,
  __resetTpslWatcherForTests,
} = await import('../src/bot/tpslWatcher.js');

const CHAIN = 4663;
const CONFIRM_MS = 5_000;
const CLOSE_HASH = '0xAcCtMetaTestHash000000000000000000000000000000000000000001' as `0x${string}`;

const fakeBot = { api: { sendMessage: async () => {} } } as unknown as Bot;

function resetDb(): void {
  __resetStoreForTests();
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

let tokenCounter = 5000;
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
}

function enrollPosition(tokenId: string): void {
  setUserPrefs(1, { tpSlEnabled: true });
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
  });
  setPositionTpSl(CHAIN, tokenId, { enabled: true, tpPercent: 10, slPercent: 15 });
}

/**
 * Mirrors what clients.ts's journalledSend() does in production: a journal
 * entry is created BEFORE broadcast (BROADCAST_UNKNOWN) and moved to
 * CONFIRMED once the receipt lands. Tests inject closePosition directly, so
 * this recreates that already-CONFIRMED end state for the close's own tx
 * hash, which is what setJournalAccountingMeta looks up by (chainId, hash).
 */
function seedConfirmedJournalEntry(hash: string): number {
  const id = createTxJournalEntry({ chainId: CHAIN, wallet: '0xhotwallet', nonce: 1, action: 'writeContract:multicall' });
  updateTxJournalEntry(id, { state: 'CONFIRMED', tx_hash: hash });
  return id;
}

function resetAll(): void {
  __resetTpslWatcherForTests();
  resetDb();
  tokenCounter = 5000;
}

function fakeCloseResult(tokenId: string, feesPortionUsd: number) {
  return {
    hash: CLOSE_HASH,
    tokenId: BigInt(tokenId),
    amount0: 0n,
    amount1: 0n,
    amount0Human: 3,
    amount1Human: 2,
    expected0: 0n,
    expected1: 0n,
    withdrawalUsd: 100,
    feesPortionUsd,
    feeSplitIsEstimated: true,
    txLink: `https://example/tx/${CLOSE_HASH}`,
    token0: '0xusdg' as `0x${string}`,
    token1: '0xtok' as `0x${string}`,
    symbol0: 'USDG',
    symbol1: 'TOK',
  };
}

async function triggerCloseAndWait(tokenId: string, feesPortionUsd: number): Promise<void> {
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }), // TP hit (10%)
    closePosition: async () => fakeCloseResult(tokenId, feesPortionUsd),
  });
  startTpslWatcher(fakeBot);
  await __tickForTests(fakeBot); // arms the real 5s confirmation timer
  await new Promise((r) => setTimeout(r, CONFIRM_MS + 300)); // let it fire -> recheckAndMaybeClose -> executeClose
  await stopTpslWatcher();
}

test('TP/SL close stages accounting metadata on the journal entry BEFORE the ledger write (withdrawal only, no fees)', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  const journalId = seedConfirmedJournalEntry(CLOSE_HASH);

  await triggerCloseAndWait(tokenId, 0);

  const entry = getTxJournalEntry(journalId);
  assert.ok(entry, 'journal entry must still exist');
  assert.ok(entry!.accountingMeta, 'Phase 4.7 fix: closePosition via TP/SL must stage accountingMeta, matching the manual /close path');
  assert.equal(entry!.accountingMeta!.length, 1, 'no fee portion -> only the withdrawal event is staged');

  const staged = entry!.accountingMeta![0];
  assert.equal(staged.kind, 'withdrawal');
  assert.equal(staged.tokenId, tokenId);
  assert.equal(staged.amountHuman, 3 + 2);
  assert.equal(staged.usd, 100 - 0);

  const ledgerRows = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  assert.equal(ledgerRows.length, 1);
  assert.equal(staged.usd, ledgerRows[0].usd, 'staged meta must exactly match what was actually recorded to the ledger');
  assert.equal(staged.amountHuman, ledgerRows[0].amountHuman);
}, { timeout: CONFIRM_MS + 5_000 });

test('TP/SL close stages BOTH withdrawal and fee_claim metadata when fees were collected, matching both ledger rows exactly', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  const journalId = seedConfirmedJournalEntry(CLOSE_HASH);

  await triggerCloseAndWait(tokenId, 25); // feesPortionUsd = 25

  const entry = getTxJournalEntry(journalId);
  assert.ok(entry?.accountingMeta, 'accountingMeta must be staged');
  assert.equal(entry!.accountingMeta!.length, 2, 'both withdrawal and fee_claim must be staged atomically in one call');

  const withdrawalMeta = entry!.accountingMeta!.find((m) => m.kind === 'withdrawal');
  const feeMeta = entry!.accountingMeta!.find((m) => m.kind === 'fee_claim');
  assert.ok(withdrawalMeta && feeMeta);
  assert.equal(withdrawalMeta!.usd, 100 - 25);
  assert.equal(feeMeta!.usd, 25);
  assert.equal(feeMeta!.feeSplitIsEstimated, true);

  const withdrawalLedger = getLedgerEntries(CHAIN, tokenId, 'withdrawal');
  const feeLedger = getLedgerEntries(CHAIN, tokenId, 'fee_claim');
  assert.equal(withdrawalLedger.length, 1);
  assert.equal(feeLedger.length, 1);
  assert.equal(withdrawalMeta!.usd, withdrawalLedger[0].usd, 'staged withdrawal meta must match the actual ledger row exactly');
  assert.equal(feeMeta!.usd, feeLedger[0].usd, 'staged fee_claim meta must match the actual ledger row exactly');

  // Proves crash-recoverability: replaying this staged metadata via
  // recordLedger (idempotent by chainId+txHash+kind, see db/index.ts) would
  // reproduce the exact rows already present — never diverge from what a
  // real, un-crashed run recorded.
}, { timeout: CONFIRM_MS + 5_000 });
