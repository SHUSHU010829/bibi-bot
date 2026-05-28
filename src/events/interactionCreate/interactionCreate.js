const {
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const config = require("../../config");
const fs = require("fs");
const { getDataFile } = require("../../utils/dataPaths");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

// 票務面板數據文件路徑
const PANELS_FILE = getDataFile("ticket-panels.json");

// 讀取面板數據
function loadPanels() {
  try {
    if (fs.existsSync(PANELS_FILE)) {
      const data = fs.readFileSync(PANELS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    logger.error({ source: "ticket-panels-load", err: error.message }, "讀取面板數據失敗");
    trackError("ticket-panels-load", error);
  }
  return { panels: {} };
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;

    // 通用按鈕速率限制：票務 / 投票 / 身份組共用一個冷卻
    const customId = interaction.customId || "";
    const isHandled =
      customId === "create_ticket" ||
      customId.startsWith("vote_") ||
      customId.startsWith("role_btn_");
    if (isHandled) {
      const rl = consume(interaction.user.id, "btn:generic", {
        windowMs: 2000,
        max: 1,
      });
      if (!rl.allowed) {
        try {
          await interaction.reply({
            content: `⏳ 操作太頻繁，請 ${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (_) { /* noop */ }
        return;
      }
    }

    // 處理票務按鈕
    if (interaction.customId === "create_ticket") {
      await handleTicketCreation(client, interaction);
      return;
    }

    // 處理投票按鈕（新格式：vote_{template}_{button}）
    if (interaction.customId.startsWith("vote_")) {
      await handleVoteButton(client, interaction);
      return;
    }

    // 處理身份組按鈕（必須以 role_btn_ 為前綴，避免攔截其他按鈕如分頁）
    if (!interaction.customId.startsWith("role_btn_")) return;

    const roleId = interaction.customId.slice("role_btn_".length);
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.reply({
        content: "無法找到該身份組！",
        flags: MessageFlags.Ephemeral,
      });
    }

    const hasRole = interaction.member.roles.cache.has(role.id);
    if (hasRole) {
      await interaction.member.roles.remove(role);
      return interaction.reply({
        content: `已經移除了身份組：${role.name}`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.member.roles.add(role);
      return interaction.reply({
        content: `已經成功給予身份組：${role.name}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    logger.error(
      { source: "interaction-dispatch", customId: interaction?.customId, err: error.message, stack: error.stack },
      "處理互動時出錯"
    );
    trackError("interaction-dispatch", error, { customId: interaction?.customId });
  }
};

async function handleTicketCreation(client, interaction) {
  try {
    // 獲取此頻道的面板配置（如果存在）
    const panels = loadPanels();
    const panelConfig = panels.panels[interaction.channel.id];

    // 使用頻道特定配置或預設配置
    const ticketConfig = panelConfig ? {
      categoryId: panelConfig.categoryId,
      supportRoleId: panelConfig.supportRoleId,
      ticketNameFormat: config.ticket.ticketNameFormat,
      welcomeMessage: config.ticket.welcomeMessage,
      alreadyHasTicket: config.ticket.alreadyHasTicket,
      ticketCreating: config.ticket.ticketCreating,
      ticketCreated: config.ticket.ticketCreated,
    } : config.ticket;

    // 檢查用戶是否已經有票務
    const existingTicket = interaction.guild.channels.cache.find(
      (channel) =>
        channel.name === `ticket-${interaction.user.username.toLowerCase()}` &&
        channel.type === ChannelType.GuildText
    );

    if (existingTicket) {
      return interaction.reply({
        content: ticketConfig.alreadyHasTicket,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      content: ticketConfig.ticketCreating,
      flags: MessageFlags.Ephemeral,
    });

    // 驗證並獲取父類別
    let parentCategory = null;
    if (ticketConfig.categoryId && ticketConfig.categoryId !== "YOUR_CATEGORY_ID") {
      const category = interaction.guild.channels.cache.get(ticketConfig.categoryId);
      if (category && category.type === ChannelType.GuildCategory) {
        parentCategory = ticketConfig.categoryId;
      } else {
        logger.warn(
          { source: "ticket-create", categoryId: ticketConfig.categoryId },
          "票務類別 ID 無效或不存在,改用無類別創建"
        );
      }
    }

    // 創建票務頻道
    const ticketChannel = await interaction.guild.channels.create({
      name: ticketConfig.ticketNameFormat.replace(
        "{username}",
        interaction.user.username.toLowerCase()
      ),
      type: ChannelType.GuildText,
      parent: parentCategory,
      topic: `票務創建者：${interaction.user.id}`,
      permissionOverwrites: [
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
      ],
    });

    // 如果有支援團隊身份組，添加權限
    if (ticketConfig.supportRoleId && ticketConfig.supportRoleId !== "YOUR_SUPPORT_ROLE_ID") {
      const supportRole = interaction.guild.roles.cache.get(ticketConfig.supportRoleId);
      if (supportRole) {
        await ticketChannel.permissionOverwrites.create(
          ticketConfig.supportRoleId,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          }
        );
      } else {
        logger.warn(
          { source: "ticket-create", supportRoleId: ticketConfig.supportRoleId },
          "支援團隊身份組 ID 無效或不存在"
        );
      }
    }

    // 發送歡迎訊息
    const welcomeEmbed = new EmbedBuilder()
      .setColor("#00ff00")
      .setTitle("🎫 票務已創建")
      .setDescription(
        ticketConfig.welcomeMessage.replace("{user}", interaction.user.toString())
      )
      .setTimestamp();

    await ticketChannel.send({
      content: `${interaction.user}`,
      embeds: [welcomeEmbed],
    });

    await interaction.editReply({
      content: ticketConfig.ticketCreated.replace(
        "{channel}",
        ticketChannel.toString()
      ),
      flags: MessageFlags.Ephemeral,
    });
    trackSuccess("ticket-create");
  } catch (error) {
    logger.error(
      { source: "ticket-create", userId: interaction.user?.id, err: error.message, stack: error.stack },
      "創建票務時出錯"
    );
    trackError("ticket-create", error, { userId: interaction.user?.id });
    try {
      await interaction.editReply({
        content: "❌ 創建票務時發生錯誤！請聯絡管理員。",
        flags: MessageFlags.Ephemeral,
      });
    } catch (replyError) {
      logger.error({ source: "ticket-create", err: replyError.message }, "回覆錯誤訊息失敗");
      trackError("ticket-create", replyError);
    }
  }
}

async function handleVoteButton(client, interaction) {
  try {
    // 先 defer，避免 DB 查詢 + 多次 updateOne 讓 3 秒 token 過期觸發 10062
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "vote-button", customId: interaction.customId },
          "互動已逾期,無法 defer"
        );
        trackError("vote-button", deferErr, { reason: "expired" });
        return;
      }
      throw deferErr;
    }

    // 查找對應的投票提案
    const proposal = await client.votingProposalsCollection.findOne({
      messageId: interaction.message.id,
      status: "VOTING",
    });

    if (!proposal) {
      return interaction.editReply({
        content: "❌ 找不到對應的投票或投票已結束！",
      });
    }

    const userId = interaction.user.id;
    const customId = interaction.customId;

    // 解析按鈕 ID：vote_{template}_{button}
    const parts = customId.split("_");
    if (parts.length < 3) {
      return interaction.editReply({
        content: "❌ 無效的按鈕 ID！",
      });
    }

    const templateKey = parts[1];
    const buttonId = parts.slice(2).join("_");

    // 獲取模板配置
    const template = config.voting.templates[templateKey];
    if (!template) {
      return interaction.editReply({
        content: "❌ 找不到對應的投票模板！",
      });
    }

    // 找到對應的按鈕配置
    const buttonConfig = template.buttons.find(btn => btn.id === buttonId);
    if (!buttonConfig) {
      return interaction.editReply({
        content: "❌ 找不到對應的按鈕配置！",
      });
    }

    // 步驟 1：從所有按鈕類別中移除用戶（互斥邏輯）
    const pullUpdate = {};
    for (const btn of template.buttons) {
      pullUpdate[`votes.${btn.id}`] = userId;
    }

    await client.votingProposalsCollection.updateOne(
      { _id: proposal._id },
      { $pull: pullUpdate }
    );

    // 步驟 2：將用戶添加到目標類別
    await client.votingProposalsCollection.updateOne(
      { _id: proposal._id },
      { $addToSet: { [`votes.${buttonId}`]: userId } }
    );

    // 回覆用戶
    await interaction.editReply({
      content: `${buttonConfig.emoji} 已將您的票更改為【${buttonConfig.label}】`,
    });

    // 更新投票訊息顯示當前票數
    await updateVoteMessage(client, interaction, proposal);
    trackSuccess("vote-button");

  } catch (error) {
    logger.error(
      { source: "vote-button", userId: interaction.user?.id, customId: interaction.customId, err: error.message, stack: error.stack },
      "處理投票按鈕時出錯"
    );
    trackError("vote-button", error, { userId: interaction.user?.id, customId: interaction.customId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: "❌ 處理投票時發生錯誤！",
        });
      } else {
        await interaction.reply({
          content: "❌ 處理投票時發生錯誤！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyError) {
      logger.error({ source: "vote-button", err: replyError.message }, "回覆錯誤訊息失敗");
      trackError("vote-button", replyError);
    }
  }
}

async function updateVoteMessage(client, interaction, proposal) {
  try {
    // 重新獲取最新的投票數據
    const updatedProposal = await client.votingProposalsCollection.findOne({
      _id: proposal._id
    });

    if (!updatedProposal) return;

    // 獲取模板配置
    const template = config.voting.templates[updatedProposal.templateKey];
    if (!template) {
      logger.error(
        { source: "vote-update", templateKey: updatedProposal.templateKey },
        "找不到投票模板"
      );
      trackError("vote-update", new Error(`template not found: ${updatedProposal.templateKey}`));
      return;
    }

    const originalEmbed = interaction.message.embeds[0];
    const { EmbedBuilder } = require("discord.js");

    const updatedEmbed = EmbedBuilder.from(originalEmbed);

    // 清除舊的投票統計欄位（保留前3個：類型、時間、截止）
    updatedEmbed.spliceFields(3, updatedEmbed.data.fields?.length - 3 || 0);

    // 添加新的投票統計
    const voteCounts = {};
    let totalScore = 0;

    for (const btn of template.buttons) {
      const count = updatedProposal.votes[btn.id]?.length || 0;
      voteCounts[btn.id] = count;
      totalScore += count * btn.weight;

      updatedEmbed.addFields({
        name: `${btn.emoji} ${btn.label}`,
        value: `${count} 人`,
        inline: true
      });
    }

    // 根據通過條件類型添加門檻說明
    const passCondition = template.passCondition;
    let thresholdText = "";

    switch (passCondition.type) {
      case "weighted":
        updatedEmbed.addFields({
          name: "📊 總分",
          value: `${totalScore} 分`,
          inline: true
        });
        thresholdText = `總分 ≥ ${passCondition.minTotalScore} 且 高意願 ≥ ${passCondition.minHighInterest} 人`;
        break;

      case "reverse":
        thresholdText = `如果活躍人數 < ${passCondition.maxStillActive + 1} 人，則通過`;
        break;

      case "majority":
        const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);
        updatedEmbed.addFields({
          name: "📊 總投票數",
          value: `${totalVotes} 票`,
          inline: true
        });
        thresholdText = `總票數 ≥ ${passCondition.minTotalVotes} 且 贊成票 > 反對票`;
        break;

      case "simple":
        thresholdText = `支持票 ≥ ${passCondition.minSupport} 票`;
        break;
    }

    if (thresholdText) {
      updatedEmbed.addFields({
        name: "✅ 通過門檻",
        value: thresholdText,
        inline: false
      });
    }

    await interaction.message.edit({ embeds: [updatedEmbed] });

  } catch (error) {
    logger.error(
      { source: "vote-update", err: error.message, stack: error.stack },
      "更新投票訊息時出錯"
    );
    trackError("vote-update", error);
  }
}
