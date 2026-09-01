import { config } from './config.js';
import { getDb } from './db/index.js';
import { getHotWalletAddress } from './chain/clients.js';
import { listWallets, getActiveWallet } from './wallet/keys.js';
import { createBot } from './bot/bot.js';
import { startTpslWatcher, stopTpslWatcher } from './bot/tpslWatcher.js';
import {
  startVolumeAlertWatcher,
  stopVolumeAlertWatcher,
} from './bot/volumeAlertWatcher.js';

async function main() {
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

  const bot = createBot();

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

  // Keep process alive; surface unhandled poll errors
  process.once('SIGINT', () => {
    stopTpslWatcher();
    stopVolumeAlertWatcher();
    bot.stop();
  });
  process.once('SIGTERM', () => {
    stopTpslWatcher();
    stopVolumeAlertWatcher();
    bot.stop();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
