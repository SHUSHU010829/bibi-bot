require("colors");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");
const questNotifyPref = require("./questNotifyPref");
const notifyPrefs = require("../reminders/notifyPrefs");

// COIN_EMOJI 為動態自訂 emoji，只會在 Embed 描述渲染；標題／footer 用 🪙 文字。
// optOut：被動任務的 DM 才附「如何關閉提醒」的 footer；ephemeral 私人回覆不附。
const buildClaimEmbed = (claimed, { optOut = false } = {}) => {
  const tag = claimed.period === "weekly" ? "📅 週常" : "🌞 每日";
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🪙 任務完成！")
    .setDescription(
      `${tag} ・ **${claimed.name}**\n自動入帳 **+${claimed.reward.toLocaleString()}** ${COIN_EMOJI}`
    );
  if (optOut) {
    embed.setFooter({ text: "不想再收到提醒？用 /通知設定 即可關閉" });
  }
  return embed;
};

module.exports = async (client, ctx, claimed) => {
  if (!claimed) return;

  try {
    // 與挖礦任務同步：指令觸發的任務一律以 ephemeral 私人回覆（只有本人看得到）。
    if (ctx?.interaction) {
      await ctx.interaction
        .followUp({
          embeds: [buildClaimEmbed(claimed)],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    // 沒有 interaction 的被動事件（發言／語音／表情、grantCoins 賭博／股市）：
    // 預設私訊通知；玩家可在 /逼幣任務 或 /通知設定 關閉「完成 DM 通知」。
    const userId = ctx?.userId || ctx?.user?.id;
    const guildId = ctx?.guildId;
    if (!userId || !guildId) return;

    const enabled = await questNotifyPref.isDmEnabled(client, userId, guildId);
    if (!enabled) return;

    // 通知總開關關閉時，連被動任務 DM 也一併靜音。
    const masterOn = await notifyPrefs.isMasterEnabled(client, userId, guildId);
    if (!masterOn) return;

    let user = ctx?.user;
    if (!user) user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    await user
      .send({ embeds: [buildClaimEmbed(claimed, { optOut: true })] })
      .catch(() => {});
  } catch (e) {
    console.log(`[ERROR] notifyQuestClaim: ${e}`.red);
  }
};
