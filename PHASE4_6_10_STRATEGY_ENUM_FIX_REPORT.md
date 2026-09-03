# PHASE 4.6.10 STRATEGY ENUM VALIDATION REPORT

## 1. Original Finding

"STRATEGY enum silent-default gap" — flagged as a remaining, related
finding in Phase 4.6.6's and 4.6.8's reports: the MULTI configuration
path silently falls back to the default strategy when `STRATEGY`
contains an unknown/invalid value, so a typo or malformed configuration
could cause the bot to run a strategy different from the operator's
intent, with no warning.

## 2. Current Strategy Architecture

`src/strategy/multiConfig.ts`:
```ts
export function getActiveStrategyName(): StrategyName {
  const raw = (process.env.STRATEGY ?? 'default').trim().toLowerCase();
  return raw === 'multi' ? 'multi' : 'default';
}
```
`getActiveStrategyName()` is not a startup-only function — it is called
**live, at runtime**, from three separate handlers in `src/bot/bot.ts`
(the `/multi` command, `multi:refresh`, and `multi:exec:*` callback
handlers — confirmed by `grep`), gating whether the MULTI command family
is reachable at all. It is not called anywhere in `src/index.ts`'s
startup sequence today. This live, frequent, must-never-throw call
pattern is the key architectural fact that shaped this phase's fix
(§5, §9).

## 3. Supported Strategy Values

From `src/strategy/types.ts`:
```ts
export type StrategyName = 'default' | 'multi';
```
Exactly two members — confirmed directly from the type definition, not
assumed. No other strategy value exists anywhere in the codebase.

## 4. Silent-Default Root Cause

`getActiveStrategyName()`'s ternary — `raw === 'multi' ? 'multi' : 'default'`
— treats every string that isn't exactly `'multi'` (after trim+lowercase)
identically, collapsing three distinct cases into one:
1. **Missing** (`process.env.STRATEGY` is `undefined`) — the intentional,
   documented default.
2. **Explicitly empty** (`STRATEGY=""`) — currently indistinguishable
   from missing.
3. **Present but invalid** (`STRATEGY=mulit`, `STRATEGY=foobar`, ...) —
   the actual bug: a real operator typo silently and permanently becomes
   `'default'`, with only a log-level trace (if any) to notice.

## 5. Validation Boundary

A new, separate, authoritative function —
`assertValidStrategyEnv()` (`src/strategy/multiConfig.ts`) — is the
single place that rejects an unrecognized value. `getActiveStrategyName()`
is **not modified** (zero lines changed) and keeps its exact existing
behavior and contract, because it cannot safely be made to throw: it
runs on every `/multi`-family Telegram command, and making it throw
would turn an invalid `STRATEGY` into a per-command runtime error
(crashing/erroring individual bot interactions) instead of a single,
controlled startup failure — which is what the task requires ("fail
BEFORE any transaction-capable service starts", not "fail on every
subsequent command"). `assertValidStrategyEnv()` is called exactly once,
early in `src/index.ts`'s `main()` (§9); by the time
`getActiveStrategyName()` is ever invoked at runtime, this call has
already guaranteed `process.env.STRATEGY` is either unset or a
recognized name — env vars do not change during a process's lifetime, so
this single startup check is sufficient and authoritative (no duplicate
validation logic was introduced, per §21's explicit instruction).

Both functions share the same normalization rule (trim + lowercase) and
the same enum source (`VALID_STRATEGY_NAMES`, derived directly from the
`StrategyName` type, not invented independently).

## 6. Missing STRATEGY Behavior

**Preserved exactly.** `assertValidStrategyEnv()`'s first line is
`if (raw == null) return;` — an unset `STRATEGY` is never treated as
invalid; it returns immediately without throwing, and
`getActiveStrategyName()` continues to resolve it to `'default'` exactly
as before. Verified by test (§14/§15).

## 7. Invalid STRATEGY Behavior

Any **present** value that does not normalize (trim + lowercase) to
`'default'` or `'multi'` now causes `assertValidStrategyEnv()` to throw,
including the explicit `STRATEGY=""` case named in the task's own
CRITICAL SAFETY PRINCIPLE — confirmed present-but-empty is not treated
as equivalent to unset (`process.env.STRATEGY === ''` is not `null`, so
the early-return does not trigger; `''.trim().toLowerCase()` is `''`,
which is not in `VALID_STRATEGY_NAMES`, so it throws).

## 8. Case/Whitespace Semantics

**Preserved exactly, not newly introduced.** `getActiveStrategyName()`
already performed `.trim().toLowerCase()` before its comparison — this
existing normalization is reused as-is by `assertValidStrategyEnv()`.
Consequently `"MULTI"`, `" multi "`, `"multi "`, `" multi"`, and
`"Default"` all continue to be accepted (matching pre-existing valid
behavior, verified by test), while a value that still doesn't match
after that same normalization (a typo, `"multi2"`, `"unknown"`, a
whitespace-only string, etc.) is rejected. No new normalization
(trimming, casing) was added anywhere.

## 9. Startup Failure Boundary

`assertValidStrategyEnv()` is called as the very first statement inside
`main()` in `src/index.ts` — **before** the instance-lock acquisition,
before `getDb()`, before wallet/client initialization, before
`createBot()`, before the TP/SL and volume-alert watchers start, and
before `bot.start()`. A thrown error propagates uncaught out of `main()`
to the existing top-level handler:
```ts
main().catch((err) => {
  console.error(err);
  setLifecycleState('failed', [...]);
  releaseInstanceLock();
  process.exit(1);
});
```
which already logs the error, marks health `FAILED`, releases the
instance lock (a safe no-op here since the lock was never acquired), and
exits non-zero — the exact same fail-closed path Phase 4.6.6 established
for invalid RPC/address configuration. No new startup-failure mechanism
was invented; this reuses the existing one. Verified structurally by a
test that reads `src/index.ts`'s source and asserts the call's text
offset precedes `acquireInstanceLock(...)`, `getDb()`, and `bot.start(`.

## 10. Instance Lock Interaction

Placed **before** instance-lock acquisition, consistent with the
existing precedent already set by Phase 4.6.6: `config.dbPath` (the
first property access on the lazy `config` Proxy, which triggers
`getConfig()`'s own RPC/address validation) is read at
`defaultLockPath(config.dbPath)`, immediately before
`acquireInstanceLock(...)` — i.e., configuration validation already ran
before lock acquisition in the existing architecture. `assertValidStrategyEnv()`
was placed immediately before that same point, preserving this ordering
rather than introducing a new one. Since the check throws before the
lock is ever requested, no lock is acquired and none needs releasing on
this path — `releaseInstanceLock()` in the top-level `catch` is a safe
no-op when no lock is held (verified: `instanceLock.ts`'s
`releaseInstanceLock` is already ownership-checked and safe to call when
nothing is held).

## 11. Health/Readiness Interaction

Not modified. The health server is intentionally started **before**
this check (Phase 4.6.5's "as early as possible" design, preserved) so
liveness (`GET /health`) is observable even during this failure. On an
invalid `STRATEGY`, the thrown error reaches `main().catch()`, which
calls the existing, generic `setLifecycleState('failed', [...])` —
already correctly wired for any startup exception, requiring no new
health.ts code. `GET /ready` correctly reflects not-ready/failed via
this pre-existing mechanism; no false `READY` state is possible since
`setLifecycleState('ready', ...)` is only reached at the very end of a
fully-succeeded `main()` (after `bot.start()`), which an invalid
`STRATEGY` never reaches.

## 12. Telegram/Strategy Gating

Not modified. `bot.ts`'s three `getActiveStrategyName() !== 'multi'`
gate checks (the `/multi` command family) are untouched — confirmed
zero lines changed in `bot.ts` this phase. Since `assertValidStrategyEnv()`
already guarantees a valid `STRATEGY` before the bot ever starts serving
commands, these gates continue to see only `'default'` or `'multi'` in
production, exactly as they always have.

## 13. Error Message

```
Invalid STRATEGY "mulit": expected one of default, multi (or unset, which defaults to 'default')
```
Names the variable (`STRATEGY`), the exact invalid value received
(quoted verbatim), and the full accepted-values list. Contains no
secrets, RPC URLs, private keys, tokens, or API keys — it reads only
from `process.env.STRATEGY` and the static `VALID_STRATEGY_NAMES` list,
neither of which can contain such values. Verified by test.

## 14. Invalid-Value Tests

`test/strategyEnum.test.ts`'s invalid-value matrix covers: `"mulit"`,
`"foobar"`, `"unknown"`, `"multi2"`, `"degen"`, `"DEFAULT_STRATEGY"`,
whitespace-only (`"   "`), `"null"`, `"undefined"`, and the explicit
empty-string case (`""`, its own dedicated test per the task's
CRITICAL SAFETY PRINCIPLE) — every one throws `/Invalid STRATEGY/`.

## 15. Valid-Value Tests

Covers both actual `StrategyName` members (`"multi"`, `"default"`),
missing/unset, and the existing case/whitespace-normalized forms
(`"MULTI"`, `" multi "`, `"multi "`, `" multi"`) — none throw, and
`getActiveStrategyName()`'s result is asserted unchanged for each.

## 16. No-Silent-Fallback Test

`'no-silent-fallback: an invalid STRATEGY never causes any strategy to
be silently selected by the validator'` — confirms `assertValidStrategyEnv()`
throws for `"definitely-invalid"` with no return value that could be
mistaken for a selected strategy (the function returns `void`; its only
observable outcome for invalid input is the thrown exception). Combined
with the real-child-process tests (§17), this is the core security
regression the task requires.

## 17. Startup Side-Effect Test

Four real child-process tests (mirroring the exact pattern already
established in `test/config.validation.test.ts`'s "real startup" suite
from Phase 4.6.6) via a new fixture, `test/fixtures/assert-strategy.mts`,
which imports and calls the actual `assertValidStrategyEnv()` — the same
function `src/index.ts`'s `main()` depends on:
- missing `STRATEGY` → exits 0, prints `STRATEGY_OK`.
- `STRATEGY=multi` → exits 0, prints `STRATEGY_OK`.
- `STRATEGY=mulit` → exits non-zero, never prints `STRATEGY_OK`, stderr
  contains `STRATEGY_ERROR ... Invalid STRATEGY`.
- `STRATEGY=""` → exits non-zero, never prints `STRATEGY_OK`.

A structural test additionally confirms (by reading `src/index.ts`'s
source directly) that the `assertValidStrategyEnv();` call's text offset
precedes `acquireInstanceLock(lockPath)`, `getDb()`, and `bot.start(` —
proving by construction that no transaction-capable service can execute
before this check, without needing to mock the full bot/RPC/Telegram
stack (which the codebase has no dependency-injection seam for at the
`main()` level, and inventing one was out of this phase's scope).

## 18. Type Safety

`VALID_STRATEGY_NAMES: readonly StrategyName[] = ['default', 'multi']`
is typed against the real `StrategyName` union — not a broad `as
StrategyName` cast bypassing validation. The untrusted runtime string
(`process.env.STRATEGY`) is checked via `Array.prototype.includes`
against this typed list before ever being treated as a `StrategyName`;
`assertValidStrategyEnv()` itself returns `void` and never claims a
`StrategyName` type for the raw input — the caller (`getActiveStrategyName()`,
unchanged) is the only place a string becomes a `StrategyName`, and it
does so via its own existing, narrow ternary (`raw === 'multi' ? 'multi' : 'default'`),
not a cast.

## 19. Trading Logic Audit

No MULTI strategy parameter, market-cap/token-age/volume threshold, Top
N, fee tier, TVL/volume/fee scoring weight, pool discovery/ranking,
range calculation, single-sided liquidity logic, quote/price-impact/
slippage/minOut computation, simulation, gas estimation, execution,
TP/SL logic, or accounting formula was touched. Confirmed by the diff
(§24) touching only `src/strategy/multiConfig.ts` (additive) and
`src/index.ts` (one new startup call, one import). The full MULTI test
suite (`strategy.multiExecute.test.ts`, `strategy.multiPool.test.ts`,
`strategy.multiPool.nanHardening.test.ts`, `strategy.multiRisk.test.ts`,
`strategy.multiRange.test.ts` — 66 tests) passes unmodified.

## 20. Strategy Parameter Audit

`loadMultiConfig()`/`validateMultiConfig()` (the functions that read
`MULTI_MIN_MARKET_CAP_USD`, `MULTI_TOP_N`, `MULTI_RANGE_PERCENT`, pool
scoring weights, etc.) are untouched — confirmed zero lines changed in
that portion of `multiConfig.ts` (the diff in §24 is a pure addition
after `getActiveStrategyName()`, before `envNum`). The existing
per-parameter MULTI config validation (which safely disables MULTI on a
malformed numeric/address value while leaving the bot and
default-strategy trading running) is completely separate from, and
unaffected by, this phase's STRATEGY-enum check — both now coexist:
STRATEGY-enum validation halts the whole process on an ambiguous
operator intent; MULTI parameter validation continues to just disable
MULTI on a malformed *parameter* while STRATEGY itself is valid.

## 21. Test Results

```
npx tsx --test test/strategyEnum.test.ts test/strategy.isolation.test.ts
tests 19, pass 19, fail 0

npx tsx --test test/strategy.multiExecute.test.ts test/strategy.multiPool.test.ts \
  test/strategy.multiPool.nanHardening.test.ts test/strategy.multiRisk.test.ts \
  test/strategy.multiRange.test.ts
tests 66, pass 66, fail 0

npm test
tests 426, pass 426, fail 0
```
(411 pre-existing baseline from Phase 4.5.2 through 4.6.9, all preserved
byte-for-byte, + 15 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

## 22. Typecheck

```
npm run typecheck
```
Clean.

## 23. Build

```
npm run build
```
Clean.

## 24. Diff Scope Audit

```
git diff --stat -- src/strategy/multiConfig.ts src/index.ts
 src/index.ts                | 111 ++++++++++++++++++++++++++++++++++++++++++--
 src/strategy/multiConfig.ts |  42 +++++++++++++++++
 2 files changed, 148 insertions(+), 5 deletions(-)
```
(`src/index.ts`'s total reflects cumulative uncommitted changes since
Phase 4.6.5, not new deletions this phase — this phase's own diff
against `src/index.ts` is exactly one import-line edit and one new
12-line comment+call block, verified directly.) `test/strategyEnum.test.ts`
and `test/fixtures/assert-strategy.mts` are new/untracked. `getActiveStrategyName()`
has zero lines changed. No other file was modified. `git status --short`
before and after this phase shows the exact same set of prior-phase
(4.5.2 through 4.6.9) modified/untracked files, with zero additional
changes to any of them. No reset, stash, checkout, or revert was
performed.

## 25. Remaining P2/P3 Findings

- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **DexScreener unvalidated `as`-cast JSON boundary** (flagged Phase
  4.6.7/4.6.8/4.6.9) — still not fixed; explicitly out of this phase's
  scope ("Do NOT combine this with DexScreener JSON validation").
- **Retry architecture** — not inspected this phase (explicitly out of
  scope).
- **Global exception handling** — not inspected this phase (explicitly
  out of scope).
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** (Phase 4.6.8) — unbounded by design, accounting-critical,
  not touched.
- No new findings were discovered in this phase beyond the one it was
  scoped to fix. The **STRATEGY enum silent-default gap itself is now
  fixed** and is not carried forward as a remaining finding.

## 26. Files Changed

- [src/strategy/multiConfig.ts](src/strategy/multiConfig.ts) — added `assertValidStrategyEnv()` and `VALID_STRATEGY_NAMES` (42 insertions, purely additive)
- [src/index.ts](src/index.ts) — call `assertValidStrategyEnv()` first in `main()`, before instance-lock acquisition
- [test/strategyEnum.test.ts](test/strategyEnum.test.ts) — new, 15 focused regression tests
- [test/fixtures/assert-strategy.mts](test/fixtures/assert-strategy.mts) — new, real-child-process fixture
- [PHASE4_6_10_STRATEGY_ENUM_FIX_REPORT.md](PHASE4_6_10_STRATEGY_ENUM_FIX_REPORT.md) — this report

## 27. Verdict

**PASS**

Every currently valid `STRATEGY` value (`'multi'`, `'default'`, and
missing/unset) continues to resolve identically, including all existing
case/whitespace-normalized forms — verified by regression tests and by
the fact that `getActiveStrategyName()` itself has zero lines changed.
Every invalid value (typos, garbage, whitespace-only, and the explicit
empty-string case named in the task's own safety principle) now fails
startup with a clear, secret-free error identifying the variable, the
bad value, and the accepted values — proven both as a direct function
call and via a real child process exercising the actual code path
`src/index.ts` depends on. No silent fallback remains: an invalid value
can no longer cause any strategy to be silently selected, and — proven
structurally — cannot reach the instance lock, the database, or
`bot.start()`. No trading logic or MULTI parameter was changed. 426/426
tests pass, typecheck and build are clean.
