// Test-only fixture (Phase 4.6.15): registers the real, production
// registerFatalErrorHandlers() in a fresh process, then deliberately
// creates an unhandled promise rejection (a fire-and-forget async call
// with no .catch(), mirroring the exact pattern audited in index.ts's
// bot.start(...) and tpslWatcher.ts's void recheckAndMaybeClose(...)).
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

import { registerFatalErrorHandlers } from '../../src/fatalError.js';

registerFatalErrorHandlers();

async function willReject(): Promise<void> {
  throw new Error('deliberate test rejection');
}

void willReject();
