// 挖礦成功訊息上「⛏️ 再挖一次」按鈕處理器。
//
// 按鈕 customId = mine_again_<ownerId>（見 commands/mining/mine.js）。
// 直接呼叫 executeMine 把訊息換成新一次挖礦結果；若仍在冷卻，
// executeMine 會回傳冷卻畫面（含 CD 縮短券按鈕），無需另外處理。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { parseMineAgainId, executeMine } = require("../../commands/mining/mine");

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
    const parsed = parseMineAgainId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:mineAgain", {
      windowMs: 1500,
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
        "🚫 這是別人的挖礦訊息按鈕，請呼叫自己的 /挖礦～",
      );
      return;
    }

    if (!(await deferUpdateSafe(interaction))) return;

    await executeMine(client, interaction, { allowOverflow: false });
    trackSuccess("mine-again");
  } catch (err) {
    logger.error(
      {
        source: "mine-again",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "再挖一次（挖礦訊息按鈕）時出錯",
    );
    trackError("mine-again", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 再挖一次失敗，請呼叫舒舒！");
  }
};
