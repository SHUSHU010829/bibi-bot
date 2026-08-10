// 深挖結果訊息上「🔮 再挖一次」按鈕處理器。
//
// 按鈕 customId = deepmine_again_<ownerId>（見 commands/mining/deepMine.js）。
// 比照挖礦 / 釣魚的「再來一次」：用 deferReply 另發一則全新的深挖結果訊息，
// 不覆蓋原本那則，讓每一次深挖紀錄都留在頻道裡。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const deepMineCommand = require("../../commands/mining/deepMine");

const PREFIX = "deepmine_again_";

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
    if (!interaction.customId.startsWith(PREFIX)) return;

    const ownerId = interaction.customId.slice(PREFIX.length);

    const rl = consume(interaction.user.id, "btn:deepMineAgain", {
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
        "🚫 這不是你的深挖！用 `/深挖` 開自己的～",
      );
      return;
    }

    if (!(await deferReplySafe(interaction))) return;

    await deepMineCommand.execute(client, interaction);
    trackSuccess("deepmine-again");
  } catch (err) {
    logger.error(
      {
        source: "deepmine-again",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "再挖一次（深挖訊息按鈕）時出錯",
    );
    trackError("deepmine-again", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 再挖一次失敗，請呼叫舒舒！");
  }
};
