/**
 * Phase 4.6.1 — single-instance process lock tests (P1-2).
 *
 * Most cases test the real, unmocked `src/instanceLock.ts` functions
 * against a scratch lock file. A few cases genuinely need a second OS
 * process (to get a real, verifiably live-or-dead PID that isn't this
 * test process's own, and to exercise true concurrent acquisition) —
 * those use `node:child_process`, per the task's own guidance to prefer
 * child-process integration tests where a true multi-process scenario
 * isn't otherwise practical to simulate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireInstanceLock,
  releaseInstanceLock,
  defaultLockPath,
  __resetLockStateForTests,
} from '../src/instanceLock.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-lock-test-'));
const require = createRequire(import.meta.url);

function freshLockPath(): string {
  return path.join(scratchDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

function rmIfExists(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

// ── 1. First instance acquires the lock ──

test('acquireInstanceLock: first acquisition succeeds and writes identifiable PID/host/time metadata', () => {
  const lockPath = freshLockPath();
  const result = acquireInstanceLock(lockPath, 'test-owner');
  assert.equal(result.acquired, true);
  const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  // ── 8. Lock contains identifiable PID/metadata ──
  assert.equal(info.pid, process.pid);
  assert.equal(typeof info.hostname, 'string');
  assert.ok(info.hostname.length > 0);
  assert.equal(typeof info.acquiredAt, 'number');
  assert.equal(info.owner, 'test-owner');
  releaseInstanceLock(lockPath);
});

// ── 2. Second (here: same-process re-)acquisition cannot succeed while the first is live ──
// ── 5. A live PID's lock cannot be stolen ──
//
// Attempting to acquire the SAME path again without releasing means the
// existing lock's recorded PID is this very test process's own PID — which
// is unimpeachably "live" from the OS's point of view, exactly like a
// genuinely separate second instance racing a still-running first one.

test('acquireInstanceLock: a second acquisition attempt against a lock held by a live PID fails closed', () => {
  const lockPath = freshLockPath();
  const first = acquireInstanceLock(lockPath);
  assert.equal(first.acquired, true);

  const second = acquireInstanceLock(lockPath);
  assert.equal(second.acquired, false);
  if (!second.acquired) {
    assert.equal(second.reason, 'HELD_BY_LIVE_PROCESS');
    assert.equal(second.existing.pid, process.pid);
  }
  releaseInstanceLock(lockPath);
});

// ── 3. Releasing permits the next acquisition ──

test('releaseInstanceLock then acquireInstanceLock: release genuinely frees the path for the next instance', () => {
  const lockPath = freshLockPath();
  const first = acquireInstanceLock(lockPath);
  assert.equal(first.acquired, true);
  releaseInstanceLock(lockPath);
  assert.equal(fs.existsSync(lockPath), false);

  const second = acquireInstanceLock(lockPath);
  assert.equal(second.acquired, true, 'a fresh acquisition after release must succeed');
  releaseInstanceLock(lockPath);
});

// ── 4. A stale PID (confirmed dead) is safely reclaimed ──

test('acquireInstanceLock: a lock recorded against a now-dead PID is safely reclaimed', () => {
  const lockPath = freshLockPath();
  // A real, now-exited process — spawnSync blocks until it exits, so by the
  // time we have its pid back, the OS guarantees that pid is no longer this
  // process (barring the astronomically unlikely case of immediate reuse,
  // the same residual risk any PID-based lock scheme carries — documented
  // in instanceLock.ts and the phase report).
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = dead.pid!;
  assert.ok(typeof deadPid === 'number' && deadPid > 0);

  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid, hostname: 'somewhere-else', acquiredAt: Date.now() - 60_000 }),
  );

  const result = acquireInstanceLock(lockPath);
  assert.equal(result.acquired, true, 'a lock file naming a confirmed-dead PID must be reclaimable');
  const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(info.pid, process.pid, 'the reclaiming process must stamp its own PID, not keep the stale one');
  releaseInstanceLock(lockPath);
});

test('acquireInstanceLock: a lock held by a genuinely different, still-running process is not reclaimed', async () => {
  const lockPath = freshLockPath();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  await new Promise((resolve) => setTimeout(resolve, 100)); // let it actually start
  const livePid = child.pid!;
  assert.ok(typeof livePid === 'number' && livePid > 0);

  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: livePid, hostname: 'somewhere-else', acquiredAt: Date.now() }),
  );

  const result = acquireInstanceLock(lockPath);
  assert.equal(result.acquired, false, 'a lock held by a real, currently-running process must never be stolen');
  if (!result.acquired) assert.equal(result.reason, 'HELD_BY_LIVE_PROCESS');

  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  rmIfExists(lockPath);
});

// ── 9. A malformed lock file is handled safely (never silently stolen) ──

test('acquireInstanceLock: a malformed lock file refuses to guess and fails closed rather than stealing it', () => {
  const lockPath = freshLockPath();
  fs.writeFileSync(lockPath, 'this is not json');

  const result = acquireInstanceLock(lockPath);
  assert.equal(result.acquired, false);
  if (!result.acquired) assert.equal(result.reason, 'INDETERMINATE');
  // Must not have touched/deleted the unreadable file.
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'this is not json');
  rmIfExists(lockPath);
});

// ── 6/7. Release is idempotent and safe from both the no-arg (startup-failure) form
//         and the explicit-path (shutdown-signal) form used in index.ts ──

test('releaseInstanceLock: the no-arg form (used by the startup-failure catch handler) releases the most recently held lock', () => {
  __resetLockStateForTests();
  const lockPath = freshLockPath();
  const result = acquireInstanceLock(lockPath);
  assert.equal(result.acquired, true);
  releaseInstanceLock(); // exactly how index.ts's main().catch(...) calls it
  assert.equal(fs.existsSync(lockPath), false);
});

test('releaseInstanceLock: the explicit-path form (used by SIGINT/SIGTERM handlers) releases correctly and is idempotent', () => {
  const lockPath = freshLockPath();
  const result = acquireInstanceLock(lockPath);
  assert.equal(result.acquired, true);
  releaseInstanceLock(lockPath);
  assert.equal(fs.existsSync(lockPath), false);
  // Calling it again (e.g. both a signal handler and an 'exit' handler
  // firing) must not throw or misbehave.
  assert.doesNotThrow(() => releaseInstanceLock(lockPath));
});

test('releaseInstanceLock: never removes a lock that was reclaimed by someone else in the meantime', () => {
  const lockPath = freshLockPath();
  const first = acquireInstanceLock(lockPath, 'first');
  assert.equal(first.acquired, true);

  // Simulate: this process's lock was judged stale and reclaimed by another
  // instance while we still (incorrectly, hypothetically) think we own it.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, hostname: 'other', acquiredAt: Date.now() }));

  releaseInstanceLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true, 'must never delete a lock file that no longer records our own PID');
  rmIfExists(lockPath);
});

// ── defaultLockPath: derived deterministically from the configured dbPath ──

test('defaultLockPath: derives a stable, distinct path from dbPath', () => {
  const a = defaultLockPath(path.join(scratchDir, 'bot.json'));
  const b = defaultLockPath(path.join(scratchDir, 'bot.json'));
  assert.equal(a, b, 'must be deterministic for the same dbPath');
  assert.notEqual(a, path.join(scratchDir, 'bot.json'), 'must not collide with the store file itself');
});

// ── 10. True concurrent acquisition from two real OS processes has exactly one winner ──
//
// A single Node process is inherently single-threaded, so two sequential
// in-process calls only prove the atomicity of the underlying O_CREAT|O_EXCL
// syscall, not genuine cross-process races. Per the task's own guidance,
// this uses two real child processes racing the same lock path.

test('acquireInstanceLock: two real processes racing the same lock path — exactly one wins', async () => {
  const lockPath = freshLockPath();
  const modUrl = pathToFileURL(require.resolve('../src/instanceLock.ts')).href;
  const childScript = path.join(scratchDir, 'race-child.ts');
  fs.writeFileSync(
    childScript,
    [
      `import { acquireInstanceLock } from ${JSON.stringify(modUrl)};`,
      `const result = acquireInstanceLock(process.argv[2]);`,
      `process.stdout.write(result.acquired ? 'ACQUIRED' : 'FAILED:' + result.reason);`,
      // Stay alive briefly after deciding the outcome so a sibling that
      // checks liveness slightly later sees a genuinely live PID rather
      // than one that already exited — otherwise this test would collapse
      // into "sequential stale-reclaim" (a different, already-covered
      // case) instead of exercising a true concurrent race.
      `setTimeout(() => process.exit(0), 900);`,
    ].join('\n'),
  );

  const tsxCli = require.resolve('tsx/cli');
  const run = (): Promise<string> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [tsxCli, childScript, lockPath]);
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.once('exit', () => resolve(out));
    });

  const [a, b] = await Promise.all([run(), run()]);
  const outcomes = [a, b];
  const acquiredCount = outcomes.filter((o) => o === 'ACQUIRED').length;
  assert.equal(acquiredCount, 1, `exactly one of two racing processes must acquire the lock — got: ${outcomes.join(' / ')}`);
  rmIfExists(lockPath);
});
