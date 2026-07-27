// /逼幣任務 介面內，每個任務旁的「🔄 重抽」「💰 領取」按鈕處理器。
// customId = qrr_<userId>_<questId> / qcl_<userId>_<questId>（features/quests/questManageButton.js）。

const { MessageFlags } = require("discord.js");

const { deferUpdateSafe } = require("../../utils/safeAck");
const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { questSystem } = require("../../config");
const questManageButton = require("../../features/quests/questManageButton");
const questAssignmentService = require("../../features/quests/questAssignmentService");
const questService = require("../../features/quests/questService");
const { getQuestById } = require("../../features/quests/questDefinitions");
const { buildQuestContainer } = require("../../features/quests/questView");
const questRewards = require("../../features/quests/questRewards");
const { COIN_EMOJI } = require("../../constants/coin");

const REASON_MSG = {
  disabled: "🔧 個人化任務系統未啟用。",
  no_assignment: "🔧 任務指派資料不存在，請重新打開 /逼幣任務。",
  not_in_pool: "❌ 這個任務不在你本期的指派裡。",
  not_ready: "❌ 任務尚未完成，還不能領取。",
  not_found: "❌ 找不到這個任務。",
  already_skipped: "❌ 這個任務已經被你跳過了。",
  already_claimed: "❌ 這個任務已經領取了。",
  over_limit: "❌ 你本期的重抽額度已用完。",
  pool_exhausted: "❌ 任務池已抽完，沒有其他任務可換。",
  stale: "⚠️ 任務狀態剛被更新，請重新打開 /逼幣任務。",
  charge_failed: "💸 餘額不足或扣款失敗。",
};

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
    const parsed = questManageButton.parseCustomId(interaction.customId);
    if (!parsed) return;
    const { action, userId: ownerId, questId } = parsed;

    const rl = consume(interaction.user.id, `btn:quest${action}`, {
      windowMs: 2000,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
      );
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的任務面板，請呼叫自己的 /逼幣任務～",
      );
      return;
    }

    if (!questSystem?.enabled || !client.questAssignmentsCollection) {
      await replyEphemeral(interaction, "🔧 任務系統尚未啟動，請聯絡舒舒！");
      return;
    }

    const def = getQuestById(questId);
    if (!def) {
      await replyEphemeral(interaction, "❌ 找不到這個任務。");
      return;
    }
    const tier = questAssignmentService.tierFromPeriod(def.period);
    if (action === "reroll" && !tier) {
      await replyEphemeral(interaction, "❌ 此任務不支援重抽。");
      return;
    }

    if (!(await deferUpdateSafe(interaction))) return;

    const opts = {
      username: interaction.user.username,
      avatarHash: interaction.user.avatar,
      member: interaction.member,
    };
    let result;
    if (action === "reroll") {
      result = await questAssignmentService.rerollQuest(
        client,
        interaction.user.id,
        interaction.guildId,
        tier,
        questId,
        opts,
      );
    } else {
      result = await questService.claimSingle(
        client,
        interaction.user.id,
        interaction.guildId,
        questId,
        interaction.member,
        interaction.user.username,
      );
    }

    // 重繪面板
    const container = await buildQuestContainer(
      client,
      interaction.user.id,
      interaction.guildId,
    );
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    if (!result.ok) {
      await replyEphemeral(
        interaction,
        REASON_MSG[result.reason] || `❌ 操作失敗：${result.reason}`,
      );
      return;
    }

    if (action === "reroll") {
      const newDef = getQuestById(result.to);
      await replyEphemeral(
        interaction,
        `🔄 已重抽「**${def.name}**」→「**${newDef?.name || result.to}**」・ 花費 **${result.cost.toLocaleString()}** ${COIN_EMOJI}\n` +
          `-# 本期重抽次數 ${result.used}/${result.limit}`,
      );
    } else {
      const c = result.claimed;
      const tag = c.period === "weekly" ? "📅 週常" : "🌞 每日";
      const msLines = (result.milestones || []).map(
        (m) =>
          `\n🎁 里程碑達成 **${m.name}**（完成 ${m.count} 個任務）→ ${questRewards.rewardText(
            { rewardItems: m.rewardItems },
          )}`,
      );
      await replyEphemeral(
        interaction,
        `💰 ${tag} ・ **${c.name}** ・ ${questRewards.rewardText(c)}${msLines.join("")}`,
      );
    }
    trackSuccess(`quest-manage-${action}`);
  } catch (err) {
    logger.error(
      {
        source: "quest-manage-button",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "重抽任務按鈕處理時出錯",
    );
    trackError("quest-manage-button", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 操作失敗，請呼叫舒舒！");
  }
};
