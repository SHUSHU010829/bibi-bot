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
    const parsed = dungeonCmd.parseContinueId(interaction.customId);
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
