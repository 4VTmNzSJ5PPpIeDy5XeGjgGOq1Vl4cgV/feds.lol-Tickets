import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction,
  type TextChannel
} from "discord.js";
import * as db from "../database";
import { scheduleTicketChannelDeletion } from "../lib/deleteTicketChannel";

const SUPPORT_ROLE_IDS: string[] = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

const CATEGORY_META = {
  general_support: {
    label: "General Support",
    emoji: "<:claim:1478268515117961226>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_GENERAL_SUPPORT",
    guidance:
      "Please include any details that will help us respond faster:\n" +
      "• What happened and when\n" +
      "• Relevant usernames / IDs\n" +
      "• Screenshots or links (if applicable)"
  },
  report_user: {
    label: "Report User",
    emoji: "<:report:1478268560471097354>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_REPORT_USER",
    guidance:
      "To help us investigate, please include:\n" +
      "• Who was involved (username, ID, or link)\n" +
      "• What rule was broken or what happened\n" +
      "• When it happened (date/time if possible)\n" +
      "• Screenshots, logs, or other evidence"
  },
  account_recovery: {
    label: "Account Recovery",
    emoji: "<:recovery:1478268585582268477>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_ACCOUNT_RECOVERY",
    guidance:
      "To recover your account, please provide:\n" +
      "• The email or username linked to the account\n" +
      "• When you last had access\n" +
      "• Any proof of ownership (e.g. past emails, receipts)\n" +
      "• How you lost access (if you know)"
  },
  purchase_billing: {
    label: "Purchase / Billing",
    emoji: "<:purchase:1478267209641099367>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_PURCHASE_BILLING",
    guidance:
      "To help with your purchase or billing issue, please include:\n" +
      "• What you purchased and when\n" +
      "• Transaction ID, receipt, or payment method (last 4 digits only)\n" +
      "• What went wrong (not received, wrong amount, refund, etc.)\n" +
      "• Any error messages or screenshots"
  },
  badge_application: {
    label: "Badge Application",
    emoji: "<:verified_application:1478268606620897391>",
    color: 0x4240ae,
    categoryEnv: "CATEGORY_BADGE_APPLICATION",
    guidance:
      "For your badge application, please include:\n" +
      "• Your feds.lol profile or handle\n" +
      "• Why you’re applying (notability, role, or criteria met)\n" +
      "• Links or proof that support your application\n" +
      "• Any other context that helps us review"
  }
} as const;

// Log which ticket categories have a channel ID set (so tickets go in the right Discord category)
const categoryStatus = Object.entries(CATEGORY_META).map(([key, meta]) => {
  const id = process.env[meta.categoryEnv]?.trim();
  return `${key}=${id ? "ok" : "MISSING"}`;
});
console.log("[tickets] Category channels:", categoryStatus.join(", "));

const claimedTickets = new Map<string, string>();
const escalatedTickets = new Set<string>();
const ticketCooldowns = new Map<string, number>();

const TICKET_COOLDOWN_MS = 30 * 1000;

async function sendLog(
  guild: Guild,
  channelName: string,
  user: { tag: string; id: string },
  action: "Opened" | "Closed",
  category?: string
) {
  const logId = process.env.LOG_CHANNEL_ID;
  if (!logId) return;

  const logChannel =
    guild.channels.cache.get(logId) ??
    (await guild.channels.fetch(logId).catch(() => null));
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

  logChannel.send({ embeds: [embed] }).catch((e) => {
    console.error("[tickets] logChannel.send failed:", e);
  });
}

function isSupportMember(interaction: Interaction): boolean {
  if (!interaction.isButton() && !interaction.isAnySelectMenu()) return false;
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;
  const roles = (member.roles as { cache: Map<string, unknown> }).cache;
  return SUPPORT_ROLE_IDS.some((id) => roles.has(id));
}

function describeInteraction(i: Interaction): string {
  const base = [
    `type=${i.type}`,
    `user=${(i as any).user?.id ?? "?"}`,
    `guild=${(i as any).guild?.id ?? "?"}`,
    `channel=${(i as any).channelId ?? "?"}`
  ];

  if (i.isButton()) base.push(`customId=${i.customId}`);
  if (i.isAnySelectMenu()) base.push(`customId=${i.customId}`);
  if (i.isModalSubmit()) base.push(`customId=${i.customId}`);
  if (i.isChatInputCommand()) base.push(`command=${i.commandName}`);

  return base.join(" ");
}

function startAckWatchdogAndFailsafe(i: Interaction): void {
  // Goal: prevent Discord "Interaction failed" even if DB/REST is slow.
  // - Watchdog: log if not acked quickly (so it shows on /logs).
  // - Failsafe: if still not acked, attempt a defer to keep UX responsive.
  if (!("isRepliable" in i) || typeof (i as any).isRepliable !== "function") return;
  if (!(i as any).isRepliable()) return;

  const repliable = i as unknown as { replied?: boolean; deferred?: boolean };

  // Log before the 3s Discord timeout window.
  setTimeout(() => {
    if (!repliable.replied && !repliable.deferred) {
      console.warn("[interaction] NOT ACKED IN TIME:", describeInteraction(i));
    }
  }, 2200);

  // Last-resort defer (only if handler hasn't already acknowledged).
  // Exclusions: showModal flows must NOT be deferred.
  const isTicketOpenMenu = i.isStringSelectMenu() && i.customId === "ticket_open";
  if (isTicketOpenMenu) return;

  setTimeout(() => {
    if (repliable.replied || repliable.deferred) return;

    if (i.isButton()) {
      // Defer update is safest for button interactions (allows followUp if needed).
      void i.deferUpdate().catch((e) => {
        console.error("[interaction] deferUpdate failsafe failed:", e);
      });
      return;
    }

    void (i as any)
      .deferReply({ flags: MessageFlags.Ephemeral })
      .catch((e: unknown) => {
        console.error("[interaction] deferReply failsafe failed:", e);
      });
  }, 2600);
}

function normaliseFedsUrl(input: string): string {
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

function extractFedsHandle(fedsUrl: string): string {
  const cleaned = fedsUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const parts = cleaned.split("/");
  return parts[1] || "user";
}

function slugify(value: string, max = 20): string {
  return (
    String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max) || "ticket"
  );
}

function buildChannelName(briefDescription: string, fedsUrl: string): string {
  const left = slugify(briefDescription, 20);
  const right = slugify(extractFedsHandle(fedsUrl), 20);
  return `${left}-${right}`.slice(0, 90);
}

async function closeTicket(
  client: Client,
  channel: TextChannel,
  guild: Guild,
  user: { tag: string; id: string },
  ticketOwnerId: string
) {
  const owner = await guild.members.fetch(ticketOwnerId).catch(() => null);

  try {
    await sendLog(guild, channel.name, owner?.user ?? user, "Closed");
  } catch (e) {
    console.error("sendLog failed:", e);
  }

  await db.closeTicketByChannel(channel.id).catch((e) => {
    console.error("DB close failed:", e);
  });

  scheduleTicketChannelDeletion(client, guild.id, channel.id, "button-close");
}

const event = {
  name: "interactionCreate",

  async execute(interaction: Interaction, client: Client & { commands?: any }) {
    startAckWatchdogAndFailsafe(interaction);

    // Slash commands
    if (interaction.isChatInputCommand()) {
      const command = client.commands?.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(
          interaction as ChatInputCommandInteraction,
          client
        );
      } catch (err) {
        console.error(err);
        const payload = {
          content: "An error occurred.",
          flags: MessageFlags.Ephemeral
        } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload as any).catch((e) => {
            console.error("[interaction] followUp failed:", e);
          });
        } else {
          await interaction.reply(payload as any).catch((e) => {
            console.error("[interaction] reply failed:", e);
          });
        }
      }
      return;
    }

    // Select menu -> show modal
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "ticket_open"
    ) {
      const value = interaction.values[0].trim().toLowerCase();
      const meta = (CATEGORY_META as any)[value];

      if (!meta) {
        return interaction.reply({
          content: "Unknown category.",
          flags: MessageFlags.Ephemeral
        });
      }

      const existing = await db.getOpenTicketByUser(
        interaction.guild!.id,
        interaction.user.id
      );
      if (existing) {
        return interaction.reply({
          content: `You already have an open ticket: <#${existing.channel_id}>`,
          flags: MessageFlags.Ephemeral
        });
      }

      const lastUsed = ticketCooldowns.get(interaction.user.id) || 0;
      const now = Date.now();
      if (now - lastUsed < TICKET_COOLDOWN_MS) {
        const seconds = Math.ceil(
          (TICKET_COOLDOWN_MS - (now - lastUsed)) / 1000
        );
        return interaction.reply({
          content: `Slow down. Wait ${seconds}s before opening another ticket.`,
          flags: MessageFlags.Ephemeral
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
        new ActionRowBuilder<TextInputBuilder>().addComponents(briefInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(fedsInput)
      );

      return interaction.showModal(modal);
    }

    // Modal submit -> create ticket
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("ticket_modal_")
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const categoryKey = interaction.customId.replace("ticket_modal_", "").trim();
      const meta = (CATEGORY_META as any)[categoryKey];
      const guild = interaction.guild!;
      const user = interaction.user;

      if (!meta) {
        return interaction.editReply({ content: "Unknown category." });
      }

      const existing = await db.getOpenTicketByUser(guild.id, user.id);
      if (existing) {
        return interaction.editReply({
          content: `You already have an open ticket: <#${existing.channel_id}>`
        });
      }

      const lastUsed = ticketCooldowns.get(user.id) || 0;
      const now = Date.now();
      if (now - lastUsed < TICKET_COOLDOWN_MS) {
        const seconds = Math.ceil(
          (TICKET_COOLDOWN_MS - (now - lastUsed)) / 1000
        );
        return interaction.editReply({
          content: `Slow down. Wait ${seconds}s before opening another ticket.`
        });
      }

      const briefDescription = interaction.fields
        .getTextInputValue("brief_description")
        .trim();

      let fedsUrl: string;
      try {
        fedsUrl = normaliseFedsUrl(
          interaction.fields.getTextInputValue("feds_url")
        );
      } catch (err) {
        return interaction.editReply({ content: (err as Error).message });
      }

      const supportRoleIds = SUPPORT_ROLE_IDS;
      const parentId = process.env[meta.categoryEnv]?.trim() || undefined;
      if (!parentId) {
        console.warn(
          `[tickets] No category set for "${categoryKey}". Add ${meta.categoryEnv}=<category_channel_id> to .env (right‑click the category in Discord → Copy ID).`
        );
      }
      const member = await guild.members.fetch(user.id);
      const channelName = buildChannelName(briefDescription, fedsUrl);

      const overwrites: any[] = [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: client.user!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        }
      ];

      for (const roleId of supportRoleIds) {
        const role =
          guild.roles.cache.get(roleId) ??
          (await guild.roles.fetch(roleId).catch(() => null));
        if (role) {
          overwrites.push({
            id: role.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks
            ]
          });
        }
      }

      const ticketChannel = (await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: overwrites,
        topic: `Ticket for ${user.tag} | Category: ${meta.label} | Feds: ${fedsUrl} | Brief: ${briefDescription}`
      })) as TextChannel;

      const ticketRecord = await db.createTicket({
        guildId: guild.id,
        channelId: ticketChannel.id,
        userId: user.id,
        username: user.tag,
        categoryKey,
        briefDescription,
        fedsUrl
      });

      try {
        await ticketChannel.setTopic(
          `Ticket #${ticketRecord.id} for ${user.tag} | Category: ${meta.label} | Feds: ${fedsUrl} | Brief: ${briefDescription}`
        );
      } catch {
        // ignore topic failures
      }

      ticketCooldowns.set(user.id, now);

      const guidance = (meta as { guidance?: string }).guidance ?? "";
      const openEmbed = new EmbedBuilder()
        .setTitle(`${meta.emoji} ${meta.label}`)
        .setDescription(
          `Welcome ${user}, thanks for reaching out.\n\n` +
            `A staff member will assist you soon.\n\n` +
            `> Press **Close Ticket** below if your issue is resolved.\n\n` +
            (guidance ? `${guidance}` : "")
        )
        .addFields(
          { name: "Ticket ID", value: `#${ticketRecord.id}`, inline: true },
          { name: "Category", value: meta.label, inline: true },
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

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        closeBtn,
        claimBtn,
        escalateBtn
      );

      const mentionContent = supportRoleIds.length
        ? supportRoleIds.map((id) => `<@&${id}>`).join(" ")
        : undefined;

      await ticketChannel.send({
        content: mentionContent,
        embeds: [openEmbed],
        components: [row]
      });

      await sendLog(guild, ticketChannel.name, user, "Opened", meta.label);

      return interaction.editReply({
        content: `Your ticket has been created: ${ticketChannel}`
      });
    }

    // Claim ticket
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("ticket_claim_")
    ) {
      const button = interaction as ButtonInteraction;
      const { channel, user } = button;
      if (!channel || !channel.isTextBased() || channel.isDMBased()) return;

      const isSupport = isSupportMember(button);
      const isAdmin = button.memberPermissions?.has(
        PermissionFlagsBits.ManageChannels
      );

      if (!isSupport && !isAdmin) {
        return button.reply({
          content: "Only staff can claim tickets.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (claimedTickets.has(channel.id)) {
        return button.reply({
          content: `This ticket is already claimed by **${claimedTickets.get(
            channel.id
          )}**.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // Acknowledge quickly; we'll post a visible message in-channel.
      await button.deferUpdate();

      claimedTickets.set(channel.id, user.tag);

      const msg = await channel.messages
        .fetch({ limit: 10 })
        .then((msgs) =>
          msgs.find((m) =>
            (m.components?.[0] as any)?.components?.some((c: any) =>
              c.customId?.startsWith("ticket_claim_")
            )
          )
        )
        .catch(() => null);

      if (msg) {
        const updatedRow: any = ActionRowBuilder.from(
          msg.components[0] as any
        ) as any;
        (updatedRow.components as any[]).forEach((btn: any) => {
          if (btn.data?.custom_id?.startsWith("ticket_claim_")) btn.setDisabled(true);
          if (
            escalatedTickets.has(channel.id) &&
            btn.data?.custom_id?.startsWith("ticket_escalate_")
          ) {
            btn.setDisabled(true);
          }
        });
        await msg.edit({ components: [updatedRow] }).catch((e) => {
          console.error("[tickets] claim msg.edit failed:", e);
        });
      }

      await channel
        .send({ content: `Ticket claimed by ${user}.` })
        .catch((e) => console.error("[tickets] claim channel.send failed:", e));
      return;
    }

    // Escalate ticket
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("ticket_escalate_")
    ) {
      const button = interaction as ButtonInteraction;
      const { channel, user } = button;
      if (!channel || !channel.isTextBased() || channel.isDMBased()) return;
      const escalateRoleId = "1457448238243254314";

      const isSupport = isSupportMember(button);
      const isAdmin = button.memberPermissions?.has(
        PermissionFlagsBits.ManageChannels
      );

      if (!isSupport && !isAdmin) {
        return button.reply({
          content: "Only staff can escalate tickets.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (!escalateRoleId) {
        return button.reply({
          content: "No escalation role is configured.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (escalatedTickets.has(channel.id)) {
        return button.reply({
          content: "This ticket has already been escalated.",
          flags: MessageFlags.Ephemeral
        });
      }

      // Acknowledge quickly; we'll post a visible message in-channel.
      await button.deferUpdate();

      escalatedTickets.add(channel.id);

      const msg = await channel.messages
        .fetch({ limit: 10 })
        .then((msgs) =>
          msgs.find((m) =>
            (m.components?.[0] as any)?.components?.some((c: any) =>
              c.customId?.startsWith("ticket_escalate_")
            )
          )
        )
        .catch(() => null);

      if (msg) {
        const updatedRow: any = ActionRowBuilder.from(
          msg.components[0] as any
        ) as any;
        (updatedRow.components as any[]).forEach((btn: any) => {
          if (btn.data?.custom_id?.startsWith("ticket_escalate_")) {
            btn.setDisabled(true);
          }
          if (
            claimedTickets.has(channel.id) &&
            btn.data?.custom_id?.startsWith("ticket_claim_")
          ) {
            btn.setDisabled(true);
          }
        });
        await msg.edit({ components: [updatedRow] }).catch((e) => {
          console.error("[tickets] escalate msg.edit failed:", e);
        });
      }

      await channel
        .send({ content: `Ticket escalated by ${user}. <@&${escalateRoleId}>` })
        .catch((e) => console.error("[tickets] escalate channel.send failed:", e));
      return;
    }

    // Close ticket prompt
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("ticket_close_")
    ) {
      const button = interaction as ButtonInteraction;
      const { channel, user, guild } = button;
      if (!channel || !guild || !channel.isTextBased() || channel.isDMBased())
        return;
      const ticketOwnerId = button.customId.replace("ticket_close_", "");

      const isOwner = user.id === ticketOwnerId;
      const isSupport = isSupportMember(button);
      const isAdmin = button.memberPermissions?.has(
        PermissionFlagsBits.ManageChannels
      );

      if (!isOwner && !isSupport && !isAdmin) {
        return button.reply({
          content: "You don't have permission to close this ticket.",
          flags: MessageFlags.Ephemeral
        });
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle("Close Ticket?")
        .setDescription(
          "Are you sure you want to close this ticket? This cannot be undone."
        )
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

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmBtn,
        transcriptBtn,
        cancelBtn
      );

      return button.reply({
        embeds: [confirmEmbed],
        components: [row],
        flags: MessageFlags.Ephemeral
      });
    }

    // Create transcript
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("ticket_transcript_")
    ) {
      const button = interaction as ButtonInteraction;
      await button.deferReply({ flags: MessageFlags.Ephemeral });

      const { channel, guild, user } = button;
      if (!channel || !guild || !channel.isTextBased() || channel.isDMBased()) {
        return button.editReply({ content: "Invalid channel for transcript." });
      }

      const ticket = await db.getTicketByChannel(channel.id);

      if (!ticket) {
        return button.editReply({
          content: "No ticket record found for this channel."
        });
      }

      try {
        let lastId: string | undefined;
        const allMessages: any[] = [];

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const options: { limit: number; before?: string } = { limit: 100 };
          if (lastId) options.before = lastId;

          const batch = await channel.messages.fetch(options);
          if (!batch.size) break;

          const batchArray = [...batch.values()];
          allMessages.push(...batchArray);

          if (batch.size < 100) break;
          if (allMessages.length >= 5000) break;

          lastId = batchArray[batchArray.length - 1].id;
          await new Promise((r) => setTimeout(r, 120));
        }

        const content = allMessages
          .slice(0, 5000)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => {
            const msgContent =
              m.content?.trim() ||
              (m.attachments.size ? "[attachment]" : "[no text]");
            return `[${m.createdAt.toISOString()}] ${m.author.tag}: ${msgContent}`;
          })
          .join("\n");

        const savedTranscript = await db.saveTranscript(
          channel.name,
          user.tag,
          content
        );

        const transcriptBaseUrl = process.env.TRANSCRIPT_BASE_URL?.trim();
        const transcriptViewKey = process.env.TRANSCRIPT_VIEW_KEY?.trim();

        let renderTranscriptUrl: string | null = null;
        if (transcriptBaseUrl && transcriptViewKey && savedTranscript?.id) {
          renderTranscriptUrl =
            `${transcriptBaseUrl.replace(/\/+$/, "")}` +
            `/transcripts/${savedTranscript.id}?key=${encodeURIComponent(
              transcriptViewKey
            )}`;
        }

        const logId = process.env.LOG_CHANNEL_ID;
        if (logId) {
          const logChannel =
            guild.channels.cache.get(logId) ??
            (await guild.channels.fetch(logId).catch(() => null));

          if (logChannel?.isTextBased()) {
            const logEmbed = new EmbedBuilder()
              .setTitle("Transcript Saved")
              .addFields(
                { name: "Ticket ID", value: `#${ticket.id}`, inline: true },
                { name: "User", value: `<@${ticket.user_id}>`, inline: true },
                { name: "Channel", value: channel.name, inline: true },
                { name: "Saved By", value: `${user} (${user.tag})`, inline: true },
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
                value: `[Open in Render dashboard](${renderTranscriptUrl})`
              });
            }

            await logChannel.send({ embeds: [logEmbed] }).catch((e) => {
              console.error("[tickets] transcript logChannel.send failed:", e);
            });
          }
        }

        return button.editReply({
          content: "Transcript saved and logged to the dashboard."
        });
      } catch (e) {
        console.error("Transcript save failed:", e);
        return button.editReply({ content: "Failed to save transcript." });
      }
    }

    // Confirm close
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("ticket_confirm_close_")
    ) {
      const button = interaction as ButtonInteraction;
      const { channel, guild, user } = button;
      if (!channel || !guild || !channel.isTextBased() || channel.isDMBased())
        return;

      // Always acknowledge first (DB calls can exceed Discord's 3s interaction window)
      await button.deferUpdate();

      const dbTicket = await db.getTicketByChannel(channel.id).catch(() => null);
      if (!dbTicket) {
        return button
          .followUp({
            content: "No ticket record found for this channel.",
            flags: MessageFlags.Ephemeral
          })
          .catch((e) => {
            console.error("[tickets] confirm close followUp failed:", e);
          });
      }
      if (dbTicket.status !== "open") {
        return button
          .followUp({
            content: "This ticket is already closed.",
            flags: MessageFlags.Ephemeral
          })
          .catch((e) => {
            console.error("[tickets] confirm close followUp failed:", e);
          });
      }

      const closeEmbed = new EmbedBuilder()
        .setTitle("Ticket Closed")
        .setDescription(
          `Closed by ${user}. This channel will be deleted in **5 seconds**.`
        )
        .setColor(0x4240ae)
        .setTimestamp();

      try {
        await channel.send({ embeds: [closeEmbed] });
      } catch (e) {
        console.error("[ticket] Could not send close embed:", e);
      }

      claimedTickets.delete(channel.id);
      escalatedTickets.delete(channel.id);

      await closeTicket(
        client,
        channel as TextChannel,
        guild,
        user,
        dbTicket.user_id
      );
      return;
    }

    // Cancel close
    if (
      interaction.isButton() &&
      interaction.customId === "ticket_cancel_close"
    ) {
      const button = interaction as ButtonInteraction;
      return button.update({
        content: "Ticket closure cancelled.",
        embeds: [],
        components: []
      });
    }
  }
};

export = event;

