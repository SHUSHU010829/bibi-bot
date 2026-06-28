const {
  ChannelType,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const config = require("../../config");
const { loadPanels } = require("../../utils/suggestionPanelsStore");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  // 步驟 1：選擇類別後，先請使用者選擇公開或私密
  if (interaction.isStringSelectMenu() && interaction.customId === "suggestion_select") {
    return presentVisibilityChoice(client, interaction);
  }

  // 步驟 2：選好公開／私密後，建立討論頻道
  if (interaction.isButton() && interaction.customId.startsWith("suggestion_open:")) {
    return createSuggestionChannel(client, interaction);
  }
};

// 步驟 1：顯示「私密 / 公開」選擇按鈕
async function presentVisibilityChoice(client, interaction) {
  try {
    if (!interaction.guild) {
      logger.warn({ source: "suggestion-select" }, "interaction.guild 不存在,可能在 DM 中");
      return await interaction.reply({
        content: "❌ 此功能只能在伺服器中使用。",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (
      !interaction.values ||
      !Array.isArray(interaction.values) ||
      interaction.values.length === 0
    ) {
      logger.error({ source: "suggestion-select" }, "interaction.values 不存在或為空");
      trackError("suggestion-select", new Error("invalid interaction.values"));
      return await interaction.reply({
        content: "❌ 無法讀取你的選擇，請重試。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const selectedType = interaction.values[0];
    const suggestionType = config.suggestion.types[selectedType];

    if (!suggestionType) {
      logger.error({ source: "suggestion-select", selectedType }, "無效的建議類型");
      trackError("suggestion-select", new Error(`invalid type: ${selectedType}`));
      return await interaction.reply({
        content: "❌ 無效的建議類型！",
        flags: MessageFlags.Ephemeral,
      });
    }

    const privateButton = new ButtonBuilder()
      .setCustomId(`suggestion_open:${selectedType}:private`)
      .setLabel("私密討論（預設）")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Primary);

    const publicButton = new ButtonBuilder()
      .setCustomId(`suggestion_open:${selectedType}:public`)
      .setLabel("公開討論")
      .setEmoji("🌐")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(privateButton, publicButton);

    await interaction.reply({
      content:
        `你選擇了 ${suggestionType.emoji} **${suggestionType.label}**\n\n` +
        "請選擇此討論的顯示方式：\n" +
        "🔒 **私密討論**：只有你與管理團隊看得到，內容不公開。\n" +
        "🌐 **公開討論**：所有人都看得到並可一起討論，且**不會顯示你的名字**（匿名）。",
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error(
      { source: "suggestion-select", userId: interaction.user?.id, err: error.message, stack: error.stack },
      "顯示公開／私密選擇時出錯"
    );
    trackError("suggestion-select", error, { userId: interaction.user?.id });
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "❌ 處理建議時發生錯誤！請聯絡管理員。",
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error({ source: "suggestion-select", err: replyError.message }, "回覆錯誤訊息失敗");
        trackError("suggestion-select", replyError);
      }
    }
  }
}

// 步驟 2：依公開／私密建立討論頻道
async function createSuggestionChannel(client, interaction) {
  try {
    if (!interaction.guild) {
      return await interaction.reply({
        content: "❌ 此功能只能在伺服器中使用。",
        flags: MessageFlags.Ephemeral,
      });
    }

    // customId 格式：suggestion_open:{typeKey}:{private|public}
    const [, selectedType, visibility] = interaction.customId.split(":");
    const isPublic = visibility === "public";
    const suggestionType = config.suggestion.types[selectedType];

    if (!suggestionType) {
      logger.error({ source: "suggestion-open", selectedType }, "無效的建議類型");
      trackError("suggestion-open", new Error(`invalid type: ${selectedType}`));
      return await interaction.reply({
        content: "❌ 無效的建議類型！",
        flags: MessageFlags.Ephemeral,
      });
    }

    // 先 deferUpdate，沿用原本的臨時訊息並移除按鈕，避免重複點擊建立多個頻道
    if (!(await deferUpdateSafe(interaction))) {
      logger.warn(
        { source: "suggestion-open", customId: interaction.customId },
        "互動已逾期,無法 defer"
      );
      trackError("suggestion-open", new Error("expired"), { reason: "expired" });
      return;
    }

    // 獲取此頻道的面板配置（如果存在）
    const panels = await loadPanels(client);
    const panelConfig = panels.panels[interaction.channel.id];

    const suggestionConfig = panelConfig
      ? {
          categoryId: panelConfig.categoryId,
          supportRoleId: panelConfig.supportRoleId,
        }
      : {
          categoryId: config.suggestion.categoryId,
          supportRoleId: config.suggestion.supportRoleId,
        };

    // 私密討論：限制每位使用者同時只能有一個開啟中的私密討論
    // 公開討論為匿名，不記錄創建者，因此不套用此限制
    if (!isPublic) {
      const existingSuggestion = interaction.guild.channels.cache.find(
        (channel) =>
          channel.topic === `建議創建者：${interaction.user.id}` &&
          channel.type === ChannelType.GuildText,
      );

      if (existingSuggestion) {
        return interaction.editReply({
          content: `❌ 您已經有一個開啟的私密討論了！\n請前往 ${existingSuggestion} 或先關閉現有的討論。`,
          components: [],
        });
      }
    }

    await interaction.editReply({
      content: "⏳ 正在創建討論頻道...",
      components: [],
    });

    // 驗證並獲取父類別
    let parentCategory = null;
    if (
      suggestionConfig.categoryId &&
      suggestionConfig.categoryId !== "YOUR_CATEGORY_ID"
    ) {
      const category = interaction.guild.channels.cache.get(
        suggestionConfig.categoryId,
      );
      if (category && category.type === ChannelType.GuildCategory) {
        parentCategory = suggestionConfig.categoryId;
      } else {
        logger.warn(
          { source: "suggestion-open", categoryId: suggestionConfig.categoryId },
          "建議類別 ID 無效或不存在,改用無類別創建"
        );
      }
    }

    // 公開討論：頻道名稱不含使用者名字（匿名），所有人皆可查看與發言
    // 私密討論：頻道名稱含使用者名字，僅創建者與管理團隊可見
    const channelName = isPublic
      ? `${suggestionType.channelPrefix}-公開-${interaction.id.slice(-4)}`
      : `${suggestionType.channelPrefix}-${interaction.user.username.toLowerCase()}`;

    const permissionOverwrites = isPublic
      ? [
          {
            id: interaction.guild.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ]
      : [
          {
            id: interaction.guild.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ];

    // 公開討論為匿名，topic 不記錄創建者；私密討論記錄創建者 ID 供查重
    const suggestionChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: parentCategory,
      topic: isPublic ? "公開討論（匿名）" : `建議創建者：${interaction.user.id}`,
      permissionOverwrites,
    });

    // 如果有支援團隊身份組，添加權限
    if (
      suggestionConfig.supportRoleId &&
      suggestionConfig.supportRoleId !== "YOUR_SUPPORT_ROLE_ID"
    ) {
      const supportRole = interaction.guild.roles.cache.get(
        suggestionConfig.supportRoleId,
      );
      if (supportRole) {
        await suggestionChannel.permissionOverwrites.create(
          suggestionConfig.supportRoleId,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          },
        );
      } else {
        logger.warn(
          { source: "suggestion-open", supportRoleId: suggestionConfig.supportRoleId },
          "支援團隊身份組 ID 無效或不存在"
        );
      }
    }

    // 公開討論不顯示創建者名字（匿名），私密討論則 @ 並標示創建者
    const closeButton = new ButtonBuilder()
      .setCustomId("close_suggestion")
      .setLabel("關閉票務")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger);

    const head = isPublic ? "" : `${interaction.user}\n`;
    const welcomeContainer = new ContainerBuilder()
      .setAccentColor(0xffd700)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `${head}# ${suggestionType.emoji} ${suggestionType.label}${isPublic ? "（公開討論）" : ""}\n` +
            suggestionType.welcomeMessage.replace(
              "{user}",
              isPublic ? "大家" : interaction.user.toString(),
            ),
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(closeButton),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
        ),
      );

    await suggestionChannel.send({
      components: [welcomeContainer],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: isPublic
        ? { parse: [] }
        : { users: [interaction.user.id] },
    });

    await interaction.editReply({
      content: isPublic
        ? `✅ 公開討論頻道已創建（匿名，不會顯示你的名字）！\n請前往 ${suggestionChannel}`
        : `✅ 私密討論頻道已創建！\n請前往 ${suggestionChannel}`,
    });
    trackSuccess("suggestion-open");
  } catch (error) {
    logger.error(
      { source: "suggestion-open", userId: interaction.user?.id, err: error.message, stack: error.stack },
      "創建建議頻道時出錯"
    );
    trackError("suggestion-open", error, { userId: interaction.user?.id });

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "❌ 處理建議時發生錯誤！請聯絡管理員。",
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        logger.error({ source: "suggestion-open", err: replyError.message }, "回覆錯誤訊息失敗");
        trackError("suggestion-open", replyError);
      }
    } else {
      try {
        await interaction.editReply({
          content: "❌ 創建討論頻道時發生錯誤！請聯絡管理員。",
          components: [],
        });
      } catch (editError) {
        logger.error({ source: "suggestion-open", err: editError.message }, "編輯回覆失敗");
        trackError("suggestion-open", editError);
      }
    }
  }
};
