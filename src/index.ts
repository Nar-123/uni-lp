import { assertValidTradingModeEnv, config, getTradingMode } from './config.js';
import { getDb } from './db/index.js';
import { getHotWalletAddress, runStartupTxRecovery } from './chain/clients.js';
import { listWallets, getActiveWallet } from './wallet/keys.js';
import { createBot } from './bot/bot.js';
import { startTpslWatcher, stopTpslWatcher } from './bot/tpslWatcher.js';
import {
  startVolumeAlertWatcher,
  stopVolumeAlertWatcher,
} from './bot/volumeAlertWatcher.js';
import { recoverMissingLedger } from './pnl/reconcile.js';
import { assertValidStrategyEnv, loadMultiConfig, validateMultiConfig } from './strategy/index.js';
import { acquireInstanceLock, defaultLockPath, releaseInstanceLock } from './instanceLock.js';
import { resolveHealthPort, setLifecycleState, startHealthServer, stopHealthServer } from './health.js';
import { registerFatalErrorHandlers } from './fatalError.js';

// Phase 4.6.15: process-wide uncaughtException/unhandledRejection safety
// net — registered as early as possible, before any startup work begins.
// See fatalError.ts for the full audit finding and design rationale.
registerFatalErrorHandlers();

async function main() {
  // Phase 4.6.5: health/readiness HTTP server, started as early as
  // possible so liveness is observable even if a later startup step
  // fails. Non-critical by design (see health.ts) — a bind failure is
  // logged and the trading process continues to start regardless.
  const healthPort = resolveHealthPort();
  const health = await startHealthServer(healthPort);
  if (health.started) {
    console.log(`[health] listening on :${health.port} (GET /health, GET /ready)`);
  }

  // Phase 4.6.10: STRATEGY must be validated before any transaction-capable
  // service (instance lock, db, wallet, bot, watchers) starts. This is
  // distinct from the existing per-parameter MULTI config validation further
  // below (which only disables MULTI on a malformed numeric/address value,
  // leaving the bot and default-strategy trading running) — an unrecognized
  // STRATEGY value means the operator's fundamental intent is ambiguous, so
  // the whole process must fail to start. Throwing here propagates to
  // main().catch() below, which already logs, marks health FAILED, releases
  // the instance lock (not yet acquired at this point, so a no-op), and
  // exits non-zero — the same fail-closed path Phase 4.6.6 established for
  // invalid RPC/address configuration.
  assertValidStrategyEnv();

  // Phase 4.7.1: TRADING_MODE validated the same way and at the same point
  // as STRATEGY above — a present-but-unrecognized value fails startup
  // outright rather than being silently absorbed into 'live'. Unlike
  // STRATEGY, an invalid TRADING_MODE is arguably even more safety-critical
  // to catch here: a typo that should have meant "staging" must never
  // silently run as 'live' (the default). Logged unconditionally so the
  // active mode is always visible in startup logs, not just when staging.
  assertValidTradingModeEnv();
  console.log(`[startup] TRADING_MODE=${getTradingMode()}${getTradingMode() === 'staging' ? ' — all transaction broadcasts will be refused at the journalledSend choke point' : ''}`);

  // Phase 4.6.1 (P1-2): claim exclusive ownership of this wallet/dbPath
  // BEFORE any transaction-capable service (db load, wallet client, bot,
  // watchers) starts — a second instance sharing the same persistence
  // file/wallet must fail to start rather than race the first one.
  const lockPath = defaultLockPath(config.dbPath);
  const lock = acquireInstanceLock(lockPath);
  if (!lock.acquired) {
    if (lock.reason === 'HELD_BY_LIVE_PROCESS') {
      console.error(
        `[instance-lock] refusing to start: ${lockPath} is held by a live process ` +
          `(pid=${lock.existing.pid}, host=${lock.existing.hostname}, since ` +
          `${new Date(lock.existing.acquiredAt).toISOString()}). Only one bot instance may ` +
          `run against this wallet/database at a time. If that process is not actually ` +
          `running, remove ${lockPath} manually and restart.`,
      );
    } else {
      console.error(
        `[instance-lock] refusing to start: could not safely determine ownership of ${lockPath} ` +
          `(${lock.detail}). Refusing to guess — inspect and, if appropriate, remove the file manually.`,
      );
    }
    setLifecycleState('failed', ['instance lock could not be acquired']);
    process.exit(1);
  }
  console.log(`[instance-lock] acquired ${lockPath} (pid=${process.pid})`);

  getDb();
  // Touch wallet store + clients (migrates legacy hot-wallet if needed)
  const active = getActiveWallet();
  const wallets = listWallets();
  console.log('LP Uniswap bot starting…');
  console.log(`Wallets: ${wallets.length} · active: ${active.label} (${active.address})`);
  console.log('Wallet store:', config.walletPath);
  console.log('Allowed users:', [...config.allowedUserIds].join(', '));
  console.log('Chains: 4663 (Robinhood), 56 (BSC), 8453 (Base)');
  console.log(
    'Uniswap Trading API:',
    process.env.UNISWAP_API_KEY?.trim() ? 'configured' : 'off (local v3 multi-hop only)',
  );
  console.log(
    'Across API:',
    process.env.ACROSS_API_KEY?.trim() && process.env.ACROSS_INTEGRATOR_ID?.trim()
      ? 'configured (quote aggregation with Relay)'
      : 'off (Relay only)',
  );
  // Ensure client account matches active
  void getHotWalletAddress();

  // Phase 4.6.5: informational-only notes surfaced on GET /ready once the
  // process reaches 'ready'. These NEVER gate the ready/not-ready HTTP
  // status itself (that remains "did startup complete") and never gate
  // any transaction — the actual blocking gate for unresolved-tx is, and
  // remains, chain/clients.ts's journalledSend pre-send check, unchanged.
  const readinessNotes: string[] = [];

  // Phase 2 Part 4: resolve any transaction left unresolved by a prior
  // crash/restart/RPC outage BEFORE the bot starts handling commands or
  // the TP/SL watcher starts polling — new sends for an affected wallet
  // are refused until this clears (see chain/clients.ts journalledSend).
  try {
    const { resolved, stillUnresolved } = await runStartupTxRecovery();
    if (resolved > 0 || stillUnresolved > 0) {
      console.log(
        `[tx-recovery] startup complete: ${resolved} resolved, ${stillUnresolved} still unresolved`,
      );
    }
    if (stillUnresolved > 0) {
      readinessNotes.push(
        `${stillUnresolved} unresolved transaction(s) from a previous session — new sends for the affected wallet(s) remain blocked by the existing pre-send guard until resolved`,
      );
    }
  } catch (e) {
    console.error('[tx-recovery] startup recovery pass failed (continuing):', e);
    readinessNotes.push('startup transaction-recovery pass failed — see logs');
  }

  // Phase 3.5: Auto-recover any ledger events that were staged in journal
  // accounting metadata but never written (process crashed after tx success
  // but before recordLedger() completed).
  try {
    const recovery = recoverMissingLedger();
    if (recovery.recovered > 0) {
      console.log(
        `[ledger-recovery] startup: recovered ${recovery.recovered} missing ledger event(s)`,
      );
    }
    if (recovery.status === 'RECONCILIATION_REQUIRED') {
      const needsAttention = recovery.findings.filter(
        (f) => f.ledgerState !== 'MISSING_RECOVERED',
      ).length;
      readinessNotes.push(`${needsAttention} ledger reconciliation finding(s) require operator review — run /reconcile`);
      console.warn(
        `[ledger-recovery] startup: ${needsAttention} finding(s) require operator review — run /reconcile`,
      );
    }
  } catch (e) {
    console.error('[ledger-recovery] startup recovery pass failed (continuing):', e);
  }

  const bot = createBot();

  // Phase 4: MULTI strategy config validation. STRATEGY=multi is opt-in;
  // any invalid/missing config leaves MULTI disabled — the bot itself still
  // starts normally and default-strategy trading is entirely unaffected.
  try {
    const multiConfig = loadMultiConfig();
    const validation = validateMultiConfig(multiConfig);
    if (multiConfig.enabled && validation.valid) {
      console.log(`[multi] enabled (chain=${multiConfig.chainId}, usdg=${multiConfig.usdgAddress})`);
    } else {
      console.log(`[multi] DISABLED: ${multiConfig.disabledReason ?? validation.reason ?? 'invalid config'}`);
    }
  } catch (e) {
    console.error('[multi] startup config check failed (MULTI disabled):', e);
  }

  // Ensure long-polling mode (no webhook) so getUpdates works
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log('Webhook cleared — using long polling');
  } catch (e) {
    console.warn('deleteWebhook failed (continuing):', e);
  }

  // Register slash-command menu (shows when user types /)
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Help + settings' },
      { command: 'help', description: 'Show help' },
      { command: 'settings', description: 'Chain, width, amount, auto-swaps, TP/SL' },
      { command: 'screener', description: 'GMGN trending table · filters · mint' },
      { command: 'alerts', description: '5m vol alerts ON/OFF · filters' },
      { command: 'wallet', description: 'Multi-wallet · balances · transfer' },
      { command: 'bridge', description: 'Bridge RH ↔ BSC ↔ Base (best quote)' },
      { command: 'swap', description: 'Swap native↔stable or custom CA' },
      { command: 'wrap', description: 'Wrap native → WETH/WBNB' },
      { command: 'unwrap', description: 'Unwrap WETH/WBNB → native' },
      { command: 'revoke', description: 'Revoke unlimited token approvals' },
      { command: 'list', description: 'Open LP positions + close' },
      { command: 'close', description: 'Close a position' },
      { command: 'tokens', description: 'Extra tokens · swap to native' },
      { command: 'pnl', description: 'Portfolio PnL summary' },
      { command: 'history', description: 'Per-position PnL from ledger' },
      { command: 'generate', description: 'PnL card image · /generate #id' },
      { command: 'reconcile', description: 'Accounting reconciliation check (operator)' },
      { command: 'multi', description: 'MULTI strategy candidates (dry-run) · execute' },
      { command: 'tp', description: 'TP/SL enroll · /tp #id [tp sl|off|list]' },
      { command: 'add', description: 'Mint LP (paste CA → pick pool)' },
      { command: 'cancel', description: 'Cancel current flow' },
    ]);
    console.log('Bot commands registered (setMyCommands)');
  } catch (e) {
    console.warn('setMyCommands failed:', e);
  }

  // Experimental TP/SL background poller (30s / 5s confirm)
  startTpslWatcher(bot);
  // 5m volume spike alerts (60s poll)
  startVolumeAlertWatcher(bot);

  bot.start({
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    onStart: (info) => {
      console.log(`Bot @${info.username} online (polling)`);
    },
  });

  // Phase 4.6.5: everything required for normal operation has now been
  // initialized — instance lock, startup tx/ledger recovery, bot
  // commands, TP/SL + volume-alert watchers, and the Telegram polling
  // loop has been started. GET /ready now returns 200.
  setLifecycleState('ready', readinessNotes);

  // Keep process alive; surface unhandled poll errors
  //
  // Phase 4.6.4: stopTpslWatcher() is now async — it waits (bounded) for
  // any in-flight close before resolving, so it must be awaited here for
  // that guarantee to actually apply at the one real shutdown entry
  // point. Every other call in these handlers (stopVolumeAlertWatcher,
  // bot.stop, releaseInstanceLock) is unchanged and runs in the same
  // order as before, just after the TP/SL watcher has actually finished
  // shutting down rather than merely having been told to.
  //
  // Phase 4.6.5: lifecycle state flips to 'stopping' IMMEDIATELY (before
  // any awaited cleanup), so GET /ready reflects not-ready the instant a
  // shutdown signal is received rather than after cleanup completes —
  // liveness (GET /health) stays 200 for as long as this process/health
  // server can still respond, matching "readiness must reflect shutdown
  // immediately; liveness may remain available during graceful shutdown".
  process.once('SIGINT', async () => {
    setLifecycleState('stopping');
    await stopTpslWatcher();
    stopVolumeAlertWatcher();
    bot.stop();
    releaseInstanceLock(lockPath);
    setLifecycleState('stopped');
    await stopHealthServer();
  });
  process.once('SIGTERM', async () => {
    setLifecycleState('stopping');
    await stopTpslWatcher();
    stopVolumeAlertWatcher();
    bot.stop();
    releaseInstanceLock(lockPath);
    setLifecycleState('stopped');
    await stopHealthServer();
  });
}

main().catch((err) => {
  console.error(err);
  setLifecycleState('failed', [err instanceof Error ? err.message : String(err)].filter(Boolean));
  // Release before exiting so a startup/initialization failure (RPC init,
  // strategy config, recovery, or any uncaught error above) doesn't leave
  // the lock held by a PID that's about to stop existing — the next start
  // attempt would otherwise have to wait for stale-PID detection instead
  // of finding a clean lock.
  releaseInstanceLock();
  process.exit(1);
});
