// Test-only fixture (Phase 4.6.15): registers the real, production
// registerFatalErrorHandlers() in a fresh process, then deliberately
// throws an uncaught synchronous exception. Proves the actual registered
// process.on('uncaughtException', ...) handler behaves exactly as
// test/fatalError.test.ts's unit tests predict — real process, real
// event, not a simulation.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

import { registerFatalErrorHandlers } from '../../src/fatalError.js';

registerFatalErrorHandlers();

setTimeout(() => {
  throw new Error('deliberate test exception');
}, 10);
