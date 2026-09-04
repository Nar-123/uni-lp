/**
 * Phase 4.7.2 — v4 mint tokenId extraction fix.
 *
 * Root cause (src/chain/v4.ts, before this fix): mintV4SingleSided derived
 * the minted tokenId by reading the position manager's *shared, global*
 * `nextTokenId()` counter BEFORE broadcasting, then assumed the mint would
 * receive exactly that value. A verification step (`ownerOf(nextIdBefore)`)
 * existed, but its "mismatch" branch was dead code — it detected the
 * mismatch correctly, then just reassigned the SAME wrong value again,
 * rather than falling back to the (already-implemented, but only reachable
 * when `ownerOf` reverts) Transfer-log-scanning logic.
 *
 * This is not theoretical: a real $50 canary mint
 * (0xce5ffd45497a23ef4a52ae7bf5651fd8e619049f3209175f2b10c90ce66e80f7,
 * wallet 0xF1a8C178E3deB0a0AE6bB9133c6101EDF8BB1237) predicted tokenId
 * 1731172, but the transaction's own Transfer event proved the real
 * minted tokenId was 1731176 — four other mints landed on the same shared
 * PositionManager between the counter read and this transaction's
 * confirmation. `ownerOf(1731172)` succeeded (it's a real, pre-existing
 * NFT owned by someone else) rather than reverting, so the dead-code
 * mismatch branch fired instead of the Transfer-log fallback.
 *
 * The fix (`extractMintedTokenId`) removes the counter-based guess
 * entirely and derives the tokenId exclusively from decoding this
 * transaction's own ERC-721 Transfer event (from=0x0, to=recipient,
 * emitted by the position manager itself) — failing closed (throwing
 * `MintTokenIdExtractionError`) rather than fabricating or falling back to
 * any counter-based guess when that event cannot be found unambiguously.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256, toHex, pad } from 'viem';
import { extractMintedTokenId, MintTokenIdExtractionError } from '../src/chain/v4.js';

const POSM = '0x58daec3116aae6d93017baaea7749052e8a04fa7' as `0x${string}`;
const RECIPIENT = '0xF1a8C178E3deB0a0AE6bB9133c6101EDF8BB1237' as `0x${string}`;
const OTHER_ADDRESS = '0x929336C20682221f87b282E5626572a761A5f494' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const UNRELATED_CONTRACT = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as `0x${string}`;

// Real ERC-721/ERC-20 Transfer(address,address,uint256) topic0 — the exact
// value observed in the real canary transaction's receipt logs.
const TRANSFER_TOPIC0 = keccak256(toHex('Transfer(address,address,uint256)'));

function addrTopic(addr: string): `0x${string}` {
  return pad(addr as `0x${string}`, { size: 32 }).toLowerCase() as `0x${string}`;
}
function tokenIdTopic(id: bigint): `0x${string}` {
  return pad(toHex(id), { size: 32 });
}

function transferLog(params: { address: string; from: string; to: string; tokenId: bigint }) {
  return {
    address: params.address,
    data: '0x' as `0x${string}`,
    topics: [TRANSFER_TOPIC0, addrTopic(params.from), addrTopic(params.to), tokenIdTopic(params.tokenId)],
  };
}

// ── G. Successful normal mint (single, unambiguous Transfer) ─────────────

test('normal mint: exactly one mint Transfer (from=0x0, to=recipient) — returns its tokenId', () => {
  const receipt = { logs: [transferLog({ address: POSM, from: ZERO, to: RECIPIENT, tokenId: 42n })] };
  assert.equal(extractMintedTokenId(receipt, POSM, RECIPIENT), 42n);
});

// ── THE REAL INCIDENT: counter-predicted 1731172, actual minted 1731176 ──

test('race regression: the actual Transfer event (1731176) is used, never the counter-predicted value (1731172)', () => {
  // No 1731172 appears anywhere in this receipt at all — this proves the
  // function cannot possibly reproduce the old bug's output, since it
  // never reads any counter, only decodes what is actually in the logs.
  const receipt = { logs: [transferLog({ address: POSM, from: ZERO, to: RECIPIENT, tokenId: 1731176n })] };
  const result = extractMintedTokenId(receipt, POSM, RECIPIENT);
  assert.equal(result, 1731176n);
  assert.notEqual(result, 1731172n);
});

// ── A. Missing Transfer event ─────────────────────────────────────────────

test('A. no logs at all: fails closed with MintTokenIdExtractionError', () => {
  const receipt = { logs: [] };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

test('A. logs present but none are Transfer events from the position manager: fails closed', () => {
  const receipt = {
    logs: [
      { address: POSM, data: '0x1234' as `0x${string}`, topics: [keccak256(toHex('SomeOtherEvent()'))] },
    ],
  };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

// ── B. Transfer from wrong address (not a mint) ───────────────────────────

test('B. a Transfer with from != zero address (a real transfer, not a mint) is ignored — fails closed if it is the only log', () => {
  const receipt = { logs: [transferLog({ address: POSM, from: OTHER_ADDRESS, to: RECIPIENT, tokenId: 99n })] };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

// ── C. Transfer to wrong wallet ────────────────────────────────────────────

test('C. a mint Transfer to a different recipient is ignored — fails closed if it is the only log', () => {
  const receipt = { logs: [transferLog({ address: POSM, from: ZERO, to: OTHER_ADDRESS, tokenId: 99n })] };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

// ── D. Transfer emitted by the wrong contract ─────────────────────────────

test('D. a matching Transfer emitted by a different contract (not the position manager) is ignored', () => {
  const receipt = { logs: [transferLog({ address: UNRELATED_CONTRACT, from: ZERO, to: RECIPIENT, tokenId: 99n })] };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

// ── E. Multiple matching Transfer events — ambiguous, must fail closed ───

test('E. two distinct matching mint-Transfer-to-recipient events: ambiguous, fails closed rather than arbitrarily picking one', () => {
  const receipt = {
    logs: [
      transferLog({ address: POSM, from: ZERO, to: RECIPIENT, tokenId: 1n }),
      transferLog({ address: POSM, from: ZERO, to: RECIPIENT, tokenId: 2n }),
    ],
  };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

// ── F. Malformed tokenId / malformed log structure ────────────────────────

test('F. a log with too few topics to decode as Transfer is skipped, not treated as a crash or a match', () => {
  const receipt = {
    logs: [
      { address: POSM, data: '0x' as `0x${string}`, topics: [TRANSFER_TOPIC0, addrTopic(ZERO)] }, // missing to/tokenId topics
    ],
  };
  assert.throws(() => extractMintedTokenId(receipt, POSM, RECIPIENT), MintTokenIdExtractionError);
});

// ── H. Receipt success with unexpected event structure alongside a real match ──

test('H. unrelated/malformed logs alongside the one real match do not prevent correct extraction', () => {
  const receipt = {
    logs: [
      { address: POSM, data: '0xdeadbeef' as `0x${string}`, topics: [keccak256(toHex('Unrelated(uint256)'))] },
      { address: UNRELATED_CONTRACT, data: '0x' as `0x${string}`, topics: [TRANSFER_TOPIC0, addrTopic(RECIPIENT), addrTopic(OTHER_ADDRESS), tokenIdTopic(7n)] },
      transferLog({ address: POSM, from: ZERO, to: RECIPIENT, tokenId: 1731176n }),
    ],
  };
  assert.equal(extractMintedTokenId(receipt, POSM, RECIPIENT), 1731176n);
});

// ── Case-insensitivity (addresses in logs are lowercase on-chain) ────────

test('address matching is case-insensitive (real receipts return lowercase addresses)', () => {
  const receipt = {
    logs: [transferLog({ address: POSM.toLowerCase(), from: ZERO, to: RECIPIENT.toLowerCase(), tokenId: 5n })],
  };
  assert.equal(extractMintedTokenId(receipt, POSM, RECIPIENT), 5n);
});
