require("colors");
const {
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const config = require("../../../config");

async function run(client, interaction) {
  try {
    if (!interaction.channel.name.startsWith("ticket-")) {
      return interaction.reply({
        content: "❌ 只能在票務頻道中關閉票務！",
        flags: MessageFlags.Ephemeral,
      });
    }

    const channelPermissions = interaction.channel.permissionsFor(
      interaction.user
    );
    const hasPermission =
      channelPermissions.has(PermissionFlagsBits.Administrator) ||
      interaction.channel.topic?.includes(interaction.user.id);

    if (!hasPermission) {
      return interaction.reply({
        content: "❌ 只有票務創建者或管理員可以關閉此票務！",
        flags: MessageFlags.Ephemeral,
      });
    }

    const container = new ContainerBuilder()
      .setAccentColor(0xff0000)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${config.ticket.closeMessage}\n${config.ticket.closeDescription.replace(
            "{user}",
            interaction.user.toString(),
          )}`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
        ),
      );

    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    setTimeout(async () => {
      try {
        await interaction.channel.delete();
      } catch (error) {
        console.log(`[ERROR] 刪除票務頻道時出錯：\n${error}`.red);
      }
    }, 5000);
  } catch (error) {
    console.log(`[ERROR] 關閉票務時出錯：\n${error}`.red);
    await interaction.reply({
      content: "❌ 關閉票務時發生錯誤！",
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = { run };
