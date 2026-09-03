/**
 * gmgn-cli invocation — Phase 4.5.1.
 *
 * Two kinds of coverage:
 *
 * 1. Real, cross-platform process-spawning tests using `runGmgnProcess()`
 *    directly (real cross-spawn call, no mocking) against `process.execPath`
 *    (the Node binary running this test) as a stand-in "CLI" — this avoids
 *    depending on gmgn-cli actually being installed in CI while still
 *    exercising the real spawn mechanism on whatever platform the test
 *    runs on (the previous Windows bug was exactly a real-spawn failure
 *    that a mocked test would never have caught).
 *
 * 2. Deterministic, mocked-runner tests of `gmgnJson()`'s error
 *    classification, using its injectable `runner` option — proving every
 *    failure mode maps to a distinct, documented GmgnErrorCode, and that a
 *    candidate-source failure is never silently reported as an empty
 *    result (see also test/strategy.multiCandidates.test.ts for the
 *    strategy-layer half of that guarantee).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';
import { gmgnJson, GmgnError, GmgnRateLimitError, runGmgnProcess, type SpawnedProcess } from '../src/gmgn/cli.js';

const NODE = process.execPath;
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// ── Real spawn (no mocking) — proves the actual cross-platform mechanism ──

test('real spawn: successful process returns captured stdout', async () => {
  const { stdout } = await runGmgnProcess(NODE, ['-e', 'console.log("hello")'], {
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024,
    env: process.env,
  });
  assert.equal(stdout.trim(), 'hello');
});

test('real spawn: non-zero exit is reported with the real exit code, not swallowed', async () => {
  await assert.rejects(
    () => runGmgnProcess(NODE, ['-e', 'process.exit(3)'], { timeoutMs: 10_000, maxBufferBytes: 1024 * 1024, env: process.env }),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 3);
      return true;
    },
  );
});

test('real spawn: a genuinely nonexistent binary rejects with ENOENT', async () => {
  await assert.rejects(
    () => runGmgnProcess('this-binary-does-not-exist-anywhere-xyz', [], { timeoutMs: 10_000, maxBufferBytes: 1024 * 1024, env: process.env }),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 'ENOENT');
      return true;
    },
  );
});

test('real spawn: a long-running process is killed on timeout and reported as killed', async () => {
  await assert.rejects(
    () =>
      runGmgnProcess(NODE, ['-e', 'setTimeout(() => {}, 60_000)'], {
        timeoutMs: 200,
        maxBufferBytes: 1024 * 1024,
        env: process.env,
      }),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
});

test('real spawn: stdout exceeding maxBuffer is rejected rather than growing unbounded', async () => {
  await assert.rejects(
    () =>
      runGmgnProcess(NODE, ['-e', 'process.stdout.write("x".repeat(1000))'], {
        timeoutMs: 10_000,
        maxBufferBytes: 100,
        env: process.env,
      }),
    /maxBuffer/,
  );
});

// ── gmgnJson() classification via an injected runner (deterministic) ──────

function okRunner(stdout: string) {
  return async () => ({ stdout, stderr: '' });
}

function failRunner(err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }) {
  return async () => {
    throw err;
  };
}

test('gmgnJson: CLI success with bare JSON output', async () => {
  const result = await gmgnJson<{ ok: boolean }>(['token', 'info'], { runner: okRunner('{"ok":true}') });
  assert.deepEqual(result, { ok: true });
});

test('gmgnJson: CLI success with {code,data} envelope output is unwrapped', async () => {
  const result = await gmgnJson<{ rank: number[] }>(['market', 'trending'], {
    runner: okRunner('{"code":0,"data":{"rank":[1,2,3]}}'),
  });
  assert.deepEqual(result, { rank: [1, 2, 3] });
});

test('gmgnJson: CLI not found (ENOENT) -> GMGN_CLI_NOT_FOUND, distinct from other failures', async () => {
  await assert.rejects(
    () => gmgnJson(['market', 'trending'], { runner: failRunner(Object.assign(new Error('spawn gmgn-cli ENOENT'), { code: 'ENOENT' })) }),
    (err: GmgnError) => {
      assert.ok(err instanceof GmgnError);
      assert.equal(err.code, 'GMGN_CLI_NOT_FOUND');
      return true;
    },
  );
});

test('gmgnJson: CLI timeout -> GMGN_CLI_TIMEOUT', async () => {
  await assert.rejects(
    () => gmgnJson(['market', 'trending'], { runner: failRunner(Object.assign(new Error('gmgn-cli timed out'), { killed: true, signal: 'SIGTERM' })) }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_TIMEOUT');
      return true;
    },
  );
});

test('gmgnJson: CLI non-zero exit -> GMGN_CLI_NONZERO_EXIT, with stderr preserved', async () => {
  await assert.rejects(
    () =>
      gmgnJson(['market', 'trending'], {
        runner: failRunner(Object.assign(new Error('exit 1'), { code: 1, stderr: 'boom: config missing' })),
      }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_NONZERO_EXIT');
      assert.match(err.message, /boom: config missing/);
      return true;
    },
  );
});

test('gmgnJson: CLI malformed (non-JSON) output -> GMGN_CLI_MALFORMED_OUTPUT', async () => {
  await assert.rejects(
    () => gmgnJson(['market', 'trending'], { runner: okRunner('not json at all {{{') }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_MALFORMED_OUTPUT');
      return true;
    },
  );
});

test('gmgnJson: CLI empty output -> GMGN_CLI_EMPTY_OUTPUT', async () => {
  await assert.rejects(
    () => gmgnJson(['market', 'trending'], { runner: okRunner('   \n  ') }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_EMPTY_OUTPUT');
      return true;
    },
  );
});

test('gmgnJson: rate-limit text in stderr -> GmgnRateLimitError, not a generic failure', async () => {
  await assert.rejects(
    () =>
      gmgnJson(['market', 'trending'], {
        runner: failRunner(Object.assign(new Error('request failed'), { code: 1, stderr: 'HTTP 429 too many requests' })),
      }),
    (err: unknown) => {
      assert.ok(err instanceof GmgnRateLimitError);
      assert.equal(err.code, 'GMGN_CLI_RATE_LIMITED');
      return true;
    },
  );
});

test('gmgnJson: auth-failure text -> GMGN_CLI_AUTH_FAILED', async () => {
  await assert.rejects(
    () =>
      gmgnJson(['market', 'trending'], {
        runner: failRunner(Object.assign(new Error('request failed'), { code: 1, stderr: 'Unauthorized: invalid api key' })),
      }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_AUTH_FAILED');
      return true;
    },
  );
});

test('gmgnJson: an unclassified process error still fails closed as GMGN_CLI_EXEC_FAILED, never silently swallowed', async () => {
  await assert.rejects(
    () => gmgnJson(['market', 'trending'], { runner: failRunner(new Error('some unexpected internal failure')) }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_EXEC_FAILED');
      return true;
    },
  );
});

test('gmgnJson: envelope {code!=0} error is classified NONZERO_EXIT, not silently treated as empty data', async () => {
  await assert.rejects(
    () => gmgnJson(['market', 'trending'], { runner: okRunner('{"code":5,"data":null,"message":"internal error"}') }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_NONZERO_EXIT');
      return true;
    },
  );
});

// ── Defense-in-depth argument allowlist ───────────────────────────────────

test('argument safety: an unsafe character in an argument is rejected before the process is ever spawned', async () => {
  let runnerCalled = false;
  await assert.rejects(
    () =>
      gmgnJson(['token', 'info', '--chain', 'robinhood" & calc.exe & "'], {
        runner: async () => {
          runnerCalled = true;
          return { stdout: '{}', stderr: '' };
        },
      }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_INVALID_INPUT');
      return true;
    },
  );
  assert.equal(runnerCalled, false, 'the runner must never be invoked once an unsafe argument is detected');
});

test('argument safety: ordinary GMGN argument values (address, chain name, numbers) are unaffected', async () => {
  const result = await gmgnJson<{ ok: boolean }>(
    ['token', 'info', '--chain', 'robinhood', '--address', '0x1234567890123456789012345678901234567890'],
    { runner: okRunner('{"ok":true}') },
  );
  assert.deepEqual(result, { ok: true });
});

// ── Phase 4.6.2: SIGTERM -> SIGKILL escalation ────────────────────────────
//
// Two layers of coverage, deliberately:
//
// 1. A fully-controlled fake "child process" (constructed here, injected
//    via runGmgnProcess's spawnFn option) to deterministically and
//    portably prove the exact escalation LOGIC — grace timing, exactly-
//    once settlement, every kill()-throws/race permutation. Real OS
//    signal semantics differ enough between POSIX and Windows (Windows
//    has no real "ignore a signal" capability — any kill() call already
//    terminates unconditionally there) that these specific sequencing
//    guarantees are best proven this way, not by racing a real timer
//    against a real OS scheduler.
// 2. A real OS process (test/fixtures/ignore-sigterm.mjs) for genuine
//    end-to-end coverage — see "real OS process" below.

type FakeChild = {
  child: SpawnedProcess;
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  emitError: (err: Error) => void;
  emitStdout: (chunk: string) => void;
  killCalls: NodeJS.Signals[];
};

/**
 * `killBehavior(signal)` decides what a `.kill(signal)` call does:
 * - 'ignore': recorded, nothing else happens (simulates a child that
 *   doesn't react — either it's still starting up, or it trapped/ignored
 *   the signal).
 * - 'exit': recorded, and 'close' is emitted shortly after (simulates the
 *   signal successfully terminating the child).
 * - 'throw': the call throws synchronously (simulates ESRCH — the
 *   process already exited before this signal could be delivered).
 */
function makeFakeChild(killBehavior: (signal: NodeJS.Signals) => 'ignore' | 'exit' | 'throw'): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killCalls: NodeJS.Signals[] = [];

  const child: SpawnedProcess = {
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    on: (event, listener) => emitter.on(event, listener as never),
    kill: (signal: NodeJS.Signals) => {
      killCalls.push(signal);
      const behavior = killBehavior(signal);
      if (behavior === 'throw') {
        // Event-driven, not a guessed delay: schedule 'close' to follow
        // right behind the throw regardless of system load / timer jitter,
        // since a fixed-delay race against the production grace timer is
        // inherently flaky under load (observed: 2035ms vs a 2000ms grace
        // timer left far too thin a margin when run alongside every other
        // test file's own timers).
        setImmediate(() => emitter.emit('close', null, signal));
        throw new Error('kill ESRCH: no such process');
      }
      if (behavior === 'exit') {
        setImmediate(() => emitter.emit('close', null, signal));
      }
      return true;
    },
  };

  return {
    child,
    emitClose: (code, signal) => emitter.emit('close', code, signal),
    emitError: (err) => emitter.emit('error', err),
    emitStdout: (chunk) => stdout.emit('data', Buffer.from(chunk)),
    killCalls,
  };
}

function runWithFakeChild(
  fake: FakeChild,
  opts: { timeoutMs?: number; maxBufferBytes?: number } = {},
) {
  return runGmgnProcess('fake-cli', ['some', 'args'], {
    timeoutMs: opts.timeoutMs ?? 30,
    maxBufferBytes: opts.maxBufferBytes ?? 1024 * 1024,
    env: process.env,
    spawnFn: () => fake.child,
  });
}

test('escalation: process exits promptly after SIGTERM -> SIGKILL is never sent', async (t) => {
  t.diagnostic('bounded by node:test default timeout; expected to finish in well under 1s');
  const fake = makeFakeChild((signal) => (signal === 'SIGTERM' ? 'exit' : 'ignore'));
  await assert.rejects(
    () => runWithFakeChild(fake),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
  assert.deepEqual(fake.killCalls, ['SIGTERM'], 'a child that responds to SIGTERM must never receive SIGKILL');

  // Timer cleanup: wait past where the grace/kill timers WOULD have fired
  // if they were not cleared, and confirm no further kill() call happened.
  await new Promise((r) => setTimeout(r, 2_500));
  assert.deepEqual(fake.killCalls, ['SIGTERM'], 'grace/kill timers must be cleared on settlement, not fire later');
});

test('escalation: a child that ignores SIGTERM is escalated to SIGKILL', async () => {
  const fake = makeFakeChild((signal) => (signal === 'SIGTERM' ? 'ignore' : 'exit'));
  await assert.rejects(
    () => runWithFakeChild(fake),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
  assert.deepEqual(fake.killCalls, ['SIGTERM', 'SIGKILL'], 'an unresponsive child must be escalated to SIGKILL');
}, { timeout: 8_000 });

test('escalation: a child that ignores both signals does not make the wrapper wait forever', async () => {
  const fake = makeFakeChild(() => 'ignore');
  const start = Date.now();
  await assert.rejects(
    () => runWithFakeChild(fake),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 8_000, `must settle on its own bounded timeout even if the child never dies (took ${elapsedMs}ms)`);
  assert.deepEqual(fake.killCalls, ['SIGTERM', 'SIGKILL']);
}, { timeout: 10_000 });

test('escalation: SIGTERM throwing (process already gone) settles safely, not as a fatal error', async () => {
  // 'throw' represents "it had already exited" at essentially the same
  // moment our timeout fired (a genuine kernel-level race); makeFakeChild
  // schedules the resulting 'close' event immediately after the throw.
  const fake = makeFakeChild((signal) => (signal === 'SIGTERM' ? 'throw' : 'exit'));
  await assert.rejects(
    () => runWithFakeChild(fake),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
});

test('escalation: SIGKILL throwing (process already gone) settles safely, not as a fatal error', async () => {
  // SIGTERM is ignored (no auto-close) so the grace timer genuinely reaches
  // the SIGKILL attempt; 'throw' there schedules 'close' immediately after.
  const fake = makeFakeChild((signal) => (signal === 'SIGTERM' ? 'ignore' : 'throw'));
  await assert.rejects(
    () => runWithFakeChild(fake),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
  assert.deepEqual(fake.killCalls, ['SIGTERM', 'SIGKILL']);
}, { timeout: 8_000 });

test('escalation: a close(code=0) event racing after timeout is still reported as timeout, never as success', async () => {
  const fake = makeFakeChild(() => 'ignore');
  // Simulate the process happening to finish (successfully!) just after
  // the timeout fired — this must not be mistaken for a real success.
  setTimeout(() => fake.emitClose(0, null), 40);
  await assert.rejects(
    () => runWithFakeChild(fake, { timeoutMs: 30 }),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true, 'a post-timeout close(0) must not resolve the promise as a success');
      return true;
    },
  );
});

test('escalation: an error event racing after timeout is reported as timeout, never leaked raw', async () => {
  const fake = makeFakeChild(() => 'ignore');
  setTimeout(() => fake.emitError(new Error('some unrelated stream error')), 40);
  await assert.rejects(
    () => runWithFakeChild(fake, { timeoutMs: 30 }),
    (err: NodeJS.ErrnoException & { killed?: boolean; message: string }) => {
      assert.equal(err.killed, true);
      assert.match(err.message, /timed out/i, 'the raw racing error must not leak past a declared timeout');
      return true;
    },
  );
});

test('escalation: timeout never becomes a malformed-JSON error even if stdout received data first', async () => {
  const fake = makeFakeChild(() => 'ignore');
  fake.emitStdout('not valid json {{{');
  setTimeout(() => fake.emitClose(0, null), 40);
  await assert.rejects(
    () => runWithFakeChild(fake, { timeoutMs: 30 }),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true, 'must classify as timeout, never let gmgnJson attempt to parse stale stdout as MALFORMED_OUTPUT');
      return true;
    },
  );
});

test('escalation: timeout never becomes a non-zero-exit error', async () => {
  const fake = makeFakeChild(() => 'ignore');
  setTimeout(() => fake.emitClose(1, null), 40);
  await assert.rejects(
    () => runWithFakeChild(fake, { timeoutMs: 30 }),
    (err: NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) => {
      assert.equal(err.killed, true, 'must classify as timeout, not NONZERO_EXIT, once timeout was already declared');
      return true;
    },
  );
});

test('gmgnJson: a timeout from the real escalation path classifies as GMGN_CLI_TIMEOUT end to end', async () => {
  const fake = makeFakeChild(() => 'ignore');
  await assert.rejects(
    () =>
      gmgnJson(['market', 'trending'], {
        timeoutMs: 30,
        runner: (file, args, o) => runGmgnProcess(file, args, { ...o, spawnFn: () => fake.child }),
      }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_TIMEOUT');
      return true;
    },
  );
}, { timeout: 8_000 });

// ── Real OS process (§10): genuine end-to-end escalation coverage ────────

test('real OS process: a child that truly ignores SIGTERM is terminated and reported as timeout', async () => {
  const fixture = path.join(FIXTURES_DIR, 'ignore-sigterm.mjs');
  let capturedPid: number | undefined;

  const start = Date.now();
  await assert.rejects(
    () =>
      runGmgnProcess(NODE, [fixture], {
        timeoutMs: 300,
        maxBufferBytes: 1024 * 1024,
        env: process.env,
        spawnFn: (file, args, env) => {
          const real = crossSpawn(file, args, { env });
          capturedPid = real.pid;
          return real as unknown as SpawnedProcess;
        },
      }),
    (err: NodeJS.ErrnoException & { killed?: boolean }) => {
      assert.equal(err.killed, true);
      return true;
    },
  );
  const elapsedMs = Date.now() - start;
  // Generous bound: timeoutMs(300) + grace(2000) + kill-wait(2000) + slack,
  // covering the POSIX worst case where SIGTERM is genuinely ignored and
  // SIGKILL is required. On Windows this resolves much faster, since any
  // kill() call there already terminates unconditionally.
  assert.ok(elapsedMs < 9_000, `escalation must be bounded even for a genuinely unresponsive real process (took ${elapsedMs}ms)`);

  assert.ok(capturedPid, 'sanity check: a real PID was captured');
  // Confirm the real OS process is actually gone (no orphan left behind).
  // Signal 0 performs no actual signal delivery — it only checks whether
  // the process still exists (POSIX and Windows both support this via
  // Node's process.kill).
  await new Promise((r) => setTimeout(r, 200)); // let the OS finish reaping it
  assert.throws(
    () => process.kill(capturedPid!, 0),
    /ESRCH|no such process/i,
    'the real child process must no longer exist after the wrapper settles',
  );
}, { timeout: 15_000 });
