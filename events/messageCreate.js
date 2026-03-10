const db = require("../database.js");

const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

const dmCooldowns = new Map();
const DM_COOLDOWN_MS = 60 * 1000;

function isSupportMessage(message) {
  return SUPPORT_ROLE_IDS.some((roleId) => message.member?.roles?.cache?.has(roleId));
}

module.exports = {
  name: "messageCreate",

  async execute(message, client) {
    try {
      if (!message.guild) return;
      if (message.author.bot) return;

      const ticket = await db.getTicketByChannel(message.channel.id);
      if (!ticket || ticket.status !== "open") return;

      if (message.author.id === ticket.user_id) return;

      const isStaff = isSupportMessage(message) ||
        message.member?.permissions?.has("ManageChannels");

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

      await ticketOwner.send(
        `You have a new staff reply in **${message.guild.name}** ticket **#${message.channel.name}**.\n\n` +
        `**${message.author.tag}:** ${preview}`
      ).catch(() => {});

      dmCooldowns.set(cooldownKey, now);
    } catch (err) {
      console.error("[messageCreate] error:", err?.stack || err);
    }
  },
};
