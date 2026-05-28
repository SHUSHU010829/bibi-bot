require("colors");
const {
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const fs = require("fs");
const config = require("../../../config");
const { getDataFile } = require("../../../utils/dataPaths");

const PANELS_FILE = getDataFile("ticket-panels.json");

function ensureDataFile() {
  if (!fs.existsSync(PANELS_FILE)) {
    fs.writeFileSync(PANELS_FILE, JSON.stringify({ panels: {} }, null, 2));
  }
}

function loadPanels() {
  ensureDataFile();
  const data = fs.readFileSync(PANELS_FILE, "utf8");
  return JSON.parse(data);
}

function savePanels(data) {
  ensureDataFile();
  fs.writeFileSync(PANELS_FILE, JSON.stringify(data, null, 2));
}

async function run(client, interaction) {
  try {
    const title = interaction.options.getString("title") || config.ticket.panelTitle;
    const description = interaction.options.getString("description") || config.ticket.panelDescription;
    const buttonLabel = interaction.options.getString("button_label") || config.ticket.buttonLabel;
    const buttonEmoji = interaction.options.getString("button_emoji") || config.ticket.buttonEmoji;
    const categoryId = interaction.options.getString("category_id") || config.ticket.categoryId;
    const supportRole = interaction.options.getRole("support_role");
    const supportRoleId = supportRole ? supportRole.id : config.ticket.supportRoleId;

    if (categoryId && categoryId !== "YOUR_CATEGORY_ID") {
      const category = interaction.guild.channels.cache.get(categoryId);
      if (!category || category.type !== 4) {
        return interaction.reply({
          content: "❌ 提供的類別 ID 無效！請確認類別存在並正確。",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const button = new ButtonBuilder()
      .setCustomId("create_ticket")
      .setLabel(buttonLabel)
      .setEmoji(buttonEmoji)
      .setStyle(ButtonStyle.Primary);

    const container = new ContainerBuilder()
      .setAccentColor(0x0099ff)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${title}\n${description}`),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(new ActionRowBuilder().addComponents(button))
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# ${interaction.guild.name} ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
        ),
      );

    await interaction.reply({
      content: "✅ 票務面板已設置！",
      flags: MessageFlags.Ephemeral,
    });

    const message = await interaction.channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    const panels = loadPanels();
    panels.panels[interaction.channel.id] = {
      messageId: message.id,
      channelId: interaction.channel.id,
      guildId: interaction.guild.id,
      title,
      description,
      buttonLabel,
      buttonEmoji,
      categoryId,
      supportRoleId,
      createdAt: new Date().toISOString(),
      createdBy: interaction.user.id,
    };
    savePanels(panels);
  } catch (error) {
    console.log(`[ERROR] 設置票務面板時出錯：\n${error}`.red);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ 設置票務面板時發生錯誤！",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

module.exports = { run };
