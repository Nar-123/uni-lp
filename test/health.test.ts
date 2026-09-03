/**
 * Phase 4.6.5 — health/readiness observability.
 *
 * P2 finding: "No health/readiness signal exists anywhere. Process-alive
 * is currently the only external signal." This suite tests the new
 * src/health.ts module: three distinct signals (liveness, readiness,
 * trading-safe — deliberately reported as NOT_EXPOSED, see health.ts's
 * own doc comment for why), a real HTTP server (not just direct function
 * calls), and the explicit lifecycle state machine that src/index.ts
 * drives (starting -> ready -> stopping -> stopped, or -> failed).
 *
 * Two kinds of coverage: pure response-builder tests (fast, no I/O) and
 * a real HTTP server test (an ephemeral port, actual `fetch` requests,
 * actual status codes) — the task explicitly requires the latter, not
 * only `buildLivenessResponse()`/`buildReadinessResponse()` called directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setLifecycleState,
  getLifecycleState,
  buildLivenessResponse,
  buildReadinessResponse,
  startHealthServer,
  stopHealthServer,
  resolveHealthPort,
} from '../src/health.js';

function reset(): void {
  setLifecycleState('starting');
}

// ── 1/4/5. Lifecycle state transitions (pure, no I/O) ────────────────────

test('initial/starting state is not ready, and liveness is unaffected', () => {
  reset();
  assert.equal(getLifecycleState(), 'starting');
  const ready = buildReadinessResponse();
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.body.status, 'not_ready');
  assert.equal(ready.body.state, 'starting');

  const live = buildLivenessResponse();
  assert.equal(live.statusCode, 200, 'process is alive even while still starting');
  assert.equal(live.body.status, 'ok');
});

test('readiness becomes true only after the explicit ready transition', () => {
  reset();
  assert.equal(buildReadinessResponse().statusCode, 503);
  setLifecycleState('ready');
  const ready = buildReadinessResponse();
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.status, 'ok');
  assert.equal(ready.body.state, 'ready');
});

test('startup failure ("failed" state) never reports ready', () => {
  reset();
  setLifecycleState('failed', ['instance lock could not be acquired']);
  const ready = buildReadinessResponse();
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.body.status, 'not_ready');
  assert.equal(ready.body.state, 'failed');
  // Liveness is still fine — a failed startup is a readiness concern, not
  // proof the process/event loop itself is unresponsive.
  assert.equal(buildLivenessResponse().statusCode, 200);
});

test('shutdown ("stopping") immediately flips readiness to not-ready, even though it was ready a moment ago', () => {
  reset();
  setLifecycleState('ready');
  assert.equal(buildReadinessResponse().statusCode, 200);

  setLifecycleState('stopping');
  const ready = buildReadinessResponse();
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.body.state, 'stopping');
  // Liveness remains available during graceful shutdown, matching the
  // task's explicit allowance ("liveness may remain available during
  // graceful shutdown if the server can still respond").
  assert.equal(buildLivenessResponse().statusCode, 200);
});

test('"stopped" also reports not-ready', () => {
  reset();
  setLifecycleState('ready');
  setLifecycleState('stopped');
  assert.equal(buildReadinessResponse().statusCode, 503);
  assert.equal(buildReadinessResponse().body.state, 'stopped');
});

// ── 6/7. Trading-safe is explicitly NOT_EXPOSED, never fabricated ────────

test('trading-safe is always reported as the literal NOT_EXPOSED, never a fabricated boolean, regardless of state', () => {
  reset();
  for (const state of ['starting', 'ready', 'failed', 'stopping', 'stopped'] as const) {
    setLifecycleState(state);
    assert.equal(buildReadinessResponse().body.tradingSafe, 'NOT_EXPOSED');
  }
});

// ── informational notes never change the HTTP status ─────────────────────

test('readiness warnings are informational only — they never change the ready HTTP status', () => {
  reset();
  setLifecycleState('ready', ['3 unresolved transaction(s) from a previous session']);
  const ready = buildReadinessResponse();
  assert.equal(ready.statusCode, 200, 'a warning note must never downgrade an otherwise-ready state to not-ready');
  assert.deepEqual(ready.body.warnings, ['3 unresolved transaction(s) from a previous session']);
});

// ── 2/3/8/9. Liveness is independent of RPC/GMGN/any external dependency ──

test('liveness performs no I/O of any kind — it only reads local process/lifecycle state', () => {
  reset();
  // buildLivenessResponse's only inputs are process.uptime(), the current
  // Date, and the local lifecycleState variable — there is no RPC client,
  // no GMGN CLI invocation, no database read anywhere in health.ts.
  // Static proof: it is synchronous (a real RPC/GMGN call would have to
  // be async), and completes in well under a millisecond even under load.
  const start = process.hrtime.bigint();
  buildLivenessResponse();
  const elapsedNs = Number(process.hrtime.bigint() - start);
  assert.ok(elapsedNs < 5_000_000, `liveness must be near-instant (no I/O); took ${elapsedNs}ns`);
});

test('liveness stays 200 while readiness independently reflects an unhealthy startup — RPC/GMGN-down is a readiness concern, never a liveness one', () => {
  reset();
  // Simulates "process alive, but a dependency the startup sequence
  // needed is down" — modeled here via the 'failed' state, since this
  // codebase's actual RPC/GMGN calls are not health.ts's concern at all
  // (traced: health.ts imports nothing from chain/ or gmgn/).
  setLifecycleState('failed', ['RPC unavailable during startup']);
  assert.equal(buildLivenessResponse().statusCode, 200, 'an external dependency failure must never make the process appear dead');
  assert.equal(buildReadinessResponse().statusCode, 503);
});

// ── Security: no secrets in any response ──────────────────────────────────

test('no response ever contains anything resembling a secret, key, or token', () => {
  reset();
  setLifecycleState('ready', ['note referencing nothing sensitive']);
  const combined = JSON.stringify([buildLivenessResponse(), buildReadinessResponse()]).toLowerCase();
  for (const forbidden of ['privatekey', 'private_key', 'seed', 'mnemonic', 'telegram_bot_token', 'apikey', 'api_key', 'secret', 'password', '0x' /* no address/hash should ever appear */]) {
    assert.ok(!combined.includes(forbidden), `response must never contain "${forbidden}"`);
  }
});

// ── resolveHealthPort: safe validation, never crashes on bad input ───────

test('resolveHealthPort falls back to the default on missing/invalid HEALTH_PORT', () => {
  const originalEnv = process.env.HEALTH_PORT;
  try {
    delete process.env.HEALTH_PORT;
    assert.equal(resolveHealthPort(9999), 9999);

    process.env.HEALTH_PORT = 'not-a-number';
    assert.equal(resolveHealthPort(9999), 9999);

    process.env.HEALTH_PORT = '-1';
    assert.equal(resolveHealthPort(9999), 9999);

    process.env.HEALTH_PORT = '99999';
    assert.equal(resolveHealthPort(9999), 9999);

    process.env.HEALTH_PORT = '4200';
    assert.equal(resolveHealthPort(9999), 4200);
  } finally {
    if (originalEnv === undefined) delete process.env.HEALTH_PORT;
    else process.env.HEALTH_PORT = originalEnv;
  }
});

// ── 19. Mandatory real HTTP test: actual server, actual requests ─────────

test('real HTTP server: GET /health and GET /ready return actual status codes and JSON over a real socket', async () => {
  reset();
  const result = await startHealthServer(0); // port 0 = OS-assigned ephemeral port
  try {
    assert.equal(result.started, true);
    const port = result.port!;
    assert.ok(port > 0);

    // Not ready yet.
    const notReadyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(notReadyRes.status, 503);
    const notReadyBody = await notReadyRes.json();
    assert.equal(notReadyBody.status, 'not_ready');
    assert.equal(notReadyBody.state, 'starting');

    // Liveness is 200 regardless.
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('content-type'), 'application/json');
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');
    assert.equal(typeof healthBody.uptimeSeconds, 'number');

    // Flip to ready — the real server must reflect it on the next request.
    setLifecycleState('ready');
    const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(readyRes.status, 200);
    const readyBody = await readyRes.json();
    assert.equal(readyBody.status, 'ok');
    assert.equal(readyBody.tradingSafe, 'NOT_EXPOSED');

    // Unknown route -> 404, not a crash.
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    assert.equal(notFoundRes.status, 404);

    // Repeated requests remain responsive (no leak/hang across many calls).
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(r.status, 200);
    }
  } finally {
    await stopHealthServer();
  }
});

test('starting the health server twice is idempotent and returns the same bound port', async () => {
  reset();
  const first = await startHealthServer(0);
  try {
    const second = await startHealthServer(0);
    assert.equal(second.started, true);
    assert.equal(second.port, first.port, 'a second start call while already listening must not rebind or change port');
  } finally {
    await stopHealthServer();
  }
});

test('an invalid bind (port already in use) is reported, not thrown, and never crashes the caller', async () => {
  reset();
  const holder = await startHealthServer(0);
  const heldPort = holder.port!;
  try {
    // stopHealthServer() only tracks one server internally, so directly
    // attempt a second real listen on the same port via Node's http to
    // simulate "port already in use" without relying on health.ts's
    // singleton (which would just report already-started for the same
    // instance). This proves startHealthServer's OWN error handling path.
    const { createServer } = await import('node:http');
    await stopHealthServer(); // free health.ts's singleton slot
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(heldPort, resolve));
    try {
      const result = await startHealthServer(heldPort);
      assert.equal(result.started, false, 'a bind failure must be reported, not thrown');
      assert.ok(result.error);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  } finally {
    await stopHealthServer();
  }
});

test('stopHealthServer on a never-started server is a safe no-op', async () => {
  await assert.doesNotReject(() => stopHealthServer());
});
