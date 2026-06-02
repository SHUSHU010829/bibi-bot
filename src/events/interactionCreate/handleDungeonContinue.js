// 地下城「🔄 繼續探索」按鈕處理器。
//
// 按鈕 customId = dungeon_continue_<ownerId>（見 commands/mining/dungeon.js）。
// 確認是本人後，直接交回 /地下城 指令的 run() 重跑一次
// （run() 會自己 deferReply，產生一則全新的探索結果訊息）。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const dungeonCmd = require("../../commands/mining/dungeon");

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

    const cid = interaction.customId;
    // 分支：背包滿確認按鈕（dungeon_overflow_confirm_<userId> / _cancel_<userId>）
    const overflowConfirm = cid.startsWith(dungeonCmd.DUNGEON_OVERFLOW_CONFIRM_PREFIX);
    const overflowCancel = cid.startsWith(dungeonCmd.DUNGEON_OVERFLOW_CANCEL_PREFIX);
    if (overflowConfirm || overflowCancel) {
      const prefix = overflowConfirm
        ? dungeonCmd.DUNGEON_OVERFLOW_CONFIRM_PREFIX
        : dungeonCmd.DUNGEON_OVERFLOW_CANCEL_PREFIX;
      const ownerId = cid.slice(prefix.length);
      if (interaction.user.id !== ownerId) {
        return replyEphemeral(interaction, "🚫 這不是你的地下城。");
      }
      if (overflowCancel) {
        return interaction
          .update({ components: [], content: "已取消這次探索。" })
          .catch(() => {});
      }
      await interaction.deferUpdate();
      return await dungeonCmd.executeDungeon(client, interaction, {
        allowOverflow: true,
      });
    }

    const parsed = dungeonCmd.parseContinueId(cid);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:dungeonContinue", {
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

    // 只有本人能用自己的「繼續探索」
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的「繼續探索」按鈕，請用 /地下城 自己開一場～"
      );
      return;
    }

    if (typeof dungeonCmd.run !== "function") return;
    await dungeonCmd.run(client, interaction);
    trackSuccess("dungeon-continue");
  } catch (err) {
    logger.error(
      {
        source: "dungeon-continue",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "地下城繼續探索處理失敗"
    );
    trackError("dungeon-continue", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 繼續探索失敗，請呼叫舒舒！");
  }
};
