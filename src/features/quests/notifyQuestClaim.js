require("colors");
const { MessageFlags } = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");
const questNotifyPref = require("./questNotifyPref");

const formatClaim = (claimed) => {
  const tag = claimed.period === "weekly" ? "📅 週常" : "🌞 每日";
  return `${COIN_EMOJI} 任務完成！${tag} ・ **${claimed.name}** ・ 自動入帳 **+${claimed.reward.toLocaleString()}** ${COIN_EMOJI}`;
};

module.exports = async (client, ctx, claimed) => {
  if (!claimed) return;

  try {
    // 與挖礦任務同步：指令觸發的任務一律以 ephemeral 私人回覆（只有本人看得到）。
    if (ctx?.interaction) {
      await ctx.interaction
        .followUp({ content: formatClaim(claimed), flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }

    // 沒有 interaction 的被動事件（發言／語音／表情、grantCoins 賭博／股市）：
    // 預設靜默自動入帳；只有玩家在 /逼幣任務 自行開啟「完成 DM 通知」才私訊。
    const userId = ctx?.userId || ctx?.user?.id;
    const guildId = ctx?.guildId;
    if (!userId || !guildId) return;

    const enabled = await questNotifyPref.isDmEnabled(client, userId, guildId);
    if (!enabled) return;

    let user = ctx?.user;
    if (!user) user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    await user.send(formatClaim(claimed)).catch(() => {});
  } catch (e) {
    console.log(`[ERROR] notifyQuestClaim: ${e}`.red);
  }
};
