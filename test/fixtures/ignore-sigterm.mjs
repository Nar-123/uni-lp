// Test-only fixture (Phase 4.6.2): deliberately ignores SIGTERM so
// test/gmgnCli.test.ts can exercise real SIGTERM->SIGKILL escalation
// against a genuine OS process.
//
// SIGKILL is uncatchable on POSIX, so this process WILL be terminated by
// it there. On Windows there is no real signal delivery — any kill()
// call (including a plain 'SIGTERM') already terminates the process
// unconditionally (TerminateProcess), so this handler never actually
// gets a chance to run there; that is a platform reality, not a bug in
// this fixture or in the escalation logic under test.
//
// Guaranteed cleanup: self-terminates after a bounded lifetime no matter
// what, so a broken implementation under test (or a test that never
// signals this process at all) can never leave it running forever.
process.on('SIGTERM', () => {
  /* deliberately ignored */
});

setTimeout(() => process.exit(0), 15_000);

// Keep the event loop alive without busy-looping.
setInterval(() => {}, 1_000);

console.log('ready');
