/**
 * Phase 4.7 — zero-trust audit finding 6.3 (Part I/J, position sizing & USD
 * accounting), pre-mint sizing half.
 *
 * Root cause (src/strategy/multiExecute.ts's executeTradeIntent, before this
 * fix):
 *   const usdgPrice = (await getTokenPriceUsd(config.chainId, usdgAddress)) ?? 1;
 *   fixedAmountHuman = config.positionSizeUsd / usdgPrice;
 *
 * A failed/unavailable price lookup fabricated a $1.00 USDG price and sized
 * a REAL deposit against it — before any capital had moved, when failing
 * closed was free. This suite exists because that pre-mint branch calls
 * getTokenPriceUsd directly (no dependency-injection seam) — the sibling
 * test/strategy.multiExecute.test.ts file explicitly documents (see its own
 * header) that this codebase's policy is NOT to unit-test paths requiring
 * live RPC/price-API access, rather than retrofit a DI seam for one audit
 * fix. Consistent with that policy and with the structural/source-inspection
 * testing technique already used elsewhere in this codebase (Phases 4.6.10,
 * 4.6.13, 4.6.14, 4.6.16) for logic with no DI seam, this test reads the
 * actual current source and asserts the specific fabricate-on-null pattern
 * is gone and the fail-closed abort is present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'strategy', 'multiExecute.ts'), 'utf8');

test('pre-mint fixed-USD sizing never fabricates a $1.00 price on a failed lookup — it aborts the trade instead', () => {
  const startIdx = src.indexOf('if (config.positionSizeUsd != null) {');
  assert.ok(startIdx >= 0, 'sanity: the fixed-USD sizing branch must still exist at this call site');
  const endIdx = src.indexOf("} else if (prefs.sizeMode === 'fixed') {", startIdx);
  assert.ok(endIdx > startIdx, 'sanity: could not isolate the fixed-USD sizing branch');
  const branch = src.slice(startIdx, endIdx);

  assert.doesNotMatch(
    branch,
    /getTokenPriceUsd\([^)]*\)\)\s*\?\?\s*1/,
    'the fixed-USD sizing branch must not fabricate a $1.00 fallback price for a real deposit amount',
  );
  assert.match(
    branch,
    /usdgPrice\s*==\s*null/,
    'a null price lookup must be explicitly checked',
  );
  assert.match(
    branch,
    /return\s*\{\s*skipped:\s*true,\s*reason:\s*'PRICE_UNAVAILABLE'\s*\}/,
    'a null price lookup must abort the trade (no capital has moved yet) rather than proceed with a guessed price',
  );
});

test('post-mint accounting fallback (deposit already broadcast, cannot abort) at least logs when it falls back to $1.00', () => {
  const idx = src.indexOf('const usdgPriceRaw = await getTokenPriceUsd(intent.chainId, usdgAddress);');
  assert.ok(idx >= 0, 'the post-mint accounting price lookup must still exist');
  const window = src.slice(idx, idx + 600);
  assert.match(window, /console\.warn/, 'a failed post-mint price lookup must be observable, not silent');
  assert.match(window, /usdgPriceRaw\s*\?\?\s*1/, 'sanity: the fallback itself is retained (broadcast already happened, a number is still required)');
});
