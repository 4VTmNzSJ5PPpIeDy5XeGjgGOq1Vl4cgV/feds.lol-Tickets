import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember
} from "discord.js";
import * as db from "../database";

const SUPPORT_ROLE_IDS: string[] = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

function isSupportMember(member: GuildMember | null): boolean {
  if (!member) return false;
  return SUPPORT_ROLE_IDS.some((id) => member.roles.cache.has(id));
}

const command = {
  data: new SlashCommandBuilder()
    .setName("adduser")
    .setDescription("Add a server member to this ticket channel.")
    .setDMPermission(false)
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Member to add to this ticket.")
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const { channel, guild, member, user: actor } = interaction;
    if (!guild || !channel || !("permissionOverwrites" in channel)) {
      return interaction.reply({
        content: "This command can only be used in a server text channel.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Ack early to avoid "Unknown interaction" on slower DB/REST.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    const ticket = await db.getTicketByChannel(channel.id);
    if (!ticket || ticket.status !== "open") {
      return interaction.editReply({
        content: "This command can only be used inside an open ticket."
      });
    }

    const memberObj = member as GuildMember;
    const isAdmin = memberObj.permissions.has(PermissionFlagsBits.ManageChannels);
    const isSupport = isSupportMember(memberObj);

    if (!isSupport && !isAdmin) {
      return interaction.editReply({ content: "Only staff can add users to tickets." });
    }

    const targetUser = interaction.options.getUser("user", true);
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      return interaction.editReply({ content: "That user is not a member of this server." });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).permissionOverwrites.edit(targetUser.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true
      });
    } catch (e) {
      console.error("[adduser] permissionOverwrites.edit failed:", e);
      return interaction.editReply({
        content:
          "Failed to add that user. (Check bot permissions and role hierarchy.)"
      });
    }

    // Visible audit trail inside the ticket.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).send({
        content: `${actor} added ${targetUser} to this ticket.`
      });
    } catch {
      // ignore message failure; permissions were still updated
    }

    return interaction.editReply({ content: `Added ${targetUser} to this ticket.` });
  }
};

export = command;

