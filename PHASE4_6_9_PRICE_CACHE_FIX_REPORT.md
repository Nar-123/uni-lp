# PHASE 4.6.9 PRICE CACHE HARDENING REPORT

## 1. Original P3 Finding

`src/price/dexscreener.ts`'s `priceCache` can accumulate an unbounded
number of unique keys over a long-running process — flagged as a
remaining finding in the Phase 4.6.8 memory-growth report, deliberately
deferred there because `dexscreener.ts` was excluded from that phase's
scope.

## 2. Current priceCache Architecture

```ts
type PriceCacheEntry = { usd: number; at: number; source: string };
const priceCache = new Map<string, PriceCacheEntry>();
const CACHE_MS = 60_000;

function cacheKey(chainId: SupportedChainId, token: string): string {
  return `${chainId}:${token.toLowerCase()}`;
}
```

- **Key**: `` `${chainId}:${token.toLowerCase()}` `` — chain ID
  participates directly, and the token address is lower-cased before
  keying.
- **Value**: `{ usd, at, source }` — price, cache-write timestamp, and a
  human-readable provenance string (`'stable-peg'`, `'dexscreener'`,
  `'dexscreener-eth-mainnet-fallback'`).
- **Insertion path**: 6 call sites inside `getTokenPriceUsd` — 3 for
  stable-pegged tokens (USDG/USDT/USDC, always `usd: 1`), 1 for a normal
  DexScreener-derived price, 1 for the wrapped-native-via-stable-pair
  fallback, 1 for the wrapped-native-via-Ethereum-mainnet-WETH last
  resort.
- **Lookup path**: `getTokenPriceUsd`'s very first check —
  `const hit = priceCache.get(key); if (hit && Date.now() - hit.at < CACHE_MS) return hit.usd;`
  — and `getCriticalTokenPriceUsd`'s metadata read (`priceCache.get(key)`)
  after calling `getTokenPriceUsd`.
- **Expiration**: lazy, read-side only, via the check above — a stale
  entry is never returned as a hit, it simply falls through to a fresh
  fetch.
- **Overwrite**: every cache-miss write is a plain `.set(key, ...)` —
  writing an existing key updates its value but (per the `Map` spec)
  does not change its position in iteration order.
- **Cleanup (pre-fix)**: none, except one narrow special case —
  `getCriticalTokenPriceUsd` explicitly `priceCache.delete(key)`s an
  entry it has just determined is stale, purely to force one bypass-cache
  refetch; the key is immediately repopulated by the `getTokenPriceUsd`
  call that follows, so this never reduced the map's steady-state size.
- **Maximum possible keys (pre-fix)**: none — bounded only by the
  lifetime count of distinct `(chainId, token)` pairs ever priced by the
  process.
- **Chain participation**: yes, chain ID is the first key segment —
  verified no cross-chain collision is possible (§9).

## 3. Root Cause

Every cache-miss write path (`setPriceCacheBounded`'s 6 call sites, listed
above) called `priceCache.set(key, ...)` directly with no corresponding
removal path. MULTI's candidate discovery prices a different meme token
on almost every scan cycle, and the manual bot's mint/swap/bridge flows
price arbitrary user-supplied tokens — so the key set grows with
lifetime-distinct-tokens-ever-priced, not with anything currently
relevant to trading. A key whose 60s freshness window lapsed and was
never looked up again simply stayed in the `Map` forever.

## 4. Existing Cache Semantics (preserved exactly)

- TTL: `CACHE_MS = 60_000` (60s) — **unchanged**.
- Staleness checked lazily, only on read — **unchanged**.
- Reads do **not** refresh/extend an entry's `at` timestamp — **unchanged**
  (confirmed: the hit-path `return hit.usd;` never touches `hit.at`).
- Writes do refresh `at` (a fresh fetch always re-stamps `Date.now()`) —
  **unchanged**.
- A cache miss always performs a real network fetch
  (`fetchTokenPairs`/`fetchPairByAddress` → DexScreener HTTP API) —
  **unchanged**.
- Prior to this phase, no entry was ever actively deleted for being
  stale (only the one narrow `getCriticalTokenPriceUsd` bypass case,
  which nets to zero size change). **This is what changed** (§5).
- The cache is a single module-level `Map` shared globally across all
  chains and all callers — **unchanged**; multiple chains already
  populate it side-by-side, disambiguated by the chain-ID key prefix.

## 5. Chosen Bounding Mechanism

**Mechanism C: TTL-based eviction + a hard maximum size**, mirroring the
prune-on-write idiom already established and proven correct in Phase
4.6.8 for `strategy/multiRisk.ts`'s `cooldownMap` and
`chain/tokens.ts`'s `supplyCache`:

```ts
function prunePriceCache(): void {
  const cutoff = Date.now() - CACHE_MS;
  for (const [key, entry] of priceCache) {
    if (entry.at < cutoff) priceCache.delete(key);
  }
}

function setPriceCacheBounded(key: string, entry: PriceCacheEntry): void {
  prunePriceCache();
  if (!priceCache.has(key) && priceCache.size >= MAX_PRICE_CACHE_SIZE) {
    const oldestKey = priceCache.keys().next().value;
    if (oldestKey !== undefined) priceCache.delete(oldestKey);
  }
  priceCache.set(key, entry);
}
```

TTL-based pruning alone was not sufficient to satisfy the task's own
required invariant ("cache.size <= MAX_CACHE_SIZE at all times after
insertion") — a burst of more unique tokens than the size cap, all
priced within the same 60-second window, would not have any expired
entries for TTL pruning to remove. The hard size cap (FIFO via `Map`
insertion-order iteration, the same technique as `chain/tokens.ts`'s
`metaCache`) exists purely as a backstop for that burst case. In normal
operation the TTL prune alone keeps the map small; the size cap is a
deterministic ceiling that is never crossed even under a pathological
spike.

## 6. Maximum Cache Size

`MAX_PRICE_CACHE_SIZE = 1000` — a clearly documented constant. Chosen
conservatively relative to realistic usage: MULTI's GMGN fetch limit is
`Math.min(100, max(topN*5, 50))` (≤100 candidates per scan), manual
`/screener` and mint/swap flows price a handful of tokens per user
action, and there are only 3 supported chains — a realistic peak working
set within any single 60s window is on the order of tens to a few
hundred entries. 1000 comfortably exceeds that (matching the order of
magnitude used for `chain/tokens.ts`'s `metaCache` bound of 500 in
Phase 4.6.8) without being "effectively unlimited."

## 7. Eviction Policy

Deterministic FIFO by `Map` insertion order — identical technique to
`chain/tokens.ts`'s `metaCache` (Phase 4.6.8). No randomness. Re-writing
an already-present key (`priceCache.has(key)` true) never triggers
eviction and never consumes a new slot, since a `Map.set` on an existing
key does not change its insertion position — verified by test (§11).

## 8. TTL Behavior

Completely unchanged. `CACHE_MS` was neither shortened nor extended.
The read-side freshness check (`Date.now() - hit.at < CACHE_MS`) was not
touched. `prunePriceCache`'s cutoff uses the exact same `CACHE_MS`
constant, so pruning only ever removes entries the read-side check would
already treat as a miss — pruning is a pure memory-hygiene operation
layered on top of unchanged freshness semantics, never a substitute for
or a relaxation of them.

## 9. Chain-Key Safety

`cacheKey(chainId, token)` was not modified. Verified by test
(`'chain-key safety: identical token address on two different chains
never collides'`): the same token address on Robinhood Chain (4663),
BSC (56), and Base (8453) produces three independent entries, none of
which can evict or overwrite another. No collision bug was found, so
none was fixed — consistent with the task's explicit instruction not to
redesign the key absent a real, demonstrated collision.

## 10. Price Freshness Compatibility

No behavioral change for any cache hit that would have been valid under
the pre-existing semantics: `getTokenPriceUsd`'s freshness check is
untouched, and `prunePriceCache` only ever removes entries that check
would already refuse to serve as a hit. `getCriticalTokenPriceUsd`'s
stale-price-forces-refresh logic (its own `priceCache.delete(key)` call)
is untouched — verified present and unmodified in the diff (§22). No
stale price can become newly-acceptable, and no valid fresh price is
newly rejected.

## 11. Same-Key Behavior

`'same-key test: repeated writes to the same token never create
duplicate entries'` — 500 writes to the identical `(chainId, token)` key
leave `priceCache.size === 1`. `'re-caching an already-cached key does
not consume a FIFO slot / trigger eviction of others'` — filling the
cache to its exact bound, then re-writing the oldest key, proves neither
that key nor any other is evicted as a side effect of the update.

## 12. Stress Test

`'stress test: a single burst of 5,000 unique FRESH tokens (all within
one TTL window) stays bounded at MAX_PRICE_CACHE_SIZE'` — 5,000 writes,
all with `at: now` (none expired, so TTL pruning cannot remove any of
them), leaves `priceCache.size === 1000` exactly, proving the hard size
cap is what bounds this case, not TTL. `'eviction is deterministic FIFO:
the oldest-inserted key is dropped first, never a newer one'` fills the
cache to exactly its bound and verifies the very first key is evicted
while the second-oldest and newest both survive. No real network call
was used — all entries are inserted via the test-only
`__setPriceCacheEntryForTests` accessor, which calls the same
`setPriceCacheBounded` production function directly.

## 13. Long-Run Simulation

`'long-run simulation: 10,000 distinct expired tokens are pruned away,
not retained forever'` — 10,000 inserts, all already expired at
insertion time, followed by an explicit prune call, leaves
`priceCache.size === 0`. No timer was added (§21 — none was needed), no
listener was added, no persistent file was touched (this cache is
entirely in-memory, never written to `db/index.ts`'s JSON store), and no
network request was made by the test.

## 14. Failure-Path Behavior

Not modified, and verified still correct by the full,
unmodified-and-passing `test/priceFreshness.test.ts` suite (run
alongside this phase's new tests, §19): a fetch exception is caught by
`getCriticalTokenPriceUsd`'s own `try/catch` and resolves to `ok:false`,
never populating the cache with a bad value; `getTokenPriceUsd` itself
only ever calls `setPriceCacheBounded` with values that already passed
an explicit finiteness/positivity check
(`Number.isFinite(baseUsd) && baseUsd > 0`, and the WETH/WBNB sanity
bounds) — this validation logic was not touched. The new
`setPriceCacheBounded`/`prunePriceCache` functions cannot introduce
`NaN`/`Infinity`/`null`/a fake zero price themselves — they only move
already-validated entries around a `Map`; they perform no arithmetic on
`usd` at all.

## 15. Concurrency Review

`priceCache` was, and remains, populated by ordinary sequential
`async`/`await` code with no explicit locking — multiple concurrent
`getTokenPriceUsd` calls for the same key can still race to write the
same key twice in an interleaved fashion, exactly as before this phase.
This phase does not introduce a new concurrency architecture, and does
not need to: a race between two writers of the *same* key at worst
results in one of the two fresh values winning (both are valid live
prices, and the loser is simply the very slightly older of two prices
fetched moments apart — pre-existing behavior, unrelated to bounding).
Pruning and eviction do not introduce any new race: `prunePriceCache`
and the FIFO-eviction check both run synchronously (no `await` inside
either), so a single `setPriceCacheBounded` call cannot be interleaved
with another JavaScript-thread operation on the same `Map`, ruling out a
torn/corrupted `Map` state.

## 16. Performance Impact

No RPC, DexScreener, GMGN, or any other network/database call was added.
`prunePriceCache` and the FIFO-eviction check are synchronous, local
`Map` operations bounded by the map's own (now-capped) size — since
`priceCache.size` can never exceed `MAX_PRICE_CACHE_SIZE` (1000) after
any insertion completes, every prune scan is O(≤1000), a small bounded
constant, not an unbounded scan. Both new functions piggyback on writes
that already happen (a cache-miss write already implies a real network
fetch just completed) — no new call site or new trigger was introduced.

## 17. Trading Logic Audit

No trading logic was modified. `src/price/dexscreener.ts` contains price
lookup only — no candidate filtering/ranking, pool scoring/selection,
range calculation, single-sided liquidity logic, price-impact/slippage/
minOut computation, simulation, gas estimation, execution, TP/SL
decision logic, or accounting formula lives in this file, and none of it
was touched (confirmed by the diff in §22 touching only cache-bounding
code, the test-only exports, and the pre-existing-and-unmodified Phase
4.6.6 `MAX_CRITICAL_PRICE_AGE_MS` block that predates this phase).
`test/priceFreshness.test.ts`'s full suite (TP/SL unknown-price
protection, stale-price rejection, PnL historical-vs-live valuation
separation) passes unmodified, confirming no downstream consumer's
behavior changed.

## 18. Strategy Parameter Audit

No file under `src/strategy/*` appears in this phase's diff. No MULTI
parameter (market-cap threshold, token-age threshold, volume threshold,
Top N, fee tiers, TVL/volume/fee scoring weights, range percentage) was
read, referenced, or modified.

## 19. Test Results

```
npx tsx --test test/priceCache.growth.test.ts test/priceFreshness.test.ts
tests 20, pass 20, fail 0

npm test
tests 411, pass 411, fail 0
```
(401 pre-existing baseline from Phase 4.5.2 through 4.6.8, all preserved
byte-for-byte, + 10 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

One test-authoring note, disclosed rather than hidden: the first version
of the "entry exactly at the TTL boundary" test used an `at` timestamp
of precisely `now - CACHE_MS`, which is racy against `Date.now()`'s
millisecond resolution (the prune-side cutoff and the test's own `now`
capture can land on the identical millisecond, making the `<` comparison
ambiguous at that exact boundary). This was a test-precision bug, not a
production one — fixed by using a value comfortably past the boundary
(`CACHE_MS + 1000`ms old), which is what "expired" actually means in
practice; the production `prunePriceCache`/read-side check were not
changed.

## 20. Typecheck

```
npm run typecheck
```
Clean.

## 21. Build

```
npm run build
```
Clean.

## 22. Diff Scope Audit

```
git diff --stat -- src/price/dexscreener.ts
 src/price/dexscreener.ts | 93 ++++++++++++++++++++++++++++++++++++++++++------
 1 file changed, 83 insertions(+), 10 deletions(-)
```
`test/priceCache.growth.test.ts` is new/untracked. The diff contains:
(1) the new `MAX_PRICE_CACHE_SIZE`/`prunePriceCache`/`setPriceCacheBounded`
block, (2) 6 call-site swaps from raw `priceCache.set(...)` to
`setPriceCacheBounded(...)`, (3) 4 new test-only export functions at the
bottom of the file, and (4) the pre-existing, unmodified-this-phase
Phase 4.6.6 `resolveMaxCriticalPriceAgeMs`/`MAX_CRITICAL_PRICE_AGE_MS`
block, which appears in the diff only because `git diff` compares
against the original base commit and shows the file's full cumulative
uncommitted state — confirmed by inspection that no line inside that
block was touched this turn. No other file was modified. `git status
--short` before and after this phase shows the exact same set of
prior-phase (4.5.2 through 4.6.8) modified/untracked files, with zero
additional changes to any of them. No reset, stash, checkout, or revert
was performed.

## 23. Remaining P2/P3 Findings

- **`STRATEGY` env var silent-default-on-unknown-value gap** (Phase
  4.6.6) — still out of scope, lives in `strategy/multiConfig.ts`.
- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **DexScreener unvalidated `as`-cast JSON boundary** (flagged in Phase
  4.6.7, reaffirmed in 4.6.8) — `fetchTokenPairs`/`fetchPairByAddress`
  still cast the raw HTTP response with `as { pairs?: DexPair[] | null }`
  with no runtime schema validation. Still not fixed this phase — this
  phase's ABSOLUTE SCOPE was explicitly cache-bounding only ("Do NOT
  modify: price calculation... price source"), and this validation gap
  is a distinct concern from cache growth.
- **Retry architecture** — not inspected this phase (explicitly out of
  scope).
- **Global exception handling** — not inspected this phase (explicitly
  out of scope).
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** (Phase 4.6.8) — unbounded by design, accounting-critical,
  not touched.
- No new findings were discovered in this phase beyond the one it was
  scoped to fix.

## 24. Files Changed

- [src/price/dexscreener.ts](src/price/dexscreener.ts) — bounded `priceCache` (83 insertions, 10 deletions)
- [test/priceCache.growth.test.ts](test/priceCache.growth.test.ts) — new, 10 focused regression tests
- [PHASE4_6_9_PRICE_CACHE_FIX_REPORT.md](PHASE4_6_9_PRICE_CACHE_FIX_REPORT.md) — this report

## 25. Verdict

**PASS**

`priceCache` is now demonstrably bounded: TTL-based pruning (unchanged
60s freshness window) removes expired entries on every write, and a
1000-entry FIFO cap guarantees `priceCache.size` can never exceed that
bound even under a same-window burst of thousands of unique tokens —
proven by direct `Map.size`/`Map.has` assertions, not RSS measurement.
A cache hit that is still valid under the pre-existing semantics returns
the identical value (no numeric transformation is possible — the new
code never touches `usd`, only `Map` key/entry lifecycle). TTL/freshness
semantics, the stale-price-forces-refresh path, chain-key safety, and
the existing fail-closed price-validation logic are all unmodified and
verified still passing via the full `priceFreshness.test.ts` suite. No
trading logic or MULTI parameter was touched. 411/411 tests pass,
typecheck and build are clean.
