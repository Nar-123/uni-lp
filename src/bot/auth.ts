import type { Context } from 'grammy';
import { config } from '../config.js';

export function isAllowed(userId: number | undefined): boolean {
  if (userId == null) return false;
  return config.allowedUserIds.has(userId);
}

export async function requireAuth(ctx: Context): Promise<boolean> {
  const id = ctx.from?.id;
  if (!isAllowed(id)) {
    await ctx.reply('⛔ Unauthorized. This bot is private.');
    return false;
  }
  return true;
}
