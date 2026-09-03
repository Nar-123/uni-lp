/**
 * Phase 4.6.1 — single-instance process lock (P1-2).
 *
 * Prevents two bot processes from operating on the same persistence file /
 * wallet at once. `withTxLock` (chain/txLock.ts) only serializes sends
 * *within* one process; nothing previously stopped a second process
 * (e.g. a process-manager restart racing an old instance that hasn't
 * fully exited yet, or an operator accidentally starting the bot twice)
 * from loading the same `data/bot.json`, each with its own independent
 * in-memory copy, and both fetching the same wallet's pending nonce from
 * the RPC node — a genuine cross-process nonce race, and independently a
 * last-write-wins race on the JSON store itself.
 *
 * Mechanism: an exclusive lock file created with O_CREAT|O_EXCL (`wx`),
 * which is atomic at the OS level — if the file already exists, the
 * create fails instead of silently succeeding. The file's contents (PID,
 * hostname, acquisition time, optional owner label) let a later process
 * identify who holds it and decide whether it's stale.
 *
 * Stale-lock recovery: a PID recorded in an existing lock file that is no
 * longer running is safe to reclaim (the process that held it is
 * provably gone). A PID that *is* running — or that we can't prove isn't
 * running (e.g. an unreadable/malformed lock file, or an unexpected error
 * checking it) — must never be reclaimed; every "can't tell" case fails
 * closed (refuses to acquire) rather than risking two live owners. This
 * is deliberately conservative: PID reuse by an unrelated process after
 * the original holder died is a known, accepted residual risk of any
 * lock-file-by-PID scheme and is not fully eliminated here (see the
 * report's documentation of this limitation) — but a live, still-running
 * original holder is never mistakenly treated as stale.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LockInfo = {
  pid: number;
  hostname: string;
  acquiredAt: number;
  /** Human-identifiable context for operator diagnosis, e.g. active wallet address. */
  owner?: string;
};

export type LockAcquireResult =
  | { acquired: true; lockPath: string }
  | { acquired: false; lockPath: string; reason: 'HELD_BY_LIVE_PROCESS'; existing: LockInfo }
  | { acquired: false; lockPath: string; reason: 'INDETERMINATE'; detail: string };

const MAX_RECLAIM_ATTEMPTS = 3;

let heldLockPath: string | null = null;
let exitHandlerRegistered = false;

/** Derive the lock file path from the same base path db/index.ts uses for the store. */
export function defaultLockPath(dbPath: string): string {
  return `${path.resolve(dbPath.replace(/\.(db|json)$/i, ''))}.lock`;
}

function readLockFileSafely(lockPath: string): LockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as LockInfo).pid === 'number' &&
      Number.isInteger((parsed as LockInfo).pid)
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is (as best as Node can tell) a live process.
 *
 * `process.kill(pid, 0)` sends no signal — it only performs the OS's
 * existence/permission check. ESRCH means the OS is certain no such
 * process exists (safe to treat as stale). Every other outcome — the
 * process exists but we lack permission to signal it (EPERM), or any
 * other unexpected error — must be treated as "can't prove it's gone",
 * which this function reports as alive so callers fail closed rather
 * than reclaiming a lock they can't actually confirm is abandoned.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') return false;
    return true; // EPERM or anything else: treat as "can't prove not alive"
  }
}

function writeLockFile(lockPath: string, info: LockInfo): void {
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeSync(fd, JSON.stringify(info, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Acquire the single-instance lock. Must be called before any
 * transaction-capable service (db load, wallet client, bot, watchers)
 * starts — see index.ts, where this is the first statement in main().
 */
export function acquireInstanceLock(lockPath: string, owner?: string): LockAcquireResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
    try {
      writeLockFile(lockPath, {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
        owner,
      });
      heldLockPath = lockPath;
      registerExitCleanup();
      return { acquired: true, lockPath };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        return {
          acquired: false,
          lockPath,
          reason: 'INDETERMINATE',
          detail: `unexpected error creating lock file: ${err.message}`,
        };
      }

      const existing = readLockFileSafely(lockPath);
      if (!existing) {
        // Lock file exists but its contents can't be trusted (empty,
        // malformed, mid-write by another process). We cannot prove the
        // holder is gone, so we refuse rather than guess.
        return {
          acquired: false,
          lockPath,
          reason: 'INDETERMINATE',
          detail: `lock file exists but is unreadable/malformed — refusing to guess whether it is stale`,
        };
      }

      if (isProcessAlive(existing.pid)) {
        return { acquired: false, lockPath, reason: 'HELD_BY_LIVE_PROCESS', existing };
      }

      // Stale: the recorded PID is confirmed not running. Reclaim only if
      // the file still matches exactly what we just read (narrows, though
      // does not fully eliminate, the window against another process
      // reclaiming it concurrently) — then loop and retry the atomic
      // create. If someone else wins that create first, the next loop
      // iteration's EEXIST + liveness check converges safely either way.
      try {
        const stillThere = readLockFileSafely(lockPath);
        if (
          stillThere &&
          stillThere.pid === existing.pid &&
          stillThere.acquiredAt === existing.acquiredAt
        ) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Someone else may have already reclaimed/removed it — fine,
        // the loop's next O_EXCL create attempt is the real arbiter.
      }
    }
  }

  return {
    acquired: false,
    lockPath,
    reason: 'INDETERMINATE',
    detail: `exhausted ${MAX_RECLAIM_ATTEMPTS} attempts reclaiming an apparently-stale lock without success`,
  };
}

/**
 * Release the lock — but only if it's still ours (matching PID), so this
 * process can never delete a lock another process legitimately holds
 * (e.g. one that reclaimed it after judging *this* process stale, which
 * should not happen while we're still alive to call this, but must never
 * be possible even in a pathological ordering). Safe to call multiple
 * times and safe to call when no lock is held.
 */
export function releaseInstanceLock(lockPath?: string): void {
  const target = lockPath ?? heldLockPath;
  if (!target) return;
  try {
    const existing = readLockFileSafely(target);
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(target);
    }
  } catch {
    // Best-effort — if it's already gone or unreadable there's nothing
    // more to safely do here.
  } finally {
    if (target === heldLockPath) heldLockPath = null;
  }
}

/** Test-only: forget any held-lock bookkeeping without touching the filesystem. */
export function __resetLockStateForTests(): void {
  heldLockPath = null;
  exitHandlerRegistered = false;
}

function registerExitCleanup(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  // Synchronous-only 'exit' handler as a last-resort net in addition to
  // the explicit release calls on SIGINT/SIGTERM/startup-failure in
  // index.ts — covers any other exit path. releaseInstanceLock is
  // idempotent and ownership-checked, so calling it again there is safe.
  process.on('exit', () => releaseInstanceLock());
}
