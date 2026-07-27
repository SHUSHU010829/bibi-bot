// /逼幣任務 介面下方「領錢」按鈕處理器。
//
// 按鈕 customId = questclaim_<userId>（見 features/quests/questClaimButton.js）。
// 確認本人後補領所有「待入帳」獎勵，就地重繪任務面板，
// 並私訊（followUp）回報這次領到的明細。

const { MessageFlags } = require("discord.js");

const { deferUpdateSafe } = require("../../utils/safeAck");
const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { questSystem } = require("../../config");
const questService = require("../../features/quests/questService");
const questClaimButton = require("../../features/quests/questClaimButton");
const { buildQuestContainer } = require("../../features/quests/questView");
const questRewards = require("../../features/quests/questRewards");
const { COIN_EMOJI } = require("../../constants/coin");

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const parsed = questClaimButton.parseCustomId(interaction.customId);
    if (!parsed) return;
    const { userId: ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:questClaim", {
      windowMs: 2000,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`
      );
      return;
    }

    // 只有本人能操作自己 /逼幣任務 上的按鈕
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的任務面板，請呼叫自己的 /逼幣任務～"
      );
      return;
    }

    if (!questSystem?.enabled || !client.questProgressCollection) {
      await replyEphemeral(interaction, "🔧 任務系統尚未啟動，請聯絡舒舒！");
      return;
    }

    // 先確認互動，避免後續 DB 操作超過 3 秒 token 視窗
    if (!(await deferUpdateSafe(interaction))) return;

    const result = await questService.claimAll(
      client,
      interaction.user.id,
      interaction.guildId,
      interaction.member,
      interaction.user.username
    );

    // 就地重繪整個任務面板（含按鈕最新狀態）
    const container = await buildQuestContainer(
      client,
      interaction.user.id,
      interaction.guildId
    );
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    if (!result.claimed || result.claimed.length === 0) {
      await replyEphemeral(
        interaction,
        "📭 目前沒有可領的任務獎勵～去完成任務後再回來按一鍵領取。"
      );
      return;
    }

    const lines = result.claimed.map((q) => {
      const tag = q.period === "weekly" ? "📅 週常" : "🌞 每日";
      return `${tag} ・ **${q.name}** ・ ${questRewards.rewardText(q)}`;
    });
    const summaryParts = [`**+${result.total.toLocaleString()}** ${COIN_EMOJI}`];
    for (const [key, qty] of Object.entries(result.itemTotals || {})) {
      summaryParts.push(`**${questRewards.itemRewardLabel(key)} ×${qty}**`);
    }
    if (result.milestones?.length) {
      for (const m of result.milestones) {
        lines.push(
          `🎁 里程碑達成 **${m.name}**（完成 ${m.count} 個任務）→ ${questRewards.rewardText(
            { rewardItems: m.rewardItems }
          )}`
        );
      }
    }
    await replyEphemeral(
      interaction,
      `${COIN_EMOJI} 共補領 **${result.claimed.length}** 筆 ・ ${summaryParts.join(
        " + "
      )}\n${lines.join("\n")}`
    );
    trackSuccess("quest-claim-button");
  } catch (err) {
    logger.error(
      {
        source: "quest-claim-button",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "領錢按鈕處理時出錯"
    );
    trackError("quest-claim-button", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 領取失敗，請呼叫舒舒！");
  }
};
