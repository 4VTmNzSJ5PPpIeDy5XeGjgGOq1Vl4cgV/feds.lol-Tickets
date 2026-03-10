const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const db = require("../database.js");

const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

async function fetchAllMessages(channel, batchSize = 100, maxMessages = 5000) {
  const all = [];
  let lastId;

  while (true) {
    const options = { limit: batchSize };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);
    if (!batch.size) break;

    const batchArray = [...batch.values()];
    all.push(...batchArray);

    if (all.length >= maxMessages) break;
    if (batch.size < batchSize) break;

    lastId = batchArray[batchArray.length - 1].id;
  }

  return all
    .slice(0, maxMessages)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current ticket."),

  async execute(interaction) {
    const { channel, guild, member, user } = interaction;

    const ticket = await db.getTicketByChannel(channel.id);

    if (!ticket || ticket.status !== "open") {
      return interaction.reply({
        content: "This command can only be used inside an open ticket.",
        ephemeral: true,
      });
    }

    const isSupport = SUPPORT_ROLE_IDS.some((id) => member.roles.cache.has(id));
    const isAdmin = member.permissions.has(PermissionFlagsBits.ManageChannels);
    const isOwner = user.id === ticket.user_id;

    if (!isOwner && !isSupport && !isAdmin) {
      return interaction.reply({
        content: "You don't have permission to close this ticket.",
        ephemeral: true,
      });
    }

    const closeEmbed = new EmbedBuilder()
      .setTitle("Ticket Closed")
      .setDescription(`Closed by ${user}. This channel will be deleted in **5 seconds**.`)
      .setColor(0x4240ae)
      .setTimestamp();

    await interaction.reply({ embeds: [closeEmbed] });

    let savedTranscript = null;
    let renderTranscriptUrl = null;

    try {
      const messages = await fetchAllMessages(channel, 100, 5000);

      const textTranscript = messages
        .map((m) => {
          const content = m.content?.trim() || (m.attachments.size ? "[attachment]" : "[no text]");
          return `[${m.createdAt.toISOString()}] ${m.author.tag}: ${content}`;
        })
        .join("\n");

      savedTranscript = await db.saveTranscript(channel.name, user.tag, textTranscript);

      const transcriptBaseUrl = process.env.TRANSCRIPT_BASE_URL?.trim();
      const transcriptViewKey = process.env.TRANSCRIPT_VIEW_KEY?.trim();

      if (transcriptBaseUrl && transcriptViewKey && savedTranscript?.id) {
        renderTranscriptUrl =
          `${transcriptBaseUrl.replace(/\/+$/, "")}` +
          `/transcripts/${savedTranscript.id}?key=${encodeURIComponent(transcriptViewKey)}`;
      }
    } catch (e) {
      console.error("Database transcript save failed:", e);
    }

    try {
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
              { name: "Closed By", value: user.tag, inline: true },
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
    } catch (e) {
      console.error("Transcript logging failed:", e);
    }

    try {
      await db.closeTicketByChannel(channel.id);
    } catch (e) {
      console.error("Ticket DB close failed:", e);
    }

    setTimeout(() => {
      channel.delete().catch((e) => console.error("Delete failed:", e));
    }, 5000);
  },
};
