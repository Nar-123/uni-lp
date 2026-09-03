# PHASE 4.6.16 RPC ERROR-SURFACING ASYMMETRY AUDIT

## 1. Original Finding

"RPC_4663-vs-USDC_4663 error asymmetry" — carried forward, unresolved,
in every phase's "Remaining P2/P3 Findings" section since Phase 4.6.6,
always phrased as "cosmetic, both fail closed." This phase re-audits it
under a sharper lens: not merely "do the error messages differ," but
"can either path let an RPC/configuration failure become valid-looking
data that reaches a trading decision."

## 2. RPC_4663 Meaning

Confirmed by reading `src/config.ts` directly (not assumed):
`RPC_4663` is an **environment variable name**, not an RPC endpoint or
call in its own right — it optionally overrides the JSON-RPC URL used
to construct the viem HTTP transport for chain 4663 (Robinhood Chain).
Read via `resolveRpcUrl('RPC_4663', CHAINS[4663].defaultRpc)` inside
`getConfig()` (a lazily-evaluated, memoized function, first invoked
early in `src/index.ts`'s `main()`). Validated by `assertValidRpcUrl`
(Phase 4.6.6): must be a non-empty, non-whitespace-padded string
parseable as a URL with an `http:`/`https:` scheme. If absent, the
existing hardcoded default (`CHAINS[4663].defaultRpc`) is used
unvalidated (trusted, hardcoded, unchanged). If present but invalid,
`assertValidRpcUrl` **unconditionally throws** — confirmed directly
from source, no fallback path exists.

## 3. USDC_4663 Meaning

Also an **environment variable name**, not an RPC endpoint — it
optionally overrides the USDC ERC-20 **token contract address** for
chain 4663. Read via `resolveOptionalAddressEnv('USDC_4663')` inside the
module-top-level `CHAINS` constant (eagerly evaluated the instant
`config.ts` is imported — before `main()` is even defined). Validated
by `assertValidOptionalAddress` (Phase 4.6.6): must be a non-empty,
non-whitespace-padded string that passes viem's `isAddress()`. If
absent, `undefined` is used — a legitimate, pre-existing business state
(Robinhood Chain's primary stable is USDG; having no configured USDC
address there is normal, not an error — confirmed by
`depositAssets`/`primaryStableAddress`/`primaryStableSymbol`, all of
which correctly `if (c.usdc)`-guard before using it). If present but
invalid, `assertValidOptionalAddress` **unconditionally throws** —
confirmed directly from source, no fallback path exists.

## 4. RPC Path Inventory

The actual "asymmetry" is a difference in **when** each throw is
reachable, not **whether** one:

| | `RPC_4663` | `USDC_4663` |
|---|---|---|
| Validated inside | `getConfig()` — lazy, memoized function | `CHAINS` — eager, module-top-level constant |
| First evaluated | On first property access of `config`/`getConfig()` (early in `main()`) | The instant `config.ts` is `import`ed (before `main()` exists) |
| Invalid value | Throws inside a function body — catchable by `main().catch()` | Throws during module evaluation — an uncaught exception at `import` time |
| Absent value | Falls back to `CHAINS[4663].defaultRpc` (unvalidated, hardcoded, trusted) | Resolves to `undefined` (a real, pre-existing, valid business state) |
| Outcome either way | Non-zero exit, error visible on stderr, process never starts | Non-zero exit, error visible on stderr, process never starts |

Beyond `config.ts`, the broader repository search for `RPC`/`transport`/
`createPublicClient`/`createWalletClient`/`http(`/`fallback`/`provider`
found exactly one transport construction site
(`src/chain/clients.ts`'s `getPublicClient`/`getWalletClient`, both
using viem's `http()` with the already-resolved, already-validated
`config.rpc[chainId]` string) — no fallback-provider logic, no
alternate RPC path, and no other place `RPC_4663`/`USDC_4663` are read
(confirmed by grep — each appears only in `config.ts`).

## 5. Error Flow Comparison

Both paths, traced end to end:
```
RPC_4663 invalid  -> assertValidRpcUrl throws -> getConfig() throws
  -> reached inside main()'s body -> propagates to main().catch()
  -> console.error + setLifecycleState('failed') + releaseInstanceLock() + process.exit(1)

USDC_4663 invalid -> assertValidOptionalAddress throws -> CHAINS throws
  -> reached during `import './config.js'` (module evaluation)
  -> Node's own uncaught-exception default: stack trace to stderr, process.exit(1)
```
**Classification (task's own A-D scale, §4): A — cosmetic only.** Both
paths (a) throw, (b) never return/resolve any value, (c) result in the
process never starting, (d) print the invalid variable's name and the
specific validation failure to stderr. Neither can produce
"RPC/config failure -> empty/default/zero -> caller treats it as valid
data" — there is no code path in either validator that returns
anything on the invalid-input branch; both branches are `throw`
statements exclusively (verified directly by test, §19).

## 6. Empty vs Error Analysis

Not applicable to the two validators themselves — neither has an "empty
result" concept (a URL string and an address string are each either
present-and-valid, present-and-invalid [throws], or absent
[falls back to a defined, safe default/`undefined`]). Extended to the
broader RPC-*read* question the checklist raises (a genuinely different
concern from config validation): every traced on-chain read function
(`getPosition`'s `ownerOf`/`positions` reads, `resolvePoolFromFactory`'s
factory `getPool` read, `getTokenTotalSupply`'s `totalSupply` read)
already distinguishes "the call itself failed" (propagates as a
rejection or, for the one function with a catch, returns `null`) from
"the call succeeded and returned a real, on-chain zero/empty value" (a
legitimate result, returned as such) — detailed per category below.

## 7. Zero-Value Fallback Analysis

Searched for RPC error handlers returning `0`/`0n`/`false`/`[]`/`{}`/
`null`/`undefined` as a fallback. Found exactly **one** intentional,
already-documented instance: `chain/tokens.ts`'s `getTokenTotalSupply`
returns `null` (not `0n`) on a caught RPC failure — a deliberate,
type-distinguishable "unknown," not a fabricated zero (§10). No other
RPC-read function in the traced call graph (`getPosition`,
`resolvePoolFromFactory`, `readLiveLiquidity`) has any catch-and-default
pattern at all — each lets a failure propagate as a genuine promise
rejection instead (verified directly by structural test, §19).

## 8. Price Safety

Unchanged, unmodified (Phase 2 Part 4 / Phase 4.6.9 / Phase 4.6.11, none
touched this phase). `getPosition` (line ~671 of `positions.ts`) uses
`getCriticalTokenPriceUsd` explicitly, with its own comment: "a stale or
unavailable price becomes p0/p1 = null here, which `priceCompleteFor`
already treats as UNKNOWN... never a fabricated $0." `priceCompleteFor`
(`chain/safety.ts`, already covered by `test/safety.test.ts`'s
"position:" tests, re-verified with new adversarial numeric cases this
phase) correctly treats a price of exactly `0` or negative as
*incomplete* (not "known"), so a corrupted/failed price read can never
be silently treated as a legitimate `$0` valuation for a nonzero
amount. One minor, purely theoretical observation (not a proven
defect, and not reachable given upstream Phase 4.6.9/4.6.11 finite-price
validation): `priceCompleteFor`'s own check (`p0 > 0`) would treat a
price of `Infinity` as "known" — this can never actually occur in
practice since every price this codebase produces is already validated
finite one layer up, so no fix was made (see §22).

## 9. Liquidity/TVL Safety

`close.ts`'s `readLiveLiquidity` and `pools.ts`'s
`resolvePoolFromFactory` both have **no catch clause at all** — an RPC
failure propagates as a genuine rejection (verified directly by
structural test, §19), never silently becoming a fabricated `0n`
liquidity or a fabricated "no pool" `null`. `resolvePoolFromFactory`
only returns `null` after the factory contract call has **already
succeeded** and returned the literal zero address — a real, on-chain,
authoritative "no pool exists for this pair/fee" answer, not a failure
substitute. MULTI's own pool-scoring TVL/volume figures
(`strategy/multiPool.ts`, Phase 4.6.7) are sourced entirely from
DexScreener, not from these on-chain reads at all — that boundary is
Phase 4.6.9/4.6.11 territory, untouched.

## 10. Ownership Safety

Unchanged, unmodified — this is exactly the "Phase 1" hardening the
task's own §9 references. `getPosition` (`positions.ts`) wraps its
`ownerOf` read in an explicit try/catch using the exported, pure
`classifyOwnershipError` (`chain/safety.ts`): a specific, narrow
ERC721-nonexistent-token revert message classifies as `'gone'` (safe
`null`); **anything else — RPC timeout, rate limit, network error, an
unrecognized revert — classifies as `'unknown'` and is rethrown**,
never treated as "not owned." Re-verified this phase with additional
RPC-specific adversarial phrases (`ECONNRESET`, `rate limited (429)`,
`connect ETIMEDOUT`, an empty string) — all correctly classify
`'unknown'`. Confirmed both v3 (`positions.ts`) and v4 (`v4.ts`) import
and use the **same** `classifyOwnershipError` function — no divergent
ownership-safety semantics between protocols.

## 11. Total Supply Safety

Unchanged, unmodified — this is the other "Phase 1" hardening §10
references. `getTokenTotalSupply`'s own doc comment states it plainly:
"On read failure, supply is UNKNOWN and must not be reported as 0 (0
supply silently implies $0 market cap for callers) — returns `null` so
callers can fail closed." Verified directly this phase: the native-token
branch (`isNativeTokenAddress(token)` → `return 0n`) is a **real,
type-distinguishable, genuinely executable zero** (tested directly, zero
RPC calls involved) — completely separate in both type and meaning from
the RPC-failure branch's `null` (verified structurally: the catch block
returns `null`, never `0n`).

## 12. Position Safety

`getPosition` returns `null` for "liquidity=0 AND both tokensOwed=0"
**only after** both the ownership read and the position-data read have
already succeeded (verified structurally this phase: the zero-check's
source position in the function body comes strictly after both RPC
reads) — this is a real, authoritative, post-confirmed-ownership
on-chain zero, never a failure fallback. A failure during either read
propagates as a rejection before this line is ever reached.

## 13. Fee Safety

`tokensOwed0`/`tokensOwed1` come from the exact same `positions()`
on-chain read as liquidity (`positions.ts`, no separate/weaker path) —
covered by the identical safety property in §12. `computeV3UnclaimedFees`
(the live fee-growth computation) only runs when `poolAddress &&
liquidity > 0n` (i.e. a confirmed-existing position), and its own
underlying `slot0`/`liquidity` pool reads have no catch clause either —
a failure there propagates rather than silently zeroing the fee
estimate.

## 14. MULTI Strategy Safety

MULTI's candidate/pool pipeline does not perform on-chain RPC reads for
its scoring inputs at all (`strategy/multiPool.ts`'s `scoreMultiPool`
reads only DexScreener-sourced `pool.tvlUsd`/`pool.pair.volume.h24`,
already comprehensively hardened against non-finite/negative values in
Phase 4.6.7, unmodified) — there is no separate RPC-read path here for
this audit to find divergent from `RPC_4663`/`USDC_4663`'s config
validation. `strategy/multiConfig.ts`'s own `MULTI_USDG_ADDRESS`
resolution reuses the same `isAddress`-based validation pattern
established by Phase 4.6.6 (not modified, not re-audited beyond
confirming it exists and follows the same convention).

## 15. Execution Safety

Not touched this phase (explicitly out of scope: "DO NOT modify...
execution"). Traced only far enough to confirm no execution-path
function relies on a fabricated zero/false value originating from
either `RPC_4663`/`USDC_4663`'s config validation or the broader
RPC-read patterns audited above — `minOut`/slippage computation
(`chain/safety.ts`'s `computeWithdrawalMins`/`computeMinWithSlippage`,
already covered extensively by `test/safety.test.ts`, unmodified) reads
live pool state via the same "no catch, propagate on failure" pattern
already confirmed safe in §9.

## 16. Error Classification

This codebase already has a small, consistent, ad-hoc taxonomy —
confirmed by reading rather than inventing a new one: `'gone' |
'unknown'` (ownership, `classifyOwnershipError`), `null` for
"read failed, value unknown" (`getTokenTotalSupply`, `getCriticalTokenPriceUsd`'s
`ok:false`), and a thrown `Error` for "this operation cannot safely
continue" (everything else — the dominant pattern). No new error
architecture was created; this phase reuses and re-verifies the
existing one exactly as instructed ("If one exists, use it. Do NOT
create a large new error architecture for this small audit").

## 17. Partial Data Analysis

The two config validators (`RPC_4663`/`USDC_4663`) are independent,
single-value reads with no batching — not applicable. For the broader
RPC-read question: `getPosition`'s two-read sequence (ownership, then
position data) is inherently sequential, not partial-batch — if the
first read fails, the second is never attempted (no partial-success
state is possible there). `Promise.all` calls within `getPosition`
(e.g. `getTokenMeta` for both tokens, `getCriticalTokenPriceUsd` for
both tokens) propagate the first rejection immediately per `Promise.all`'s
own standard semantics — a partial success (one resolves, one rejects)
already fails the whole `getPosition` call closed, rather than being
silently consumed as a complete snapshot.

## 18. Multicall Analysis

No Multicall3 usage was found in the RPC_4663/USDC_4663-adjacent code
paths audited this phase (`config.ts`, `positions.ts`'s `getPosition`,
`pools.ts`'s `resolvePoolFromFactory`, `close.ts`'s `readLiveLiquidity`
all use direct, individual `readContract` calls, not a batched
multicall). No concrete Multicall3 safety defect was found or
demonstrated; per the task's own instruction ("do not modify Multicall3
implementation unless a concrete safety defect is demonstrated"), none
was fixed. **N/A** for this specific audit's scope.

## 19. Failure-Injection Tests

New file `test/rpcErrorAsymmetry.test.ts` — 16 tests, including:
`assertValidRpcUrl`/`assertValidOptionalAddress` both throw (never
return a fallback) for the same set of adversarial inputs (empty,
whitespace, malformed); a structural test proving neither validator's
internal `catch` (only `assertValidRpcUrl` has one, for `new URL()`
parse errors) ever resolves to a fallback — every catch immediately
re-throws; `classifyOwnershipError` re-verified against RPC-specific
adversarial phrases; `priceCompleteFor` re-verified against NaN/zero/
negative price edge cases; `getTokenTotalSupply`'s native-token branch
executed for real (genuine `0n`, zero RPC calls) with a structural
check that its failure branch returns `null`, never `0n`;
`resolvePoolFromFactory` and `readLiveLiquidity` structurally confirmed
to have no catch-and-fallback pattern; `getPosition` structurally
confirmed to gate its zero-liquidity `null` behind both successful RPC
reads.

## 20. Cross-Path Parity Tests

`'cross-path parity: RPC_4663 and USDC_4663 validators both throw...'`
and `'...both validators name the variable and reject the value...'`
directly compare `assertValidRpcUrl` and `assertValidOptionalAddress`
side-by-side against the identical set of adversarial inputs, proving
equivalent *safety* semantics (both throw, neither substitutes a
fallback, both name the offending variable) without requiring identical
error text — exactly the distinction the task itself draws. A separate
test confirms v3 (`positions.ts`) and v4 (`v4.ts`) share the identical
`classifyOwnershipError` function, ruling out a divergent
ownership-safety path between protocols.

## 21. Real Network Validation

Not performed this phase. The two-value config-validation asymmetry
(§2-§5) requires no network access to verify (it's pure, synchronous
input validation, already fully covered by Phase 4.6.6's
`test/config.validation.test.ts` real-child-process tests, re-run this
phase, §23). The broader RPC-read safety properties (§9-§13) were
verified via direct source inspection and the existing, already-real
tests in `test/safety.test.ts` (which exercise the actual, real
classification functions, not RPC calls themselves) — no live RPC
endpoint was queried this phase, and per the task's own instruction, a
skipped network validation "does not automatically mean FAIL" when the
underlying logic has already been verified by other rigorous means.

## 22. Changes Made

**Production code unchanged because the asymmetry was proven
cosmetic/operationally safe.** Every RPC-read and config-validation path
traced in this audit either (a) unconditionally throws on invalid
input/failure (the dominant pattern, verified structurally across
`assertValidRpcUrl`, `assertValidOptionalAddress`, `resolvePoolFromFactory`,
`readLiveLiquidity`, and `getPosition`'s ownership check), or (b)
returns a real, type-distinguishable `null`/`'unknown'` sentinel that
existing, unmodified callers already correctly treat as "fail closed,
never fabricate" (`getTokenTotalSupply`, `classifyOwnershipError`,
`getCriticalTokenPriceUsd`/`priceCompleteFor`). One purely theoretical,
currently-unreachable observation was noted and explicitly *not* acted
on (§8's `Infinity`-price edge case in `priceCompleteFor`) — fixing it
would mean modifying price-completeness logic without a demonstrated,
reachable defect, which the task's own scope forbids ("DO NOT modify...
price impact... execution" and "if asymmetry is cosmetic only, DO NOT
MODIFY PRODUCTION CODE").

## 23. Full Test Results

```
npx tsx --test test/rpcErrorAsymmetry.test.ts
tests 16, pass 16, fail 0

npx tsx --test test/rpcErrorAsymmetry.test.ts test/safety.test.ts test/config.validation.test.ts test/memoryGrowth.test.ts
tests 87, pass 87, fail 0

npm test
tests 524, pass 524, fail 0
```
(508 pre-existing baseline from Phase 4.5.2 through 4.6.15, all
preserved byte-for-byte, + 16 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

Two test-authoring bugs, disclosed rather than hidden, were found and
fixed within this same turn: (1) a blanket `doesNotMatch(/catch/)`
assertion incorrectly flagged `assertValidRpcUrl`'s one legitimate
catch-and-rethrow (URL parsing) — fixed to check the precise invariant
("every catch immediately re-throws, never returns a fallback") instead
of banning `catch` outright; (2) a whole-file `indexOf` search for
`"functionName: 'positions'"` matched an earlier, unrelated occurrence
in a different function before `getPosition`'s own — fixed by scoping
the search to `getPosition`'s own function body first. Both were
test-precision bugs, not production issues.

## 24. Typecheck

```
npm run typecheck
```
Clean.

## 25. Build

```
npm run build
```
Clean.

## 26. Trading Logic Audit

No price calculation, quote calculation, MULTI candidate filtering/
ranking/pool scoring, range calculation, single-sided liquidity logic,
simulation, gas strategy, nonce strategy, receipt deadline, close
fallback, retry architecture, TP/SL decision logic, or accounting
formula was modified. Every file this audit inspected (`config.ts`,
`positions.ts`, `pools.ts`, `close.ts`, `tokens.ts`, `safety.ts`, `v4.ts`)
has zero lines changed this phase (confirmed by diff, §29 — every one
shows the identical line count to the pre-phase baseline).

## 27. Strategy Parameter Audit

No file under `src/strategy/*` appears in this phase's diff. No MULTI
parameter, threshold, weight, or fee tier was read, referenced, or
modified.

## 28. Remaining P2/P3 Findings

- **`ledger`/`positions`/`multi_position_meta` persistent file growth**
  (Phase 4.6.8) — unbounded by design, accounting-critical, not touched.
- **`journalledSend`'s refusal-gate retry inefficiency** (Phase 4.6.12) —
  minor, non-unsafe, "journal semantics" territory, out of scope.
- **GMGN's `GmgnRateLimitError.resetAt` never consumed** (Phase 4.6.12) —
  missing convenience, GMGN CLI behavior explicitly out of scope.
- **`runStartupTxRecovery`'s sequential loop has no aggregate deadline**
  (Phase 4.6.12) — "transaction recovery semantics," out of scope.
- **`close.ts`'s terminal-journal-write-back optimization** (Phase
  4.6.14) — minor missed optimization, "journal semantics" out of scope.
- **v4 close path dedicated adversarial test gap** (Phase 4.6.14) — the
  v4 close function relies on the same universal `journalledSend` gate
  but was not given its own dedicated adversarial test.
- **The two traced fire-and-forget call sites** (`bot.start()`,
  `tpslWatcher.ts`'s `recheckAndMaybeClose`) — addressed at the process
  level by Phase 4.6.15's global fatal-error handler, not at the
  call-site level; not carried forward as unresolved.
- **`priceCompleteFor`'s `Infinity`-price edge case** (new observation
  this phase, §8) — a price of `Infinity` would be treated as "known" by
  `priceCompleteFor`'s `p0 > 0` check. Currently unreachable in practice
  (every price this codebase produces is already validated finite one
  layer up, by Phase 4.6.9/4.6.11), so not fixed — flagged for a future
  phase only if `priceCompleteFor` is ever fed a price from a new,
  not-yet-finite-validated source.
- No new safety-severity findings beyond what is listed above. **The
  "RPC_4663-vs-USDC_4663 error asymmetry" finding itself is now fully
  resolved/closed** — both config-validation paths are confirmed to
  fail closed identically in every safety-relevant respect, and the
  broader runtime RPC-read safety properties the audit's checklist
  raised (ownership, price, totalSupply, position, fee, liquidity/TVL,
  pool resolution) were traced and confirmed already correctly hardened
  by earlier, differently-scoped phases (Phase 1, Phase 2 Part 4, Phase
  4.6.6, Phase 4.6.7, Phase 4.6.9, Phase 4.6.11) — it is not carried
  forward as an open P3 item.

## 29. Files Changed

- [test/rpcErrorAsymmetry.test.ts](test/rpcErrorAsymmetry.test.ts) — new, 16 focused audit tests
- [PHASE4_6_16_RPC_ERROR_ASYMMETRY_AUDIT_REPORT.md](PHASE4_6_16_RPC_ERROR_ASYMMETRY_AUDIT_REPORT.md) — this report

No production (`src/`) file was modified.

## 30. Verdict

**PASS**

RPC/configuration failures cannot silently become valid-looking data in
either the literal `RPC_4663`/`USDC_4663` config-validation paths or
the broader RPC-read call graph this audit traced: both env-var
validators unconditionally throw on invalid input (proven directly by
test, including a structural check that no internal catch block ever
substitutes a fallback), and every on-chain read function inspected
either propagates a failure as a genuine rejection or returns a real,
type-distinguishable sentinel (`null`, `'unknown'`) that existing,
unmodified callers already correctly treat as "unknown, never
fabricated." Empty results remain distinguishable from failures
wherever the checklist required it (ownership, totalSupply, pool
resolution, position liquidity/fees); zero values remain distinguishable
from failures in the same set. Price safety, liquidity/TVL safety,
ownership safety, totalSupply safety, position safety, and execution
safety are all preserved, unmodified, and — in most cases — were already
comprehensively tested by pre-existing suites this phase re-ran and
cited rather than duplicated. No trading parameter was changed. 524/524
tests pass, typecheck and build are clean, and zero production code was
changed — consistent with an audit that found the asymmetry cosmetic
and the surrounding architecture already safe.
