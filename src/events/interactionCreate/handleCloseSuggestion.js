const {
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const config = require("../../config");
const { loadPanels } = require("../../utils/suggestionPanelsStore");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "close_suggestion") return;

  try {
    if (!interaction.guild) {
      return await interaction.reply({
        content: "❌ 此功能只能在伺服器中使用。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = interaction.channel;

    const panels = await loadPanels(client);
    let supportRoleId = null;
    for (const panel of Object.values(panels.panels || {})) {
      if (panel.guildId === interaction.guild.id && panel.supportRoleId) {
        supportRoleId = panel.supportRoleId;
        break;
      }
    }
    if (!supportRoleId) {
      supportRoleId = config.suggestion.supportRoleId;
    }

    const memberPermissions = channel.permissionsFor(interaction.member);
    const hasAdminPermission =
      memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
      (supportRoleId && interaction.member.roles.cache.has(supportRoleId));

    if (!hasAdminPermission) {
      const mention = supportRoleId ? `<@&${supportRoleId}>\n` : "";
      const requestContainer = new ContainerBuilder()
        .setAccentColor(0xffa500)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${mention}# 📣 票務關閉請求\n` +
              `${interaction.user} 想要關閉此票務。\n\n請管理員確認後點擊「關閉票務」按鈕來關閉此頻道。`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.reply({
        components: [requestContainer],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { roles: supportRoleId ? [supportRoleId] : [] },
      });
      trackSuccess("close-suggestion-request");
      return;
    }

    const closeContainer = new ContainerBuilder()
      .setAccentColor(0xff0000)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🔒 票務已關閉\n此票務已被 ${interaction.user} 關閉。\n頻道將在 5 秒後刪除。`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
        ),
      );

    await interaction.reply({
      components: [closeContainer],
      flags: MessageFlags.IsComponentsV2,
    });

    const t = setTimeout(async () => {
      try {
        await channel.delete();
      } catch (error) {
        logger.error(
          { source: "close-suggestion", err: error.message },
          "刪除建議票務頻道時出錯",
        );
        trackError("close-suggestion", error);
      }
    }, 5000);
    t.unref?.();
    trackSuccess("close-suggestion");
  } catch (error) {
    logger.error(
      {
        source: "close-suggestion",
        userId: interaction.user?.id,
        err: error.message,
        stack: error.stack,
      },
      "處理關閉票務按鈕時出錯",
    );
    trackError("close-suggestion", error, { userId: interaction.user?.id });

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "❌ 處理關閉票務時發生錯誤！請聯絡管理員。",
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error(
          { source: "close-suggestion", err: replyError.message },
          "回覆錯誤訊息失敗",
        );
        trackError("close-suggestion", replyError);
      }
    }
  }
};
