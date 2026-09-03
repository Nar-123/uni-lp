# PHASE 4.6.7 SCORE NaN / INFINITY FIX REPORT

## 1. Original P2 Finding

"scoreMultiPool NaN propagation." The MULTI pool scoring path could
produce `NaN`, `Infinity`, or `-Infinity` from invalid/corrupted numeric
inputs, risking non-obvious ranking/selection behavior.

## 2. scoreMultiPool Call Graph

```
listPoolsForToken() (chain/pools.ts)
   ↓ ListedPool[] — tvlUsd, pair.volume.h24 sourced from
     dexscreener.ts's fetchTokenPairs()/fetchPairByAddress(),
     which casts a raw fetch response with `as { pairs?: DexPair[] | null }`
     — no runtime validation of the JSON's numeric fields
   ↓
discoverAndScorePoolsForCandidate() (strategy/multiPool.ts)
   ↓ hard filters: isUsdgPool, PREFERRED_FEE_TIERS, MIN_POOL_TVL_USD gate
   ↓
scoreMultiPool(pool, config)  ← ONLY function modified this phase
   ↓ MultiPoolCandidate { totalScore, tvlScore, volumeScore, volumeTvlScore, feeScore, rejectedReasons, ... }
   ↓
comparePoolCandidates() sort  ← unmodified; now provably never sees an invalid candidate
   ↓
selected = ranked[0] ?? null
   ↓
multiExecute.ts's discoverAndScorePoolsForCandidate() caller: `if (!selected) { reject NO_VALID_POOL; continue }`  ← unmodified, already fail-closed
```

Only one caller of `scoreMultiPool` exists in non-test code:
`discoverAndScorePoolsForCandidate` in the same file. Only one caller of
`discoverAndScorePoolsForCandidate` exists in non-test code:
`multiExecute.ts`'s `runMultiStrategyOnce`.

## 3. Root Cause

`ListedPool.tvlUsd: number` and `DexPair.volume?: { h24?: number }` are
TypeScript-typed as `number`, but their actual runtime values originate
from `dexscreener.ts`:
```ts
const data = (await res.json()) as { pairs?: DexPair[] | null };
```
a blind type assertion over an external HTTP JSON response — nothing
validates at runtime that `pair.liquidity.usd` or `pair.volume.h24` are
actually finite, non-negative numbers. A corrupted/malformed upstream
response (e.g. a huge value that overflows to `Infinity` when JSON-
parsed, or a non-numeric string that TypeScript still believes is a
`number`) flows unchanged into `scoreMultiPool`'s arithmetic:

- `Math.min(1, NaN)` → `NaN` (from a NaN `tvlUsd` or `volumeUsd`)
- `Math.min(1, -Infinity)` → `-Infinity` (from a negative-Infinity input)
- `volumeUsd / tvlUsd` → `NaN` when both are `Infinity` (`Infinity/Infinity`)
- `NaN`/`Infinity`/`-Infinity` then propagate through the weighted sum
  (`tvlScore * weight + volumeScore * weight + ...`) into `totalScore`,
  which was previously returned completely unvalidated and pushed
  straight into the `scored`/`ranked` arrays consumed by
  `comparePoolCandidates`' sort.

One specific case bypassed the pre-existing `TVL_TOO_LOW` gate silently:
`tvlUsd = Infinity` satisfies `Infinity >= MIN_POOL_TVL_USD` (`true`), so
it was never rejected by that check, and `Math.min(1, Infinity/100_000)`
evaluates to a *finite* `1` — meaning corrupted "infinite TVL" data was
previously treated as the single best possible TVL score rather than
being recognized as invalid.

## 4. Invalid Numeric Sources

Traced every arithmetic operation in `scoreMultiPool` (§3 of the task):

| Expression | Vulnerable to |
|---|---|
| `tvlUsd / TVL_REFERENCE_USD` | `tvlUsd` = NaN → NaN; `tvlUsd` = Infinity → clamps to 1 (finite but semantically corrupt); `tvlUsd` = -Infinity → -Infinity |
| `volumeUsd / VOLUME_REFERENCE_USD` | same as above for `volumeUsd` |
| `volumeUsd / tvlUsd / VOLUME_TVL_RATIO_REFERENCE` | `Infinity / Infinity` → NaN; `tvlUsd` NaN already excluded by the pre-existing `tvlUsd > 0` guard evaluating to `false` for NaN, but `volumeUsd` NaN still propagates NaN through this division |
| `tvlScore*w1 + volumeScore*w2 + volumeTvlScore*w3 + feeScore*w4` | any NaN/Infinity component propagates into `totalScore`; `Infinity + (-Infinity)` → NaN |

`feeScoreFor(pool.fee)` uses only exact equality comparisons
(`fee === 50_000`), so it was already safe — a NaN/Infinity/garbage
`fee` simply falls through to `return 0`. Not modified.

## 5. Validation Added

Two layers, added directly in `scoreMultiPool` (`src/strategy/multiPool.ts`):

**Input validation** — a new `isValidMetric(value)` helper:
```ts
function isValidMetric(value: number | null): boolean {
  return value == null || (Number.isFinite(value) && value >= 0);
}
```
`null`/`undefined` (field genuinely absent) is unchanged, pre-existing,
protected behavior — see §10. Only a *present* value is classified
invalid if it is not `Number.isFinite` or is negative. Applied to the
two raw external-sourced inputs, `tvlUsd` and `volumeUsd` (`h24`), before
either enters any arithmetic. An invalid one is substituted with `null`
for the purposes of computing sub-scores (exactly the same as the
pre-existing "absent" path — 0 contribution, no division), while the
candidate is separately flagged via `rejectedReasons`.

**Output validation** — the final weighted sum is checked with
`Number.isFinite(rawTotalScore)` before being returned, as a second,
independent layer of defense (e.g. against a non-finite `MultiConfig`
weight from a source other than `tvlUsd`/`volumeUsd`).

`rejectedReasons: string[]` (a field that already existed on
`MultiPoolCandidate`, previously always hard-coded to `[]` and unused
anywhere else in the codebase — confirmed by grep) now carries specific
codes: `INVALID_TVL_INPUT`, `INVALID_VOLUME_INPUT`,
`INVALID_SCORE_RESULT`.

## 6. Division-by-Zero Handling

The only division whose denominator can be attacker/upstream-controlled
is `volumeUsd / tvlUsd` in `volumeTvlScore`. This was **already** guarded
by a pre-existing `tvlUsd > 0` condition (`0/0` and `x/0` were already
impossible here before this phase). Verified explicitly with tests:
`tvlUsd = 0` → `volumeTvlScore = 0` (guard short-circuits, no division
performed), never `NaN`/`Infinity`. This phase's new input validation is
what closes the *actual* gap: `tvlUsd = Infinity` still satisfies
`tvlUsd > 0`, so `volumeUsd / Infinity` could still produce `NaN` when
`volumeUsd` is also `Infinity` — now caught because `Infinity` is
rejected as an invalid raw `tvlUsd` before reaching this line at all.

## 7. Final Score Validation

`Number.isFinite(rawTotalScore)` is checked unconditionally before
`totalScore` is set. Verified by a dedicated test that manufactures a
non-finite result through a channel *other* than `tvlUsd`/`volumeUsd`
(a corrupted `poolTvlWeight: Infinity`) — confirms this is a real,
independent second layer, not just inference from the input checks.

## 8. Invalid Pool Handling

`discoverAndScorePoolsForCandidate` (the sole caller of `scoreMultiPool`)
now checks `candidateScore.rejectedReasons.length > 0` immediately after
scoring and, if so, pushes `{ poolAddress, reason }` onto the existing
`rejected` list (reusing the same shape as the pre-existing `NOT_USDG` /
`FEE_TIER_NOT_SUPPORTED` / `TVL_TOO_LOW` rejections) and `continue`s —
the invalid candidate is never pushed onto `scored`. No fallback score,
no `?? 0` substitution, no "first pool wins" behavior was introduced.
If every pool in a batch is invalid, `scored` stays empty, `ranked[0]`
is `undefined`, and `selected` is `null` — the pre-existing, unmodified
"no valid pool" contract.

## 9. Ranking Safety

Because invalid candidates are filtered out **before** `scored.push(...)`,
`comparePoolCandidates` (unmodified) now provably never receives a
candidate whose `totalScore`, `tvlUsd`, or `volumeUsd` is
NaN/Infinity/-Infinity — every value it compares is guaranteed finite by
construction. Verified with a dedicated test where an invalid pool
carries a raw `tvlUsd: Infinity` (a value that would dominate any naive
numeric comparator) alongside a valid, modest pool — the valid pool wins
every time.

## 10. Valid Score Compatibility

The scoring formula itself — coefficients, `TVL_REFERENCE_USD`,
`VOLUME_REFERENCE_USD`, `VOLUME_TVL_RATIO_REFERENCE`, `feeScoreFor`,
`PREFERRED_FEE_TIERS`, the weighted-sum structure — is **completely
unmodified**. A regression test pins the exact formula output for known
valid inputs (`tvlUsd=100_000, fee=50_000` → `totalScore = 0.45`,
matching `1*0.3 + 0*0.3 + 0*0.25 + 1.0*0.15`), byte-for-byte identical to
the pre-fix arithmetic.

One deliberate, explicitly-documented divergence from the generic
"undefined critical input → rejected" template (task §20 item 5/6): in
*this* codebase, an absent (`null`/`undefined`) `tvlUsd`/`volumeUsd` is
pre-existing, protected, valid-and-safe behavior (0 contribution to that
sub-score, never `NaN`) — proven by an already-passing test in
`test/strategy.multiPool.test.ts` ("missing volume/TVL data scores 0 for
that dimension rather than throwing or faking a value"). Rejecting
absent data outright would have **broken that pre-existing test** and
violated the task's own higher-priority instruction (§7, §4: "preserve
valid score exactly," "zero/absence is not automatically invalid").
Only a *present-but-corrupt* value is now rejected; absence remains
exactly as it always was. This distinction is documented inline in the
new test file and here for transparency.

## 11. Tie-Breaker Compatibility

`comparePoolCandidates`'s tie-break chain (score → tvl → volume →
address) is unmodified. Verified with a new test: two pools with
identical valid scores plus a third, corrupt (NaN-volume) pool mixed
into the same batch — the tie-break between the two valid pools resolves
identically to the pre-existing behavior (lexicographically-lower
address wins), completely undisturbed by the corrupt pool's presence or
exclusion order.

## 12. Tests Added

New file `test/strategy.multiPool.nanHardening.test.ts` — 22 tests,
covering all of task §20's required matrix (adapted per §10's documented
exception) plus additional cases: valid-formula regression pin, NaN/
Infinity/-Infinity/negative/malformed for both `tvlUsd` and `volumeUsd`,
zero-volume and zero-TVL validity (preserved, per §4), absent-field
validity (preserved, per §10), failure isolation, all-invalid fail-
closed, invalid-pool-cannot-rank-first, invalid-pool-cannot-reach-
execution, tie-break preservation, extreme finite values
(`Number.MAX_VALUE`/`MIN_VALUE`, accepted not clamped), always-finite-
for-accepted-pools, output-validation via a corrupted config weight, and
a property-style exhaustive-combination test (§21). The pre-existing
`test/strategy.multiPool.test.ts` (16 tests) was run alongside, unmodified,
and still passes in full.

## 13. Failure-Isolation Test

`'failure isolation: a NaN-volume pool is excluded; valid pools before/after it are unaffected'`:
three pools (valid, NaN-volume, valid) in one batch. Result: exactly 2
pools ranked, the corrupt one entirely absent from `pools`, the higher-
volume of the two valid pools selected, and the corrupt pool appears in
`rejected` with reason `INVALID_VOLUME_INPUT` — the whole discovery
operation does not crash or fail wholesale; only the corrupt pool is
excluded.

## 14. All-Invalid Test

`'all-invalid: every pool corrupt -> no selection, no fallback, no first-pool-by-default'`:
three pools, each corrupt via a different channel (`Infinity` TVL,
`-Infinity` TVL, NaN volume). Result: `pools.length === 0`,
`selected === null`, and all three appear in `rejected` — no invented
fallback pool, no pool "wins" by default. (One of the three is actually
caught earlier by the pre-existing `TVL_TOO_LOW` gate rather than a new
`INVALID_*` code — `-Infinity >= MIN_POOL_TVL_USD` is `false` — still
fully fail-closed, just via a different, pre-existing reason string;
documented in the test.)

## 15. Extreme-Value Test

`'extreme finite values (Number.MAX_VALUE / MIN_VALUE) are accepted, not rejected, and produce a finite score'`:
`tvlUsd = Number.MAX_VALUE`, `volumeUsd = Number.MIN_VALUE` — both are
legitimately finite per `Number.isFinite`, so neither is rejected;
`tvlScore` clamps to `1` via the pre-existing, unmodified
`Math.min(1, ...)`, and `totalScore` remains finite. No new clamping was
added — an unusual-but-finite value is not treated as invalid, per task
§13/§15's explicit warning against over-validation.

## 16. Fuzz / Property Test

`'property test: across the full input-value domain, an accepted pool always has a finite score'`:
a manual nested-loop combination (no new dependency) over
`[100_000, 0, -1, NaN, Infinity, -Infinity]` crossed for both `tvlUsd`
and `volumeUsd` (36 combinations). Invariant checked for every
combination: if `rejectedReasons` is empty, `totalScore` is finite; the
placeholder `totalScore` is finite even when rejected; and a raw input
failing `Number.isFinite(x) && x >= 0` always produces the matching
`INVALID_*` reason code.

## 17. Full Test Results

```
npm test
tests 390, pass 390, fail 0
```
(368 pre-existing baseline from Phase 4.5.2 through 4.6.6, all preserved
byte-for-byte, + 22 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

## 18. Typecheck

```
npm run typecheck
```
Clean.

## 19. Build

```
npm run build
```
Clean.

## 20. Trading Logic Audit

`git diff --stat` confirms `src/strategy/multiExecute.ts` (0 lines
changed this phase — already correctly handles `selected === null` via
its pre-existing `NO_VALID_POOL` rejection, requiring no modification).
No `sendTransaction`/`writeContract`/`mint`/`close`/`collect` call was
added or touched anywhere in this diff. `scoreMultiPool` and
`discoverAndScorePoolsForCandidate` remain pure/async-data functions with
no side effects beyond returning data — verified by inspection of the
full diff (§22).

## 21. Strategy Parameter Audit

Explicitly diffed and confirmed unchanged this phase: `PREFERRED_FEE_TIERS`
(`[50_000, 40_000, 30_000]`), `TVL_REFERENCE_USD` (100_000),
`VOLUME_REFERENCE_USD` (50_000), `VOLUME_TVL_RATIO_REFERENCE` (0.5),
`feeScoreFor`'s tier→score mapping, `MIN_POOL_TVL_USD` (imported,
untouched, in `chain/pools.ts`), `minMarketCapUsd`/`minTokenAgeHours`/
`topN`/`rangePercent`/`tpPercent`/`slPercent` (all live in
`multiConfig.ts`, a file this phase's diff never touches). None of these
values were read from, referenced by, or modified in the diff shown in
§22.

## 22. Diff Scope Audit

```
git diff --stat -- src/strategy/multiPool.ts
 src/strategy/multiPool.ts | 69 ++++++++++++++++++++++++++++++++++++++++-------
 1 file changed, 60 insertions(+), 9 deletions(-)
```
`test/strategy.multiPool.nanHardening.test.ts` is new/untracked. Full
diff reviewed line-by-line (§3–§9 above quote every changed line's
purpose): every change is a finite-check helper, its application to the
two raw inputs, an output-validation check on the final sum, population
of the pre-existing-but-previously-unused `rejectedReasons` field, and a
caller-side `continue` on non-empty `rejectedReasons`. No other file was
modified. `git status --short` before and after this phase shows the
exact same set of prior-phase (4.5.2 / 4.6 / 4.6.1 / 4.6.2 / 4.6.3 /
4.6.4 / 4.6.5 / 4.6.6) modified/untracked files, with zero additional
changes to any of them. No reset, stash, checkout, or revert was
performed.

## 23. Remaining P2/P3 Findings

Every other previously-identified finding remains intentionally
untouched by this phase:

- `STRATEGY` env var silent-default-on-unknown-value gap (flagged in
  Phase 4.6.6's report; lives in `src/strategy/multiConfig.ts`, MULTI-
  strategy-owned, out of scope for a configuration-validation-only or a
  scoring-only phase alike).
- The `RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry (Phase 4.6.6,
  cosmetic only, both fail closed).
- Memory management, retry architecture, global exception handling — not
  inspected or modified this phase.
- Instance lock, GMGN CLI, persistence implementation, TP/SL shutdown,
  health/readiness implementation, configuration validation, MULTI
  strategy parameters/candidate filtering/ranking/pool discovery beyond
  `scoreMultiPool` itself, range calculation, quote/price-impact/
  slippage/simulation/gas, transaction construction/recovery, accounting —
  confirmed untouched by this phase's diff (§22).
- Not a new finding, but worth noting for completeness: `dexscreener.ts`'s
  `fetchTokenPairs`/`fetchPairByAddress` still cast the raw HTTP JSON
  response with `as` with no runtime schema validation at the network
  boundary itself — this phase closes the specific, named consequence
  (`scoreMultiPool` NaN propagation) at the point the data is actually
  used for arithmetic, rather than validating the response shape at the
  fetch boundary, which would be a broader change touching a file this
  phase's ABSOLUTE SCOPE does not list as a target ("quote logic," "price
  calculations" are explicitly out of scope, and dexscreener.ts also
  backs those paths).

## 24. Verdict

**PASS**

No NaN/Infinity/-Infinity score can reach `comparePoolCandidates`,
`ranked[0]`, or `selected` — proven both by construction (invalid
candidates are filtered before entering `scored`) and by dedicated
tests, including one where the corrupt pool's raw values would dominate
any naive comparator. Invalid pool data fails closed: it is excluded
with a specific reason code, never scored as 0-and-accepted, never
becomes a fallback, and an all-invalid batch correctly yields
`selected === null` with no invented substitute. The scoring formula,
its coefficients, and valid-data ranking/tie-break behavior are provably
unchanged (regression-pinned test + all pre-existing tests still pass
unmodified). No execution-path code (`multiExecute.ts` or any
transaction-sending function) was touched. 390/390 tests pass, typecheck
and build are clean.
