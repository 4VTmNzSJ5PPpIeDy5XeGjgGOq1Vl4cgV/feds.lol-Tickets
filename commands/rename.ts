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

function slugifyChannelName(value: string): string {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

const command = {
  data: new SlashCommandBuilder()
    .setName("rename")
    .setDescription("Rename the current ticket channel.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("New channel name (letters/numbers/hyphens).")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(100)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const { channel, guild, member, user: actor } = interaction;
    if (!guild || !channel || !("setName" in channel)) {
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
        content: "Only staff can rename tickets.",
        flags: MessageFlags.Ephemeral
      });
    }

    const requested = interaction.options.getString("name", true);
    const newName = slugifyChannelName(requested);

    if (!newName) {
      return interaction.reply({
        content: "Please provide a valid name (letters/numbers/hyphens).",
        flags: MessageFlags.Ephemeral
      });
    }

    if ((channel as any).name === newName) {
      return interaction.reply({
        content: "That’s already the current channel name.",
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).setName(newName, `Renamed by ${actor.tag}`);
    } catch (e) {
      console.error("[rename] setName failed:", e);
      return interaction.reply({
        content: "Failed to rename the channel. (Check bot permissions.)",
        flags: MessageFlags.Ephemeral
      });
    }

    // Visible audit trail inside the ticket.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).send({
        content: `${actor} renamed this ticket to **${newName}**.`
      });
    } catch {
      // ignore
    }

    return interaction.reply({
      content: `Renamed channel to **${newName}**.`,
      flags: MessageFlags.Ephemeral
    });
  }
};

export = command;

