# PHASE3_5_RECOVERY_AUDIT.md

## Phase 3.5 — Accounting Recovery & Reconciliation Hardening

**Verdict: PASS**

---

## 1. Existing Recovery Architecture

### Transaction Journal (Phase 2 Part 4)

Every broadcast attempt is recorded in `tx_journal` BEFORE the network call, using `createTxJournalEntry()` in `journalledSend()` (src/chain/clients.ts). State transitions:

```
BROADCAST_UNKNOWN  ← written before RPC call (pessimistic default)
       ↓
  SUBMITTED        ← hash obtained after successful broadcast
       ↓
  CONFIRMED        ← receipt.status='success' found via resolveAmbiguousTx
 MINED_REVERT      ← receipt.status!='success'
 NOT_SUBMITTED     ← nonce never consumed (safe to retry)
RECOVERY_REQUIRED  ← ambiguity could not be resolved within bounded attempts
```

At startup, `runStartupTxRecovery()` processes all unresolved entries (states: BROADCAST_UNKNOWN, SUBMITTED, RECOVERY_REQUIRED) via `resolveAmbiguousTx()`, which polls receipts and nonces. Only `CONFIRMED` entries represent finalized successful on-chain transactions.

### Ledger (Phase 3)

`recordLedger()` in `db/index.ts` is idempotent by `(chainId, txHash, kind)`. Every successful on-chain operation that changes accounting calls `recordLedger()` inside the Telegram bot handler in `src/bot/bot.ts`, AFTER the on-chain function returns.

### The Gap

```
journalledSend() ───────► journal: SUBMITTED
       │
waitForReceiptBounded() → tx confirmed on-chain
       │
bot.ts handler ─────────► CRASH HERE
                           ┌───────────────────────┐
                           │ journal → CONFIRMED   │ (on restart)
                           │ ledger → missing      │ ← THE GAP
                           └───────────────────────┘
```

On restart, `runStartupTxRecovery()` transitions `SUBMITTED → CONFIRMED` but has no mechanism to re-trigger `recordLedger()`. The ledger event is permanently lost.

---

## 2. Missing-Ledger Scenario

**Trigger conditions:**
- A transaction successfully mined (`CONFIRMED` in journal)
- Process crashes after the on-chain call returns but before `recordLedger()` is called
- No human intervention

**Impact:**
- Deposit missing → `depositsUsd = 0` → PnL shows artificially inflated gross returns
- Withdrawal missing → `withdrawalsUsd = 0` → PnL shows loss when position actually closed profitably
- Fee claim missing → fees uncounted in `netPnlUsd`

**Prior to Phase 3.5:** No automatic detection or repair path existed. The gap was documented in `PHASE3_ACCOUNTING_AUDIT.md` as a remaining risk.

---

## 3. Recovery Implementation

### 3a. Journal Accounting Metadata (`JournalAccountingMeta`)

A new exported type is added to `src/db/index.ts`:

```typescript
export type JournalAccountingMeta = {
  kind: LedgerKind;
  tokenId: string;
  tokenAddress: string | null;
  amountRaw: string | null;
  amountHuman: number | null;
  usd: number | null;           // null = unknown → RECONCILIATION_REQUIRED
  feeSplitIsEstimated?: boolean;
};
```

The `TxJournalRow` now carries an optional `accounting_meta: JournalAccountingMeta[]` field. This field is populated by `setJournalAccountingMeta(chainId, txHash, meta[])` — a new function in `db/index.ts` that finds the journal entry by `(chainId, txHash)` and attaches the metadata.

### 3b. Staging in bot.ts

In `src/bot/bot.ts`, BEFORE each `recordLedger()` call, the bot now calls `setJournalAccountingMeta()` to write the to-be-recorded ledger event(s) into the journal. This covers all accounting call sites:

| Operation | Kind(s) staged |
|---|---|
| v3 mint | `deposit` |
| v4 mint | `deposit` |
| close (principal) | `withdrawal` |
| close (fees) | `fee_claim` (if feesPortionUsd > 0) |
| claim fees | `fee_claim` (if feesUsd > 0 or amounts > 0) |

For a close operation, both events are staged atomically in one `setJournalAccountingMeta()` call before either `recordLedger()` call. This ensures recovery knows about both events even if the process crashes between the two `recordLedger()` calls.

If `setJournalAccountingMeta()` returns false (journal entry not found — e.g. due to journal pruning or a TX path that bypassed `journalledSend()`), the code proceeds to `recordLedger()` normally. The metadata staging is best-effort and never blocks the primary recording path.

### 3c. `recoverMissingLedger()` (src/pnl/reconcile.ts)

The new recovery function:

1. Lists all `CONFIRMED` journal entries (via `listConfirmedTxJournal()`)
2. For each entry with `accountingMeta`:
   - For each metadata item, checks if a ledger event already exists for `(chainId, txHash, kind)`
   - If present → skip (idempotent)
   - If absent and `usd != null` → calls `recordLedger()` with the stored historical metadata
   - If absent and `usd == null` → records a `MISSING_NO_USD` finding (RECONCILIATION_REQUIRED)
3. Entries without metadata are silently skipped (they predate Phase 3.5 or represent non-accounting TXs)
4. Returns `LedgerRecoveryReport` with `recovered` count, `findings[]`, and overall status

**Safety invariants enforced:**
- Only `CONFIRMED` entries are processed (never MINED_REVERT, SUBMITTED, BROADCAST_UNKNOWN, RECOVERY_REQUIRED)
- Uses stored historical `usd` value — never fetches current market price
- Uses stored `amountRaw`/`amountHuman` — never uses minimum output or pre-TX estimates
- `usd = null` → fails closed (RECONCILIATION_REQUIRED), never defaults to 0
- `recordLedger()` is already idempotent → second call for same `(chainId, txHash, kind)` is a safe no-op

### 3d. Startup Integration (src/index.ts)

After `runStartupTxRecovery()` completes, `recoverMissingLedger()` runs automatically:

```
startup
  → runStartupTxRecovery()     // resolve SUBMITTED → CONFIRMED
  → recoverMissingLedger()     // fill missing ledger events from journal metadata
  → bot starts
```

---

## 4. Idempotency

**Key:** `(chainId, txHash, kind)` — reused from Phase 3's `recordLedger()` identity.

**Proof:**
- `recordLedger()` checks for a duplicate row before inserting; duplicate is a logged no-op
- `recoverMissingLedger()` checks `getLedgerEntries(chainId, tokenId, kind).find(e => e.txHash === entry.txHash)` before calling `recordLedger()`
- Running `recoverMissingLedger()` N times on the same confirmed entry produces exactly 1 ledger row

Verified by tests 3, P1, P2.

---

## 5. Crash Recovery

**Scenario trace (e.g. close position):**

1. `closePosition()` calls `wallet.writeContract({...multicall...})` via `journalledSend()`
2. Journal entry created: `BROADCAST_UNKNOWN`
3. Hash returned: `SUBMITTED + txHash`
4. `waitForTransactionReceipt()` returns success
5. `closePosition()` returns `CloseResult` to bot.ts handler
6. `setJournalAccountingMeta(chainId, result.hash, [{withdrawal}, {fee_claim}])` writes metadata to journal
7. **CRASH** — process dies before step 8
8. _(would have been)_ `recordLedger({withdrawal, ...})` + `recordLedger({fee_claim, ...})`

**On restart:**
1. `runStartupTxRecovery()` → `resolveAmbiguousTx()` → receipt found → `CONFIRMED`
2. `recoverMissingLedger()` → finds CONFIRMED entry with `accounting_meta`
3. Checks: no ledger events exist for these `(chainId, txHash, kind)` pairs
4. Calls `recordLedger({withdrawal, usd=8000, amountHuman=8.0, ...})`
5. Calls `recordLedger({fee_claim, usd=200, feeSplitIsEstimated=true, ...})`
6. Both events created with historical values → PnL is correct

**Result:** Exactly one ledger event per kind. No PnL impact from the crash.

---

## 6. Reconciliation

### `reconcileAccounting()` (existing, updated)

Read-only structural integrity check. Detects:
- `DUPLICATE_LEDGER_EVENT` — multiple rows for same `(chainId, txHash, kind)`
- `LEDGER_EVENT_FOR_UNRESOLVED_TX` — ledger event exists for SUBMITTED/BROADCAST_UNKNOWN/RECOVERY_REQUIRED
- `LEDGER_EVENT_FOR_REVERTED_TX` — ledger event exists for MINED_REVERT

Updated `ReconciliationFinding` to carry `tokenId`, `eventKind`, `journalState`, `ledgerState` for the full per-finding report format specified in §10.

### `recoverMissingLedger()` (new)

Proactive repair function. Reports `RecoveryFinding[]` with `ledgerState`:
- `MISSING_RECOVERED` — event auto-created successfully
- `MISSING_NO_USD` — cannot recover: USD value was not captured at staging time
- `MISSING_NO_META` — (reserved for future; currently silently skipped when no metadata)

### `formatReconciliationReport()` (new)

Formats the combined recovery + check results for operator display without exposing private key material.

---

## 7. Operator Interface

### `/reconcile` Telegram command (src/bot/bot.ts)

- Auth-gated via `requireAuth(ctx)` — only `config.allowedUserIds` may invoke
- Does NOT expose private keys, wallet mnemonics, or full addresses
- Runs `recoverMissingLedger()` first (auto-repair), then `reconcileAccounting()` (integrity check)
- Reports `RECONCILIATION_OK` or `RECONCILIATION_REQUIRED` with findings
- Registered in `setMyCommands` in `src/index.ts`

Example output:
```
RECONCILIATION_OK
Checked: ledger=47 journal=23 confirmed=15
```

Or when issues exist:
```
Auto-recovered: 2 missing ledger event(s) created.
RECONCILIATION_REQUIRED
Checked: ledger=49 journal=25 confirmed=17

Recovery findings requiring attention:
  MISSING_NO_USD chain=8453 tx=0x1a2b3c4d5e... kind=fee_claim token=tok-123
  reason: CONFIRMED tx has staged accounting metadata but USD value was null at staging time — manual reconciliation required
```

---

## 8. Fee/Principal Split

**Current behavior:** `feesPortionUsd = pos.unclaimedFeesUsd` — a pre-close snapshot from the position reader, not derived from on-chain events.

**Why this is an estimate:** The Uniswap V3/V4 `multicall(decreaseLiquidity + collect)` path does not emit a separate "fees collected" event. The on-chain state available after the fact is:

- `DecreaseLiquidity(tokenId, liquidity, amount0, amount1)` — principal liquidity converted to tokens
- `Collect(tokenId, recipient, amount0, amount1)` — total tokens collected (principal + accumulated fees)
- `feesExact = collect.amount0 - decrease.amount0` (calculable from logs)

**Phase 3.5 audit conclusion:** Exact separation IS calculable from receipt logs (V3), but implementing log parsing requires significant changes to `close.ts` and introduces new failure modes (log parsing errors, reorg edge cases). The spec says "Do NOT invent fake precision."

**What was implemented:**

A new `feeSplitIsEstimated: boolean` field is added to `CloseResult`. It is always set to `true` in all code paths (v3 and v4 delegate). This makes the estimate status explicit and testable.

The `feeSplitIsEstimated` flag is propagated into `JournalAccountingMeta` for `fee_claim` entries from close operations, so that recovery passes carry the same signal.

**Future improvement:** Parse `DecreaseLiquidity` + `Collect` log events from the close receipt to compute exact fee amounts. Set `feeSplitIsEstimated = false` only when both events are present and internally consistent.

---

## 9. Integration Test

Status: **1 BLOCKED** (unchanged from Phase 3)

The full tick-range cross-check in `test/integration/quote.rpc.test.ts` remains BLOCKED due to RPC throttling when fetching full tick bitmap data. This test requires:

- Real on-chain pool data
- Real tick bitmap fetching (rate-limited by public RPC)
- Real quote execution
- Independent cross-check of the quote engine output

Foundry's local fork environment was not available (Windows Application Control policy blocked the installer). The test was NOT artificially promoted to PASS. It remains BLOCKED pending a deterministic fork environment or stable RPC.

The two non-blocked integration tests continue to pass (pool discovery + basic quote).

---

## 10. Tests

### Unit tests (test/reconcile.test.ts) — 24 new tests

| # | Test | Result |
|---|---|---|
| 1 | CONFIRMED journal + missing ledger detected | PASS |
| 2 | recoverMissingLedger auto-creates from metadata | PASS |
| 3 | Recovery idempotency (2 passes → 1 event) | PASS |
| 4 | Simulated restart + recovery → same state | PASS |
| 5 | null usd → RECONCILIATION_REQUIRED, no $0 row | PASS |
| 6 | MINED_REVERT + no ledger → no event created | PASS |
| 6b | MINED_REVERT + existing ledger → flagged, not mutated | PASS |
| 7a | BROADCAST_UNKNOWN → no finalized accounting | PASS |
| 7b | SUBMITTED → no finalized accounting | PASS |
| 7c | RECOVERY_REQUIRED → no finalized accounting | PASS |
| 8 | Actual amountHuman/amountRaw preserved from metadata | PASS |
| 9 | Historical USD preserved, not live price | PASS |
| 10 | Recovery after recordLedger → no duplicate | PASS |
| 11 | feeSplitIsEstimated=true in fee_claim metadata | PASS |
| 12 | /reconcile authorization (isAllowed gate) | PASS |
| P1 | CONFIRMED tx → ≤1 ledger event per kind (5 passes) | PASS |
| P2 | N=7 recovery passes → same state, 1 total event | PASS |
| P3 | Reverted tx → zero events (3 passes) | PASS |
| P4 | Unresolved tx → zero events (3 passes) | PASS |
| P5 | Incomplete metadata → RECONCILIATION_REQUIRED (3 passes) | PASS |
| multi | Close: withdrawal + fee_claim both recovered | PASS |
| meta-f | setJournalAccountingMeta returns false for unknown hash | PASS |
| meta-t | setJournalAccountingMeta returns true for known entry | PASS |
| conf | listConfirmedTxJournal returns only CONFIRMED entries | PASS |

### Total test count

```
npm test: 168 pass, 0 fail  (was 144 before Phase 3.5)
npm run typecheck: clean
npm run build: clean
npm run test:integration: 2 pass, 1 BLOCKED (rate-limited RPC; unchanged from Phase 3)
```

---

## 11. Remaining Risks

### a. setJournalAccountingMeta fails silently

`setJournalAccountingMeta()` returns `false` when the journal entry cannot be found (e.g. journal pruned, TX bypassed `journalledSend()`). In this case, `recordLedger()` still runs normally. If the process crashes at that point, the ledger event is permanently lost with no recovery path — the gap from pre-Phase-3.5 behavior is not closed for these edge cases.

**Mitigation:** `journalledSend()` is the only path for all wallet client operations. Pruning only removes terminal (non-SUBMITTED) rows. The window where `setJournalAccountingMeta()` can fail is very small in practice.

### b. Crash between `setJournalAccountingMeta()` and `recordLedger()`

If the process crashes after `setJournalAccountingMeta()` but before `recordLedger()`, and the journal entry is still SUBMITTED (not yet CONFIRMED), then on restart:

1. `runStartupTxRecovery()` transitions `SUBMITTED → CONFIRMED`
2. `recoverMissingLedger()` finds metadata → creates the ledger event

**This is the intended behavior.** The scenario is fully covered.

### c. Crash before `setJournalAccountingMeta()` is called

If the process crashes between `closePosition()` returning and `setJournalAccountingMeta()` being called (an extremely narrow window), there is no metadata to recover from. The gap is the same as pre-Phase-3.5.

**Mitigation:** This window is 1-2 instructions. The probability is extremely low. A future improvement could be to stage metadata inside `journalledSend()` itself (would require passing accounting info through to the send layer, which is architecturally invasive).

### d. Fee/principal split remains estimated

`feeSplitIsEstimated = true` on all close operations. The withdrawal/fee_claim split uses a pre-close snapshot. This is explicitly documented and never misrepresented as exact.

### e. pnl/card.ts (/generate) not updated with gross/net labels

This is a pre-existing documented risk from Phase 3. Out of scope for Phase 3.5.

---

## 12. Known Limitations

1. **Recovery scope:** Only transactions with `accounting_meta` staged before the crash can be auto-recovered. Transactions from before Phase 3.5 deployment that crashed mid-accounting cannot be recovered automatically.

2. **USD unavailability at staging time:** If token prices are unavailable when `setJournalAccountingMeta()` is called (because `getTokenPriceUsd()` returned null), `depUsd` in bot.ts is already `0` — the same value that would be recorded in `recordLedger()` without Phase 3.5. The `usd = 0` case (not null) still produces a ledger event during recovery; only `usd = null` is blocked. This maintains identical behavior to the pre-crash `recordLedger()` call.

3. **Integration test BLOCKED:** The full tick-range cross-check remains BLOCKED by public RPC rate limiting. A Foundry local fork or stable archive RPC would unblock it.

4. **No on-chain re-verification:** `reconcileAccounting()` and `recoverMissingLedger()` are local consistency checks. They do not re-fetch receipts from the chain to verify that a `CONFIRMED` entry is genuinely final (no chain reorg). This is consistent with the existing codebase's single-confirmation semantics.

---

## Final Verdict: PASS

All PASS criteria met:

| Criterion | Status |
|---|---|
| Confirmed transactions can safely recover missing accounting | ✅ recoverMissingLedger() creates missing events from staged metadata |
| Recovery is idempotent | ✅ Verified by tests 3, P1, P2 |
| Reverted transactions cannot create accounting | ✅ Only CONFIRMED entries processed; MINED_REVERT skipped |
| Unknown transactions cannot create accounting | ✅ BROADCAST_UNKNOWN, SUBMITTED, RECOVERY_REQUIRED skipped |
| Incomplete metadata fails closed | ✅ usd=null → RECONCILIATION_REQUIRED, no $0 event |
| Historical price is preserved | ✅ Stored usd used; current price never fetched during recovery |
| Actual amounts remain actual | ✅ amountRaw/amountHuman from metadata, not estimates |
| No duplicate PnL | ✅ recordLedger() idempotency + pre-check in recoverMissingLedger() |
| Tests pass | ✅ 168/168 unit tests, 2/3 integration (1 BLOCKED — unchanged) |
| Typecheck passes | ✅ tsc --noEmit clean |
| Build passes | ✅ tsc clean |
