require("colors");
const { MessageFlags } = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");

const formatClaim = (claimed) => {
  const tag = claimed.period === "weekly" ? "📅 週常" : "🌞 每日";
  return `${COIN_EMOJI} 任務完成！${tag} ・ **${claimed.name}** ・ 自動入帳 **+${claimed.reward.toLocaleString()}** ${COIN_EMOJI}`;
};

module.exports = async (client, ctx, claimed) => {
  if (!claimed) return;
  const text = formatClaim(claimed);

  try {
    if (ctx?.interaction) {
      await ctx.interaction
        .followUp({ content: text, flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }

    let user = ctx?.user;
    if (!user && ctx?.userId) {
      user = await client.users.fetch(ctx.userId).catch(() => null);
    }
    if (!user) return;
    await user.send(text).catch(() => {});
  } catch (e) {
    console.log(`[ERROR] notifyQuestClaim: ${e}`.red);
  }
};
