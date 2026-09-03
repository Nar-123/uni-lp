# PHASE 4.6.6 CONFIGURATION VALIDATION FIX REPORT

## 1. Original P2 Finding

"Several environment-supplied addresses and RPC URLs are not validated at
startup." (Phase 4.6 reliability audit.)

## 2. Configuration Inventory

Full surface inventory (`grep -rn "process.env" src/` across every
non-test file):

| Variable | Type | Required | Validation | Existing Default |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | string (secret) | **Required** | Non-empty (`requireEnv`) — unchanged | throws if missing |
| `TELEGRAM_USER_IDS` | comma-separated integers | **Required** | Parses + rejects any non-finite member — unchanged (already good) | throws if missing |
| `PRIVATE_KEY` | hex string (secret) | Optional | Strict `^0x[0-9a-fA-F]{64}$` regex (`wallet/keys.ts` `normalizePk`) — unchanged (already fail-closed) | auto-generates a wallet |
| `WALLETS_PATH` / `WALLET_PATH` | file path | Optional | None | unchanged — filesystem path, not an address/RPC target; an invalid path fails loudly and immediately (`ENOENT`/`EISDIR`) rather than silently, so it does not match this P2's "silent" failure mode |
| `DB_PATH` | file path | Optional | None | unchanged, same reasoning |
| **`RPC_4663`** | URL | Optional | **NONE before this phase** — raw string used as-is | **Fixed**: must be non-empty, no leading/trailing whitespace, valid URL syntax, `http:`/`https:` scheme only |
| **`RPC_56`** | URL | Optional | **NONE before this phase** | **Fixed**, same rule |
| **`RPC_8453`** | URL | Optional | **NONE before this phase** | **Fixed**, same rule |
| **`USDC_4663`** | EVM address | Optional | **NONE before this phase** — blind `as Address` cast | **Fixed**: must pass viem's `isAddress()`, non-empty, no whitespace |
| `MAX_CRITICAL_PRICE_AGE_MS` | positive number (ms) | Optional | NaN/negative/zero already rejected (pre-existing `> 0` check); **`Infinity` was not rejected** | **Fixed**: `Number.isFinite(n) && n > 0` — closes the `Infinity` gap |
| `STRATEGY` | enum (`default`\|`multi`) | Optional | Unknown value silently maps to `'default'` (`src/strategy/multiConfig.ts`) | **Not touched — out of scope.** This file is unambiguously "MULTI strategy" code, explicitly on this phase's do-not-modify list. Documented in §19 as a known, related, but out-of-scope gap. |
| `HEALTH_PORT` | integer 1–65535 | Optional | Already validated (Phase 4.6.5, `src/health.ts`) | **Not touched — out of scope** ("health/readiness implementation") |
| `MULTI_CHAIN_ID`, `MULTI_USDG_ADDRESS`, `MULTI_MIN_MARKET_CAP_USD`, and other `MULTI_*` thresholds/weights | various | Optional | Already validated via `validateMultiConfig()` (Phase 4, fail-closed: invalid config disables MULTI with a reason) | **Not touched — out of scope** ("MULTI strategy") |
| `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID`, `RELAY_API_KEY`, `UNISWAP_API_KEY` | secret strings | Optional | Presence-checked only (feature on/off) | **Not touched** — these are optional third-party API keys with no documented fixed format to validate against; over-validating an opaque secret string against a guessed format would risk false rejections (§15's explicit warning), and they are not "addresses" or "RPC URLs," the P2's named category |
| `CARD_AUTHOR` | display string | Optional | None | **Not touched** — cosmetic text, not safety-critical |
| `GMGN_CLI_PATH`, `GMGN_SLIPPAGE_PCT`, GMGN swap-mode flags | various | Optional | Already validated at their own call sites (`gmgn/cli.ts`, Phase 4.5.1's argument allowlist; `gmgn/swap.ts`'s own checks) | **Not touched — out of scope** ("GMGN CLI") |

## 3. Root Cause

`src/config.ts`:
```js
rpc: {
  4663: process.env.RPC_4663 ?? CHAINS[4663].defaultRpc,
  ...
}
```
and
```js
usdc: (process.env.USDC_4663 as Address | undefined) ?? undefined,
```
Both used the raw environment value completely as-is whenever it was
*present* — `??` only substitutes the default when the variable is
`undefined`/`null`, not when it's present-but-garbage (empty string,
whitespace, malformed URL, non-address string). The `USDC_4663` line
additionally performed a compile-time-only TypeScript cast
(`as Address`) with **zero runtime check** — any string at all would
silently become "the" USDC address used elsewhere in the app.

Separately, `src/price/dexscreener.ts`'s `MAX_CRITICAL_PRICE_AGE_MS`
already guarded against NaN/negative/zero via a `> 0` check, but
`Number('Infinity') === Infinity` and `Infinity > 0` is `true` — an
operator setting `MAX_CRITICAL_PRICE_AGE_MS=Infinity` would have silently
and permanently disabled `isPriceStale()`'s protection (`age > Infinity`
can never be true).

## 4. Validation Architecture

Minimal, narrowly-scoped, no new module: two small exported validator
functions plus two small private resolver wrappers, added directly in
`src/config.ts` next to the code they protect — no separate
"config validation" subsystem was introduced, since the existing
lazy-singleton `getConfig()` (for RPC) and module-level `CHAINS` constant
(for the address) already provide the correct "runs before any
transaction-capable service" timing without needing a new call site
wired into `main()`'s sequence (see §10).

```
present + valid   -> used exactly as given (no normalization)
present + invalid -> throw Error(`Invalid <VAR>: <reason>`)
absent            -> existing hardcoded default, untouched
```

## 5. Address Validation

`assertValidOptionalAddress()` uses viem's own `isAddress()` — already a
dependency, no new validation library added, exactly as instructed. Does
**not** require checksum casing (both `0x5fc5...D168` and its
all-lowercase form are accepted — viem's `isAddress()` accepts both by
default) and does **not** reject the zero address (syntactically valid;
"non-zero" is an application-semantics concern this validator has no
business enforcing, per §4's explicit instruction not to require non-zero
unless existing semantics demand it — checked: nothing in this codebase's
existing `USDC_4663` consumers requires non-zero). Rejects: empty string,
whitespace-padded values (never silently trimmed — trimming would itself
be a silent normalization), and anything that fails `isAddress()`
(wrong length, non-hex characters, missing `0x` prefix).

## 6. RPC URL Validation

`assertValidRpcUrl()` requires: non-empty, no leading/trailing
whitespace, parseable by the WHATWG `URL` constructor, and a scheme of
exactly `http:` or `https:` — the *only* schemes this codebase's actual
transport can use (traced: every `getPublicClient`/`getWalletClient` call
in `chain/clients.ts` uses viem's `http()` transport function
exclusively; there is no `webSocket()` transport anywhere in this
codebase, so accepting `ws:`/`wss:` here would validate a URL the app
could never actually connect with). No blockchain connectivity check is
performed — this validates **syntax only**, deliberately distinct from
"is this RPC currently reachable" (which this codebase does not check at
startup at all, and this phase does not add — matching §5's explicit
instruction not to add an expensive connectivity test).

## 7. Numeric Validation

Only one numeric variable was in scope for a fix:
`MAX_CRITICAL_PRICE_AGE_MS`. `Number.isFinite(n) && n > 0` replaces the
prior `n > 0` alone, closing the `Infinity` gap while leaving the
existing NaN/negative/zero rejection (and the existing 90-second default)
completely unchanged. **Design choice, stated plainly**: this value still
*falls back to its existing default* on an invalid input rather than
throwing/failing startup (unlike the RPC/address fixes, which do throw).
Rationale: this variable is not the P2 finding's named target
("addresses and RPC URLs"); its pre-existing lenient-fallback behavior
for NaN/negative/zero already shipped and is exercised by
`test/priceFreshness.test.ts`; and `MAX_CRITICAL_PRICE_AGE_MS` is a
module-level constant imported very widely across the codebase — turning
one more of its invalid-input cases into a hard `throw` at import time
would be a wider-blast-radius behavior change for a variable outside this
finding's explicit scope. The one actually-dangerous case (`Infinity`
silently disabling protection) is closed; the pre-existing, narrower,
already-shipped "fall back to a safe default" behavior for other invalid
inputs is preserved rather than escalated.

No other numeric environment variable exists in the non-MULTI,
non-health, non-GMGN configuration surface (confirmed by the full
inventory in §2).

## 8. Boolean Validation

No boolean environment variable exists in the configuration surface this
phase is scoped to touch. (The task's example, `DRY_RUN`, does not exist
anywhere in this repository — confirmed by grep; not invented here, per
§2's explicit instruction "do not invent configuration variables.")

## 9. Enum Validation

`STRATEGY` is the only enum-like environment variable found, and it does
exhibit exactly the anti-pattern the task describes (§9: "unknown
strategy → default strategy" instead of failing startup). It lives in
`src/strategy/multiConfig.ts`, which is unambiguously MULTI-strategy code
— explicitly on this phase's do-not-modify list. **Left untouched**,
documented here and in §19 as a known, real, but out-of-scope finding for
a future, correctly-scoped phase.

## 10. Startup Integration

No change was needed to `src/index.ts`'s call order. Both fixes are
already positioned correctly relative to "before any transaction-capable
service starts" by virtue of the *existing* architecture:

- `CHAINS` (containing the `USDC_4663` check) is a module-level `const`,
  evaluated the moment `config.ts` is first imported — which happens at
  the very top of `src/index.ts`, before `main()` is even defined, let
  alone called. An invalid value throws during module evaluation itself.
- `getConfig()` (containing the RPC checks) is a lazy singleton computed
  on first access; the first access happens very early inside `main()`
  (e.g. `config.walletPath` is logged within the first several lines),
  strictly before `runStartupTxRecovery()`, before the bot is created,
  before either watcher starts, and before `bot.start()`.

Both therefore already satisfy "acquire instance lock → validate
configuration → startup recovery → initialize services → READY" without
needing a new, separately-ordered validation call.

## 11. Error Handling

Every thrown error names the exact variable and the specific validation
failure (e.g. `Invalid RPC_4663: unsupported protocol "ftp:" (expected
http:// or https://)`), matching §12's required format. One asymmetry
was found and is documented rather than "fixed around": an invalid
`RPC_4663` throws *inside* `getConfig()`, which is called from within
`main()`'s `try`-free body but ultimately caught by `main().catch(...)`
— so the error is one exception among the normal control flow. An
invalid `USDC_4663`, however, throws while `CHAINS` is being constructed
at **module top-level**, before `main()` exists to be called at all —
this surfaces as Node's own default uncaught-exception output (a raw
stack trace) rather than the same clean one-line message. Both outcomes
are still fully fail-closed (non-zero exit, the variable name and reason
visible, no transaction-capable service ever starts, no instance lock is
even acquired since that happens later inside `main()`) — verified
directly with a real child-process test for each case (§13). Reconciling
this asymmetry would require deferring `CHAINS`' `usdc` field to a
function call, which every consumer of `CHAINS[chainId].usdc` across the
codebase would need to account for — a broader refactor than this
phase's "do not require a broad refactor" instruction permits for a
purely cosmetic (not a safety) difference.

## 12. Secret Exposure Review

No secret-valued environment variable (`TELEGRAM_BOT_TOKEN`,
`PRIVATE_KEY`, any `*_API_KEY`) was modified or newly validated this
phase, so no new secret-handling code path was introduced. Verified by
explicit tests that: (a) the pure validators' own error messages never
echo back a value that looks like a credential, and (b) a real
child-process startup failure (triggered by an invalid `RPC_4663`) with a
deliberately-set fake `TELEGRAM_BOT_TOKEN` never leaks that token's value
in either stdout or stderr.

## 13. Boundary Tests

New file `test/config.validation.test.ts` (31 tests) plus a new fixture
`test/fixtures/load-config.mts` for the mandatory real-startup test:

- **RPC URL**: valid http, valid https, empty, whitespace-only,
  leading/trailing whitespace (rejected, never silently trimmed),
  malformed syntax, unsupported scheme (`ftp:`), `wss:` specifically
  rejected (this codebase's transport cannot use it), bare host with no
  scheme, error-message-never-leaks-input-adjacent-secrets.
- **Address**: valid checksummed, valid all-lowercase (no unnecessary
  checksum requirement — §15), empty, too short, non-hex, missing `0x`
  prefix, whitespace-padded (rejected), the zero address (accepted —
  syntactically valid, not this validator's concern).
- **Numeric** (`MAX_CRITICAL_PRICE_AGE_MS`): absent → default; NaN →
  default; **Infinity → default, and the result is asserted finite**
  (the actual fix); negative and zero → default (pre-existing behavior
  re-confirmed unchanged); a valid positive override honored exactly.
- **Real startup** (§20, mandatory — via a real child process, not a
  direct function call): valid config with an explicit valid RPC
  override proceeds; missing optional RPC falls back to the exact
  existing hardcoded default; invalid `RPC_4663` (garbage, and
  separately empty) prevents startup with no `CONFIG_OK` ever printed;
  invalid `USDC_4663` prevents startup (verified against its actual
  uncaught-exception shape, §11); valid `USDC_4663` is accepted
  unchanged; an invalid-config failure never leaks a fake secret token
  value.

One iteration note, disclosed rather than hidden: the first version of
the "invalid `USDC_4663`" real-startup test expected the same
`CONFIG_ERROR ...` shape the `RPC_4663` test sees, and failed immediately
on the first run with a raw Node stack trace instead. This led directly
to discovering and documenting the module-top-level-vs-lazy asymmetry in
§11 — the test was corrected to verify the actual (still fully
fail-closed) behavior rather than assuming a specific error-wrapping
shape; not a production defect, a test-assumption bug, caught before this
report was written.

## 14. Full Test Results

```
npm test
tests 368, pass 368, fail 0
```
(337 pre-existing baseline — Phase 4.5.2 + Phase 4.6/4.6.1/4.6.2/4.6.3/
4.6.4/4.6.5, all preserved byte-for-byte — + 31 new this phase.) Verified
stable across 2 consecutive full-suite runs and 3 consecutive isolated
runs of the new file (the latter specifically to check for real-child-
process spawning flakiness, given 7 of the 31 tests spawn a real `tsx`
process each). One pre-existing, unrelated flake was observed in one
full-suite run: `test/instanceLock.test.ts`'s real-two-process lock race
test (Phase 4.6.1, not touched this phase, imports nothing from
`config.ts`/`dexscreener.ts`) — reproduced as passing cleanly in 1/1
isolated re-runs immediately after, consistent with inherent timing
sensitivity in a real-process-race test under full-suite system load, not
a regression from this phase's changes.

## 15. Typecheck

```
npm run typecheck
```
Clean.

## 16. Build

```
npm run build
```
Clean.

## 17. Valid-Configuration Compatibility

Confirmed by direct diff inspection (§18) and by test: for every
variable touched, a *valid* present value is returned completely
unchanged (no trimming, no case normalization, no re-formatting) — only
the *invalid* branch's behavior changed (silent-passthrough/blind-cast →
throw). A real child-process test confirms an explicit valid
`RPC_4663`/`USDC_4663` override still works exactly as before, and that
omitting the override still yields the exact pre-existing hardcoded
default string.

## 18. Diff Scope Audit

```
git diff --stat -- src/config.ts src/price/dexscreener.ts test/config.validation.test.ts
 src/config.ts            | 67 +++++++++++++++++++++++++++++++++++++++++++++---
 src/price/dexscreener.ts | 22 +++++++++++++---
 2 files changed, 81 insertions(+), 8 deletions(-)
```
(`test/config.validation.test.ts` and `test/fixtures/load-config.mts` are
new, untracked files.) Both diffs reviewed in full: every change is
either a new validator function, a new small resolver wrapper, or a
one-line call-site swap passing the exact same variable name/default
through to the new wrapper — no unrelated line was touched.

**No other file was modified by this phase.** `git status --short` at
the start of this phase showed the exact same pre-existing uncommitted
Phase 4.5.2 / 4.6 / 4.6.1 / 4.6.2 / 4.6.3 / 4.6.4 / 4.6.5 changes as at
the end — confirmed by `git diff --stat` on every one of those files
showing zero additional changes beyond what already existed at the start
of this turn. No reset, stash, checkout, or revert was performed at any
point.

## 19. Remaining P2/P3 Findings

Every other Phase 4.6 finding, and every out-of-scope configuration gap
discovered while building the inventory, is **intentionally untouched**:

- **`STRATEGY` env var silently maps any unrecognized value to
  `'default'`** instead of failing startup (§9) — a real, confirmed gap
  matching this same P2's spirit, but located in `src/strategy/
  multiConfig.ts`, explicitly excluded as "MULTI strategy" code. Flagged
  here for a future, correctly-scoped phase.
- The `RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry (§11) —
  cosmetic only (both fail closed correctly), not fixed since resolving
  it would require a broader refactor of `CHAINS`' eager evaluation.
- `scoreMultiPool` NaN propagation (Phase 4.5.2, BUG-003).
- `runStartupTxRecovery`'s sequential loop (Phase 4.6.3, noted as
  out of scope there too).
- Memory management, retry architecture, global exception handling —
  none inspected or modified this phase.
- Instance lock, GMGN CLI, persistence implementation, TP/SL shutdown,
  health/readiness implementation, MULTI strategy — confirmed untouched
  by this phase's diff (§18's scoping).

## 20. Verdict

**PASS**

Critical, previously-unvalidated configuration (`RPC_4663`/`RPC_56`/
`RPC_8453`, `USDC_4663`) is now validated at the exact point the existing
architecture already reads it, before any transaction-capable service
can start — confirmed with a real child-process test, not only a pure
validator-function call. Invalid configuration fails closed: it is never
silently converted into an empty string, a blindly-cast garbage address,
or (for the `MAX_CRITICAL_PRICE_AGE_MS` case) a safety-disabling
`Infinity`. Valid existing configuration remains byte-for-byte
compatible — the only behavioral change is that previously-invalid
configuration now fails startup instead of silently proceeding. No
secrets appear in any validation error. No transaction-capable service
can start with an invalid `RPC_4663`/`USDC_4663` — proven directly, not
assumed. 368/368 tests pass, typecheck and build are clean.
