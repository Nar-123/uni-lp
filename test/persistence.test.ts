/**
 * Phase 4.6.1 — crash-safe persistence tests (P1-1).
 *
 * Exercises the real db/index.ts JSON-file store (not mocked) against a
 * scratch DB_PATH, set up BEFORE any db/config-touching import runs —
 * same isolation pattern as test/ledger.test.ts. `__resetStoreForTests()`
 * is used between cases that need `load()` to actually re-read from disk
 * (rather than reuse the in-memory singleton), to simulate a process
 * restart without spawning a child process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-persist-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const storePath = process.env.DB_PATH;
const tmpPath = `${storePath}.tmp`;
const bakPath = `${storePath}.bak`;

const {
  getDb,
  recordLedger,
  getLedgerEntries,
  createTxJournalEntry,
  getTxJournalEntry,
  __resetStoreForTests,
} = await import('../src/db/index.js');

function freshTokenId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rmIfExists(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function readRawPrimary(): string {
  return fs.readFileSync(storePath, 'utf8');
}

// ── 1/2. Successful atomic write leaves a valid, complete primary and no leftover temp file ──

test('persist: a successful mutation leaves the primary as valid JSON with no leftover .tmp', () => {
  __resetStoreForTests();
  getDb();
  const tokenId = freshTokenId();
  recordLedger({ chainId: 8453, tokenId, kind: 'deposit', usd: 42 });

  const raw = readRawPrimary();
  const parsed = JSON.parse(raw); // must not throw
  assert.ok(Array.isArray(parsed.ledger));
  assert.ok(parsed.ledger.some((r: { token_id: string }) => r.token_id === tokenId));
  assert.equal(fs.existsSync(tmpPath), false, 'the temp file must be renamed away, never left behind on success');
});

// ── 9. Repeated writes preserve the complete accumulated state, not just the latest delta ──

test('persist: repeated writes accumulate — every prior entry survives every subsequent write', () => {
  __resetStoreForTests();
  getDb();
  const ids = [freshTokenId(), freshTokenId(), freshTokenId()];
  for (const id of ids) {
    recordLedger({ chainId: 8453, tokenId: id, kind: 'deposit', usd: 1 });
  }
  const raw = JSON.parse(readRawPrimary());
  for (const id of ids) {
    assert.ok(
      raw.ledger.some((r: { token_id: string }) => r.token_id === id),
      `entry ${id} from an earlier write must still be present after later writes`,
    );
  }
});

// ── 10. Journal survives a simulated restart (reload from disk) ──

test('persist + restart: a tx journal entry written before "restart" is readable after it', () => {
  __resetStoreForTests();
  getDb();
  const id = createTxJournalEntry({ chainId: 8453, wallet: '0xabc', nonce: 5, action: 'writeContract:mint' });

  // Simulate a process restart: drop the in-memory singleton, force a fresh load() from disk.
  __resetStoreForTests();
  const reloaded = getTxJournalEntry(id);
  assert.ok(reloaded, 'journal entry must survive a reload from the on-disk primary');
  assert.equal(reloaded!.chainId, 8453);
  assert.equal(reloaded!.action, 'writeContract:mint');
});

// ── 3/6/7. A write failure never silently succeeds and never touches the existing valid primary ──

test('persist: a temp-file write failure throws (never silently reports success) and leaves the existing primary byte-for-byte unchanged', () => {
  __resetStoreForTests();
  getDb();
  const survivorId = freshTokenId();
  recordLedger({ chainId: 8453, tokenId: survivorId, kind: 'deposit', usd: 7 });
  const before = readRawPrimary();

  // Force the temp-file write to fail: put a directory where persist() needs
  // to open a file for writing. This is a real, portable failure condition
  // (opening a directory with mode 'w' fails on every platform), not a mock.
  rmIfExists(tmpPath);
  fs.mkdirSync(tmpPath);
  try {
    assert.throws(
      () => recordLedger({ chainId: 8453, tokenId: freshTokenId(), kind: 'deposit', usd: 99 }),
      /persist: failed to write temp file/,
      'a persist() failure must propagate, never be swallowed as a silent success',
    );
    const after = readRawPrimary();
    assert.equal(
      after,
      before,
      'the existing on-disk primary must be byte-for-byte unchanged after a failed write attempt — ' +
        'it is never truncated or touched before the replacement is ready',
    );
  } finally {
    rmIfExists(tmpPath);
  }
});

// ── 4. A backup-rotation failure is non-fatal and does not block installing the new state ──
//
// True fault-injection of the SECOND (critical) rename is impractical to do
// portably without a mocking framework (this repo has none) or fragile
// platform-specific file-locking tricks. The backup rotation uses the exact
// same fs.renameSync API as the critical install rename, so forcing *it* to
// fail (by making its target an existing non-empty directory, which no
// rename can replace on any platform) exercises the same failure class and
// verifies the documented behavior: rotation failure is logged and does not
// prevent the new state from being installed.

test('persist: a backup-rotation failure is non-fatal — the new state is still installed', () => {
  __resetStoreForTests();
  getDb();
  rmIfExists(bakPath);
  fs.mkdirSync(bakPath);
  fs.mkdirSync(path.join(bakPath, 'occupied')); // non-empty — cannot be replaced by rename

  const tokenId = freshTokenId();
  try {
    assert.doesNotThrow(() => recordLedger({ chainId: 8453, tokenId, kind: 'deposit', usd: 3 }));
    const raw = JSON.parse(readRawPrimary());
    assert.ok(
      raw.ledger.some((r: { token_id: string }) => r.token_id === tokenId),
      'the new entry must be installed even though backup rotation failed',
    );
  } finally {
    rmIfExists(bakPath);
  }
});

// ── 5/6. Malformed primary is never silently treated as an empty database ──

test('load: a corrupt primary with no usable backup/temp throws — never silently becomes an empty store', () => {
  __resetStoreForTests();
  rmIfExists(tmpPath);
  rmIfExists(bakPath);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, '{not valid json!!');

  assert.throws(
    () => getDb(),
    /FATAL: primary store .* is corrupt/,
    'a corrupt primary with nothing to recover from must fail loud, never fall back to an invented empty store',
  );

  // The corrupt file must be preserved (quarantined), never deleted.
  const dir = fs.readdirSync(path.dirname(storePath));
  const quarantined = dir.filter((f) => f.includes(path.basename(storePath) + '.corrupt-'));
  assert.equal(quarantined.length, 1, 'the corrupt primary must be renamed aside for diagnosis, not deleted');

  // Clean up so later tests in this file get a fresh, valid primary again.
  __resetStoreForTests();
  rmIfExists(storePath);
  for (const f of quarantined) rmIfExists(path.join(path.dirname(storePath), f));
  getDb();
});

test('load: a corrupt primary recovers from a valid .tmp sidecar (the most recent complete write) rather than failing or going empty', () => {
  __resetStoreForTests();
  getDb();
  const survivorId = freshTokenId();
  recordLedger({ chainId: 8453, tokenId: survivorId, kind: 'deposit', usd: 11 });
  const goodState = readRawPrimary();

  // Corrupt the primary, but leave a valid .tmp behind, as a crash between
  // "temp file fully written" and "renamed over primary" would.
  fs.writeFileSync(storePath, '{{{not json');
  fs.writeFileSync(tmpPath, goodState);

  __resetStoreForTests();
  const recovered = getLedgerEntries(8453, survivorId);
  assert.equal(recovered.length, 1, 'must recover the entry from the .tmp sidecar, not report an empty ledger');

  // And the corrupt original must have been quarantined, not deleted.
  const dir = fs.readdirSync(path.dirname(storePath));
  const quarantined = dir.filter((f) => f.includes(path.basename(storePath) + '.corrupt-'));
  assert.ok(quarantined.length >= 1, 'the corrupt primary must be quarantined during sidecar recovery too');
  for (const f of quarantined) rmIfExists(path.join(path.dirname(storePath), f));
});

test('load: primary missing entirely recovers from .bak (previous generation) rather than starting empty', () => {
  __resetStoreForTests();
  getDb();
  const survivorId = freshTokenId();
  recordLedger({ chainId: 8453, tokenId: survivorId, kind: 'deposit', usd: 5 });
  const goodState = readRawPrimary();

  // Simulate a crash exactly between the two renames in persist(): the
  // primary was moved to .bak, but the temp file was never promoted (and,
  // for this test, doesn't exist at all — the harder "recover from .tmp"
  // case is covered separately above).
  fs.copyFileSync(storePath, bakPath);
  rmIfExists(storePath);
  rmIfExists(tmpPath);

  __resetStoreForTests();
  const recovered = getLedgerEntries(8453, survivorId);
  assert.equal(recovered.length, 1, 'must recover from .bak when the primary is absent and no .tmp exists');
  assert.equal(readRawPrimary(), goodState, 'the recovered state must be re-committed to the primary path');
});

test('load: a missing primary with an unreadable/malformed sidecar throws — never invents an empty store when history should exist', () => {
  __resetStoreForTests();
  rmIfExists(storePath);
  rmIfExists(tmpPath);
  fs.writeFileSync(bakPath, 'not json at all');

  assert.throws(
    () => getDb(),
    /FATAL: primary store .* is missing/,
    'a missing primary with only a corrupt sidecar must fail loud, never silently start empty',
  );

  __resetStoreForTests();
  rmIfExists(bakPath);
  const dir = fs.readdirSync(path.dirname(storePath));
  for (const f of dir) {
    if (f.includes('.corrupt-')) rmIfExists(path.join(path.dirname(storePath), f));
  }
  getDb();
});

// ── 8. Stray leftover temp file next to a valid primary is cleaned up, not left dangling forever ──

test('load: a stray .tmp next to a valid primary is cleaned up without affecting the loaded state', () => {
  __resetStoreForTests();
  getDb();
  const survivorId = freshTokenId();
  recordLedger({ chainId: 8453, tokenId: survivorId, kind: 'deposit', usd: 9 });

  fs.writeFileSync(tmpPath, '{"positions":[],"ledger":[],"nextLedgerId":1,"prefs":{}}'); // stray, superseded garbage

  __resetStoreForTests();
  const rows = getLedgerEntries(8453, survivorId);
  assert.equal(rows.length, 1, 'the valid primary must win over a stray stale .tmp');
  assert.equal(fs.existsSync(tmpPath), false, 'a stray .tmp superseded by a valid primary must be cleaned up on load');
});
