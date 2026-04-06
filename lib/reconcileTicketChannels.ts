import type { Client } from "discord.js";

import * as db from "../database";
import { deleteTicketChannelWithRetry } from "./deleteTicketChannel";

const STAGGER_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * After restarts, scheduled channel.delete timers are lost. Remove channels for tickets
 * that are already marked closed in the DB but whose Discord channel still exists.
 */
export async function reconcileStaleTicketChannels(client: Client): Promise<void> {
  let rows: { guild_id: string; channel_id: string }[];
  try {
    rows = await db.listClosedTicketsChannelsForCleanup(48, 60);
  } catch (e) {
    console.error("[ready] Failed to list tickets for channel cleanup:", e);
    return;
  }
  if (rows.length === 0) return;

  console.log(
    `[ready] Reconciling up to ${rows.length} recently closed ticket channel(s) (orphan cleanup)`
  );

  for (const row of rows) {
    try {
      const guild =
        client.guilds.cache.get(row.guild_id) ??
        (await client.guilds.fetch(row.guild_id).catch(() => null));
      if (!guild) continue;

      const ch = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!ch) continue;

      console.warn(
        `[ready] Orphan channel ${row.channel_id} still exists for closed ticket; deleting`
      );
      await deleteTicketChannelWithRetry(guild, row.channel_id, "startup-reconcile");
    } catch (e) {
      console.error("[ready] reconcile row failed:", row, e);
    }
    await sleep(STAGGER_MS);
  }
}
