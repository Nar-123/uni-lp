// Test-only fixture (Phase 4.6.6): exercises the REAL startup config path
// (src/config.ts's getConfig(), the exact function src/index.ts's main()
// depends on for RPC/address/wallet config) in a fresh child process, so
// each invocation gets a genuinely fresh module evaluation for whatever
// env vars the parent test set. Prints a single machine-readable line and
// exits 0 on success, or exits 1 with an error line on failure — this is
// how the test distinguishes "invalid config correctly failed startup"
// from "valid config correctly proceeded" without needing to parse
// arbitrary stdout.
import { getConfig } from '../../src/config.js';

try {
  const cfg = getConfig();
  console.log(`CONFIG_OK rpc4663=${cfg.rpc[4663]}`);
  process.exit(0);
} catch (e) {
  console.error(`CONFIG_ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
