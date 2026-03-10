const { Events } = require("discord.js");
const db = require("../database");

const dmCooldowns = new Map();
const DM_COOLDOWN_MS = 60 * 1000; // 1 min per ticket per user

module.exports = {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild) return;
      if (message.author.bot) return;
      if (!message.content?.trim() && !message.attachments.size) return;

      const ticket = await db.getTicketByChannel(message.channel.id);
      if (!ticket || ticket.status !== "open") return;

      // Do not DM if the ticket owner is the one speaking
      if (message.author.id === ticket.user_id) return;

      const cooldownKey = `${message.channel.id}:${ticket.user_id}`;
      const lastSent = dmCooldowns.get(cooldownKey) || 0;
      const now = Date.now();

      if (now - lastSent < DM_COOLDOWN_MS) return;

      const user = await client.users.fetch(ticket.user_id).catch(() => null);
      if (!user) return;

      await user.send(
        `New staff activity in your ticket **#${message.channel.name}** in **${message.guild.name}**.\n\n` +
        `**${message.author.tag}:** ${message.content?.slice(0, 1500) || "[attachment]"}`
      ).catch(() => {});

      dmCooldowns.set(cooldownKey, now);
    } catch (err) {
      console.error("[messageCreate] error:", err?.stack || err);
    }
  }
};
