// Test-only fixture (Phase 4.6.10): exercises the REAL startup STRATEGY
// validation path (src/strategy/multiConfig.ts's assertValidStrategyEnv(),
// the exact function src/index.ts's main() calls before acquiring the
// instance lock or starting any transaction-capable service) in a fresh
// child process — so each invocation gets a genuinely fresh module
// evaluation for whatever STRATEGY value the parent test set. Prints a
// single machine-readable line and exits 0 on success, or exits 1 with an
// error line on failure.
import { assertValidStrategyEnv } from '../../src/strategy/multiConfig.js';

try {
  assertValidStrategyEnv();
  console.log('STRATEGY_OK');
  process.exit(0);
} catch (e) {
  console.error(`STRATEGY_ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
