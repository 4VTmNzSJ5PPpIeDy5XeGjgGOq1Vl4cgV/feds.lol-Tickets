import { PermissionFlagsBits, type Client, type Message } from "discord.js";
import * as db from "../database";

const SUPPORT_ROLE_IDS: string[] = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

const OWNER_USER_ID = "261265820678619137";
const OWNER_PREFIX = "!agent";
const OWNER_ALLOWED_ROLE_IDS = [
  "1408259928736399433", // Server Owner
  "1457448238243254314", // Server Management
  "1408259929177063456", // Server Team
  "1408259930267451512" // Server Staff
] as const;

const dmCooldowns = new Map<string, number>();
const DM_COOLDOWN_MS = 60 * 1000;

function isSupportMessage(message: Message): boolean {
  return SUPPORT_ROLE_IDS.some((roleId) =>
    message.member?.roles?.cache?.has(roleId)
  );
}

async function handleOwnerPrefixCommand(message: Message, client: Client): Promise<boolean> {
  const content = (message.content || "").trim();
  if (!content.toLowerCase().startsWith(OWNER_PREFIX)) return false;

  const isOwnerUser = message.author.id === OWNER_USER_ID;
  const hasAllowedRole = OWNER_ALLOWED_ROLE_IDS.some((roleId) =>
    message.member?.roles?.cache?.has(roleId)
  );

  // Owner can run anywhere; role-based access is guild-only.
  if (!isOwnerUser && !hasAllowedRole) return false;

  const args = content.slice(OWNER_PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "").toLowerCase();

  if (!sub || sub === "help") {
    await message.reply(
      `Owner commands:\n` +
        `- \`${OWNER_PREFIX} ping\`\n` +
        `- \`${OWNER_PREFIX} restart\``
    );
    return true;
  }

  if (sub === "ping") {
    const tag = client.user?.tag || "unknown";
    await message.reply(`pong (bot=${tag})`);
    return true;
  }

  if (sub === "restart") {
    await message.reply("Restarting now (Render should bring me back up)...").catch(() => {});
    setTimeout(() => process.exit(0), 750);
    return true;
  }

  await message.reply(`Unknown subcommand: \`${sub}\`. Try \`${OWNER_PREFIX} help\`.`);
  return true;
}

const event = {
  name: "messageCreate",

  async execute(message: Message, client: Client) {
    try {
      if (message.author.bot) return;

      // Owner-only prefix commands (no env, no slash commands).
      if (await handleOwnerPrefixCommand(message, client)) return;

      // Remaining logic is ticket-only and guild-only.
      if (!message.guild) return;

      const ticket = await db.getTicketByChannel(message.channel.id);
      if (!ticket || ticket.status !== "open") return;

      if (message.author.id === ticket.user_id) return;

      const isStaff =
        isSupportMessage(message) ||
        message.member?.permissions?.has(PermissionFlagsBits.ManageChannels);

      if (!isStaff) return;

      if (!message.content?.trim() && message.attachments.size === 0) return;

      const cooldownKey = `${message.channel.id}:${ticket.user_id}`;
      const last = dmCooldowns.get(cooldownKey) || 0;
      const now = Date.now();

      if (now - last < DM_COOLDOWN_MS) return;

      const ticketOwner = await client.users.fetch(ticket.user_id).catch(() => null);
      if (!ticketOwner) return;

      const preview = message.content?.trim()
        ? message.content.trim().slice(0, 1200)
        : "[attachment]";

      const channelName =
        (message.channel as any).name ?? (message.channelId ?? "DM");

      try {
        await ticketOwner.send(
          `You have a new staff reply in **${message.guild!.name}** ticket **#${channelName}**.\n\n` +
            `**${message.author.tag}:** ${preview}`
        );
      } catch (e) {
        console.warn(
          "[messageCreate] Staff reply DM failed:",
          ticket.user_id,
          (e as Error)?.message || e
        );
        dmCooldowns.set(cooldownKey, now);
        return;
      }

      dmCooldowns.set(cooldownKey, now);
    } catch (err) {
      console.error("[messageCreate] error:", (err as Error)?.stack || err);
    }
  }
};

export = event;
