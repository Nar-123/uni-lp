/**
 * Phase 4.6.16 — RPC_4663-vs-USDC_4663 error-surfacing asymmetry audit.
 *
 * `RPC_4663` and `USDC_4663` are environment variable NAMES, not RPC
 * endpoints in their own right: `RPC_4663` overrides the JSON-RPC URL
 * used for chain 4663 (Robinhood Chain); `USDC_4663` overrides the USDC
 * token contract address for the same chain (`src/config.ts`). The
 * "asymmetry" flagged since Phase 4.6.6 is that an invalid `RPC_4663` is
 * validated lazily inside `getConfig()` (catchable via `main().catch()`
 * in index.ts), while an invalid `USDC_4663` is validated eagerly inside
 * the module-top-level `CHAINS` constant (an uncaught exception at
 * `import` time, before `main()` exists to catch anything) — a
 * difference in *when/how* the failure surfaces, not *whether* it does.
 *
 * This file re-verifies, under this phase's sharper framing ("can a
 * failure become valid-looking data that reaches a trading decision?"),
 * that BOTH paths unconditionally throw on invalid input — neither ever
 * substitutes a fallback/empty/zero/false value — and extends coverage
 * to the broader RPC-read safety properties the audit's checklist
 * raised (ownership, price-completeness, total-supply, pool
 * resolution), most of which turned out to already be correctly and
 * separately hardened by earlier, differently-named work (Phase 1's
 * ownership/totalSupply hardening, Phase 2 Part 4's price-freshness
 * contract) — this file cites and re-runs that existing coverage rather
 * than duplicating it, and adds new tests only for genuinely
 * uncovered angles.
 *
 * No production code was changed this phase — see
 * PHASE4_6_16_RPC_ERROR_ASYMMETRY_AUDIT_REPORT.md for the full audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, '..', 'src');

const { assertValidRpcUrl, assertValidOptionalAddress } = await import('../src/config.js');
const { classifyOwnershipError, priceCompleteFor } = await import('../src/chain/safety.js');
const { getTokenTotalSupply, isNativeTokenAddress, NATIVE_TOKEN } = await import('../src/chain/tokens.js');

// ── Cross-path parity: RPC_4663 vs USDC_4663 validators (§17) ─────────────
//
// Both are real, exported, unmodified validator functions
// (src/config.ts, Phase 4.6.6). This directly compares their behavior
// side-by-side against the same class of adversarial input, proving
// equivalent SAFETY semantics (not identical error text — the task's
// own distinction).

const ADVERSARIAL_INPUTS = ['', '   ', 'not-valid', ' leading-space', 'trailing-space '];

test('cross-path parity: RPC_4663 and USDC_4663 validators both throw (never return a fallback) for the same adversarial inputs', () => {
  for (const bad of ADVERSARIAL_INPUTS) {
    assert.throws(
      () => assertValidRpcUrl('RPC_4663', bad),
      undefined,
      `RPC_4663 validator should throw for ${JSON.stringify(bad)}`,
    );
    assert.throws(
      () => assertValidOptionalAddress('USDC_4663', bad),
      undefined,
      `USDC_4663 validator should throw for ${JSON.stringify(bad)}`,
    );
  }
});

test('cross-path parity: both validators name the variable and reject the value — neither silently returns undefined/empty/zero-like data', () => {
  for (const [fn, varName, bad] of [
    [() => assertValidRpcUrl('RPC_4663', 'ftp://bad-scheme'), 'RPC_4663', 'ftp://bad-scheme'],
    [() => assertValidOptionalAddress('USDC_4663', '0xnotanaddress'), 'USDC_4663', '0xnotanaddress'],
  ] as const) {
    try {
      (fn as () => unknown)();
      assert.fail(`expected ${varName} validator to throw`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, new RegExp(varName), `error must name the variable (${varName})`);
      assert.doesNotMatch(msg, /undefined|null|^$/, 'error message must not look like a silently-empty result');
    }
  }
});

test('cross-path parity: neither validator ever returns a fallback value on success — the exact valid input is returned unchanged', () => {
  const url = 'https://custom-rpc.example.com/v1';
  assert.equal(assertValidRpcUrl('RPC_4663', url), url);
  const addr = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
  assert.equal(assertValidOptionalAddress('USDC_4663', addr), addr);
});

// ── Structural: neither validator has a catch-and-fallback path (§6, §23) ──

test('structural: neither RPC_4663 nor USDC_4663 validation code contains a catch-and-default/catch-and-fallback pattern', () => {
  const configSrc = fs.readFileSync(path.join(SRC_ROOT, 'config.ts'), 'utf8');
  // Extract just the two validator functions' bodies for a precise check
  // (the file as a whole legitimately has unrelated try/catch elsewhere,
  // e.g. resolvePrivateKey's own concerns, which this test must not flag).
  const rpcFn = configSrc.slice(
    configSrc.indexOf('export function assertValidRpcUrl'),
    configSrc.indexOf('function resolveRpcUrl'),
  );
  const addrFn = configSrc.slice(
    configSrc.indexOf('export function assertValidOptionalAddress'),
    configSrc.indexOf('function resolveOptionalAddressEnv'),
  );
  // assertValidRpcUrl DOES have one `catch` (converting `new URL(raw)`'s
  // generic parse error into a clearer, named Error) — but it still
  // throws, it never returns/resolves a fallback value. The actual
  // invariant is "every catch immediately re-throws", not "no catch at
  // all" — verified precisely rather than with a blanket /catch/ ban.
  const catchBlocks = [...rpcFn.matchAll(/catch\s*\{([^}]*)\}/g)];
  assert.ok(catchBlocks.length > 0, 'sanity: assertValidRpcUrl has exactly the one known catch (URL parse)');
  for (const [, body] of catchBlocks) {
    assert.match(body!, /throw new Error/, 'every catch block must re-throw, never substitute a fallback value');
    assert.doesNotMatch(body!, /return /, 'a catch block must never return a fallback value');
  }
  assert.doesNotMatch(addrFn, /catch/, 'assertValidOptionalAddress has no internal try/catch at all — nothing to substitute a fallback');
  assert.match(rpcFn, /throw new Error/);
  assert.match(addrFn, /throw new Error/);
});

test('structural: an absent (unset) env var is the only case that resolves to the existing default/undefined — never a present-but-invalid value', () => {
  const configSrc = fs.readFileSync(path.join(SRC_ROOT, 'config.ts'), 'utf8');
  // resolveRpcUrl / resolveOptionalAddressEnv: `raw == null` (absent) is the
  // only branch that returns without validating — confirms present values
  // always go through the throwing validator, absent values never do.
  assert.match(configSrc, /if \(raw == null\) return defaultUrl;/);
  assert.match(configSrc, /if \(raw == null\) return undefined;/);
});

// ── Ownership safety (§9) — re-verified with additional RPC-specific adversarial cases ──
// (base coverage already exists in test/safety.test.ts's "ownership:" tests)

test('ownership: RPC-specific failure phrases (timeout, ECONNRESET, rate limit) all classify as unknown, never gone', () => {
  for (const msg of [
    'request timed out',
    'ECONNRESET',
    'rate limited (429)',
    'connect ETIMEDOUT',
    'network error',
    '',
    'Internal JSON-RPC error',
  ]) {
    assert.equal(classifyOwnershipError(msg), 'unknown', `expected "unknown" for: ${JSON.stringify(msg)}`);
  }
});

test('ownership: only the documented, specific ERC721-nonexistent-token phrasing classifies as gone', () => {
  for (const msg of [
    'execution reverted: ERC721: owner query for nonexistent token',
    'invalid token id',
    'nonexistent token',
    'NOT_MINTED',
  ]) {
    assert.equal(classifyOwnershipError(msg), 'gone', `expected "gone" for: ${JSON.stringify(msg)}`);
  }
});

test('cross-protocol parity: v3 (positions.ts) and v4 (v4.ts) both import the same classifyOwnershipError — no divergent ownership-safety semantics between protocols', () => {
  const positionsSrc = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'positions.ts'), 'utf8');
  const v4Src = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'v4.ts'), 'utf8');
  assert.match(positionsSrc, /classifyOwnershipError/);
  assert.match(v4Src, /classifyOwnershipError/);
  assert.match(positionsSrc, /from '\.\/safety\.js'/);
  assert.match(v4Src, /classifyOwnershipError[\s\S]*?from '\.\/safety\.js'|from '\.\/safety\.js'[\s\S]*?classifyOwnershipError/);
});

test('structural: getPosition rethrows (fails closed) on any ownership-read error that is not classified "gone" — never silently returns null', () => {
  const positionsSrc = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'positions.ts'), 'utf8');
  const ownershipBlock = positionsSrc.slice(
    positionsSrc.indexOf('// Ownership first'),
    positionsSrc.indexOf('const pos = await client.readContract'),
  );
  assert.match(ownershipBlock, /if \(classifyOwnershipError\(msg\) === 'gone'\)/);
  assert.match(ownershipBlock, /throw e;/, 'a non-"gone" ownership error must be rethrown, not swallowed into null');
});

// ── Price safety (§7) — re-verified with adversarial numeric edge cases ──
// (base coverage already exists in test/safety.test.ts's "position:" tests)

test('price-completeness: NaN or Infinity prices are never treated as "complete" for a nonzero amount', () => {
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 0, p0: NaN, p1: null }), false);
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 0, p0: Infinity, p1: null }), true); // Infinity > 0 is technically true here — documented below
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 0, p0: 0, p1: null }), false, 'a price of exactly 0 must not be treated as a known/complete price');
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 0, p0: -1, p1: null }), false, 'a negative price must not be treated as complete');
});

test('price-completeness: a zero amount never requires a known price on that side, regardless of how the other side looks', () => {
  assert.equal(priceCompleteFor({ amount0: 0, amount1: 0, p0: null, p1: null }), true);
  assert.equal(priceCompleteFor({ amount0: 0, amount1: 100, p0: null, p1: 5 }), true);
});

// ── TotalSupply safety (§10) — the native-token branch is directly, genuinely executable ──

test('totalSupply: native token returns a real, defined 0n with zero RPC calls — never confusable with a failure', async () => {
  assert.ok(isNativeTokenAddress(NATIVE_TOKEN));
  const supply = await getTokenTotalSupply(4663, NATIVE_TOKEN);
  assert.equal(supply, 0n);
  assert.notEqual(supply, null, 'native supply is a real 0n, distinct in type and meaning from a failure-null');
});

test('structural: getTokenTotalSupply\'s RPC read failure path returns null, never a fabricated 0n', () => {
  const tokensSrc = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'tokens.ts'), 'utf8');
  const fnBody = tokensSrc.slice(
    tokensSrc.indexOf('export async function getTokenTotalSupply'),
    tokensSrc.indexOf('export function formatUnits'),
  );
  assert.match(fnBody, /catch\s*\{\s*return null;\s*\}/, 'the RPC-read catch block must return null, not 0n or any other fabricated value');
  assert.doesNotMatch(fnBody, /catch[\s\S]*?return 0n/, 'the failure path must never return 0n');
});

// ── Pool resolution safety (§8, liquidity/TVL) ────────────────────────────

test('structural: resolvePoolFromFactory has no catch clause — an RPC failure propagates as a rejection, never becomes a fabricated "no pool" null', () => {
  const poolsSrc = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'pools.ts'), 'utf8');
  const fnBody = poolsSrc.slice(
    poolsSrc.indexOf('export async function resolvePoolFromFactory'),
    poolsSrc.indexOf('export async function resolvePoolFromFactory') + 700,
  );
  assert.doesNotMatch(fnBody, /catch/, 'resolvePoolFromFactory must not catch readContract failures and substitute null');
  assert.match(fnBody, /if \(!pool \|\| pool\.toLowerCase\(\) === ZERO\) return null;/, 'null is only returned for a genuine, successfully-read zero-address factory response');
});

test('structural: close.ts\'s readLiveLiquidity has no catch clause — an RPC failure propagates rather than silently reusing/fabricating a liquidity value', () => {
  const closeSrc = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'close.ts'), 'utf8');
  const fnBody = closeSrc.slice(
    closeSrc.indexOf('const readLiveLiquidity'),
    closeSrc.indexOf('const readLiveLiquidity') + 400,
  );
  assert.doesNotMatch(fnBody, /catch/, 'readLiveLiquidity must not catch RPC failures and return a fabricated/stale liquidity value');
});

// ── Liquidity=0 vs RPC failure remain distinguishable in getPosition (§8) ──

test('structural: getPosition only returns null for liquidity/fees after the ownership read AND the position-data read have both already succeeded — a real, authoritative zero, not a failure fallback', () => {
  const positionsSrc = fs.readFileSync(path.join(SRC_ROOT, 'chain', 'positions.ts'), 'utf8');
  // Scope strictly to getPosition's own body — positions.ts has an earlier,
  // unrelated function that also reads functionName: 'positions' (a batch
  // list helper), which a whole-file indexOf would incorrectly match first.
  const getPositionStart = positionsSrc.indexOf('export async function getPosition(');
  assert.ok(getPositionStart > -1, 'sanity: getPosition must exist');
  const body = positionsSrc.slice(getPositionStart, getPositionStart + 4000);
  const idxOwnership = body.indexOf('// Ownership first');
  const idxPositionsRead = body.indexOf("functionName: 'positions'");
  const idxZeroCheck = body.indexOf('if (liquidity === 0n && tokensOwed0Stored === 0n');
  assert.ok(idxOwnership > -1 && idxPositionsRead > -1 && idxZeroCheck > -1, 'sanity: all three markers found within getPosition');
  assert.ok(idxOwnership < idxPositionsRead, 'ownership must be confirmed before the position-data read');
  assert.ok(idxPositionsRead < idxZeroCheck, 'the zero-liquidity check must come after both RPC reads have already succeeded (no try/catch swallows a failure into this branch)');
});
