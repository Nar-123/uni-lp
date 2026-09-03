/**
 * Phase 4.6.10 — STRATEGY enum validation.
 *
 * P2/P3 finding: "STRATEGY enum silent-default gap." getActiveStrategyName()
 * (src/strategy/multiConfig.ts) silently collapses ANY unrecognized STRATEGY
 * value — a typo, garbage, or an explicitly empty string — into the
 * 'default' strategy, indistinguishable from an intentionally-unset
 * STRATEGY. A misconfigured operator could unknowingly run the wrong
 * strategy with no warning.
 *
 * getActiveStrategyName() itself is deliberately left unchanged (see
 * test/strategy.isolation.test.ts, still passing, unmodified) — it is
 * called live on every /multi-family Telegram command and must never
 * throw. The fix is a new, separate, authoritative startup-time check,
 * assertValidStrategyEnv(), called once in src/index.ts's main() before
 * any transaction-capable service starts.
 *
 * Two kinds of coverage: fast, exhaustive unit tests of
 * assertValidStrategyEnv() itself, and a real child-process test (the
 * repository's established pattern — see test/config.validation.test.ts's
 * "real startup" tests) that exercises the actual function src/index.ts
 * depends on, proving an invalid value genuinely halts a fresh process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertValidStrategyEnv, getActiveStrategyName } from '../src/strategy/multiConfig.js';

const pExecFile = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.join(HERE, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'assert-strategy.mts');

function withStrategyEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.STRATEGY;
  if (value == null) delete process.env.STRATEGY;
  else process.env.STRATEGY = value;
  try {
    return fn();
  } finally {
    if (prior == null) delete process.env.STRATEGY;
    else process.env.STRATEGY = prior;
  }
}

// ── Missing STRATEGY — existing documented default preserved ─────────────

test('missing STRATEGY (unset): does not throw — existing default behavior preserved', () => {
  withStrategyEnv(undefined, () => {
    assert.doesNotThrow(() => assertValidStrategyEnv());
    assert.equal(getActiveStrategyName(), 'default');
  });
});

// ── Valid values — accepted, byte-behavior compatible ─────────────────────

test('STRATEGY=multi: accepted, getActiveStrategyName() unchanged', () => {
  withStrategyEnv('multi', () => {
    assert.doesNotThrow(() => assertValidStrategyEnv());
    assert.equal(getActiveStrategyName(), 'multi');
  });
});

test('STRATEGY=default: accepted (an existing, real StrategyName member), getActiveStrategyName() unchanged', () => {
  withStrategyEnv('default', () => {
    assert.doesNotThrow(() => assertValidStrategyEnv());
    assert.equal(getActiveStrategyName(), 'default');
  });
});

test('STRATEGY case-insensitivity is preserved (existing normalization, not new): "MULTI" is accepted', () => {
  withStrategyEnv('MULTI', () => {
    assert.doesNotThrow(() => assertValidStrategyEnv());
    assert.equal(getActiveStrategyName(), 'multi');
  });
});

test('STRATEGY whitespace-trimming is preserved (existing normalization, not new): " multi ", "multi ", " multi" are all accepted', () => {
  for (const value of [' multi ', 'multi ', ' multi']) {
    withStrategyEnv(value, () => {
      assert.doesNotThrow(() => assertValidStrategyEnv(), `expected no throw for ${JSON.stringify(value)}`);
      assert.equal(getActiveStrategyName(), 'multi');
    });
  }
});

// ── Invalid values — must fail closed, no silent fallback ────────────────

test('invalid-value matrix: each of these must throw, never silently resolve to a strategy', () => {
  const invalidValues = [
    'mulit', // typo
    'foobar',
    'unknown',
    'multi2',
    'degen',
    'DEFAULT_STRATEGY', // looks plausible but not an actual enum member
    '   ', // whitespace-only — trims to empty, not a valid name
    'null',
    'undefined',
  ]; // the explicit empty-string ('') case is its own dedicated test below
  for (const value of invalidValues) {
    withStrategyEnv(value, () => {
      assert.throws(
        () => assertValidStrategyEnv(),
        /Invalid STRATEGY/,
        `expected a throw for STRATEGY=${JSON.stringify(value)}`,
      );
    });
  }
});

test('STRATEGY="" (explicitly empty): must fail closed per the CRITICAL SAFETY PRINCIPLE, not silently treated as unset', () => {
  withStrategyEnv('', () => {
    assert.throws(() => assertValidStrategyEnv(), /Invalid STRATEGY/);
  });
});

test('error message names the variable, the invalid value, and the accepted values — no secrets', () => {
  withStrategyEnv('mulit', () => {
    try {
      assertValidStrategyEnv();
      assert.fail('expected assertValidStrategyEnv to throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /STRATEGY/);
      assert.match(msg, /mulit/);
      assert.match(msg, /default/);
      assert.match(msg, /multi/);
    }
  });
});

// ── No-silent-fallback regression (the core security property) ───────────

test('no-silent-fallback: an invalid STRATEGY never causes any strategy to be silently selected by the validator', () => {
  withStrategyEnv('definitely-invalid', () => {
    assert.throws(() => assertValidStrategyEnv());
    // assertValidStrategyEnv itself returns void — there is no return value
    // that could be mistaken for a selected strategy; the only observable
    // outcome of an invalid value is the thrown exception itself.
  });
});

// ── getActiveStrategyName() remains completely unchanged (regression) ────

test('getActiveStrategyName() is untouched: still resolves an invalid value to "default" for its own (live, never-throwing) runtime contract', () => {
  withStrategyEnv('degen', () => {
    assert.doesNotThrow(() => getActiveStrategyName());
    assert.equal(getActiveStrategyName(), 'default');
  });
});

// ── Real startup path — a fresh child process, not just a function call ──

function runStrategyFixture(strategy: string | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (strategy == null) delete env.STRATEGY;
  else env.STRATEGY = strategy;
  return pExecFile(process.execPath, [TSX_CLI, FIXTURE], { env, timeout: 20_000 })
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((e: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
}

test('real startup: missing STRATEGY proceeds normally in a fresh process', async () => {
  const result = await runStrategyFixture(undefined);
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /STRATEGY_OK/);
}, { timeout: 25_000 });

test('real startup: STRATEGY=multi proceeds normally in a fresh process', async () => {
  const result = await runStrategyFixture('multi');
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /STRATEGY_OK/);
}, { timeout: 25_000 });

test('real startup: an invalid STRATEGY halts a fresh process — no STRATEGY_OK is ever printed', async () => {
  const result = await runStrategyFixture('mulit');
  assert.notEqual(result.code, 0, 'the process must exit non-zero on an invalid STRATEGY');
  assert.doesNotMatch(result.stdout, /STRATEGY_OK/, 'must never report OK when STRATEGY is invalid');
  assert.match(result.stderr, /STRATEGY_ERROR.*Invalid STRATEGY/);
}, { timeout: 25_000 });

test('real startup: an explicitly empty STRATEGY halts a fresh process', async () => {
  const result = await runStrategyFixture('');
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /STRATEGY_OK/);
  assert.match(result.stderr, /STRATEGY_ERROR.*Invalid STRATEGY/);
}, { timeout: 25_000 });

// ── Startup ordering proof (source inspection, pinned by a stable assertion) ──

test('startup ordering: assertValidStrategyEnv is called before instance-lock/transaction-capable startup in src/index.ts', async () => {
  const fs = await import('node:fs');
  const indexSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'index.ts'), 'utf8');
  const strategyCallIdx = indexSrc.indexOf('assertValidStrategyEnv();');
  const lockCallIdx = indexSrc.indexOf('acquireInstanceLock(lockPath)');
  const dbCallIdx = indexSrc.indexOf('getDb()');
  const botStartIdx = indexSrc.indexOf('bot.start(');
  assert.ok(strategyCallIdx > -1, 'assertValidStrategyEnv() must be called in main()');
  assert.ok(strategyCallIdx < lockCallIdx, 'STRATEGY validation must precede instance-lock acquisition');
  assert.ok(strategyCallIdx < dbCallIdx, 'STRATEGY validation must precede db load');
  assert.ok(strategyCallIdx < botStartIdx, 'STRATEGY validation must precede bot.start()');
});
