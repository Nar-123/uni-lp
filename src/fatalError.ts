import { getLifecycleState, setLifecycleState } from './health.js';
import { releaseInstanceLock } from './instanceLock.js';

/**
 * Phase 4.6.15: process-level fatal-error safety net.
 *
 * Audit finding: no `uncaughtException`/`unhandledRejection` handler
 * existed anywhere in this codebase. Two concrete (not theoretical)
 * fire-and-forget paths were traced that could produce one:
 *   - `src/index.ts`'s `bot.start({...})` is never awaited or
 *     `.catch()`-ed — if grammy's polling loop ever definitively
 *     rejects (e.g. a revoked token, a persistent network outage
 *     exceeding its own internal retry budget), that rejection is
 *     unhandled. (`bot.catch(...)`, registered in bot.ts, only covers
 *     per-update processing errors — a different, narrower thing — not
 *     this top-level polling promise.)
 *   - `bot/tpslWatcher.ts`'s `void recheckAndMaybeClose(...)` (a 5s
 *     one-shot confirmation timer) has no enclosing try/catch of its
 *     own around a couple of local, synchronous DB reads/writes — an
 *     unexpected throw there (e.g. a corrupted DB file) would be
 *     unhandled.
 *
 * Without a handler, Node's own default behavior already terminates the
 * process on either event (in modern Node, both crash by default) — so
 * this was never a "the process hangs silently forever" risk. The
 * actual gap was narrower: the crash happens WITHOUT flipping lifecycle
 * to 'failed' first (so `/ready` could theoretically still answer 200
 * in the brief window before the process actually dies) and without a
 * clearly-labeled, single log line identifying which kind of fatal
 * event occurred.
 *
 * This handler does NOT attempt to resume normal operation, does NOT
 * retry, and deliberately does NOT run the full async
 * stopTpslWatcher()/bot.stop()/stopHealthServer() shutdown sequence —
 * Node's own guidance is explicit that it is not safe to do further
 * async work after an uncaughtException, since the exception may have
 * left arbitrary in-process state inconsistent. Instead it performs
 * only synchronous, already-safe, idempotent primitives — exactly the
 * same ones a startup failure already uses via main().catch() in
 * index.ts — then exits immediately:
 *   observable log (type, message, stack, current lifecycle state; no
 *   secrets — nothing here ever touches env vars, keys, or payloads)
 *     -> setLifecycleState('failed', ...)   [synchronous, pure, Phase 4.6.5]
 *     -> releaseInstanceLock()              [synchronous, ownership-checked,
 *                                             already safe to call multiple
 *                                             times or when unheld — Phase 4.6.1]
 *     -> exit(1)
 *
 * This is deliberately safe even for an in-flight transaction: the
 * existing journal-before-broadcast architecture (unmodified, Phase 2
 * Part 4) already assumes the process can die at ANY point during a
 * broadcast and is designed to recover from exactly that on the next
 * startup via the existing, unmodified txRecovery mechanism — an abrupt
 * exit here introduces no new risk beyond what that architecture
 * already tolerates.
 *
 * Idempotent: `fatalErrorHandled` ensures a second fatal event (e.g. an
 * uncaughtException immediately followed by an unhandledRejection
 * before the process actually finishes exiting) does not re-run the
 * sequence, re-log, or call exit() a second time.
 */
export type FatalErrorKind = 'uncaughtException' | 'unhandledRejection';

let fatalErrorHandled = false;

/** Test-only: forget any prior fatal-error handling so each test starts clean. */
export function __resetFatalErrorStateForTests(): void {
  fatalErrorHandled = false;
}

/** Test-only: whether a fatal error has already been handled (idempotency check). */
export function __fatalErrorHandledForTests(): boolean {
  return fatalErrorHandled;
}

export function handleFatalProcessError(
  kind: FatalErrorKind,
  err: unknown,
  deps: { exit?: (code: number) => void; log?: (...args: unknown[]) => void } = {},
): void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? console.error;

  if (fatalErrorHandled) return;
  fatalErrorHandled = true;

  const e = err instanceof Error ? err : new Error(String(err));
  // Defensive: logging itself must never prevent the exit below.
  try {
    log(
      `[fatal] ${kind} — terminating (lifecycle was: ${getLifecycleState()}):`,
      e.stack ?? e.message,
    );
  } catch {
    /* even the logger failing must not block shutdown below */
  }
  try {
    setLifecycleState('failed', [`fatal ${kind}: ${e.message}`.slice(0, 300)]);
  } catch (stateErr) {
    try {
      log('[fatal] setLifecycleState itself threw:', stateErr);
    } catch {
      /* ignore */
    }
  }
  try {
    releaseInstanceLock();
  } catch (lockErr) {
    try {
      log('[fatal] releaseInstanceLock itself threw:', lockErr);
    } catch {
      /* ignore */
    }
  }
  exit(1);
}

/** Registers the process-wide handlers. Called once from src/index.ts. */
export function registerFatalErrorHandlers(): void {
  process.on('uncaughtException', (err) => handleFatalProcessError('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handleFatalProcessError('unhandledRejection', reason));
}
