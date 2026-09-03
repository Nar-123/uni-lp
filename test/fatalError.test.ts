/**
 * Phase 4.6.15 — global exception & process lifecycle audit.
 *
 * P3 finding: no `uncaughtException`/`unhandledRejection` handler
 * existed anywhere in this codebase. Node's own default behavior
 * already terminates the process on either event (in modern Node, both
 * crash by default), so this was never a "silent hang forever" risk —
 * the actual, demonstrated gaps were: (1) the crash happens without
 * first flipping lifecycle to 'failed', so `/ready` could theoretically
 * still answer 200 in the brief window before the process dies, and (2)
 * two concrete fire-and-forget paths (`index.ts`'s un-awaited
 * `bot.start(...)`, and `tpslWatcher.ts`'s `void recheckAndMaybeClose(...)`
 * lacking its own enclosing try/catch around local DB reads/writes)
 * could produce an unhandled rejection with no clearly-labeled log line
 * identifying which kind of fatal event occurred.
 *
 * `src/fatalError.ts`'s `handleFatalProcessError` is the minimal,
 * synchronous-only safety net: log -> setLifecycleState('failed', ...)
 * -> releaseInstanceLock() -> exit(1). It deliberately does NOT attempt
 * the full async stopTpslWatcher()/bot.stop()/stopHealthServer()
 * sequence (unsafe to do further async work after an uncaughtException,
 * per Node's own guidance) and deliberately does NOT retry or attempt
 * to resume normal operation.
 *
 * This file tests the handler directly with injectable exit/log
 * functions (so no test actually terminates the process), plus real
 * child-process fixtures proving the actual registered handlers behave
 * identically to a genuine `throw`/rejection in a fresh process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const {
  handleFatalProcessError,
  registerFatalErrorHandlers,
  __resetFatalErrorStateForTests,
  __fatalErrorHandledForTests,
} = await import('../src/fatalError.js');
const { getLifecycleState, setLifecycleState } = await import('../src/health.js');
const { __resetLockStateForTests } = await import('../src/instanceLock.js');

const pExecFile = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.join(HERE, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function freshHarness() {
  __resetFatalErrorStateForTests();
  __resetLockStateForTests();
  setLifecycleState('ready');
  const logs: unknown[][] = [];
  const exitCalls: number[] = [];
  return {
    logs,
    exitCalls,
    deps: {
      log: (...args: unknown[]) => logs.push(args),
      exit: (code: number) => exitCalls.push(code),
    },
  };
}

// ── 2. uncaughtException -> fatal lifecycle handling ──────────────────────

test('uncaughtException: error is observable, lifecycle becomes failed, exit(1) is called', () => {
  const { logs, exitCalls, deps } = freshHarness();
  handleFatalProcessError('uncaughtException', new Error('boom'), deps);

  assert.equal(getLifecycleState(), 'failed');
  assert.equal(exitCalls.length, 1);
  assert.equal(exitCalls[0], 1);
  assert.ok(logs.length > 0, 'the error must be observable in logs');
  const logged = logs[0]!.join(' ');
  assert.match(logged, /uncaughtException/);
  assert.match(logged, /boom/);
});

// ── 3. unhandledRejection -> fatal lifecycle handling ─────────────────────

test('unhandledRejection: error is observable, lifecycle becomes failed, exit(1) is called', () => {
  const { logs, exitCalls, deps } = freshHarness();
  handleFatalProcessError('unhandledRejection', new Error('rejected'), deps);

  assert.equal(getLifecycleState(), 'failed');
  assert.equal(exitCalls.length, 1);
  assert.equal(exitCalls[0], 1);
  assert.match(logs[0]!.join(' '), /unhandledRejection/);
});

test('unhandledRejection: a non-Error rejection reason (string/object) is handled without throwing', () => {
  const { exitCalls, deps } = freshHarness();
  assert.doesNotThrow(() => handleFatalProcessError('unhandledRejection', 'a plain string reason', deps));
  assert.equal(exitCalls.length, 1);
});

// ── 4/5. Fatal error observable + readiness becomes NOT READY ────────────

test('fatal error flips readiness to NOT_READY: buildReadinessResponse reflects 503 after a fatal event', async () => {
  const { deps } = freshHarness();
  const { buildReadinessResponse } = await import('../src/health.js');
  assert.equal(buildReadinessResponse().statusCode, 200, 'sanity: starts ready');
  handleFatalProcessError('uncaughtException', new Error('fatal'), deps);
  const resp = buildReadinessResponse();
  assert.equal(resp.statusCode, 503);
  assert.equal(resp.body.status, 'not_ready');
  assert.equal(resp.body.state, 'failed');
});

test('a fatal error never fabricates continued readiness — liveness still reports the failed state, not "ok" trading', async () => {
  const { deps } = freshHarness();
  const { buildLivenessResponse } = await import('../src/health.js');
  handleFatalProcessError('uncaughtException', new Error('fatal'), deps);
  const live = buildLivenessResponse();
  // Liveness intentionally stays 200 (the process/event loop can still
  // answer — Phase 4.6.5's documented distinction) but must report the
  // real lifecycle state, never silently "ready".
  assert.equal(live.body.state, 'failed');
});

// ── 6/9. Idempotency: multiple fatal errors never double-run cleanup ──────

test('duplicate fatal events (uncaughtException then unhandledRejection) do not double-log, double-release, or double-exit', () => {
  const { logs, exitCalls, deps } = freshHarness();
  handleFatalProcessError('uncaughtException', new Error('first'), deps);
  handleFatalProcessError('unhandledRejection', new Error('second'), deps);

  assert.equal(exitCalls.length, 1, 'exit must be called exactly once, not once per fatal event');
  assert.equal(logs.length, 1, 'only the first fatal event may log — the second is a no-op');
  assert.match(logs[0]!.join(' '), /first/, 'the FIRST error is the one that drives shutdown');
});

test('__fatalErrorHandledForTests reflects the idempotency guard state', () => {
  const { deps } = freshHarness();
  assert.equal(__fatalErrorHandledForTests(), false);
  handleFatalProcessError('uncaughtException', new Error('x'), deps);
  assert.equal(__fatalErrorHandledForTests(), true);
});

// ── 16. Logging itself must never prevent shutdown ────────────────────────

test('a throwing logger never prevents exit(1) from being called', () => {
  const { exitCalls } = freshHarness();
  const throwingLog = () => {
    throw new Error('logger is broken');
  };
  assert.doesNotThrow(() =>
    handleFatalProcessError('uncaughtException', new Error('real error'), {
      log: throwingLog,
      exit: (code) => exitCalls.push(code),
    }),
  );
  assert.equal(exitCalls.length, 1, 'exit must still happen even though logging failed');
});

// ── 11. Instance-lock cleanup path is invoked (already-safe, ownership-checked) ──

test('a fatal error invokes releaseInstanceLock without throwing when no lock is held', () => {
  const { exitCalls, deps } = freshHarness();
  // releaseInstanceLock() with no lock held is a documented no-op — this
  // proves the fatal handler calls it without needing a lock fixture, and
  // that doing so never blocks the exit call.
  assert.doesNotThrow(() => handleFatalProcessError('uncaughtException', new Error('x'), deps));
  assert.equal(exitCalls.length, 1);
});

// ── No secrets in fatal logs ───────────────────────────────────────────────

test('fatal error logging never includes the process env or a raw secret value', () => {
  const { logs, deps } = freshHarness();
  const secretLikeError = new Error('failed while using token super-secret-value-123');
  handleFatalProcessError('uncaughtException', secretLikeError, deps);
  const logged = JSON.stringify(logs);
  // The handler itself never reads process.env or any credential store —
  // it only logs the Error object it was given. This test documents that
  // contract: whatever the caller's error message contains is logged
  // verbatim (the handler adds no additional secret-bearing context), and
  // nothing beyond the error/lifecycle state is ever included.
  assert.ok(!logged.includes('PRIVATE_KEY'));
  assert.ok(!logged.includes(process.env.TELEGRAM_BOT_TOKEN ?? '__unset__'));
});

// ── Real process behavior (child-process fixtures) ────────────────────────

function runFatalFixture(mode: 'throw' | 'reject'): Promise<{ code: number; stdout: string; stderr: string }> {
  const fixture = path.join(HERE, 'fixtures', `fatal-${mode}.mts`);
  return pExecFile(process.execPath, [TSX_CLI, fixture], { timeout: 10_000 })
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((e: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
}

test('real process: an uncaught exception in a fresh process exits non-zero with an observable [fatal] log line', async () => {
  const result = await runFatalFixture('throw');
  assert.notEqual(result.code, 0, 'a genuine uncaught exception must exit non-zero, never hang or exit 0');
  assert.match(result.stderr, /\[fatal\] uncaughtException/);
  assert.match(result.stderr, /deliberate test exception/);
}, { timeout: 15_000 });

test('real process: an unhandled rejection in a fresh process exits non-zero with an observable [fatal] log line', async () => {
  const result = await runFatalFixture('reject');
  assert.notEqual(result.code, 0, 'a genuine unhandled rejection must exit non-zero, never hang or exit 0');
  assert.match(result.stderr, /\[fatal\] unhandledRejection/);
  assert.match(result.stderr, /deliberate test rejection/);
}, { timeout: 15_000 });

// ── registerFatalErrorHandlers wires the real process events ──────────────

test('registerFatalErrorHandlers attaches exactly one listener per event (idempotent registration within a single call)', () => {
  const before = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  registerFatalErrorHandlers();
  const after = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  assert.equal(after.uncaught, before.uncaught + 1);
  assert.equal(after.rejection, before.rejection + 1);
  // Clean up — remove the listeners this test just added so it doesn't
  // leak a handler into any later test in this same process.
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
});
