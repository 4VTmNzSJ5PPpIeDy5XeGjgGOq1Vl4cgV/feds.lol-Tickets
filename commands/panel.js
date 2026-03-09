const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Send the ticket support panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle("feds.lol Support")
      .setDescription(
        "Need help? Select a category below to open a ticket. Our team will be with you shortly."
      )
      .setColor(0x4240ae)
      .setFooter({ text: "feds.lol Support - support@feds.lol" })
      .setImage("https://cdn.discordapp.com/attachments/1478684765040414802/1480613291670765579/image.png?ex=69b05015&is=69aefe95&hm=f45315fbba3cf03f400f245d90371201959632c3a56234d2c651415c62b11ab7&");

    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticket_open")
      .setPlaceholder("Select a category...")
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("General Support")
          .setDescription("General questions or issues.")
          .setValue("general_support")
          .setEmoji({ id: "1478268515117961226", name: "claim" }),
        new StringSelectMenuOptionBuilder()
          .setLabel("Report User")
          .setDescription("Report a user for breaking the rules.")
          .setValue("report_user")
          .setEmoji({ id: "1478268560471097354", name: "report" }),
        new StringSelectMenuOptionBuilder()
          .setLabel("Account Recovery")
          .setDescription("Recover access to your account.")
          .setValue("account_recovery")
          .setEmoji({ id: "1478268585582268477", name: "recovery" }),
        new StringSelectMenuOptionBuilder()
          .setLabel("Purchase / Billing")
          .setDescription("Issues with a purchase or payment.")
          .setValue("purchase_billing")
          .setEmoji({ id: "1478267209641099367", name: "purchase" }),
        new StringSelectMenuOptionBuilder()
          .setLabel("Badge Application")
          .setDescription("Apply for a verified badge.")
          .setValue("badge_application")
          .setEmoji({ id: "1478268606620897391", name: "verified_application" })
      );

    const row = new ActionRowBuilder().addComponents(menu);

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.editReply({ content: "Panel sent!" });
  },
};