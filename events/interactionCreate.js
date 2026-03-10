const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const db = require("../database.js");

const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

const CATEGORY_META = {
  general_support: {
    label: "General Support",
    emoji: "<:claim:1478268515117961226>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_GENERAL_SUPPORT",
  },
  report_user: {
    label: "Report User",
    emoji: "<:report:1478268560471097354>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_REPORT_USER",
  },
  account_recovery: {
    label: "Account Recovery",
    emoji: "<:recovery:1478268585582268477>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_ACCOUNT_RECOVERY",
  },
  purchase_billing: {
    label: "Purchase / Billing",
    emoji: "<:purchase:1478267209641099367>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_PURCHASE_BILLING",
  },
  badge_application: {
    label: "Badge Application",
    emoji: "<:verified_application:1478268606620897391>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_BADGE_APPLICATION",
  },
};

const claimedTickets = new Map();
const escalatedTickets = new Set();
const ticketCooldowns = new Map();

const TICKET_COOLDOWN_MS = 30 * 1000;

async function sendLog(guild, channelName, user, action, category) {
  const logId = process.env.LOG_CHANNEL_ID;
  if (!logId) return;

  const logChannel = guild.channels.cache.get(logId) ?? await guild.channels.fetch(logId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(`Ticket ${action}`)
    .addFields(
      { name: "User", value: `${user.tag} (${user.id})`, inline: true },
      { name: "Channel", value: channelName, inline: true }
    )
    .setColor(action === "Opened" ? 0x57f287 : 0xed4245)
    .setTimestamp();

  if (category) embed.addFields({ name: "Category", value: category, inline: true });

  logChannel.send({ embeds: [embed] }).catch(() => {});
}

function isSupportMember(interaction) {
  return SUPPORT_ROLE_IDS.some((id) => interaction.member.roles.cache.has(id));
}

function normaliseFedsUrl(input) {
  let value = String(input || "").trim();

  value = value.replace(/^@/, "");
  value = value.replace(/^https?:\/\//i, "");
  value = value.replace(/^www\./i, "");

  if (value.startsWith("feds.lol/")) return value;

  if (/^[a-zA-Z0-9._-]+$/.test(value)) {
    return `feds.lol/${value}`;
  }

  throw new Error("Please enter a valid Feds handle or feds.lol link.");
}

function extractFedsHandle(fedsUrl) {
  const cleaned = fedsUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const parts = cleaned.split("/");
  return parts[1] || "user";
}

function slugify(value, max = 20) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max) || "ticket";
}

function buildChannelName(briefDescription, fedsUrl) {
  const left = slugify(briefDescription, 20);
  const right = slugify(extractFedsHandle(fedsUrl), 20);
  return `${left}-${right}`.slice(0, 90);
}

async function closeTicket(channel, guild, user, ticketOwnerId) {
  const owner = await guild.members.fetch(ticketOwnerId).catch(() => null);

  try {
    await sendLog(guild, channel.name, owner?.user ?? user, "Closed");
  } catch (e) {
    console.error("sendLog failed:", e);
  }

  await db.closeTicketByChannel(channel.id).catch((e) => {
    console.error("DB close failed:", e);
  });

  setTimeout(() => channel.delete().catch((e) => console.error("Delete failed:", e)), 5000);
}

module.exports = {
  name: "interactionCreate",

  async execute(interaction, client) {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction, client);
      } catch (err) {
        console.error(err);
        const payload = { content: "An error occurred.", ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
      return;
    }

    // Select menu -> show modal
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_open") {
      const value = interaction.values[0].toLowerCase();
      const meta = CATEGORY_META[value];

      if (!meta) {
        return interaction.reply({
          content: "Unknown category.",
          ephemeral: true,
        });
      }

      const existing = await db.getOpenTicketByUser(interaction.guild.id, interaction.user.id);
      if (existing) {
        return interaction.reply({
          content: `You already have an open ticket: <#${existing.channel_id}>`,
          ephemeral: true,
        });
      }

      const lastUsed = ticketCooldowns.get(interaction.user.id) || 0;
      const now = Date.now();
      if (now - lastUsed < TICKET_COOLDOWN_MS) {
        const seconds = Math.ceil((TICKET_COOLDOWN_MS - (now - lastUsed)) / 1000);
        return interaction.reply({
          content: `Slow down. Wait ${seconds}s before opening another ticket.`,
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ticket_modal_${value}`)
        .setTitle(meta.label);

      const briefInput = new TextInputBuilder()
        .setCustomId("brief_description")
        .setLabel("Brief description")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(80)
        .setPlaceholder("Login issue, billing issue, profile bug...");

      const fedsInput = new TextInputBuilder()
        .setCustomId("feds_url")
        .setLabel("Feds URL / link")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(100)
        .setPlaceholder("feds.lol/dx or just dx");

      modal.addComponents(
        new ActionRowBuilder().addComponents(briefInput),
        new ActionRowBuilder().addComponents(fedsInput)
      );

      return interaction.showModal(modal);
    }

    // Modal submit -> create ticket
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket_modal_")) {
      await interaction.deferReply({ ephemeral: true });

      const categoryKey = interaction.customId.replace("ticket_modal_", "");
      const meta = CATEGORY_META[categoryKey];
      const { guild, user } = interaction;

      if (!meta) {
        return interaction.editReply({ content: "Unknown category." });
      }

      const existing = await db.getOpenTicketByUser(guild.id, user.id);
      if (existing) {
        return interaction.editReply({
          content: `You already have an open ticket: <#${existing.channel_id}>`,
        });
      }

      const lastUsed = ticketCooldowns.get(user.id) || 0;
      const now = Date.now();
      if (now - lastUsed < TICKET_COOLDOWN_MS) {
        const seconds = Math.ceil((TICKET_COOLDOWN_MS - (now - lastUsed)) / 1000);
        return interaction.editReply({
          content: `Slow down. Wait ${seconds}s before opening another ticket.`,
        });
      }

      const briefDescription = interaction.fields.getTextInputValue("brief_description").trim();

      let fedsUrl;
      try {
        fedsUrl = normaliseFedsUrl(interaction.fields.getTextInputValue("feds_url"));
      } catch (err) {
        return interaction.editReply({ content: err.message });
      }

      const supportRoleIds = SUPPORT_ROLE_IDS;
      const parentId = process.env[meta.categoryEnv] || null;
      const member = await guild.members.fetch(user.id);
      const channelName = buildChannelName(briefDescription, fedsUrl);

      const overwrites = [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
      ];

      for (const roleId of supportRoleIds) {
        const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
        if (role) {
          overwrites.push({
            id: role.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          });
        }
      }

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        topic: `Ticket for ${user.tag} | Category: ${meta.label} | Feds: ${fedsUrl} | Brief: ${briefDescription}`,
      });

      await db.createTicket({
        guildId: guild.id,
        channelId: ticketChannel.id,
        userId: user.id,
        username: user.tag,
        categoryKey,
        briefDescription,
        fedsUrl,
      });

      ticketCooldowns.set(user.id, now);

      const openEmbed = new EmbedBuilder()
        .setTitle(`${meta.emoji} ${meta.label}`)
        .setDescription(
          `Welcome ${user}, thanks for reaching out.\n\n` +
          `A staff member will assist you soon.\n\n` +
          `> Press **Close Ticket** below if your issue is resolved.`
        )
        .addFields(
          { name: "Brief Description", value: briefDescription, inline: false },
          { name: "Feds URL", value: fedsUrl, inline: false }
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
        content: supportRoleIds.map((id) => `<@&${id}>`).join(" ") || null,
        embeds: [openEmbed],
        components: [row],
      });

      await sendLog(guild, ticketChannel.name, user, "Opened", meta.label);

      return interaction.editReply({
        content: `Your ticket has been created: ${ticketChannel}`,
      });
    }

    // Claim ticket
    if (interaction.isButton() && interaction.customId.startsWith("ticket_claim_")) {
      const { channel, user } = interaction;

      const isSupport = isSupportMember(interaction);
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

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

      const msg = await channel.messages.fetch({ limit: 10 }).then((msgs) =>
        msgs.find((m) => m.components?.[0]?.components?.some((c) => c.customId?.startsWith("ticket_claim_")))
      ).catch(() => null);

      if (msg) {
        const updatedRow = ActionRowBuilder.from(msg.components[0]);
        updatedRow.components.forEach((btn) => {
          if (btn.data.custom_id?.startsWith("ticket_claim_")) btn.setDisabled(true);
          if (escalatedTickets.has(channel.id) && btn.data.custom_id?.startsWith("ticket_escalate_")) btn.setDisabled(true);
        });
        await msg.edit({ components: [updatedRow] }).catch(() => {});
      }

      return interaction.reply({ content: `Ticket claimed by ${user}.` });
    }

    // Escalate ticket
    if (interaction.isButton() && interaction.customId.startsWith("ticket_escalate_")) {
      const { channel, user } = interaction;
      const escalateRoleId = "1457448238243254314";

      const isSupport = isSupportMember(interaction);
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

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

      const msg = await channel.messages.fetch({ limit: 10 }).then((msgs) =>
        msgs.find((m) => m.components?.[0]?.components?.some((c) => c.customId?.startsWith("ticket_escalate_")))
      ).catch(() => null);

      if (msg) {
        const updatedRow = ActionRowBuilder.from(msg.components[0]);
        updatedRow.components.forEach((btn) => {
          if (btn.data.custom_id?.startsWith("ticket_escalate_")) btn.setDisabled(true);
          if (claimedTickets.has(channel.id) && btn.data.custom_id?.startsWith("ticket_claim_")) btn.setDisabled(true);
        });
        await msg.edit({ components: [updatedRow] }).catch(() => {});
      }

      return interaction.reply({
        content: `Ticket escalated by ${user}. <@&${escalateRoleId}>`,
      });
    }

    // Close ticket prompt
    if (interaction.isButton() && interaction.customId.startsWith("ticket_close_")) {
      const { channel, user } = interaction;
      const ticketOwnerId = interaction.customId.replace("ticket_close_", "");

      const isOwner = user.id === ticketOwnerId;
      const isSupport = isSupportMember(interaction);
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

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

    // Create transcript
    if (interaction.isButton() && interaction.customId.startsWith("ticket_transcript_")) {
  await interaction.deferReply({ ephemeral: true });

  const { channel, guild, user } = interaction;
  const ticket = await db.getTicketByChannel(channel.id);

  if (!ticket) {
    return interaction.editReply({ content: "No ticket record found for this channel." });
  }

  try {
    let lastId;
    const allMessages = [];

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const batch = await channel.messages.fetch(options);
      if (!batch.size) break;

      const batchArray = [...batch.values()];
      allMessages.push(...batchArray);

      if (batch.size < 100) break;
      if (allMessages.length >= 5000) break;

      lastId = batchArray[batchArray.length - 1].id;
    }

    const content = allMessages
      .slice(0, 5000)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => {
        const msgContent = m.content?.trim() || (m.attachments.size ? "[attachment]" : "[no text]");
        return `[${m.createdAt.toISOString()}] ${m.author.tag}: ${msgContent}`;
      })
      .join("\n");

    const savedTranscript = await db.saveTranscript(channel.name, user.tag, content);

    const transcriptBaseUrl = process.env.TRANSCRIPT_BASE_URL?.trim();
    const transcriptViewKey = process.env.TRANSCRIPT_VIEW_KEY?.trim();

    let renderTranscriptUrl = null;
    if (transcriptBaseUrl && transcriptViewKey && savedTranscript?.id) {
      renderTranscriptUrl =
        `${transcriptBaseUrl.replace(/\/+$/, "")}` +
        `/transcripts/${savedTranscript.id}?key=${encodeURIComponent(transcriptViewKey)}`;
    }

    const logId = process.env.LOG_CHANNEL_ID;
    if (logId) {
      const logChannel =
        guild.channels.cache.get(logId) ??
        await guild.channels.fetch(logId).catch(() => null);

      if (logChannel?.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setTitle("Transcript Saved")
          .addFields(
            { name: "Channel", value: channel.name, inline: true },
            { name: "Saved By", value: user.tag, inline: true },
            { name: "Ticket Owner", value: `<@${ticket.user_id}>`, inline: true },
            { name: "Category", value: ticket.category_key, inline: true },
            {
              name: "Brief Description",
              value: ticket.brief_description?.slice(0, 1024) || "N/A",
              inline: false
            },
            {
              name: "Feds URL",
              value: ticket.feds_url?.slice(0, 1024) || "N/A",
              inline: false
            }
          )
          .setColor(0x4240ae)
          .setTimestamp();

        if (renderTranscriptUrl) {
          logEmbed.addFields({
            name: "Dashboard Transcript",
            value: `[Open in Render dashboard](${renderTranscriptUrl})`,
          });
        }

        await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      }
    }

    return interaction.editReply({
      content: renderTranscriptUrl
        ? `Transcript saved. Dashboard link: ${renderTranscriptUrl}`
        : "Transcript saved to database."
    });
  } catch (e) {
    console.error("Transcript save failed:", e);
    return interaction.editReply({ content: "Failed to save transcript." });
  }
}
    // Confirm close
    if (interaction.isButton() && interaction.customId.startsWith("ticket_confirm_close_")) {
      await interaction.deferUpdate();

      const { channel, guild, user } = interaction;
      const dbTicket = await db.getTicketByChannel(channel.id);
      const ticketOwnerId = dbTicket?.user_id || interaction.customId.replace("ticket_confirm_close_", "");

      const closeEmbed = new EmbedBuilder()
        .setTitle("Ticket Closed")
        .setDescription(`Closed by ${user}. This channel will be deleted in **5 seconds**.`)
        .setColor(0x4240ae)
        .setTimestamp();

      await channel.send({ embeds: [closeEmbed] });

      claimedTickets.delete(channel.id);
      escalatedTickets.delete(channel.id);

      await closeTicket(channel, guild, user, ticketOwnerId);
      return;
    }

    // Cancel close
    if (interaction.isButton() && interaction.customId === "ticket_cancel_close") {
      return interaction.update({
        content: "Ticket closure cancelled.",
        embeds: [],
        components: [],
      });
    }
  },
};
