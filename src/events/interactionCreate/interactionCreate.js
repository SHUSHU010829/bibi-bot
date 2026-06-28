const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const config = require("../../config");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;

    // 通用按鈕速率限制：投票 / 身份組共用一個冷卻
    const customId = interaction.customId || "";
    const isHandled =
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
    if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
    if (hasRole) {
      await interaction.member.roles.remove(role);
      return interaction.editReply({
        content: `已經移除了身份組：${role.name}`,
      });
    } else {
      await interaction.member.roles.add(role);
      return interaction.editReply({
        content: `已經成功給予身份組：${role.name}`,
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

async function handleVoteButton(client, interaction) {
  try {
    // 先 defer，避免 DB 查詢 + 多次 updateOne 讓 3 秒 token 過期觸發 10062
    if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) {
      logger.warn(
        { source: "vote-button", customId: interaction.customId },
        "互動已逾期,無法 defer"
      );
      trackError("vote-button", { code: 10062 }, { reason: "expired" });
      return;
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

function getTemplateColor(templateKey) {
  const colors = {
    game_create: 0x00ff00,
    game_archive: 0xff9900,
    event: 0x9b59b6,
    rule_change: 0x3498db,
    general: 0x95a5a6,
  };
  return colors[templateKey] || 0x0099ff;
}

function rebuildVoteContainer(proposal, template) {
  const title = proposal.title || proposal.gameName || "提案";
  const description =
    proposal.customDescription
      ? `由 <@${proposal.proposerId}> 提出\n\n${proposal.customDescription}`
      : `由 <@${proposal.proposerId}> 提出\n\n${template.description}`;

  const createdEpoch = Math.floor(
    new Date(proposal.createdAt || Date.now()).getTime() / 1000,
  );
  const expiresEpoch = Math.floor(
    new Date(proposal.expiresAt || Date.now()).getTime() / 1000,
  );

  const voteCounts = {};
  let totalScore = 0;
  for (const btn of template.buttons) {
    const count = proposal.votes?.[btn.id]?.length || 0;
    voteCounts[btn.id] = count;
    totalScore += count * (btn.weight || 0);
  }

  const passCondition = template.passCondition;
  let thresholdText = "";
  const countLines = template.buttons.map(
    (btn) => `${btn.emoji} ${btn.label}：${voteCounts[btn.id]} 人`,
  );

  switch (passCondition?.type) {
    case "weighted":
      countLines.push(`📊 總分：${totalScore} 分`);
      thresholdText = `總分 ≥ ${passCondition.minTotalScore} 且 高意願 ≥ ${passCondition.minHighInterest} 人`;
      break;
    case "reverse":
      thresholdText = `如果活躍人數 < ${passCondition.maxStillActive + 1} 人，則通過`;
      break;
    case "majority": {
      const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);
      countLines.push(`📊 總投票數：${totalVotes} 票`);
      thresholdText = `總票數 ≥ ${passCondition.minTotalVotes} 且 贊成票 > 反對票`;
      break;
    }
    case "simple":
      thresholdText = `支持票 ≥ ${passCondition.minSupport} 票`;
      break;
  }

  const buttons = new ActionRowBuilder();
  for (const btn of template.buttons) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`vote_${proposal.templateKey}_${btn.id}`)
        .setLabel(btn.label)
        .setEmoji(btn.emoji)
        .setStyle(ButtonStyle[btn.style]),
    );
  }

  const container = new ContainerBuilder()
    .setAccentColor(getTemplateColor(proposal.templateKey))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${template.emoji} 提案：${title}\n${description}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📋 投票類型**：${template.name}\n` +
          `**⏰ 投票時間**：${proposal.duration} 小時\n` +
          `**📅 截止時間**：<t:${expiresEpoch}:R>`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(countLines.join("\n")),
    );

  if (thresholdText) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**✅ 通過門檻**\n${thresholdText}`,
      ),
    );
  }

  container.addActionRowComponents(buttons).addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# <t:${createdEpoch}:R>`),
  );

  return container;
}

async function updateVoteMessage(client, interaction, proposal) {
  try {
    const updatedProposal = await client.votingProposalsCollection.findOne({
      _id: proposal._id,
    });
    if (!updatedProposal) return;

    const template = config.voting.templates[updatedProposal.templateKey];
    if (!template) {
      logger.error(
        { source: "vote-update", templateKey: updatedProposal.templateKey },
        "找不到投票模板"
      );
      trackError("vote-update", new Error(`template not found: ${updatedProposal.templateKey}`));
      return;
    }

    const container = rebuildVoteContainer(updatedProposal, template);
    await interaction.message.edit({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    logger.error(
      { source: "vote-update", err: error.message, stack: error.stack },
      "更新投票訊息時出錯"
    );
    trackError("vote-update", error);
  }
}
