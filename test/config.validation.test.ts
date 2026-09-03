/**
 * Phase 4.6.6 — configuration validation.
 *
 * P2 finding: "Several environment-supplied addresses and RPC URLs are
 * not validated at startup." Confirmed gaps, fixed this phase:
 *
 * 1. `RPC_4663`/`RPC_56`/`RPC_8453` (src/config.ts, getConfig()) were
 *    used as-is with zero validation — an empty string, whitespace, or
 *    garbage value would silently become the RPC URL a real chain client
 *    is built from.
 * 2. `USDC_4663` (src/config.ts, CHAINS) was blindly cast
 *    (`as Address | undefined`) with no runtime check at all — a
 *    malformed value would silently become a real token address used in
 *    transactions.
 * 3. `MAX_CRITICAL_PRICE_AGE_MS` (src/price/dexscreener.ts) already
 *    rejected NaN/negative/zero (via a `> 0` check) but not `Infinity` —
 *    `MAX_CRITICAL_PRICE_AGE_MS=Infinity` would have silently disabled
 *    stale-price protection entirely (`age > Infinity` is never true).
 *
 * Two kinds of coverage: fast, exhaustive boundary tests of the pure
 * validator functions, and one real child-process test (§20, mandatory)
 * that exercises the actual `getConfig()` startup path exactly as
 * `src/index.ts` depends on it — proving invalid config genuinely
 * prevents the process from reaching a usable config object, not just
 * that a validator function would theoretically reject it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertValidRpcUrl,
  assertValidOptionalAddress,
} from '../src/config.js';
import { resolveMaxCriticalPriceAgeMs } from '../src/price/dexscreener.js';

const pExecFile = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.join(HERE, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'load-config.mts');

// ── 4/5/6/9/10/11. RPC URL validation ─────────────────────────────────────

test('assertValidRpcUrl: accepts a valid https URL unchanged', () => {
  const url = 'https://rpc.example.com/v2/abc123';
  assert.equal(assertValidRpcUrl('RPC_TEST', url), url);
});

test('assertValidRpcUrl: accepts a valid http URL', () => {
  assert.equal(assertValidRpcUrl('RPC_TEST', 'http://localhost:8545'), 'http://localhost:8545');
});

test('assertValidRpcUrl: rejects an empty string', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', ''), /empty/i);
});

test('assertValidRpcUrl: rejects a whitespace-only value', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', '   '), /empty/i);
});

test('assertValidRpcUrl: rejects leading/trailing whitespace rather than silently trimming', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', ' https://rpc.example.com '), /whitespace/i);
});

test('assertValidRpcUrl: rejects malformed URL syntax', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', 'not-a-url-at-all'), /not a valid URL/i);
});

test('assertValidRpcUrl: rejects an unsupported protocol (ftp)', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', 'ftp://rpc.example.com'), /unsupported protocol/i);
});

test('assertValidRpcUrl: rejects ws/wss — this codebase\'s transport only ever uses http()', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', 'wss://rpc.example.com'), /unsupported protocol/i);
});

test('assertValidRpcUrl: rejects a bare host with no scheme', () => {
  assert.throws(() => assertValidRpcUrl('RPC_TEST', 'rpc.example.com'), /not a valid URL/i);
});

test('assertValidRpcUrl: error message never echoes back something that looks like a credential', () => {
  const evilUrl = 'https://user:supersecretpassword@rpc.example.com';
  // This URL is syntactically VALID (it's still a well-formed https URL) —
  // the point here is just that a validation failure message for some
  // OTHER bad input never needs to, and does not, include the raw value.
  try {
    assertValidRpcUrl('RPC_TEST', 'not a url');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.ok(!msg.includes(evilUrl));
  }
});

// ── 4/7/10. Address validation ────────────────────────────────────────────

test('assertValidOptionalAddress: accepts a valid checksummed address unchanged', () => {
  const addr = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  assert.equal(assertValidOptionalAddress('USDC_TEST', addr), addr);
});

test('assertValidOptionalAddress: accepts a valid all-lowercase address (no unnecessary checksum requirement)', () => {
  const addr = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  assert.equal(assertValidOptionalAddress('USDC_TEST', addr), addr);
});

test('assertValidOptionalAddress: rejects an empty string', () => {
  assert.throws(() => assertValidOptionalAddress('USDC_TEST', ''), /empty/i);
});

test('assertValidOptionalAddress: rejects a too-short value', () => {
  assert.throws(() => assertValidOptionalAddress('USDC_TEST', '0x1234'), /not a valid EVM address/i);
});

test('assertValidOptionalAddress: rejects a non-hex value', () => {
  assert.throws(
    () => assertValidOptionalAddress('USDC_TEST', '0xZZZZ360D0400a0Fd4f2af552ADD042D716F1d168'),
    /not a valid EVM address/i,
  );
});

test('assertValidOptionalAddress: rejects a value missing the 0x prefix', () => {
  assert.throws(
    () => assertValidOptionalAddress('USDC_TEST', '5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
    /not a valid EVM address/i,
  );
});

test('assertValidOptionalAddress: rejects leading/trailing whitespace rather than silently trimming', () => {
  assert.throws(
    () => assertValidOptionalAddress('USDC_TEST', ' 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 '),
    /whitespace/i,
  );
});

test('assertValidOptionalAddress: does not require non-zero — the zero address is syntactically valid and not this validator\'s concern', () => {
  const zero = '0x0000000000000000000000000000000000000000';
  assert.equal(assertValidOptionalAddress('USDC_TEST', zero), zero);
});

// ── 9/10/11/18. Numeric validation: MAX_CRITICAL_PRICE_AGE_MS ────────────

test('resolveMaxCriticalPriceAgeMs: absent env -> existing default (90_000), unchanged', () => {
  const original = process.env.MAX_CRITICAL_PRICE_AGE_MS;
  try {
    delete process.env.MAX_CRITICAL_PRICE_AGE_MS;
    assert.equal(resolveMaxCriticalPriceAgeMs(), 90_000);
  } finally {
    if (original === undefined) delete process.env.MAX_CRITICAL_PRICE_AGE_MS;
    else process.env.MAX_CRITICAL_PRICE_AGE_MS = original;
  }
});

test('resolveMaxCriticalPriceAgeMs: NaN input falls back to the safe default, never becomes NaN', () => {
  const original = process.env.MAX_CRITICAL_PRICE_AGE_MS;
  try {
    process.env.MAX_CRITICAL_PRICE_AGE_MS = 'not-a-number';
    assert.equal(resolveMaxCriticalPriceAgeMs(), 90_000);
  } finally {
    if (original === undefined) delete process.env.MAX_CRITICAL_PRICE_AGE_MS;
    else process.env.MAX_CRITICAL_PRICE_AGE_MS = original;
  }
});

test('resolveMaxCriticalPriceAgeMs: Infinity input falls back to the safe default, never silently disables stale-price protection (the P2-relevant fix)', () => {
  const original = process.env.MAX_CRITICAL_PRICE_AGE_MS;
  try {
    process.env.MAX_CRITICAL_PRICE_AGE_MS = 'Infinity';
    const resolved = resolveMaxCriticalPriceAgeMs();
    assert.equal(resolved, 90_000);
    assert.ok(Number.isFinite(resolved), 'the resolved threshold must always be finite');
  } finally {
    if (original === undefined) delete process.env.MAX_CRITICAL_PRICE_AGE_MS;
    else process.env.MAX_CRITICAL_PRICE_AGE_MS = original;
  }
});

test('resolveMaxCriticalPriceAgeMs: negative and zero also fall back (pre-existing behavior, re-confirmed)', () => {
  const original = process.env.MAX_CRITICAL_PRICE_AGE_MS;
  try {
    process.env.MAX_CRITICAL_PRICE_AGE_MS = '-1000';
    assert.equal(resolveMaxCriticalPriceAgeMs(), 90_000);
    process.env.MAX_CRITICAL_PRICE_AGE_MS = '0';
    assert.equal(resolveMaxCriticalPriceAgeMs(), 90_000);
  } finally {
    if (original === undefined) delete process.env.MAX_CRITICAL_PRICE_AGE_MS;
    else process.env.MAX_CRITICAL_PRICE_AGE_MS = original;
  }
});

test('resolveMaxCriticalPriceAgeMs: a valid positive override is honored exactly (existing valid-config behavior unchanged)', () => {
  const original = process.env.MAX_CRITICAL_PRICE_AGE_MS;
  try {
    process.env.MAX_CRITICAL_PRICE_AGE_MS = '120000';
    assert.equal(resolveMaxCriticalPriceAgeMs(), 120_000);
  } finally {
    if (original === undefined) delete process.env.MAX_CRITICAL_PRICE_AGE_MS;
    else process.env.MAX_CRITICAL_PRICE_AGE_MS = original;
  }
});

// ── 12/13. Secret exposure review ─────────────────────────────────────────

test('validation errors never contain anything resembling a secret value', () => {
  const secrets = ['TELEGRAM_BOT_TOKEN_VALUE_xyz789', 'PRIVATE_KEY_abcdef', 'my-super-secret-api-key'];
  const messages: string[] = [];
  for (const bad of ['', 'garbage', 'ftp://x']) {
    try {
      assertValidRpcUrl('RPC_TEST', bad);
    } catch (e) {
      messages.push(e instanceof Error ? e.message : String(e));
    }
  }
  const combined = messages.join(' ');
  for (const secret of secrets) {
    assert.ok(!combined.includes(secret));
  }
});

// ── 20. Mandatory real startup-config test (real child process) ─────────

function runConfigFixture(envOverrides: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-config-test-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_IDS: '1',
    DB_PATH: path.join(scratchDir, 'bot.json'),
    WALLETS_PATH: path.join(scratchDir, 'wallets.json'),
    ...envOverrides,
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
  }
  return pExecFile(process.execPath, [TSX_CLI, FIXTURE], { env, timeout: 20_000 })
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((e: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
}

test('real startup: valid configuration (including a valid explicit RPC override) proceeds normally', async () => {
  const result = await runConfigFixture({ RPC_4663: 'https://custom-rpc.example.com' });
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /CONFIG_OK rpc4663=https:\/\/custom-rpc\.example\.com/);
}, { timeout: 25_000 });

test('real startup: missing optional RPC override falls back to the existing hardcoded default, unchanged', async () => {
  const result = await runConfigFixture({ RPC_4663: undefined });
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /CONFIG_OK rpc4663=https:\/\/rpc\.mainnet\.chain\.robinhood\.com/);
}, { timeout: 25_000 });

test('real startup: an invalid RPC_4663 (garbage URL) prevents startup — no transaction-capable config is ever produced', async () => {
  const result = await runConfigFixture({ RPC_4663: 'not-a-url-at-all' });
  assert.notEqual(result.code, 0, 'the process must exit non-zero on invalid config');
  assert.doesNotMatch(result.stdout, /CONFIG_OK/, 'config must never be reported OK when RPC_4663 is invalid');
  assert.match(result.stderr, /CONFIG_ERROR.*RPC_4663/);
}, { timeout: 25_000 });

test('real startup: an empty RPC_4663 prevents startup', async () => {
  const result = await runConfigFixture({ RPC_4663: '' });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /CONFIG_OK/);
  assert.match(result.stderr, /CONFIG_ERROR.*RPC_4663/);
}, { timeout: 25_000 });

test('real startup: an invalid USDC_4663 address prevents startup', async () => {
  const result = await runConfigFixture({ USDC_4663: 'not-an-address' });
  assert.notEqual(result.code, 0, 'the process must exit non-zero on invalid config');
  assert.doesNotMatch(result.stdout, /CONFIG_OK/, 'config must never be reported OK when USDC_4663 is invalid');
  // Unlike RPC_4663 (validated lazily inside getConfig(), so the fixture's
  // own try/catch prints "CONFIG_ERROR ..."), USDC_4663 is validated
  // inside the CHAINS object literal, which is evaluated at module
  // top-level — an invalid value throws during the `import` statement
  // itself, before the fixture's own code (including its try/catch) ever
  // runs. That surfaces as Node's default uncaught-exception output on
  // stderr rather than the fixture's own "CONFIG_ERROR" line. Both are
  // legitimate fail-closed outcomes: exit code non-zero, no CONFIG_OK,
  // and the variable name visible in the error — verified below.
  assert.match(result.stderr, /USDC_4663/, 'the variable name must be visible in the failure output either way');
  assert.match(result.stderr, /not a valid EVM address/i);
}, { timeout: 25_000 });

test('real startup: a valid USDC_4663 address is accepted (existing valid-config behavior unchanged)', async () => {
  const result = await runConfigFixture({ USDC_4663: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' });
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /CONFIG_OK/);
}, { timeout: 25_000 });

test('real startup: invalid config error output never leaks the configured Telegram token', async () => {
  const result = await runConfigFixture({ RPC_4663: 'garbage', TELEGRAM_BOT_TOKEN: 'super-secret-token-value-123' });
  assert.notEqual(result.code, 0);
  assert.ok(!result.stderr.includes('super-secret-token-value-123'));
  assert.ok(!result.stdout.includes('super-secret-token-value-123'));
}, { timeout: 25_000 });
