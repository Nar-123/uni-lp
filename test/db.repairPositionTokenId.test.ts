/**
 * Phase 4.7.2 — repairPositionTokenIdByTxHash regression tests.
 *
 * Covers the exact recovery scenario needed for the real PONS canary
 * incident (predicted tokenId 1731172, actual on-chain tokenId 1731176),
 * plus the required adversarial scenarios: repeated recovery, already-
 * correct target, missing ledger row, pool/token-pair mismatch, duplicate
 * target metadata, and internally-inconsistent existing state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-repair-tokenid-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  recordOpenPosition,
  recordLedger,
  recordMultiPositionMeta,
  createTxJournalEntry,
  updateTxJournalEntry,
  setJournalAccountingMeta,
  getMultiPositionMeta,
  listOpenPositions,
  getLedgerEntries,
  repairPositionTokenIdByTxHash,
  __resetStoreForTests,
} = await import('../src/db/index.js');

const CHAIN = 4663;
const POOL = '0x2e7ba084e848fb5af806efaeccfc9676a1a4c459f696e852b53c1a4f650c39b6';
const TOKEN0 = '0x39dBED3a2bd333467115dE45665cC57F813C4571'; // PONS
const TOKEN1 = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; // USDG
const FEE = 30000;
const TICK_LOWER = -288000;
const TICK_UPPER = -280800;
const TX_HASH = '0xce5ffd45497a23ef4a52ae7bf5651fd8e619049f3209175f2b10c90ce66e80f7';

function resetDb(): void {
  __resetStoreForTests();
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Mirrors exactly what the real (buggy, pre-fix) mint flow recorded for the real canary. */
function seedCanaryRecords(wrongTokenId: string): number {
  recordOpenPosition({
    chainId: CHAIN,
    tokenId: wrongTokenId,
    poolAddress: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    protocol: 'v4',
    dex: 'uniswap',
    strategy: 'multi',
  });
  const journalId = createTxJournalEntry({ chainId: CHAIN, wallet: '0xF1a8C178E3deB0a0AE6bB9133c6101EDF8BB1237', nonce: 2, action: 'writeContract:modifyLiquidities' });
  updateTxJournalEntry(journalId, { state: 'SUBMITTED', tx_hash: TX_HASH });
  setJournalAccountingMeta(CHAIN, TX_HASH, [
    { kind: 'deposit', tokenId: wrongTokenId, tokenAddress: TOKEN1, amountRaw: '50000000', amountHuman: 50, usd: 50, strategy: 'multi' },
  ]);
  recordLedger({ chainId: CHAIN, tokenId: wrongTokenId, kind: 'deposit', tokenAddress: TOKEN1, amountRaw: '50000000', amountHuman: 50, usd: 50, txHash: TX_HASH, strategy: 'multi' });
  recordMultiPositionMeta({
    chainId: CHAIN,
    tokenId: wrongTokenId,
    candidateSource: 'gmgn_trending_6h',
    candidateInterval: '6h',
    candidateMarketCapUsd: 641240000,
    candidateAgeHours: 1256.47596,
    candidateVolume6hUsd: 40385100,
    candidateClassification: 'MEME',
    candidateScore: 1,
    poolAddress: POOL,
    poolFee: FEE,
    poolTvlUsd: 2631931.54934922,
    poolVolumeUsd: null,
    poolScore: 0.375,
    entryPrice: null,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    positionSizeUsd: 50,
    timestamp: Date.now(),
  });
  return journalId;
}

const expectedFields = { poolAddress: POOL, token0: TOKEN0, token1: TOKEN1, fee: FEE, tickLower: TICK_LOWER, tickUpper: TICK_UPPER };

// ── 1. The real incident: 1731172 → 1731176 ───────────────────────────────

test('1. repairs the real incident: 1731172 -> 1731176 across positions, ledger, metadata, and journal accounting_meta', () => {
  resetDb();
  seedCanaryRecords('1731172');

  const result = repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });
  assert.deepEqual(result, { status: 'REPAIRED', oldTokenId: '1731172', newTokenId: '1731176' });

  const positions = listOpenPositions(CHAIN);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.tokenId, '1731176');

  const ledgerRows = getLedgerEntries(CHAIN, '1731176', 'deposit');
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0]!.usd, 50, 'the deposit amount itself must be untouched by the repair');

  const oldLedgerRows = getLedgerEntries(CHAIN, '1731172', 'deposit');
  assert.equal(oldLedgerRows.length, 0, 'no row may remain under the old, wrong tokenId');

  const meta = getMultiPositionMeta(CHAIN, '1731176');
  assert.ok(meta);
  assert.equal(meta!.poolAddress, POOL, 'pool/range/candidate metadata must be preserved exactly, only tokenId changes');
  assert.equal(meta!.tickLower, TICK_LOWER);
  assert.equal(meta!.positionSizeUsd, 50);
  assert.equal(getMultiPositionMeta(CHAIN, '1731172'), undefined);
});

// ── 2. Repeated recovery — idempotent, no duplication ─────────────────────

test('2. repeated recovery after a successful repair is idempotent — reports ALREADY_CORRECT, writes nothing further', () => {
  resetDb();
  seedCanaryRecords('1731172');
  repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });

  const second = repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });
  assert.deepEqual(second, { status: 'ALREADY_CORRECT' });

  assert.equal(listOpenPositions(CHAIN).length, 1, 'no duplicate position row was created');
  assert.equal(getLedgerEntries(CHAIN, '1731176', 'deposit').length, 1, 'no duplicate ledger row was created');
});

// ── 3. Already-correct target from the start ──────────────────────────────

test('3. calling with a correctTokenId that already matches the stored value is a safe no-op', () => {
  resetDb();
  seedCanaryRecords('1731176'); // seeded already-correct this time
  const result = repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });
  assert.deepEqual(result, { status: 'ALREADY_CORRECT' });
});

// ── 4. Missing ledger entry for this tx hash ──────────────────────────────

test('4. no ledger entry exists at all for the given tx hash: fails closed, no position record to corrupt', () => {
  resetDb();
  const result = repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: '0xdoes-not-exist', correctTokenId: '1731176' });
  assert.deepEqual(result, { status: 'NO_LEDGER_ENTRY_FOR_TX_HASH' });
});

// ── 6. Wrong pool recorded — refuse rather than repair the wrong thing ────

test('6. stored pool does not match the expected pool: refuses (MISMATCH), writes nothing', () => {
  resetDb();
  seedCanaryRecords('1731172');
  const result = repairPositionTokenIdByTxHash({
    chainId: CHAIN,
    txHash: TX_HASH,
    correctTokenId: '1731176',
    expected: { ...expectedFields, poolAddress: '0x000000000000000000000000000000000000dead' },
  });
  assert.equal(result.status, 'MISMATCH');
  assert.equal(listOpenPositions(CHAIN)[0]!.tokenId, '1731172', 'unchanged — nothing was written');
});

// ── 7. Wrong token pair recorded ───────────────────────────────────────────

test('7. stored token0/token1 does not match the expected pair: refuses (MISMATCH), writes nothing', () => {
  resetDb();
  seedCanaryRecords('1731172');
  const result = repairPositionTokenIdByTxHash({
    chainId: CHAIN,
    txHash: TX_HASH,
    correctTokenId: '1731176',
    expected: { ...expectedFields, token0: '0x000000000000000000000000000000000000dead' },
  });
  assert.equal(result.status, 'MISMATCH');
  assert.equal(getLedgerEntries(CHAIN, '1731172', 'deposit').length, 1, 'unchanged — nothing was written');
});

// ── 9. Duplicate metadata — target tokenId already exists as a distinct row ──

test('9. the target tokenId already exists as a distinct position/metadata row: refuses (TARGET_TOKEN_ID_ALREADY_EXISTS)', () => {
  resetDb();
  seedCanaryRecords('1731172');
  // Simulate 1731176 already being a real, separate, unrelated tracked position.
  recordOpenPosition({ chainId: CHAIN, tokenId: '1731176', poolAddress: '0xother', token0: '0xaaa', token1: '0xbbb', fee: 500, tickLower: 0, tickUpper: 100, protocol: 'v4', dex: 'uniswap' });

  const result = repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });
  assert.deepEqual(result, { status: 'TARGET_TOKEN_ID_ALREADY_EXISTS' });
  assert.equal(listOpenPositions(CHAIN).find((p) => p.tokenId === '1731172')?.tokenId, '1731172', 'original wrong record untouched — refused rather than overwritten');
});

// ── 10. Corrupt/inconsistent existing state ───────────────────────────────

test('10. ledger rows for the same tx hash disagree on the existing tokenId: refuses (INCONSISTENT_EXISTING_TOKEN_ID)', () => {
  resetDb();
  seedCanaryRecords('1731172');
  // Manually corrupt: add a second ledger row for the same tx hash under a DIFFERENT wrong tokenId.
  recordLedger({ chainId: CHAIN, tokenId: '9999999', kind: 'fee_claim', tokenAddress: TOKEN1, usd: 1, txHash: TX_HASH, strategy: 'multi' });

  const result = repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });
  assert.deepEqual(result, { status: 'INCONSISTENT_EXISTING_TOKEN_ID' });
});

// ── Deposit amount/timestamp/candidate metadata preserved exactly ────────

test('the repair never touches deposit amount, pool, range, fee, or candidate metadata — only the tokenId fields', () => {
  resetDb();
  seedCanaryRecords('1731172');
  const before = getMultiPositionMeta(CHAIN, '1731172')!;
  repairPositionTokenIdByTxHash({ chainId: CHAIN, txHash: TX_HASH, correctTokenId: '1731176', expected: expectedFields });
  const after = getMultiPositionMeta(CHAIN, '1731176')!;
  assert.equal(after.candidateMarketCapUsd, before.candidateMarketCapUsd);
  assert.equal(after.candidateScore, before.candidateScore);
  assert.equal(after.poolScore, before.poolScore);
  assert.equal(after.timestamp, before.timestamp);
  assert.equal(after.positionSizeUsd, before.positionSizeUsd);
});
