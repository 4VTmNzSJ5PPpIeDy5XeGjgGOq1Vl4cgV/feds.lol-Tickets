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

const CATEGORY_META = {
  general_support: {
    label: "General Support",
    categoryEnv: "CATEGORY_GENERAL_SUPPORT"
  },
  report_user: {
    label: "Report User",
    categoryEnv: "CATEGORY_REPORT_USER"
  },
  account_recovery: {
    label: "Account Recovery",
    categoryEnv: "CATEGORY_ACCOUNT_RECOVERY"
  },
  purchase_billing: {
    label: "Purchase / Billing",
    categoryEnv: "CATEGORY_PURCHASE_BILLING"
  },
  badge_application: {
    label: "Badge Application",
    categoryEnv: "CATEGORY_BADGE_APPLICATION"
  }
} as const;

type CategoryKey = keyof typeof CATEGORY_META;

const command = {
  data: new SlashCommandBuilder()
    .setName("movecategory")
    .setDescription("Move this ticket into a different category.")
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("New ticket category")
        .setRequired(true)
        .addChoices(
          { name: "General Support", value: "general_support" },
          { name: "Report User", value: "report_user" },
          { name: "Account Recovery", value: "account_recovery" },
          { name: "Purchase / Billing", value: "purchase_billing" },
          { name: "Badge Application", value: "badge_application" }
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const { channel, guild, member, user: actor } = interaction;

    if (!guild || !channel || !("setParent" in channel)) {
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
      return interaction.editReply({ content: "Only staff can move ticket categories." });
    }

    const categoryKey = interaction.options.getString("category", true) as CategoryKey;
    const meta = CATEGORY_META[categoryKey];
    if (!meta) {
      return interaction.editReply({ content: "Unknown category." });
    }

    if (ticket.category_key === categoryKey) {
      return interaction.editReply({
        content: `This ticket is already in **${meta.label}**.`
      });
    }

    const parentId = process.env[meta.categoryEnv]?.trim();
    if (!parentId) {
      return interaction.editReply({
        content:
          `Category channel is not configured for **${meta.label}**. ` +
          `Set \`${meta.categoryEnv}\` in your environment and redeploy.`
      });
    }

    const previousParentId = (channel as any).parentId ?? null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).setParent(parentId, { lockPermissions: false });
    } catch (e) {
      console.error("[movecategory] setParent failed:", e);
      return interaction.editReply({
        content: "Failed to move the channel category. (Check bot permissions.)"
      });
    }

    try {
      const updated = await db.updateTicketCategoryByChannel(channel.id, categoryKey);
      if (!updated) {
        throw new Error("DB update returned null");
      }
    } catch (e) {
      console.error("[movecategory] DB update failed:", e);

      // Best-effort rollback: put the channel back where it was.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (channel as any).setParent(previousParentId, { lockPermissions: false });
      } catch (rollbackErr) {
        console.error("[movecategory] rollback setParent failed:", rollbackErr);
      }

      return interaction.reply({
        content:
          "Moved the channel category, but failed to update the ticket record. " +
          "I reverted the channel move to keep things consistent. Please try again.",
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).send({
        content: `${actor} moved this ticket to **${meta.label}**.`
      });
    } catch {
      // ignore
    }

    return interaction.editReply({ content: `Moved ticket to **${meta.label}**.` });
  }
};

export = command;

