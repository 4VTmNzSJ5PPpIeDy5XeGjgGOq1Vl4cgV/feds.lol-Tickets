const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const db = require("../database.js");

const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map(id => id.trim())
  : [];

const CATEGORY_META = {
  general_support:    { label: "General Support",      emoji: "<:claim:1478268515117961226>",                color: 0x4240ae, categoryEnv: "CATEGORY_GENERAL_SUPPORT" },
  report_user:        { label: "Report User",           emoji: "<:report:1478268560471097354>",               color: 0x4240ae, categoryEnv: "CATEGORY_REPORT_USER" },
  account_recovery:   { label: "Account Recovery",      emoji: "<:recovery:1478268585582268477>",             color: 0x4240ae, categoryEnv: "CATEGORY_ACCOUNT_RECOVERY" },
  purchase_billing:   { label: "Purchase / Billing",    emoji: "<:purchase:1478267209641099367>",             color: 0x4240ae, categoryEnv: "CATEGORY_PURCHASE_BILLING" },
  badge_application:  { label: "Badge Application",     emoji: "<:verified_application:1478268606620897391>", color: 0x4240ae, categoryEnv: "CATEGORY_BADGE_APPLICATION" },
};

const CHANNEL_NAME_MAP = {
  general_support:   "support",
  report_user:       "user",
  account_recovery:  "recovery",
  purchase_billing:  "billing",
  badge_application: "badge",
};

// userId -> channelId  (in-memory; resets on bot restart)
const openTickets = new Map();

// channelId -> claimedBy user tag
const claimedTickets = new Map();

// channelId -> true if escalated
const escalatedTickets = new Set();

let ticketCounter = 1;

async function sendLog(guild, channelName, user, action, category) {
  const logId = process.env.LOG_CHANNEL_ID;
  if (!logId) return;

  const logChannel = guild.channels.cache.get(logId) ?? await guild.channels.fetch(logId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(`Ticket ${action}`)
    .addFields(
      { name: "User",    value: `${user.tag} (${user.id})`, inline: true },
      { name: "Channel", value: channelName,                inline: true }
    )
    .setColor(action === "Opened" ? 0x57f287 : 0xed4245)
    .setTimestamp();

  if (category) embed.addFields({ name: "Category", value: category, inline: true });

  logChannel.send({ embeds: [embed] }).catch(() => {});
}

async function closeTicket(channel, guild, user, ticketOwnerId) {
  const owner = await guild.members.fetch(ticketOwnerId).catch(() => null);

  try { await sendLog(guild, channel.name, owner?.user ?? user, "Closed"); } catch (e) { console.error("sendLog failed:", e); }

  setTimeout(() => channel.delete().catch(e => console.error("Delete failed:", e)), 5000);
}

module.exports = {
  name: "interactionCreate",

  async execute(interaction, client) {

    // ── Slash commands ──────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction, client);
      } catch (err) {
        console.error(err);
        const payload = { content: "An error occurred.", ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      }
      return;
    }

    // ── Select menu — open ticket ───────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_open") {
      await interaction.deferReply({ ephemeral: true });

      const value = interaction.values[0].toLowerCase();
      const meta  = CATEGORY_META[value];
      const { guild, user } = interaction;

      if (!meta) {
        return interaction.editReply({ content: "Unknown category." });
      }

      if (openTickets.has(user.id)) {
        const existing = guild.channels.cache.get(openTickets.get(user.id));
        if (existing) {
          return interaction.editReply({
            content: `You already have an open ticket: ${existing}.`,
          });
        }
        openTickets.delete(user.id);
      }

      const supportRoleIds = SUPPORT_ROLE_IDS;
      const parentId       = process.env[meta.categoryEnv] || null;

      const member = await guild.members.fetch(user.id);

      const overwrites = [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      for (const roleId of supportRoleIds) {
        const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
        if (role) {
          overwrites.push({
            id: role,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageMessages,
            ],
          });
        }
      }

      const channelName = `${CHANNEL_NAME_MAP[value] ?? value.replace(/_/g, "-")}-${ticketCounter++}`;

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        topic: `Ticket for ${user.tag} | Category: ${meta.label}`,
      });

      openTickets.set(user.id, ticketChannel.id);

      const openEmbed = new EmbedBuilder()
        .setTitle(`${meta.emoji} ${meta.label}`)
        .setDescription(
          `Welcome ${user}, thanks for reaching out!\n\n` +
          `Please describe your issue and a staff member will assist you soon.\n\n` +
          `> Press **Close Ticket** below to close this ticket.`
        )
        .setColor(meta.color)
        .setFooter({ text: `Opened by ${user.tag}` })
        .setTimestamp();

      const closeBtn = new ButtonBuilder()
        .setCustomId(`ticket_close_${user.id}`)
        .setLabel("Close Ticket")
        .setEmoji("<:close:1480625255130075417>")
        .setStyle(ButtonStyle.Secondary);

      const claimBtn = new ButtonBuilder()
        .setCustomId(`ticket_claim_${user.id}`)
        .setLabel("Claim")
        .setEmoji({ id: "1478268515117961226", name: "claim" })
        .setStyle(ButtonStyle.Secondary);

      const escalateBtn = new ButtonBuilder()
        .setCustomId(`ticket_escalate_${user.id}`)
        .setLabel("Escalate")
        .setEmoji({ id: "1478268560471097354", name: "report" })
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(closeBtn, claimBtn, escalateBtn);

      await ticketChannel.send({
        content: supportRoleIds.map(id => `<@&${id}>`).join(" ") || null,
        embeds: [openEmbed],
        components: [row],
      });

      await sendLog(guild, ticketChannel.name, user, "Opened", meta.label);

      return interaction.editReply({
        content: `Your ticket has been created: ${ticketChannel}`,
      });
    }

    // ── Button — claim ticket ───────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("ticket_claim_")) {
      const { channel, user } = interaction;
      const supportRoleIds = SUPPORT_ROLE_IDS;

      const isSupport = supportRoleIds.some(id => interaction.member.roles.cache.has(id));
      const isAdmin   = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isSupport && !isAdmin) {
        return interaction.reply({ content: "Only staff can claim tickets.", ephemeral: true });
      }

      if (claimedTickets.has(channel.id)) {
        return interaction.reply({
          content: `This ticket is already claimed by **${claimedTickets.get(channel.id)}**.`,
          ephemeral: true,
        });
      }

      claimedTickets.set(channel.id, user.tag);

      const msg = await channel.messages.fetch({ limit: 10 }).then(msgs =>
        msgs.find(m => m.components?.[0]?.components?.some(c => c.customId?.startsWith("ticket_claim_")))
      ).catch(() => null);

      if (msg) {
        const updatedRow = ActionRowBuilder.from(msg.components[0]);
        updatedRow.components.forEach(btn => {
          if (btn.data.custom_id?.startsWith("ticket_claim_")) btn.setDisabled(true);
          if (escalatedTickets.has(channel.id) && btn.data.custom_id?.startsWith("ticket_escalate_")) btn.setDisabled(true);
        });
        await msg.edit({ components: [updatedRow] }).catch(() => {});
      }

      await interaction.reply({ content: `Ticket claimed by ${user}.` });
    }

    // ── Button — escalate ticket ────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("ticket_escalate_")) {
      const { channel, user } = interaction;
      const supportRoleIds = SUPPORT_ROLE_IDS;
      const escalateRoleId = process.env.ESCALATE_ROLE_ID;

      const isSupport = supportRoleIds.some(id => interaction.member.roles.cache.has(id));
      const isAdmin   = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isSupport && !isAdmin) {
        return interaction.reply({ content: "Only staff can escalate tickets.", ephemeral: true });
      }

      if (!escalateRoleId) {
        return interaction.reply({ content: "No escalation role is configured.", ephemeral: true });
      }

      if (escalatedTickets.has(channel.id)) {
        return interaction.reply({ content: "This ticket has already been escalated.", ephemeral: true });
      }

      escalatedTickets.add(channel.id);

      const msg = await channel.messages.fetch({ limit: 10 }).then(msgs =>
        msgs.find(m => m.components?.[0]?.components?.some(c => c.customId?.startsWith("ticket_escalate_")))
      ).catch(() => null);

      if (msg) {
        const updatedRow = ActionRowBuilder.from(msg.components[0]);
        updatedRow.components.forEach(btn => {
          if (btn.data.custom_id?.startsWith("ticket_escalate_")) btn.setDisabled(true);
          if (claimedTickets.has(channel.id) && btn.data.custom_id?.startsWith("ticket_claim_")) btn.setDisabled(true);
        });
        await msg.edit({ components: [updatedRow] }).catch(() => {});
      }

      await interaction.reply({
        content: `Ticket escalated by ${user}. <@&${escalateRoleId}>`,
      });
    }

    // ── Button — close ticket (shows confirmation) ──────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("ticket_close_")) {
      const { channel, guild, user } = interaction;
      const ticketOwnerId  = interaction.customId.replace("ticket_close_", "");
      const supportRoleIds = SUPPORT_ROLE_IDS;

      const isOwner   = user.id === ticketOwnerId;
      const isSupport = supportRoleIds.some(id => interaction.member.roles.cache.has(id));
      const isAdmin   = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isOwner && !isSupport && !isAdmin) {
        return interaction.reply({
          content: "You don't have permission to close this ticket.",
          ephemeral: true,
        });
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle("Close Ticket?")
        .setDescription("Are you sure you want to close this ticket? This cannot be undone.")
        .setColor(0x4240ae);

      const confirmBtn = new ButtonBuilder()
        .setCustomId(`ticket_confirm_close_${ticketOwnerId}`)
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Danger);

      const transcriptBtn = new ButtonBuilder()
        .setCustomId(`ticket_transcript_${ticketOwnerId}`)
        .setLabel("Create Transcript")
        .setEmoji("📄")
        .setStyle(ButtonStyle.Secondary);

      const cancelBtn = new ButtonBuilder()
        .setCustomId("ticket_cancel_close")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(confirmBtn, transcriptBtn, cancelBtn);

      return interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true });
    }

    // ── Button — create transcript ──────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("ticket_transcript_")) {
      await interaction.deferReply({ ephemeral: true });

      const { channel, user } = interaction;

      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const content = messages
          .reverse()
          .map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`)
          .join("\n");

        await db.saveTranscript(channel.name, user.tag, content);

        await interaction.editReply({ content: "Transcript saved to database." });
      } catch (e) {
        console.error("Transcript save failed:", e);
        await interaction.editReply({ content: "Failed to save transcript." });
      }
    }

    // ── Button — confirm close ──────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("ticket_confirm_close_")) {
      await interaction.deferUpdate();

      const { channel, guild, user } = interaction;
      const ticketOwnerId = interaction.customId.replace("ticket_confirm_close_", "");

      const closeEmbed = new EmbedBuilder()
        .setTitle("Ticket Closed")
        .setDescription(`Closed by ${user}. This channel will be deleted in **5 seconds**.`)
        .setColor(0x4240ae)
        .setTimestamp();

      await channel.send({ embeds: [closeEmbed] });

      openTickets.delete(ticketOwnerId);
      claimedTickets.delete(channel.id);
      escalatedTickets.delete(channel.id);
      await closeTicket(channel, guild, user, ticketOwnerId);
    }

    // ── Button — cancel close ───────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId === "ticket_cancel_close") {
      return interaction.update({
        content: "Ticket closure cancelled.",
        embeds: [],
        components: [],
      });
    }
  },
};

