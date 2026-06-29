// 釣魚結果訊息上「🎣 再釣一次」按鈕處理器。
//
// 按鈕 customId = fish_again_<ownerId>_<location>（見 commands/fishing/fish.js）。
// location 延續玩家這一竿的釣場，直接呼叫 executeFish 換成新一次釣魚結果；
// 若仍在冷卻，executeFish 會回傳冷卻畫面（含切換地點選單與 CD 縮短券按鈕）。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { fishing } = require("../../config");
const { parseFishAgainId, executeFish } = require("../../commands/fishing/fish");

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
    const parsed = parseFishAgainId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;
    let { location } = parsed;

    const rl = consume(interaction.user.id, "btn:fishAgain", {
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
        "🚫 這是別人的釣魚訊息按鈕，請呼叫自己的 /釣魚～",
      );
      return;
    }

    if (!fishing.locations?.[location]) location = "stream";

    if (!(await deferUpdateSafe(interaction))) return;

    await executeFish(client, interaction, { location });
    trackSuccess("fish-again");
  } catch (err) {
    logger.error(
      {
        source: "fish-again",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "再釣一次（釣魚訊息按鈕）時出錯",
    );
    trackError("fish-again", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 再釣一次失敗，請呼叫舒舒！");
  }
};
