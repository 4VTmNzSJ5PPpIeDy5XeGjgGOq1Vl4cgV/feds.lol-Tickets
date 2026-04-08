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
    .setName("removeuser")
    .setDescription("Remove a server member from this ticket channel.")
    .setDMPermission(false)
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Member to remove from this ticket.")
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

    const ticket = await db.getTicketByChannel(channel.id);
    if (!ticket || ticket.status !== "open") {
      return interaction.reply({
        content: "This command can only be used inside an open ticket.",
        flags: MessageFlags.Ephemeral
      });
    }

    const memberObj = member as GuildMember;
    const isAdmin = memberObj.permissions.has(PermissionFlagsBits.ManageChannels);
    const isSupport = isSupportMember(memberObj);

    if (!isSupport && !isAdmin) {
      return interaction.reply({
        content: "Only staff can remove users from tickets.",
        flags: MessageFlags.Ephemeral
      });
    }

    const targetUser = interaction.options.getUser("user", true);

    if (targetUser.id === ticket.user_id) {
      return interaction.reply({
        content: "You can't remove the ticket owner from their own ticket.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (targetUser.id === guild.members.me?.id) {
      return interaction.reply({
        content: "You can't remove the bot from the ticket channel.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Remove explicit per-user overwrite (returns them to default perms: everyone denied).
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).permissionOverwrites.delete(targetUser.id);
    } catch (e) {
      console.error("[removeuser] permissionOverwrites.delete failed:", e);
      return interaction.reply({
        content:
          "Failed to remove that user. (Check bot permissions and role hierarchy.)",
        flags: MessageFlags.Ephemeral
      });
    }

    // Visible audit trail inside the ticket.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).send({
        content: `${actor} removed ${targetUser} from this ticket.`
      });
    } catch {
      // ignore message failure; permissions were still updated
    }

    return interaction.reply({
      content: `Removed ${targetUser} from this ticket.`,
      flags: MessageFlags.Ephemeral
    });
  }
};

export = command;

