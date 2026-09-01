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
import { gmgnJson, GmgnError, GmgnRateLimitError, runGmgnProcess } from '../src/gmgn/cli.js';

const NODE = process.execPath;

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
