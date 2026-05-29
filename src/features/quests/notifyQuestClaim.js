require("colors");
const { MessageFlags } = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");

const formatClaim = (claimed) => {
  const tag = claimed.period === "weekly" ? "📅 週常" : "🌞 每日";
  return `${COIN_EMOJI} 任務完成！${tag} ・ **${claimed.name}** ・ 自動入帳 **+${claimed.reward.toLocaleString()}** ${COIN_EMOJI}`;
};

module.exports = async (client, ctx, claimed) => {
  if (!claimed) return;

  // 與挖礦任務同步：任務完成一律以 ephemeral 私人回覆（只有本人看得到）。
  // 沒有 interaction 的情境（發言／語音／表情等被動事件、grantCoins 賭博／股市）
  // 一律靜默自動入帳，不再額外發 DM 通知。
  if (!ctx?.interaction) return;

  const text = formatClaim(claimed);

  try {
    await ctx.interaction
      .followUp({ content: text, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  } catch (e) {
    console.log(`[ERROR] notifyQuestClaim: ${e}`.red);
  }
};
