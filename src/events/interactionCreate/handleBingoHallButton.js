// 賓果大廳買卡按鈕：customId = bh_buy_<roundId>_<count>（roundId 為 uuid，含 "-" 不含 "_"）。
// 點按鈕即直接買指定張數，ephemeral 回覆。免指令。

const { MessageFlags } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const {
  buyCards,
  getOpenRound,
} = require("../../features/casino/bingoHall/service");
const { buildBuyReply } = require("../../features/casino/bingoHall/render");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("bh_buy_")) return;
    if (!client.bingoHallRoundsCollection) return;

    const rest = interaction.customId.slice("bh_buy_".length);
    const sep = rest.lastIndexOf("_");
    if (sep <= 0) return;
    const roundId = rest.slice(0, sep);
    const count = parseInt(rest.slice(sep + 1), 10);
    if (!roundId || !Number.isInteger(count) || count <= 0) return;

    const userId = interaction.user.id;
    const rl = consume(userId, "btn:bingoHall", { windowMs: 1000, max: 1 });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 慢一點，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const open = await getOpenRound(client);
    if (!open || open.roundId !== roundId) {
      return interaction.editReply("🎱 這場已經開球囉，往上看最新一場買卡吧！");
    }

    const res = await buyCards(client, {
      userId,
      guildId: interaction.guildId,
      username: interaction.member?.displayName || interaction.user.username,
      count,
      member: interaction.member,
    });

    if (!res.ok) {
      if (res.reason === "max") {
        return interaction.editReply(
          `🎱 每場最多 ${res.maxPer} 張，你已有 ${res.owned} 張，這次買不下 ${count} 張。`
        );
      }
      if (res.reason === "balance") {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！買 ${count} 張要 **${res.cost.toLocaleString()}**，你只有 **${res.balance.toLocaleString()}**。`
        );
      }
      if (res.reason === "closed") {
        return interaction.editReply("🎱 目前沒有開放中的場次，稍候下一場～");
      }
      return interaction.editReply("🔧 買卡失敗，請稍後再試。");
    }

    await interaction.editReply(buildBuyReply(res));
    trackSuccess("bingohall-button");
  } catch (error) {
    logger.error(
      {
        source: "bingohall-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "賓果大廳買卡按鈕失敗"
    );
    trackError("bingohall-button", error, { customId: interaction.customId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("🔧 買卡失敗，請呼叫舒舒！");
      } else {
        await interaction.reply({
          content: "🔧 買卡失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) { /* noop */ }
  }
};
