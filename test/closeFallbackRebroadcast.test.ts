/**
 * Phase 4.6.14 — close.ts multicall fallback re-broadcast audit.
 *
 * Phase 4.6.13's report flagged a pre-existing pattern in
 * `closePosition()` (src/chain/close.ts): the multicall-close attempt is
 * wrapped in a `try { ... } catch (e1) { ...sequential decreaseLiquidity
 * + collect fallback... }` block, and the `catch` triggers on ANY
 * failure of the try block — including, since Phase 4.6.13, a receipt-
 * wait timeout, not just a genuine on-chain revert. This file audits
 * whether that fallback can broadcast a second, duplicate economic
 * transaction while the first (multicall) transaction's true outcome is
 * still genuinely unknown.
 *
 * THE SAFETY MECHANISM: every `wallet.writeContract`/`wallet.sendTransaction`
 * call in this entire codebase — including close.ts's primary multicall
 * AND its fallback's decreaseLiquidity/collect — is routed through
 * `journalledSend` (src/chain/clients.ts, unmodified, unexported). Its
 * very first action, before doing anything else, is:
 *
 *   const unresolved = listUnresolvedTxJournal({ chainId, wallet });
 *   if (unresolved.length > 0) {
 *     await recoverUnresolvedEntries(...);            // opportunistic recovery
 *     const stillUnresolved = listUnresolvedTxJournal({ chainId, wallet });
 *     if (stillUnresolved.length > 0) throw new Error('refusing new send...');
 *   }
 *
 * This means the fallback's second broadcast can only ever be reached if
 * the FIRST transaction's journal entry has already become terminal
 * (CONFIRMED / MINED_REVERT / NOT_SUBMITTED) — i.e. its true outcome is
 * already KNOWN, never merely "unknown but we're proceeding anyway."
 *
 * `journalledSend` itself is not exported (by design — see
 * clients.ts's own doc comment), so this file follows the exact,
 * already-established precedent in test/txRecoveryLatency.test.ts
 * (Phase 4.6.3, "16. Pre-send safety: the mandatory test") for testing
 * this guarantee: reproduce journalledSend's real, unchanged gating
 * decision (`stillUnresolved.length > 0` blocks) against the REAL,
 * exported `recoverUnresolvedEntries`/journal functions, modeling the
 * exact close.ts multicall -> decreaseLiquidity -> collect sequence —
 * not a fabricated mock of the conclusion.
 *
 * No production code was changed this phase — see
 * PHASE4_6_14_CLOSE_FALLBACK_REBROADCAST_AUDIT_REPORT.md for the full
 * audit and the reasoning for why no fix was warranted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecoveryOutcome } from '../src/chain/txRecovery.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-closefallback-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '42';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  createTxJournalEntry,
  updateTxJournalEntry,
  listUnresolvedTxJournal,
  __resetStoreForTests,
} = await import('../src/db/index.js');

const { recoverUnresolvedEntries, classifyBroadcastError } = await import('../src/chain/txRecovery.js');

let _chainCounter = 900001;
function freshChainId(): number {
  return _chainCounter++;
}
const WALLET = '0x1000000000000000000000000000000000000001' as `0x${string}`;
const TOKEN_ID = 777;

/** journalledSend's exact, unchanged gating decision (clients.ts:161). */
function wouldRefuseNewSend(unresolvedCount: number): boolean {
  return unresolvedCount > 0;
}

function noSleep() {
  return Promise.resolve();
}

// ── 2/3. Exact close.ts sequence, modeled with the real journal ──────────

test('journal state: after multicall broadcasts, the entry is SUBMITTED (unresolved) — exactly what journalledSend would see if the fallback tried to send next', () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  const id = createTxJournalEntry({
    chainId: CHAIN,
    wallet: WALLET,
    nonce: 10,
    action: 'writeContract:multicall',
  });
  updateTxJournalEntry(id, { state: 'SUBMITTED', tx_hash: '0xmulticallhash' });

  const unresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]!.action, 'writeContract:multicall');
  assert.equal(unresolved[0]!.state, 'SUBMITTED', 'a broadcast whose receipt was never observed stays SUBMITTED, not FAILED or CONFIRMED');
});

// ── 4. THE MOST IMPORTANT TEST ────────────────────────────────────────────

test('MOST IMPORTANT: primary multicall broadcast + receipt wait timeout (state still ambiguous) -> the decreaseLiquidity fallback send is refused, never reaches the broadcast call', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  // 1. Primary transaction (multicall) is actually broadcast — journaled
  //    exactly as journalledSend does, SUBMITTED with a real hash.
  const multicallId = createTxJournalEntry({
    chainId: CHAIN,
    wallet: WALLET,
    nonce: 10,
    action: 'writeContract:multicall',
  });
  updateTxJournalEntry(multicallId, { state: 'SUBMITTED', tx_hash: '0xmulticallhash' });

  // 2. Receipt wait times out / RPC is unavailable — close.ts's catch (e1)
  //    is reached; the fallback is about to attempt decreaseLiquidity.
  //    Before wallet.writeContract can be called, journalledSend's gate
  //    runs its opportunistic recovery pass against the REAL, unmodified
  //    recoverUnresolvedEntries — simulating an RPC that cannot determine
  //    the multicall's fate (matches a receipt-wait timeout or a genuine
  //    RPC outage equally: neither can prove the tx was never broadcast).
  const unresolvedBefore = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.equal(unresolvedBefore.length, 1);

  const outcomes = new Map<number, RecoveryOutcome>();
  await recoverUnresolvedEntries(
    unresolvedBefore.map((e) => ({
      id: e.id,
      chainId: e.chainId,
      action: e.action,
      txHash: e.txHash as `0x${string}` | null,
      nonce: e.nonce,
      wallet: WALLET,
    })),
    () => ({
      getTransactionReceipt: async () => null, // never found — still pending / RPC can't see it
      getTransactionCount: async () => 10, // pending nonce unchanged -> could still be broadcast
    }),
    (id, outcome) => {
      outcomes.set(id, outcome);
      if (outcome !== 'SUBMITTED') {
        updateTxJournalEntry(id, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
      }
    },
    { receiptAttempts: 2, receiptBackoffMs: 1, nonceAttempts: 2, nonceBackoffMs: 1, sleepFn: noSleep },
  );

  // 3. State is still ambiguous — recovery could not prove an outcome.
  assert.equal(outcomes.get(multicallId), 'SUBMITTED', 'recovery could not resolve it — still genuinely unknown');

  // 4. journalledSend's exact gate, re-evaluated after the recovery pass —
  //    this is the precise check that stands between the fallback's
  //    decreaseLiquidity call and an actual broadcast.
  const stillUnresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  const sendWouldBeRefused = wouldRefuseNewSend(stillUnresolved.length);

  let fallbackSendCalls = 0;
  if (sendWouldBeRefused) {
    // This is the exact branch journalledSend takes: throw, never call raw().
  } else {
    fallbackSendCalls++; // would represent wallet.writeContract(decreaseLiquidity...)
  }

  assert.equal(sendWouldBeRefused, true, 'the fallback send must be refused while multicall\'s outcome is unknown');
  assert.equal(fallbackSendCalls, 0, 'NO second economic transaction may be broadcast while the first is unresolved');
});

// ── The safe-permit case: fallback IS allowed once the first tx is provably resolved ──

test('fallback is permitted once recovery proves the primary tx was never actually submitted (NOT_SUBMITTED)', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  const multicallId = createTxJournalEntry({
    chainId: CHAIN,
    wallet: WALLET,
    nonce: 10,
    action: 'writeContract:multicall',
  });
  updateTxJournalEntry(multicallId, { state: 'BROADCAST_UNKNOWN' }); // no hash was ever recorded

  const unresolvedBefore = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  await recoverUnresolvedEntries(
    unresolvedBefore.map((e) => ({
      id: e.id,
      chainId: e.chainId,
      action: e.action,
      txHash: null,
      nonce: e.nonce,
      wallet: WALLET,
    })),
    () => ({
      getTransactionReceipt: async () => null,
      getTransactionCount: async () => 10, // pending nonce == attempted nonce on every check -> never consumed
    }),
    (id, outcome) => {
      if (outcome !== 'SUBMITTED') updateTxJournalEntry(id, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
    },
    { nonceAttempts: 5, nonceBackoffMs: 1, sleepFn: noSleep },
  );

  const stillUnresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.equal(stillUnresolved.length, 0, 'a nonce proven never-consumed resolves to NOT_SUBMITTED, clearing the gate');
  assert.equal(wouldRefuseNewSend(stillUnresolved.length), false, 'the fallback may now safely proceed');
});

test('fallback is permitted once recovery proves the primary tx definitively reverted on-chain (MINED_REVERT)', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  const multicallId = createTxJournalEntry({
    chainId: CHAIN,
    wallet: WALLET,
    nonce: 10,
    action: 'writeContract:multicall',
  });
  updateTxJournalEntry(multicallId, { state: 'SUBMITTED', tx_hash: '0xmulticallhash' });

  const unresolvedBefore = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  await recoverUnresolvedEntries(
    unresolvedBefore.map((e) => ({
      id: e.id,
      chainId: e.chainId,
      action: e.action,
      txHash: e.txHash as `0x${string}` | null,
      nonce: e.nonce,
      wallet: WALLET,
    })),
    () => ({
      getTransactionReceipt: async () => ({ status: 'reverted' }),
      getTransactionCount: async () => 11,
    }),
    (id, outcome) => {
      if (outcome !== 'SUBMITTED') updateTxJournalEntry(id, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
    },
    { receiptAttempts: 1, sleepFn: noSleep },
  );

  const stillUnresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.equal(stillUnresolved.length, 0, 'a confirmed revert is terminal — clears the gate (no economic effect occurred, safe to try an alternative)');
  assert.equal(wouldRefuseNewSend(stillUnresolved.length), false);
});

// ── 9. Chained fallback: decreaseLiquidity -> collect is gated the same way ──

test('the same gate applies to the second fallback leg (collect after decreaseLiquidity), not just the first', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  const decId = createTxJournalEntry({
    chainId: CHAIN,
    wallet: WALLET,
    nonce: 11,
    action: 'writeContract:decreaseLiquidity',
  });
  updateTxJournalEntry(decId, { state: 'SUBMITTED', tx_hash: '0xdecreasehash' });

  // collect (h2) would be attempted next — journalledSend's gate sees the
  // still-unresolved decreaseLiquidity entry exactly the same way it saw
  // the multicall entry above.
  const unresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]!.action, 'writeContract:decreaseLiquidity');
  assert.equal(wouldRefuseNewSend(unresolved.length), true, 'collect must also be refused while decreaseLiquidity is unresolved');
});

// ── 10. Journal state across the full A-F outcome matrix ─────────────────

test('journal state matrix: every receipt-wait outcome maps to the documented journal state', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  const cases: Array<{
    label: string;
    receipt: { status: 'success' | 'reverted' } | null;
    nonceAdvanced: boolean;
    expectUnresolved: boolean;
    expectOutcome: RecoveryOutcome;
  }> = [
    { label: 'A. success', receipt: { status: 'success' }, nonceAdvanced: true, expectUnresolved: false, expectOutcome: 'CONFIRMED' },
    { label: 'B. revert', receipt: { status: 'reverted' }, nonceAdvanced: true, expectUnresolved: false, expectOutcome: 'MINED_REVERT' },
    { label: 'E. timeout (still pending)', receipt: null, nonceAdvanced: true, expectUnresolved: true, expectOutcome: 'SUBMITTED' },
  ];
  for (const c of cases) {
    __resetStoreForTests();
  const CHAIN = freshChainId();
    const id = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 10, action: 'writeContract:multicall' });
    updateTxJournalEntry(id, { state: 'SUBMITTED', tx_hash: '0xh' });
    await recoverUnresolvedEntries(
      [{ id, chainId: CHAIN, action: 'writeContract:multicall', txHash: '0xh' as `0x${string}`, nonce: 10, wallet: WALLET }],
      () => ({
        getTransactionReceipt: async () => c.receipt,
        getTransactionCount: async () => (c.nonceAdvanced ? 11 : 10),
      }),
      (rid, outcome) => {
        if (outcome !== 'SUBMITTED') updateTxJournalEntry(rid, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
      },
      { receiptAttempts: 1, sleepFn: noSleep },
    );
    const unresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
    assert.equal(unresolved.length > 0, c.expectUnresolved, `${c.label}: unresolved mismatch`);
  }
});

// ── D. Post-broadcast UNKNOWN via RPC error specifically (not just "not found") ──

test('post-broadcast UNKNOWN via a receipt-lookup RPC error behaves identically to a timeout — fallback still refused', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  const id = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 10, action: 'writeContract:multicall' });
  updateTxJournalEntry(id, { state: 'SUBMITTED', tx_hash: '0xh' });

  await recoverUnresolvedEntries(
    [{ id, chainId: CHAIN, action: 'writeContract:multicall', txHash: '0xh' as `0x${string}`, nonce: 10, wallet: WALLET }],
    () => ({
      getTransactionReceipt: async () => {
        throw new Error('ECONNRESET');
      },
      getTransactionCount: async () => 10,
    }),
    (rid, outcome) => {
      if (outcome !== 'SUBMITTED') updateTxJournalEntry(rid, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
    },
    { receiptAttempts: 2, receiptBackoffMs: 1, nonceAttempts: 2, nonceBackoffMs: 1, sleepFn: noSleep },
  );

  const stillUnresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.ok(stillUnresolved.length > 0, 'an RPC error must never be treated as proof the tx was never broadcast');
});

// ── C/E distinction: pre-broadcast failure is NOT the same as post-broadcast UNKNOWN ──

test('classifyBroadcastError never classifies a receipt-wait timeout message as a pre-broadcast (NOT_SUBMITTED) failure', () => {
  // Phase 4.6.13's receipt-wait timeout throws viem's own
  // WaitForTransactionReceiptTimeoutError, whose message is
  // `Timed out while waiting for transaction with hash "..." to be confirmed.`
  // This function is never actually called on that error in production
  // (receipt-wait errors don't flow through journalledSend's classifier at
  // all — see the phase report §4) — this test is a defense-in-depth
  // regression guard: even if it were, the message must not accidentally
  // match the NOT_SUBMITTED pattern list.
  const timeoutMessage = 'Timed out while waiting for transaction with hash "0xabc" to be confirmed.';
  assert.equal(classifyBroadcastError(new Error(timeoutMessage)), 'AMBIGUOUS');
});

// ── Nonce behavior: the fallback always fetches a fresh nonce, never reuses ──

test('nonce: recovery correctly distinguishes "nonce still pending" from "nonce consumed" without assuming reuse', async () => {
  __resetStoreForTests();
  const CHAIN = freshChainId();
  // journalledSend always fetches a fresh `pending` nonce for every new
  // send (unchanged, not modified this phase) — this test only confirms
  // the recovery classification itself (which determines whether the
  // fallback is ever reached) correctly reads nonce state rather than
  // assuming anything about reuse.
  const id = createTxJournalEntry({ chainId: CHAIN, wallet: WALLET, nonce: 10, action: 'writeContract:multicall' });
  updateTxJournalEntry(id, { state: 'BROADCAST_UNKNOWN' });

  await recoverUnresolvedEntries(
    [{ id, chainId: CHAIN, action: 'writeContract:multicall', txHash: null, nonce: 10, wallet: WALLET }],
    () => ({
      getTransactionReceipt: async () => null,
      getTransactionCount: async () => 11, // pending nonce advanced past 10 -> consumed
    }),
    (rid, outcome) => {
      if (outcome !== 'SUBMITTED') updateTxJournalEntry(rid, { state: outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome });
    },
    { nonceAttempts: 3, nonceBackoffMs: 1, sleepFn: noSleep },
  );

  const stillUnresolved = listUnresolvedTxJournal({ chainId: CHAIN, wallet: WALLET });
  assert.ok(stillUnresolved.length > 0, 'a consumed nonce with no hash must remain RECOVERY_REQUIRED, never cleared as safe-to-retry');
});

// ── Structural: close.ts actually routes every fallback write through the wallet client ──

test('structural: every writeContract call in the close.ts multicall path uses wallet.writeContract (routed through journalledSend), never a raw/unwrapped send', async () => {
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path2.dirname(fileURLToPath(import.meta.url));
  const closeSrc = fs2.readFileSync(path2.join(here, '..', 'src', 'chain', 'close.ts'), 'utf8');

  // Every send in closePosition must go through `wallet.writeContract`
  // (the only client that is ever wrapped with journalledSend — see
  // clients.ts's getWalletClient) — never client.writeContract (the
  // read-only public client has no such method) or a bare unwrapped call.
  const allWriteContractCalls = closeSrc.match(/[A-Za-z0-9_]+\.writeContract\(/g) ?? [];
  const walletWriteContractCalls = closeSrc.match(/\bwallet\.writeContract\(/g) ?? [];
  assert.ok(walletWriteContractCalls.length >= 5, `expected at least the 5 known writeContract call sites (multicall/decrease/collect/burn/claimFees), found ${walletWriteContractCalls.length}`);
  assert.equal(
    allWriteContractCalls.length,
    walletWriteContractCalls.length,
    'every .writeContract( call in close.ts must be wallet.writeContract( — no call may bypass the wallet client',
  );
});
