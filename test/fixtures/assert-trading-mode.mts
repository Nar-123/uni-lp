// Test-only fixture (Phase 4.7.1): exercises the REAL startup TRADING_MODE
// validation path (src/config.ts's assertValidTradingModeEnv(), the exact
// function src/index.ts's main() calls right after assertValidStrategyEnv())
// in a fresh child process. Prints a single machine-readable line and exits
// 0 on success, or exits 1 with an error line on failure.
import { assertValidTradingModeEnv, getTradingMode } from '../../src/config.js';

try {
  assertValidTradingModeEnv();
  console.log(`TRADING_MODE_OK ${getTradingMode()}`);
  process.exit(0);
} catch (e) {
  console.error(`TRADING_MODE_ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
