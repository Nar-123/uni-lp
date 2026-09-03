/**
 * Phase 4.6.5 — health/readiness observability.
 *
 * This module is OBSERVABILITY ONLY. Nothing here authorizes a
 * transaction, bypasses a risk gate, or replaces any existing safety
 * check — it only reports, as cheaply and locally as possible, where the
 * process currently is in its own lifecycle. Every real safety decision
 * (pre-send tx-lock/journal gate, MULTI's risk gate, TP/SL's own state
 * machine, simulation, quote/price validation) remains exactly where it
 * already lived before this phase, untouched.
 *
 * Three distinct signals, deliberately never conflated:
 *  - LIVENESS  ("is the process/event loop alive enough to respond?") —
 *    always 200 as long as this HTTP server itself can answer. Never
 *    touches RPC, GMGN, the database, or any external dependency.
 *  - READINESS ("has startup finished and can normal services operate?")
 *    — reflects the explicit lifecycle state set by src/index.ts at each
 *    real transition (starting -> ready -> stopping -> stopped, or
 *    -> failed on a fatal startup error). Cheap: reads a local variable,
 *    performs no I/O of any kind.
 *  - TRADING_SAFE — deliberately reported as the literal string
 *    "NOT_EXPOSED". This codebase's actual safety gates are per-operation
 *    and scattered by design (per-wallet pre-send checks in
 *    chain/clients.ts, MULTI's own risk gate, TP/SL's own lifecycle) —
 *    there is no single existing authoritative "safe to trade right now"
 *    boolean to surface, and synthesizing one here would mean inventing a
 *    new, unauthoritative cross-cutting policy that could be misread as
 *    a green light. Reporting NOT_EXPOSED is the honest answer.
 */
import { createServer, type Server } from 'node:http';

export type AppLifecycleState = 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';

let lifecycleState: AppLifecycleState = 'starting';
let readySince: number | null = null;
let readinessNotes: string[] = [];

/**
 * Called by src/index.ts at each real lifecycle transition. `notes` are
 * informational only (e.g. "N unresolved transaction(s) from a previous
 * session") — they never change the ready/not-ready HTTP status; they are
 * surfaced for an operator's visibility, never as a new blocking gate
 * (the actual blocking gate for that exact condition already exists,
 * unchanged, in chain/clients.ts's journalledSend pre-send check).
 */
export function setLifecycleState(state: AppLifecycleState, notes: string[] = []): void {
  lifecycleState = state;
  readinessNotes = notes;
  readySince = state === 'ready' ? (readySince ?? Date.now()) : null;
}

export function getLifecycleState(): AppLifecycleState {
  return lifecycleState;
}

export type HealthResponse = { statusCode: number; body: Record<string, unknown> };

/** Pure, directly-testable — no HTTP/server dependency, no I/O, no external calls. */
export function buildLivenessResponse(): HealthResponse {
  return {
    statusCode: 200,
    body: {
      status: 'ok',
      state: lifecycleState,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  };
}

/** Pure, directly-testable — reads only the local lifecycle variables above. */
export function buildReadinessResponse(): HealthResponse {
  const ready = lifecycleState === 'ready';
  return {
    statusCode: ready ? 200 : 503,
    body: {
      status: ready ? 'ok' : 'not_ready',
      state: lifecycleState,
      readySince: readySince != null ? new Date(readySince).toISOString() : null,
      tradingSafe: 'NOT_EXPOSED',
      ...(readinessNotes.length > 0 ? { warnings: readinessNotes } : {}),
      timestamp: new Date().toISOString(),
    },
  };
}

let server: Server | null = null;

function routeRequest(url: string): HealthResponse {
  if (url === '/health' || url === '/healthz' || url === '/live' || url === '/livez') {
    return buildLivenessResponse();
  }
  if (url === '/ready' || url === '/readyz') {
    return buildReadinessResponse();
  }
  return { statusCode: 404, body: { status: 'not_found' } };
}

/**
 * Starts the health/readiness HTTP server. Non-critical by design: a bind
 * failure (bad port, port already in use) is logged and resolved as
 * `{started: false}` rather than thrown — this endpoint is pure
 * observability, so its absence must never crash or block the actual
 * trading process starting up. Idempotent: a second call while already
 * listening returns the existing server's info immediately.
 */
export function startHealthServer(port: number): Promise<{ started: boolean; port?: number; error?: string }> {
  if (server) {
    const addr = server.address();
    const boundPort = addr && typeof addr === 'object' ? addr.port : port;
    return Promise.resolve({ started: true, port: boundPort });
  }
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const response = routeRequest(req.url ?? '/');
      // No keep-alive: each request is a single cheap read-only response,
      // and disabling it means server.close() during shutdown resolves
      // promptly on its own, with no lingering open sockets to wait for.
      res.setHeader('Connection', 'close');
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
    s.once('error', (err) => {
      console.error(`[health] failed to start health server on port ${port} — continuing without it:`, err instanceof Error ? err.message : err);
      resolve({ started: false, error: err instanceof Error ? err.message : String(err) });
    });
    s.listen(port, () => {
      server = s;
      // Report the ACTUAL bound port, not the requested one — these
      // differ whenever port 0 ("OS, pick one") is used, which is exactly
      // how the real-HTTP-server tests get a collision-free ephemeral
      // port. Reporting the raw input here would silently report "0" (or
      // whatever was requested) instead of the real listening port.
      const addr = s.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve({ started: true, port: boundPort });
    });
  });
}

/** Bounded, idempotent shutdown — resolves immediately if never started. */
export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    s.close(() => resolve());
  });
}

/** Reads and validates HEALTH_PORT; falls back to the default on any invalid value rather than crashing. */
export function resolveHealthPort(defaultPort = 8080): number {
  const raw = process.env.HEALTH_PORT?.trim();
  if (!raw) return defaultPort;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    console.warn(`[health] invalid HEALTH_PORT=${JSON.stringify(raw)} — falling back to ${defaultPort}`);
    return defaultPort;
  }
  return n;
}
