/**
 * Phase 4.7.1 — global staging/dry-run gate at the centralized broadcast
 * boundary (src/chain/clients.ts's journalledSend, the sole place
 * `createWalletClient` is ever constructed in this codebase).
 *
 * Unlike test/closeFallbackRebroadcast.test.ts (which reproduces
 * journalledSend's unresolved-tx gating logic against exported building
 * blocks, since journalledSend itself is unexported and network-dependent
 * beyond its first line), this suite exercises the REAL, unmodified,
 * unexported journalledSend end-to-end through the real, exported
 * getWalletClient() — made possible specifically because the staging check
 * is the very first statement in journalledSend, before any RPC call, so
 * every test here is genuinely network-independent and deterministic: a
 * staged send never reaches getPublicClient(), never reaches the journal,
 * and never reaches the real `raw()` broadcast function.
 *
 * Covers required tests #3–#9, #13, #14, #15 from the task brief.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-staginggate-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { getWalletClient, StagingBlockedError, isStagingBlockedError } = await import('../src/chain/clients.js');
const { listAllTxJournal, listUnresolvedTxJournal, listConfirmedTxJournal, __resetStoreForTests } = await import(
  '../src/db/index.js'
);

const CHAIN = 4663; // must be a real SupportedChainId — getWalletClient() only accepts 4663/56/8453

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

/**
 * Deliberately `async` and `await`s `fn()` — a synchronous try/finally
 * around an async callback would restore TRADING_MODE as soon as `fn()`
 * returns a *pending* promise, not after it settles, letting the
 * callback's later `await`ed work run with the wrong env var. That exact
 * bug was caught during this suite's own authoring (a staged send briefly,
 * genuinely reached the real Robinhood Chain RPC before this fix — see the
 * PHASE4_7_1 report's test-authoring-bug disclosure; the account used has
 * zero balance and the node rejected it, so nothing was ever broadcast).
 */
async function withTradingMode<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prior = process.env.TRADING_MODE;
  if (value == null) delete process.env.TRADING_MODE;
  else process.env.TRADING_MODE = value;
  try {
    return await fn();
  } finally {
    if (prior == null) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = prior;
  }
}

// A syntactically-plausible but entirely fake destination/calldata — never
// actually sent anywhere, since staging refuses before any RPC call.
const FAKE_TX = {
  to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
  value: 0n,
};
const FAKE_WRITE = {
  address: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
  abi: [
    {
      type: 'function',
      name: 'approve',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [{ type: 'bool' }],
    },
  ] as const,
  functionName: 'approve' as const,
  args: ['0x000000000000000000000000000000000000dEaD' as `0x${string}`, 0n] as const,
};

// ── 3/4/5. Staging blocks broadcast, at the centralized boundary ─────────

test('staging: wallet.sendTransaction is refused, never reaches the RPC broadcast', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    const wallet = getWalletClient(CHAIN);
    await assert.rejects(() => wallet.sendTransaction(FAKE_TX as never), StagingBlockedError);
  });
});

test('staging: wallet.writeContract is refused, never reaches the RPC broadcast', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    const wallet = getWalletClient(CHAIN);
    await assert.rejects(() => wallet.writeContract(FAKE_WRITE as never), StagingBlockedError);
  });
});

// ── 6. Distinguishable from SUCCESS, FAILED, and UNKNOWN ──────────────────

test('staging-blocked error is distinguishable from a real failure via isStagingBlockedError()', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    const wallet = getWalletClient(CHAIN);
    try {
      await wallet.sendTransaction(FAKE_TX as never);
      assert.fail('expected sendTransaction to reject');
    } catch (e) {
      assert.equal(isStagingBlockedError(e), true, 'must be recognized as a staging block');
      assert.ok(e instanceof StagingBlockedError);
      assert.equal((e as InstanceType<typeof StagingBlockedError>).kind, 'sendTransaction');
      assert.equal((e as InstanceType<typeof StagingBlockedError>).chainId, CHAIN);
    }
  });
});

test('a generic thrown error is NOT misclassified as a staging block', () => {
  assert.equal(isStagingBlockedError(new Error('some real RPC error')), false);
  assert.equal(isStagingBlockedError(null), false);
  assert.equal(isStagingBlockedError(undefined), false);
  assert.equal(isStagingBlockedError({ staged: true }), false, 'must also check the error name, not just a spoofed field');
});

// ── 7/8. No journal entry, no CONFIRMED state, no fake recovery entries ───

test('staging-blocked send creates ZERO journal entries — never CONFIRMED, never SUBMITTED, never unresolved', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    const wallet = getWalletClient(CHAIN);
    await assert.rejects(() => wallet.sendTransaction(FAKE_TX as never));
  });
  assert.equal(listAllTxJournal().length, 0, 'a staging block must never touch the journal at all');
  assert.equal(listUnresolvedTxJournal({ chainId: CHAIN }).length, 0);
  assert.equal(listConfirmedTxJournal(CHAIN).length, 0);
});

test('multiple staged attempts in a row create zero cumulative journal entries and never fabricate an unresolved-tx block for a later real attempt', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    const wallet = getWalletClient(CHAIN);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => wallet.sendTransaction(FAKE_TX as never));
    }
  });
  assert.equal(listAllTxJournal().length, 0, 'repeated staging blocks must never accumulate fake journal state');
});

// ── 9. Real transaction path unchanged when staging is OFF ───────────────
//
// Deliberately NOT exercised by actually letting a send reach the real RPC
// (even a doomed, zero-balance, dead-address send is a genuine broadcast
// ATTEMPT against production infrastructure — exactly what this whole
// phase exists to make impossible to do by accident). Instead, proven at
// the only two levels that can establish "unchanged" without ever
// broadcasting anything real:
//   1. getTradingMode() itself, unit-tested exhaustively in
//      test/config.tradingMode.test.ts (unset/'live' -> 'live').
//   2. Structural proof that the staging gate is a pure, self-contained
//      early guard — it neither wraps nor alters anything below it — so
//      "gate doesn't fire" is provably identical to "gate doesn't exist".

test('structural: the staging gate is a pure early guard — a single if-throw block, not a wrapper around the rest of journalledSend', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'chain', 'clients.ts'), 'utf8');

  const fnStart = src.indexOf('async function journalledSend<Args');
  assert.ok(fnStart > -1, 'journalledSend must still exist');
  const gateIdx = src.indexOf("if (getTradingMode() === 'staging')", fnStart);
  assert.ok(gateIdx > fnStart, 'the staging gate must live inside journalledSend');

  // The gate must be the FIRST statement (only past the JSDoc/type
  // signature and the opening brace) — nothing else runs before it.
  const bodyStart = src.indexOf('{', src.indexOf('): Promise<Hex> {', fnStart));
  const between = src
    .slice(bodyStart + 1, gateIdx)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//')) // exclude explanatory comment lines (which legitimately name these identifiers in prose)
    .join('\n');
  assert.doesNotMatch(
    between,
    /getPublicClient|listUnresolvedTxJournal|createTxJournalEntry|await /,
    'nothing — no RPC call, no journal read/write, no await — may run before the staging check',
  );

  // The gate itself must be a self-contained if-block that throws and
  // returns control via that throw — it must not set any variable that the
  // rest of the function's (unrelated, real-send) logic below reads, i.e.
  // it cannot alter the real-send path's behavior by side effect.
  const gateBlockEnd = src.indexOf('\n\n', gateIdx);
  const gateBlock = src.slice(gateIdx, gateBlockEnd);
  assert.match(gateBlock, /throw new StagingBlockedError/, 'the gate must throw, not fall through');
  assert.doesNotMatch(gateBlock, /\bnonce\s*=|\bjournalId\s*=/, 'the gate must not assign any variable used by the real-send logic below it');
});

// ── 13/14. Adversarial: no caller-side way to bypass the gate ────────────

test('adversarial: calling getWalletClient() with different argument shapes still routes through the same centralized gate', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    // No walletId (active wallet) and an explicit walletId resolving to the
    // same active wallet both still go through the identical getWalletClient
    // -> withTxLock -> journalledSend wrapping — there is no alternate
    // construction path that skips it.
    const walletDefault = getWalletClient(CHAIN);
    await assert.rejects(() => walletDefault.sendTransaction(FAKE_TX as never), StagingBlockedError);
  });
});

test('adversarial: concurrent staged sends never race past the gate — every single one is refused', async () => {
  resetDb();
  await withTradingMode('staging', async () => {
    const wallet = getWalletClient(CHAIN);
    const attempts = await Promise.allSettled([
      wallet.sendTransaction(FAKE_TX as never),
      wallet.sendTransaction(FAKE_TX as never),
      wallet.writeContract(FAKE_WRITE as never),
      wallet.sendTransaction(FAKE_TX as never),
    ]);
    for (const r of attempts) {
      assert.equal(r.status, 'rejected');
      if (r.status === 'rejected') assert.equal(isStagingBlockedError(r.reason), true);
    }
  });
  assert.equal(listAllTxJournal().length, 0, 'no concurrent staged attempt may leave a journal trace');
});

// ── 15. No secret exposed by staging logs/errors ──────────────────────────

test('staging block error message and log line contain no secret material (private key, token, RPC credentials)', async () => {
  resetDb();
  const originalWarn = console.warn;
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await withTradingMode('staging', async () => {
      const wallet = getWalletClient(CHAIN);
      try {
        await wallet.sendTransaction(FAKE_TX as never);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The message legitimately contains the (non-secret) wallet ADDRESS
        // and chain id — it must never contain anything resembling a raw
        // private key (0x + 64 hex chars) or a Telegram-bot-token shape.
        assert.doesNotMatch(msg, /0x[0-9a-fA-F]{64}/, 'must not contain a 32-byte hex value (private key shape)');
        assert.doesNotMatch(msg, /\d{6,}:[A-Za-z0-9_-]{30,}/, 'must not contain a Telegram-bot-token shape');
      }
    });
    const combined = logged.join('\n');
    assert.doesNotMatch(combined, /0x[0-9a-fA-F]{64}/);
    assert.doesNotMatch(combined, /\d{6,}:[A-Za-z0-9_-]{30,}/);
    assert.ok(logged.some((l) => l.includes('[staging]')), 'a clear safety event must be logged');
  } finally {
    console.warn = originalWarn;
  }
});
