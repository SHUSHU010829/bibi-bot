// /逼幣任務 介面下方「領錢」按鈕處理器。
//
// 按鈕 customId = questclaim_<userId>（見 features/quests/questClaimButton.js）。
// 確認本人後補領所有「待入帳」獎勵（等同 /領錢），就地重繪任務面板，
// 並私訊（followUp）回報這次領到的明細。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { questSystem } = require("../../config");
const questService = require("../../features/quests/questService");
const questClaimButton = require("../../features/quests/questClaimButton");
const { buildQuestContainer } = require("../../features/quests/questView");
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
    await interaction.deferUpdate();

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
        "📭 目前沒有待入帳的任務獎勵～任務完成時通常會自動入帳。"
      );
      return;
    }

    const lines = result.claimed.map((q) => {
      const tag = q.period === "weekly" ? "📅 週常" : "🌞 每日";
      return `${tag} ・ **${q.name}** ・ +**${q.reward.toLocaleString()}** ${COIN_EMOJI}`;
    });
    await replyEphemeral(
      interaction,
      `${COIN_EMOJI} 共補領 **${result.claimed.length}** 筆 ・ **+${result.total.toLocaleString()}** ${COIN_EMOJI}\n${lines.join(
        "\n"
      )}`
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
