# PHASE 4.6.11 DEXSCREENER JSON BOUNDARY VALIDATION REPORT

## 1. Original Finding

`src/price/dexscreener.ts` cast raw external HTTP JSON with a bare
TypeScript `as`, which performs zero runtime validation — flagged as a
remaining P2/P3 finding since Phase 4.6.7 and reaffirmed in 4.6.8/4.6.9/
4.6.10's reports.

## 2. Current DexScreener Data Flow

```
fetch(dexscreener API URL)
   ↓ HTTP status check (if (!res.ok) throw/return null) — unchanged
   ↓ res.json() → `any`
   ↓ [BEFORE THIS PHASE] blind `as { pairs?: DexPair[] | null }` cast
   ↓ [AFTER THIS PHASE]  parseDexScreenerTokensResponse(raw: unknown) / parseDexScreenerPairResponse(raw: unknown)
   ↓ validated DexPair[] / DexPair | null
   ↓ pairDexId / isV3Pair / priceUsdFromPair / scorePairForToken (unchanged)
   ↓ getTokenPriceUsd's cache write (setPriceCacheBounded, Phase 4.6.9, unchanged)
   ↓ caller (chain/pools.ts, strategy/multiPool.ts, getCriticalTokenPriceUsd, etc.)
```
Two entry points parse external JSON: `fetchTokenPairs` (the
`/latest/dex/tokens/:address` endpoint) and `fetchPairByAddress` (the
`/latest/dex/pairs/:chain/:address` endpoint).

## 3. Existing `as` Cast

```ts
// fetchTokenPairs
const data = (await res.json()) as { pairs?: DexPair[] | null };
return data.pairs ?? [];

// fetchPairByAddress
const data = (await res.json()) as { pair?: DexPair | null; pairs?: DexPair[] | null };
if (data.pair && data.pair.pairAddress) return data.pair;
if (data.pairs?.length) return data.pairs[0]!;
```
Both trusted the shape completely — `data.pair`/each element of
`data.pairs` was assumed to already be a well-formed `DexPair`, with no
check that `baseToken`/`quoteToken`/`priceUsd`/etc. were even the right
JavaScript type, let alone valid domain values.

## 4. Root Cause

Traced two concrete, non-theoretical consequences of the missing
validation (not merely "TypeScript doesn't check this" in the abstract):

1. **Crash**: `pairDexId`'s `(pair.dexId ?? '').toLowerCase()` throws if
   `dexId` is present but not a string (e.g. a number); `isV3Pair`'s
   `(p.labels ?? []).map(...)` throws if `labels` is present but not an
   array; any bare `pair.xxx` access throws if an element of `pairs` is
   `null`.
2. **Fabricated price** (the more serious class): `priceUsdFromPair`
   calls `Number(pair.priceUsd)` unconditionally. `Number(x)` performs
   surprising coercions on non-string, non-nullish values —
   `Number([5]) === 5`, `Number(true) === 1`, `Number([]) === 0` — so a
   malformed `priceUsd` field that happened to be an array, boolean, or
   similar would silently pass the existing `Number.isFinite(baseUsd) &&
   baseUsd > 0` check and produce a real, plausible-looking, entirely
   fabricated price with **no error at all**. This was the sharpest gap:
   not a crash, but a wrong number silently accepted as correct.

## 5. External Fields Consumed

| Field | Runtime type | Required/Optional | Validation rule |
|---|---|---|---|
| `pairs` (top-level) | array | Optional (absent/null = "no pairs", valid) | If present, must be `Array.isArray` — else the whole response is rejected (thrown) |
| `pair` (top-level, pairs-by-address endpoint only) | object | Optional | If present, validated as a full pair; falls through to `pairs` if invalid |
| `chainId` | string | Non-optional per type, but existing code tolerates absence (`?.`) | If present, must be `string`; wrong type → downgrades to `''` (never matches any chain filter, never crashes `.toLowerCase()`) |
| `dexId` | string | Same as `chainId` | Same treatment |
| `pairAddress` | string | **Required** — identity field, unguarded elsewhere | Must be a non-empty `string`; otherwise the whole pair is dropped |
| `labels` | string[] | Optional | If present, must be `Array.isArray` of all-`string` elements; wrong type → downgrades to `undefined` |
| `baseToken` / `quoteToken` | `{address, symbol, name}` | **Required** — `chain/pools.ts` reads `.address`/`.symbol` unguarded (no `?.`) | Must be a plain object with `address` (string, and a valid EVM address per viem's `isAddress`), `symbol` (string), `name` (string) — any failure drops the whole pair |
| `priceUsd` | string | Optional | Must be `typeof === 'string'`; any other type (including array/boolean, the fabrication vector) → downgrades to `undefined`, never `Number()`-coerced |
| `priceNative` | string | Optional | Same treatment as `priceUsd` |
| `liquidity.usd`/`.base`/`.quote` | number | Optional | Each independently must be `typeof === 'number' && Number.isFinite` — else that sub-field is `undefined` |
| `volume.h24` | number | Optional (not read in this file; flows to `strategy/multiPool.ts`) | Same finite-number-or-absent rule, as defense in depth |
| `feeTier` | number \| string | Optional, not read in this file | Passed through if `number` or `string`, else `undefined` |
| `url` | string | Optional, not read in this file | Passed through if `string`, else `undefined` |

## 6. Runtime Validation Boundary

Two exported entry points convert `unknown` → validated internal data:
`parseDexScreenerTokensResponse(raw: unknown): DexPair[]` and
`parseDexScreenerPairResponse(raw: unknown): DexPair | null`, backed by
internal helpers `parseDexPair`, `parseTokenRef`, `parseLiquidity`,
`parseVolume`, and generic `isPlainObject`/`isFiniteNumber` type guards.
`fetchTokenPairs` and `fetchPairByAddress` now call these immediately
after `res.json()` — no code between the parse and the JSON call, and no
`as` cast anywhere in either function.

## 7. Top-Level Validation

`parseDexScreenerTokensResponse`: the top-level value itself must be a
plain object (`isPlainObject`) — a non-object response (`null`, a
string, a number, an array) throws `Invalid DexScreener response:
expected a JSON object`. `parsePairsArray` then handles the `pairs`
field: absent/`null`/`undefined` is the pre-existing, unchanged "no
pairs found" case (`[]`, not an error); present-but-non-array throws
`"pairs" is present but not an array`. `parseDexScreenerPairResponse`
uses the same top-level object check but returns `null` rather than
throwing (matching `fetchPairByAddress`'s existing `try { ... } catch {
return null; }` wrapper, so either behavior converges to the same
outcome there).

## 8. Pair Validation

Per-pair, per §16/§17 of the task: the existing architecture already
treats each `DexPair` as an independently-triable candidate (every
caller sorts/filters/loops through the array, trying the next one when
one yields no usable price) — so a single malformed pair is **excluded**
from the array rather than failing the whole response, exactly mirroring
how a pair that merely lacked an optional field was already tolerated.
Verified by test: `null`, a string, a number, a boolean, and an array
appearing as elements of `pairs` are all silently dropped; other valid
pairs in the same array are unaffected and preserve their original
relative order.

## 9. Token Validation

`baseToken`/`quoteToken` are treated as **identity-critical**, not
merely optional decoration: `chain/pools.ts` (a file this phase does not
touch) reads `pair.baseToken.address`/`.symbol` in multiple places
**without** optional chaining — a malformed token-ref there would crash
that other file, not just this one. `parseTokenRef` therefore requires a
plain object with `address` (a valid EVM address string — see §10),
`symbol` (string), and `name` (string); any failure drops the **entire
pair**, not just the token-ref field. This is the one case where a
non-identity-looking field (symbol/name) still causes a full pair drop,
justified by that external unguarded-read exposure.

## 10. Address Validation

Reused viem's `isAddress()` — the exact same validator already
established as this codebase's convention in Phase 4.6.6
(`src/config.ts`'s `assertValidOptionalAddress`) — rather than inventing
a new address format check. Applied to `baseToken.address` and
`quoteToken.address` only; **not** applied to `pairAddress`, which can
legitimately be either a 20-byte v3 pool address or a 32-byte v4 poolId
(per this file's own existing comment in `isV3Pair`) — `isAddress()`
would incorrectly reject the latter, so `pairAddress` is validated only
as "a non-empty string," matching the existing code's own tolerance
(`isV3Pair` only checks `.length`, never requires the strict 20-byte
format). No new address normalization was introduced — a malformed
address is dropped, never coerced/corrected.

## 11. Numeric Validation

`liquidity.usd`/`.base`/`.quote` and `volume.h24` are validated with
`typeof v === 'number' && Number.isFinite(v)` — never a coercing
`Number(v)` call. A numeric-looking **string** (e.g. `"1000"`) is
correctly rejected here (downgrades to `undefined`) because the actual
DexScreener JSON contract for these fields is a real JSON number, not a
string (unlike `priceUsd`/`priceNative`, which the existing code and
type already treat as strings — see §12). This matches the task's own
instruction: "Do NOT blindly change... unless the existing code already
expects/uses that behavior" — `priceUsd` is string-typed by existing
convention (and parsed via `Number()` downstream, unchanged), while
`liquidity`/`volume` are number-typed by existing convention (never
parsed via `Number()` anywhere) — each field keeps its own existing
contract, not a uniform new rule.

## 12. Price Validation

`priceUsd`/`priceNative` must be `typeof === 'string'` to be accepted at
all — matching the `DexPair` type's own declaration (`priceUsd?:
string`) and the existing downstream `Number(pair.priceUsd)` call
pattern, which is **unchanged**: the validator does not parse or
evaluate the numeric value itself (that remains `priceUsdFromPair`'s
job, untouched), it only ensures a non-string value (array, boolean,
object, number) can never reach that `Number()` call and be silently
coerced into a fabricated number. Whether `priceUsd = "0"` or a negative
numeric string is semantically valid is unchanged — `priceUsdFromPair`'s
own `!Number.isFinite(baseUsd) || baseUsd <= 0` check (untouched) already
correctly rejects zero and negative values; this phase does not alter
that threshold or introduce a new one.

## 13. Chain Validation

Confirmed from actual usage (not documentation): DexScreener's `chainId`
field is consumed in this codebase exclusively as a **string** slug
(e.g. compared via `p.chainId?.toLowerCase() !== slug` against
`CHAINS[chainId].dexscreenerSlug`), never as the app's own numeric
`SupportedChainId`. `chainId` is not identity-critical to a pair's
usability (a pair with a missing/malformed `chainId` simply never
matches any chain filter, which is already a safe outcome under the
existing `?.`-guarded comparisons) — a wrong-typed value downgrades to
`''` rather than dropping the whole pair, which also prevents the
`.toLowerCase()` crash that a non-string value would otherwise cause. No
supported chain or chain ID was added, removed, or changed.

## 14. Empty Response Behavior

`{}` and `{"pairs":[]}` both continue to resolve to `[]` — the existing,
unchanged "no pairs found" outcome, never an error and never a
fabricated result. Verified by test.

## 15. Partial Response Behavior

A pair missing `priceUsd` (but otherwise well-formed) is preserved as a
valid `DexPair` with `priceUsd: undefined` — exactly the pre-existing
behavior, since `priceUsd` was already optional and `priceUsdFromPair`
already handles its absence safely. A pair missing `pairAddress`,
`baseToken`, or `quoteToken` is dropped entirely (§9). Verified by
dedicated tests for each required field.

## 16. Mixed Valid/Invalid Pair Behavior

Verified directly by test: a batch of `[good1, null, "garbage", {broken},
good2]` yields exactly `[good1, good2]`, in their original relative
order — the malformed entries are excluded, not merely ignored-in-place
(which would have left gaps), and the two valid pairs are byte-identical
to what they would have been without any invalid siblings.

## 17. Cache Interaction

Not modified — `MAX_PRICE_CACHE_SIZE`, `prunePriceCache`, and
`setPriceCacheBounded` (Phase 4.6.9) are untouched, confirmed by diff
(§27). Verified directly by test: a malformed response fed through the
real `fetchTokenPairs`/`getTokenPriceUsd` path writes **zero** cache
entries — `getTokenPriceUsd`'s cache-write calls
(`setPriceCacheBounded(key, ...)`) only ever execute after a price has
already been successfully extracted; a validation failure (thrown before
that point) or a validated-but-empty pairs array (which yields no
`priceUsdFromPair` match) never reaches a cache-write call at all. A
separate test confirms an unrelated, pre-existing valid cache entry is
completely unaffected by a validation failure elsewhere (the parser
functions have no cache interaction whatsoever — they are pure functions
over their `raw` input).

## 18. Price Freshness Interaction

Not modified — `CACHE_MS` (60s), `isPriceStale`, `MAX_CRITICAL_PRICE_AGE_MS`,
and `getCriticalTokenPriceUsd`'s stale-price-forces-refresh logic are
completely untouched, confirmed by diff (§27; the `MAX_CRITICAL_PRICE_AGE_MS`
block appearing in the diff is pre-existing Phase 4.6.6 work, not
modified this turn). The full `test/priceFreshness.test.ts` suite passes
unmodified, confirming stale-price rejection and TP/SL's
unknown-price-never-triggers contract are unaffected.

## 19. Error Handling

`parsePairsArray`/`parseDexScreenerTokensResponse` throw a plain `Error`
with a message identifying the specific validation category (e.g.
`"pairs" is present but not an array"`, `"expected a JSON object"`) —
never the entire raw response, never a payload dump, and containing no
secrets (these functions only ever see the DexScreener response body,
which never contains this application's credentials). This is consistent
with the pre-existing error convention already used for the HTTP-status
check (`DexScreener error ${res.status}`) two lines above.

One deliberate, scope-respecting design point, disclosed rather than
hidden: `getTokenPriceUsd` (and its callers, e.g. `fetchV3PoolsForToken`,
`valueUsd`) do **not** wrap their call to `fetchTokenPairs` in a
try/catch — this was already true before this phase for the HTTP-error
throw case, and remains true for the newly-added malformed-shape throw
case. This phase does not add error handling to those callers, because
doing so would be "retry architecture / global exception handling"
territory, explicitly out of this phase's ABSOLUTE SCOPE. A malformed
top-level shape therefore surfaces as a rejected Promise, exactly the
same class of outcome as an existing HTTP failure — a real, but
pre-existing, characteristic of this codebase, not a regression
introduced here.

## 20. Real API Validation

Network access was confirmed available in this environment. A live
request to `https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
(WETH on Ethereum) returned HTTP 200 with 30 real pairs. The new
`parseDexScreenerTokensResponse` was run directly against this real
response in a test (`'real API: a live DexScreener response for a
well-known token validates and yields a plausible price'`): all pairs
passed validation, `pairAddress`/`baseToken.address`/`quoteToken.address`
are real strings, and every present `priceUsd` parses to a positive
finite number — confirming the stricter boundary accepts genuine
production DexScreener responses without rejecting legitimate fields.
The test is written to gracefully `t.skip(...)` (not fail) if network is
unavailable in a different environment, rather than hard-failing the
suite on an environment-dependent condition.

## 21. Security / Adversarial Tests

Covered: `Object.create(null)`-based objects (accepted if structurally
correct — `typeof`-based checks don't care about the prototype chain,
matching the task's explicit "do not over-engineer" guidance since real
`JSON.parse` output never produces one anyway); a boxed `new
String(...)` (rejected — `typeof` on a boxed primitive is `'object'`,
not `'string'`); arrays masquerading as pair/token objects (rejected via
`isPlainObject`'s explicit `!Array.isArray` check); `NaN`/`Infinity`/
`-Infinity` injected into `liquidity`/`volume` fields via
programmatically-constructed test objects (all rejected, downgrade to
`undefined` — JSON itself cannot literally encode these, but a mocked/
malicious response object in a test can, and the validator is proven
robust against it, complementing Phase 4.6.7's separate NaN/Infinity
hardening of `strategy/multiPool.ts`'s own scoring math).

## 22. Test Results

```
npx tsx --test test/dexscreener.boundary.test.ts test/priceCache.growth.test.ts \
  test/priceFreshness.test.ts test/strategy.multiPool.test.ts \
  test/strategy.multiPool.nanHardening.test.ts test/config.validation.test.ts
tests 117, pass 117, fail 0

npx tsx --test test/strategy.multiExecute.test.ts test/strategy.multiPool.test.ts \
  test/strategy.multiPool.nanHardening.test.ts test/strategy.multiRisk.test.ts \
  test/strategy.multiRange.test.ts
tests 66, pass 66, fail 0

npm test
tests 458, pass 458, fail 0
```
(426 pre-existing baseline from Phase 4.5.2 through 4.6.10, all preserved
byte-for-byte, + 32 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

One test-authoring note, disclosed rather than hidden: the first version
of the cache-non-poisoning test expected `getTokenPriceUsd` to resolve to
`null` for a malformed top-level response, but it actually rejects
(propagates the thrown validation error) — because `getTokenPriceUsd`
has never wrapped its own `fetchTokenPairs` call in a try/catch, exactly
the same as the pre-existing HTTP-error case (§19). This was a
test-assumption bug, not a production one — fixed by asserting the
rejection directly (`assert.rejects`) and then verifying the cache
invariant afterward, which is the property the test actually needed to
prove.

## 23. Typecheck

```
npm run typecheck
```
Clean.

## 24. Build

```
npm run build
```
Clean.

## 25. Trading Logic Audit

No pricing formula, quote calculation, price-impact/slippage/minOut
computation, MULTI candidate filtering/ranking/pool scoring, range
calculation, single-sided liquidity logic, simulation, gas estimation,
execution, TP/SL logic, or accounting formula was modified.
`priceUsdFromPair`, `scorePairForToken`, `isV3Pair`, `pairDexId`,
`getTokenPriceUsd`'s stable-peg/dexscreener/fallback branches, and
`getCriticalTokenPriceUsd`'s staleness logic are **byte-for-byte
unchanged** — confirmed by the diff (§27) touching only the two `as`-cast
call sites (replaced with a parser call) and adding new, purely-additive
parsing functions above them. The full MULTI test suite (66 tests) and
`priceFreshness.test.ts` (unmodified) both pass.

## 26. Strategy Parameter Audit

No file under `src/strategy/*` appears in this phase's diff. No MULTI
parameter, threshold, weight, or fee tier was read, referenced, or
modified.

## 27. Diff Scope Audit

```
git diff --stat -- src/price/dexscreener.ts
 src/price/dexscreener.ts | 263 insertions(+), 17 deletions(-)
```
(The file's prior cumulative diff already included Phase 4.6.6's
`resolveMaxCriticalPriceAgeMs` and Phase 4.6.9's `MAX_PRICE_CACHE_SIZE`/
cache-bounding/test-export blocks — confirmed by inspection that none of
those lines were touched this turn; this phase's own edits are exactly:
the `isAddress` import, the new validation-boundary block after the
`DexPair` type definition, and the two `as`-cast → parser-call swaps in
`fetchTokenPairs`/`fetchPairByAddress`.) `test/dexscreener.boundary.test.ts`
is new/untracked. No other file was modified. `git status --short`
before and after this phase shows the exact same set of prior-phase
(4.5.2 through 4.6.10) modified/untracked files, with zero additional
changes to any of them. No reset, stash, checkout, or revert was
performed.

## 28. Remaining P2/P3 Findings

- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **Retry architecture** — not inspected this phase (explicitly out of
  scope).
- **Global exception handling** — not inspected this phase (explicitly
  out of scope); specifically, `getTokenPriceUsd`/`fetchV3PoolsForToken`/
  `valueUsd` still do not wrap their `fetchTokenPairs` call in a
  try/catch, so a malformed top-level response (or an HTTP failure, a
  pre-existing case) surfaces as a rejected Promise rather than a
  graceful `null` — noted in §19 as a deliberate, scope-respecting
  decision, not a new issue.
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** (Phase 4.6.8) — unbounded by design, accounting-critical,
  not touched.
- No new findings were discovered in this phase beyond the one it was
  scoped to fix. The **DexScreener unvalidated `as`-cast JSON boundary
  finding itself is now fixed** and is not carried forward as a
  remaining finding.

## 29. Files Changed

- [src/price/dexscreener.ts](src/price/dexscreener.ts) — added the runtime validation boundary; replaced both `as`-cast sites (263 insertions, 17 deletions)
- [test/dexscreener.boundary.test.ts](test/dexscreener.boundary.test.ts) — new, 32 focused regression tests including one real-network test
- [PHASE4_6_11_DEXSCREENER_BOUNDARY_FIX_REPORT.md](PHASE4_6_11_DEXSCREENER_BOUNDARY_FIX_REPORT.md) — this report

## 30. Verdict

**PASS**

Every field this codebase actually consumes from DexScreener's JSON
response — `pairs`/`pair` shape, `pairAddress`, `baseToken`/`quoteToken`
(and their `address`/`symbol`/`name`), `chainId`, `dexId`, `labels`,
`priceUsd`, `priceNative`, `liquidity.*`, `volume.h24` — is now checked
for its actual runtime type before entering any existing price/quote
logic, closing both the crash risk and the concrete price-fabrication
vector (`Number([5]) === 5`, `Number(true) === 1`). Malformed data fails
closed: a structurally broken pair is dropped (never fabricated), a
fundamentally malformed top-level response is rejected outright, and a
real, well-shaped production response continues to validate and produce
a correct price (proven against a live API call, not just synthetic
fixtures). The price cache cannot be poisoned by a validation failure,
and freshness/TTL semantics are provably unchanged. No trading logic or
MULTI parameter was touched. 458/458 tests pass, typecheck and build are
clean.
