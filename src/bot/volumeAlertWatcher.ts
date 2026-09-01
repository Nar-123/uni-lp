/**
 * 5m volume spike alerts.
 *
 * - Poll every POLL_MS (60s)
 * - Fetch GMGN market trending interval=5m with per-user alert filters
 * - Default filters: vol≥300k · mcap 300k–50M · fees≥0.5 · KOL≥3
 * - Alert only on **new** hits (cooldown per token) so we don't spam
 */
import { type Bot, InlineKeyboard } from 'grammy';
import { config, type SupportedChainId } from '../config.js';
import { getUserPrefs, listPrefsWithAlertsEnabled } from '../db/index.js';
import {
  fetchAlertTokens,
  formatAlertRichHtml,
  gmgnTokenUrl,
  type AlertFilterPrefs,
  type ScreenerToken,
} from '../gmgn/screener.js';

const POLL_MS = 60_000;
/** Don't re-alert the same token within this window */
const COOLDOWN_MS = 30 * 60_000;

type AlertKey = string; // `${userId}:${chainId}:${address}`

const lastAlerted = new Map<AlertKey, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let botRef: Bot | null = null;

function alertKey(userId: number, chainId: number, address: string): AlertKey {
  return `${userId}:${chainId}:${address.toLowerCase()}`;
}

function pruneCooldowns(now: number): void {
  for (const [k, t] of lastAlerted) {
    if (now - t > COOLDOWN_MS * 2) lastAlerted.delete(k);
  }
}

function alertPrefsFromUser(prefs: ReturnType<typeof getUserPrefs>): AlertFilterPrefs {
  return {
    alertEnabled: prefs.alertEnabled,
    alertMinVolumeUsd: prefs.alertMinVolumeUsd,
    alertMinMcapUsd: prefs.alertMinMcapUsd,
    alertMaxMcapUsd: prefs.alertMaxMcapUsd,
    alertMinKol: prefs.alertMinKol,
    alertMinTotalFee: prefs.alertMinTotalFee,
  };
}

function mintKeyboard(chainId: SupportedChainId, tokens: ScreenerToken[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < Math.min(tokens.length, 10); i++) {
    const t = tokens[i]!;
    kb.text(`🚀 $${t.symbol}`.slice(0, 28), `scr:mint:${t.address}`);
    if (i % 2 === 1 || i === Math.min(tokens.length, 10) - 1) kb.row();
  }
  if (tokens[0]) {
    kb.url('🔗 GMGN', gmgnTokenUrl(chainId, tokens[0].address)).row();
  }
  kb.text('⚙️ Alert filters', 'scr:filters').text('🔔 Off', 'alert:off');
  return kb;
}

async function sendRichAlert(
  bot: Bot,
  userId: number,
  html: string,
  kb: InlineKeyboard,
): Promise<void> {
  try {
    await bot.api.sendRichMessage(userId, {
      html,
      skip_entity_detection: true,
    }, {
      reply_markup: kb,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[vol-alert] rich send failed, plain fallback:', msg.slice(0, 160));
    // Plain fallback — strip tags lightly
    const plain = html
      .replace(/<\/?(h[1-6]|p|blockquote|footer|hr|table|tr|td|th|caption|details|summary|ol|ul|li)[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 3500);
    try {
      await bot.api.sendMessage(userId, plain || '🔔 Volume alert', {
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e2) {
      console.warn(
        '[vol-alert] notify failed',
        userId,
        e2 instanceof Error ? e2.message : e2,
      );
    }
  }
}

async function tick(bot: Bot): Promise<void> {
  if (running) return;
  running = true;
  const now = Date.now();
  try {
    pruneCooldowns(now);

    // Users with alerts on; if none in prefs yet, still alert allowlisted users with defaults
    let users = listPrefsWithAlertsEnabled();
    if (!users.length) {
      // Seed: allowed users get default-on alerts without prior /settings open
      users = [...config.allowedUserIds].map((userId) => ({
        userId,
        prefs: getUserPrefs(userId),
      })).filter((u) => u.prefs.alertEnabled);
    }

    // Group by chain to reuse one fetch per chain when filters match
    type Job = { userId: number; chainId: SupportedChainId; prefs: AlertFilterPrefs };
    const jobs: Job[] = [];
    for (const u of users) {
      if (!u.prefs.alertEnabled) continue;
      jobs.push({
        userId: u.userId,
        chainId: u.prefs.chainId,
        prefs: alertPrefsFromUser(u.prefs),
      });
    }
    if (!jobs.length) return;

    // Unique (chainId + filter signature) → tokens
    const cache = new Map<string, ScreenerToken[]>();
    const filterSig = (p: AlertFilterPrefs) =>
      [
        p.alertMinVolumeUsd,
        p.alertMinMcapUsd,
        p.alertMaxMcapUsd,
        p.alertMinKol,
        p.alertMinTotalFee,
      ].join('|');

    for (const job of jobs) {
      const sig = `${job.chainId}:${filterSig(job.prefs)}`;
      let tokens = cache.get(sig);
      if (!tokens) {
        try {
          tokens = await fetchAlertTokens(job.chainId, job.prefs);
          cache.set(sig, tokens);
        } catch (e) {
          console.warn(
            '[vol-alert] fetch failed',
            job.chainId,
            e instanceof Error ? e.message : e,
          );
          continue;
        }
      }

      const fresh: ScreenerToken[] = [];
      for (const t of tokens) {
        const k = alertKey(job.userId, job.chainId, t.address);
        const prev = lastAlerted.get(k);
        if (prev != null && now - prev < COOLDOWN_MS) continue;
        fresh.push(t);
        lastAlerted.set(k, now);
      }
      if (!fresh.length) continue;

      const html = formatAlertRichHtml(job.chainId, job.prefs, fresh);
      const kb = mintKeyboard(job.chainId, fresh);
      console.log(
        `[vol-alert] user=${job.userId} chain=${job.chainId} new=${fresh.length} ` +
          `(${fresh.map((t) => t.symbol).join(',')})`,
      );
      await sendRichAlert(bot, job.userId, html, kb);
    }
  } finally {
    running = false;
  }
}

export function startVolumeAlertWatcher(bot: Bot): void {
  if (timer) return;
  botRef = bot;
  console.log(
    `[vol-alert] watcher started (poll ${POLL_MS / 1000}s, 5m trending, cooldown ${COOLDOWN_MS / 60000}m)`,
  );
  // First tick after a short delay so polling connects first
  setTimeout(() => {
    void tick(bot).catch((e) =>
      console.warn('[vol-alert] tick', e instanceof Error ? e.message : e),
    );
  }, 8_000);
  timer = setInterval(() => {
    const b = botRef;
    if (!b) return;
    void tick(b).catch((e) =>
      console.warn('[vol-alert] tick', e instanceof Error ? e.message : e),
    );
  }, POLL_MS);
}

export function stopVolumeAlertWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  botRef = null;
}
