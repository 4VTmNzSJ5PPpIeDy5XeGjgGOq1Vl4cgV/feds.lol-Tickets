import type { Client, Guild } from "discord.js";

const DEFAULT_DELAY_MS = 5000;
const MAX_DELETE_ATTEMPTS = 5;
const RETRY_BASE_MS = 2000;
const LOG_ON_FAILURE = true;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitError(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  const status = (e as { status?: number })?.status;
  const name = (e as { name?: string })?.name;
  return (
    code === 429 ||
    status === 429 ||
    name === "DiscordAPIError[429]" ||
    String(e).toLowerCase().includes("rate limit")
  );
}

/**
 * Fetch fresh channel reference and delete with retries (rate limits / transient API errors).
 */
export async function deleteTicketChannelWithRetry(
  guild: Guild,
  channelId: string,
  context: string
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt++) {
    try {
      const ch =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null));
      if (!ch) {
        console.log(`[ticket-delete] ${context}: channel ${channelId} already gone`);
        return true;
      }
      await ch.delete(`Ticket closed (${context})`);
      console.log(`[ticket-delete] ${context}: deleted ${channelId}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[ticket-delete] ${context}: attempt ${attempt}/${MAX_DELETE_ATTEMPTS} failed:`,
        msg
      );
      if (attempt < MAX_DELETE_ATTEMPTS) {
        const backoff = RETRY_BASE_MS * attempt;
        await sleep(isRateLimitError(e) ? Math.max(backoff, 5000) : backoff);
      }
    }
  }
  return false;
}

/**
 * After a short delay, resolve guild from the client and delete the channel.
 * Survives stale channel objects better than calling delete on the interaction channel alone.
 */
export function scheduleTicketChannelDeletion(
  client: Client,
  guildId: string,
  channelId: string,
  context: string,
  delayMs = DEFAULT_DELAY_MS
): void {
  setTimeout(() => {
    void (async () => {
      try {
        const guild =
          client.guilds.cache.get(guildId) ??
          (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) {
          console.error(
            `[ticket-delete] ${context}: guild ${guildId} unavailable, cannot delete channel ${channelId}`
          );
          return;
        }
        const ok = await deleteTicketChannelWithRetry(guild, channelId, context);
        if (!ok) {
          console.error(
            `[ticket-delete] ${context}: giving up on ${channelId} — check bot Manage Channels / hierarchy`
          );
          if (LOG_ON_FAILURE) {
            const logId = process.env.LOG_CHANNEL_ID?.trim();
            if (logId) {
              const logChannel =
                guild.channels.cache.get(logId) ??
                (await guild.channels.fetch(logId).catch(() => null));
              if (logChannel?.isTextBased()) {
                await logChannel
                  .send(
                    `⚠️ Failed to delete ticket channel <#${channelId}> after close (context: \`${context}\`). ` +
                      `This is almost always a permissions/hierarchy issue: bot needs **Manage Channels** and role above the channel.`
                  )
                  .catch(() => {});
              }
            }
          }
        }
      } catch (e) {
        console.error(`[ticket-delete] ${context}: unexpected error`, e);
      }
    })();
  }, delayMs);
}
