/**
 * Phase 4.7.1 — staging gate integration through a real caller (TP/SL
 * close), and shutdown-still-works under staging.
 *
 * Covers required tests #10 (MULTI/TP-SL behavior unchanged except
 * broadcast blocking) and #11 (shutdown still works) from the task brief.
 *
 * closePosition() itself is injected (as every other tpslWatcher test in
 * this suite already does — see tpslWatcher.shutdown.test.ts,
 * tpslWatcher.accountingMeta.test.ts), but here the injected function
 * calls the REAL getWalletClient(...).writeContract(...) — the exact same
 * production choke point close.ts itself uses — rather than returning a
 * canned result. This proves the actual staging enforcement is reached via
 * a real TP/SL trigger, without needing the RPC-heavy position/pool reads
 * closePosition() performs before ever reaching the broadcast (those reads
 * are unrelated to this phase and already covered elsewhere).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-staging-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, setPositionTpSl, setUserPrefs, getLedgerEntries, listAllTxJournal, __resetStoreForTests } =
  await import('../src/db/index.js');
const { getWalletClient, isStagingBlockedError } = await import('../src/chain/clients.js');
const {
  startTpslWatcher,
  stopTpslWatcher,
  __tickForTests,
  __setTpslDepsForTests,
  __resetTpslWatcherForTests,
  __getWatcherStateForTests,
  __isClosingForTests,
} = await import('../src/bot/tpslWatcher.js');

const CHAIN = 4663;
const CONFIRM_MS = 5_000;

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

let tokenCounter = 8000;
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

function resetAll(): void {
  __resetTpslWatcherForTests();
  resetDb();
  tokenCounter = 8000;
}

/** Mirrors what the real closePosition() ultimately does: call the real, wrapped wallet client. */
async function realBroadcastingClosePosition(): Promise<never> {
  const wallet = getWalletClient(CHAIN);
  await wallet.writeContract({
    address: '0x000000000000000000000000000000000000dEaD',
    abi: [
      { type: 'function', name: 'collect', stateMutability: 'nonpayable', inputs: [], outputs: [] },
    ] as const,
    functionName: 'collect',
    args: [],
  } as never);
  throw new Error('unreachable: writeContract should have thrown before this point');
}

test('staging: a real TP/SL-triggered close reaches the real broadcast boundary and is refused there — position stays open, no ledger entry, no journal entry', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);

  const priorTradingMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'staging';

  let notifiedFailure = false;
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }), // TP hit (10%)
    closePosition: realBroadcastingClosePosition as never,
  });

  const bot = {
    api: {
      sendMessage: async (_id: number, text: string) => {
        if (text.includes('close failed')) notifiedFailure = true;
      },
    },
  } as unknown as Bot;

  try {
    startTpslWatcher(bot);
    await __tickForTests(bot); // arms the real 5s confirmation timer
    await new Promise((r) => setTimeout(r, CONFIRM_MS + 300)); // let it fire -> recheckAndMaybeClose -> executeClose -> real broadcast attempt

    assert.equal(notifiedFailure, true, 'executeClose must catch the StagingBlockedError and notify a close failure, not crash or hang');
    assert.equal(getLedgerEntries(CHAIN, tokenId, 'withdrawal').length, 0, 'a staging-blocked close must never write a withdrawal ledger row');
    assert.equal(listAllTxJournal().length, 0, 'a staging-blocked close must never create a journal entry');
    assert.equal(__isClosingForTests(CHAIN, tokenId), false, 'the closing lock must be released even after a staging-blocked attempt');

    // ── #11: shutdown still works after a staging-blocked close ──────────
    const shutdownStart = Date.now();
    await stopTpslWatcher();
    assert.ok(Date.now() - shutdownStart < 2_000, 'shutdown must complete promptly — no hang from the staging-blocked attempt');
    assert.equal(__getWatcherStateForTests(), 'stopped');
  } finally {
    if (priorTradingMode == null) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = priorTradingMode;
  }
}, { timeout: CONFIRM_MS + 5_000 });

test('sanity: isStagingBlockedError correctly identifies the error that propagated out of the real writeContract call', async () => {
  resetAll();
  const priorTradingMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'staging';
  try {
    await assert.rejects(() => realBroadcastingClosePosition(), (e) => isStagingBlockedError(e));
  } finally {
    if (priorTradingMode == null) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = priorTradingMode;
  }
});
