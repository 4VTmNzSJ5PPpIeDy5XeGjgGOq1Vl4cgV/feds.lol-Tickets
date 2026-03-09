const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const transcripts = require("discord-html-transcripts");
const fetch = require("node-fetch");
const FormData = require("form-data");

const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map(id => id.trim())
  : [];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current ticket."),

  async execute(interaction) {
    const { channel, guild, member, user } = interaction;

    // Make sure this is a ticket channel
    if (!channel.name.includes("-")) {
      return interaction.reply({ content: "This command can only be used inside a ticket.", ephemeral: true });
    }

    const isSupport = SUPPORT_ROLE_IDS.some(id => member.roles.cache.has(id));
    const isAdmin   = member.permissions.has(PermissionFlagsBits.ManageChannels);

    // Check if user is the ticket owner (their username is at the end of the channel name)
    const isOwner = channel.name.endsWith(`-${user.username}`);

    if (!isOwner && !isSupport && !isAdmin) {
      return interaction.reply({ content: "You don't have permission to close this ticket.", ephemeral: true });
    }

    const closeEmbed = new EmbedBuilder()
      .setTitle("Ticket Closed")
      .setDescription(`Closed by ${user}. This channel will be deleted in **5 seconds**.`)
      .setColor(0x4240ae)
      .setTimestamp();

    await interaction.reply({ embeds: [closeEmbed] });

    // Transcript
    try {
      const logId = process.env.LOG_CHANNEL_ID;
      if (logId) {
        const logChannel = guild.channels.cache.get(logId) ?? await guild.channels.fetch(logId).catch(() => null);
        if (logChannel?.isTextBased()) {
          const transcript = await transcripts.createTranscript(channel, {
            limit: -1,
            filename: `transcript-${channel.name}.html`,
            poweredBy: false,
          });

          let transcriptUrl = null;
          try {
            const form = new FormData();
            form.append("reqtype", "fileupload");
            form.append("userhash", "");
            form.append("fileToUpload", transcript.attachment, {
              filename: `transcript-${channel.name}.html`,
              contentType: "text/html",
            });
            const response = await fetch("https://catbox.moe/user/api.php", {
              method: "POST",
              body: form,
              timeout: 8000,
            });
            transcriptUrl = await response.text();
          } catch (e) {
            console.error("Catbox upload failed:", e.message);
          }

          const logEmbed = new EmbedBuilder()
            .setTitle("Transcript Saved")
            .addFields(
              { name: "Channel",   value: channel.name, inline: true },
              { name: "Closed By", value: `${user}`,    inline: true }
            )
            .setColor(0x4240ae)
            .setTimestamp();

          if (transcriptUrl) {
            logEmbed.addFields({ name: "View Transcript", value: `[Click to open](${transcriptUrl})` });
            await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
          } else {
            logEmbed.addFields({ name: "View Transcript", value: "Download the attached file and open it in your browser." });
            await logChannel.send({ embeds: [logEmbed], files: [transcript] }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("Transcript failed:", e);
    }

    setTimeout(() => channel.delete().catch(e => console.error("Delete failed:", e)), 5000);
  },
};