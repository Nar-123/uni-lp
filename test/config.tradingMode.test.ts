/**
 * Phase 4.7.1 — TRADING_MODE (global staging/dry-run gate) parsing and
 * startup validation.
 *
 * Mirrors test/strategyEnum.test.ts's exact structure and rigor for the
 * sibling STRATEGY env var, since TRADING_MODE is deliberately designed to
 * be that same pattern applied to a second, orthogonal concern (WHICH
 * strategy runs vs. WHETHER any real broadcast is allowed at all).
 *
 * Covers required tests #1 (staging mode parses correctly) and #2 (live/
 * default mode preserves current behavior) from the task brief.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertValidTradingModeEnv, getTradingMode } from '../src/config.js';

const pExecFile = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.join(HERE, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'assert-trading-mode.mts');

/**
 * The fixture imports src/config.ts, whose top-level `import 'dotenv/config'`
 * loads a `.env` file from the CHILD PROCESS's cwd for any key not already
 * present in its env — independently of what this test explicitly deletes
 * from the `env` object it passes to execFile. On a deployment whose real
 * `.env` sets TRADING_MODE (e.g. a staging VPS), running this fixture from
 * the repo root would let dotenv silently reintroduce TRADING_MODE=staging
 * into the "missing" case, even though the test never intended that value
 * to be present. Running the child from an empty scratch directory (no
 * .env at all) makes dotenv's load a no-op, so "missing" genuinely means
 * missing — without touching src/config.ts, without touching the real
 * .env, and without changing what the other two fixture cases (which
 * explicitly set TRADING_MODE themselves before dotenv ever runs) observe.
 */
const FIXTURE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-trading-mode-fixture-cwd-'));

function withTradingModeEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.TRADING_MODE;
  if (value == null) delete process.env.TRADING_MODE;
  else process.env.TRADING_MODE = value;
  try {
    return fn();
  } finally {
    if (prior == null) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = prior;
  }
}

// ── Missing TRADING_MODE — existing ('live') default preserved ───────────

test('missing TRADING_MODE (unset): does not throw — defaults to live (existing behavior unchanged)', () => {
  withTradingModeEnv(undefined, () => {
    assert.doesNotThrow(() => assertValidTradingModeEnv());
    assert.equal(getTradingMode(), 'live');
  });
});

// ── Valid values ───────────────────────────────────────────────────────

test('TRADING_MODE=live: accepted, getTradingMode() returns live', () => {
  withTradingModeEnv('live', () => {
    assert.doesNotThrow(() => assertValidTradingModeEnv());
    assert.equal(getTradingMode(), 'live');
  });
});

test('TRADING_MODE=staging: accepted, getTradingMode() returns staging', () => {
  withTradingModeEnv('staging', () => {
    assert.doesNotThrow(() => assertValidTradingModeEnv());
    assert.equal(getTradingMode(), 'staging');
  });
});

test('TRADING_MODE case-insensitivity: "STAGING" is accepted and normalized', () => {
  withTradingModeEnv('STAGING', () => {
    assert.doesNotThrow(() => assertValidTradingModeEnv());
    assert.equal(getTradingMode(), 'staging');
  });
});

test('TRADING_MODE whitespace-trimming: " staging ", "staging ", " staging" are all accepted', () => {
  for (const value of [' staging ', 'staging ', ' staging']) {
    withTradingModeEnv(value, () => {
      assert.doesNotThrow(() => assertValidTradingModeEnv(), `expected no throw for ${JSON.stringify(value)}`);
      assert.equal(getTradingMode(), 'staging');
    });
  }
});

// ── Invalid values — must fail closed ─────────────────────────────────

test('invalid-value matrix: each of these must throw, never silently resolve to live or staging', () => {
  const invalidValues = ['stagng', 'stage', 'dryrun', 'dry_run', 'test', 'sandbox', 'LIVE_MODE', '   ', 'null', 'undefined'];
  for (const value of invalidValues) {
    withTradingModeEnv(value, () => {
      assert.throws(
        () => assertValidTradingModeEnv(),
        /Invalid TRADING_MODE/,
        `expected a throw for TRADING_MODE=${JSON.stringify(value)}`,
      );
    });
  }
});

test('TRADING_MODE="" (explicitly empty): must fail closed, not silently treated as unset', () => {
  withTradingModeEnv('', () => {
    assert.throws(() => assertValidTradingModeEnv(), /Invalid TRADING_MODE/);
  });
});

test('error message names the variable, the invalid value, and the accepted values — no secrets', () => {
  withTradingModeEnv('stagng', () => {
    try {
      assertValidTradingModeEnv();
      assert.fail('expected assertValidTradingModeEnv to throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /TRADING_MODE/);
      assert.match(msg, /stagng/);
      assert.match(msg, /live/);
      assert.match(msg, /staging/);
    }
  });
});

// ── Real startup path — a fresh child process ─────────────────────────

function runTradingModeFixture(value: string | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (value == null) delete env.TRADING_MODE;
  else env.TRADING_MODE = value;
  return pExecFile(process.execPath, [TSX_CLI, FIXTURE], { env, cwd: FIXTURE_CWD, timeout: 20_000 })
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((e: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
}

test('real startup: missing TRADING_MODE proceeds normally and defaults to live in a fresh process', async () => {
  const result = await runTradingModeFixture(undefined);
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /TRADING_MODE_OK live/);
}, { timeout: 25_000 });

test('real startup: TRADING_MODE=staging proceeds normally in a fresh process', async () => {
  const result = await runTradingModeFixture('staging');
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /TRADING_MODE_OK staging/);
}, { timeout: 25_000 });

test('real startup: an invalid TRADING_MODE halts a fresh process — no TRADING_MODE_OK is ever printed', async () => {
  const result = await runTradingModeFixture('stagng');
  assert.notEqual(result.code, 0, 'the process must exit non-zero on an invalid TRADING_MODE');
  assert.doesNotMatch(result.stdout, /TRADING_MODE_OK/, 'must never report OK when TRADING_MODE is invalid');
  assert.match(result.stderr, /TRADING_MODE_ERROR.*Invalid TRADING_MODE/);
}, { timeout: 25_000 });

// ── Startup ordering proof (source inspection) ────────────────────────

test('startup ordering: assertValidTradingModeEnv is called before instance-lock/transaction-capable startup in src/index.ts', async () => {
  const fs = await import('node:fs');
  const indexSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'index.ts'), 'utf8');
  const tradingModeCallIdx = indexSrc.indexOf('assertValidTradingModeEnv();');
  const strategyCallIdx = indexSrc.indexOf('assertValidStrategyEnv();');
  const lockCallIdx = indexSrc.indexOf('acquireInstanceLock(lockPath)');
  const dbCallIdx = indexSrc.indexOf('getDb()');
  const botStartIdx = indexSrc.indexOf('bot.start(');
  assert.ok(tradingModeCallIdx > -1, 'assertValidTradingModeEnv() must be called in main()');
  assert.ok(tradingModeCallIdx > strategyCallIdx, 'sanity: alongside, after STRATEGY validation');
  assert.ok(tradingModeCallIdx < lockCallIdx, 'TRADING_MODE validation must precede instance-lock acquisition');
  assert.ok(tradingModeCallIdx < dbCallIdx, 'TRADING_MODE validation must precede db load');
  assert.ok(tradingModeCallIdx < botStartIdx, 'TRADING_MODE validation must precede bot.start()');
});
