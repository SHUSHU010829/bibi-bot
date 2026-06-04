require("colors");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");
const questNotifyPref = require("./questNotifyPref");
const notifyPrefs = require("../reminders/notifyPrefs");

// 任務剛達標（state: in_progress → ready）時的通知。
// 跟 notifyQuestClaim 不同：這時候錢還沒入帳，要請玩家自己到 /逼幣任務 按「💰 領取」。
const buildReadyEmbed = (quest, { optOut = false } = {}) => {
  const tag = quest.period === "weekly" ? "📅 週常" : "🌞 每日";
  const embed = new EmbedBuilder()
    .setColor(0xffa726)
    .setTitle("✅ 任務完成！")
    .setDescription(
      `${tag} ・ **${quest.name}**\n` +
        `可領 **+${quest.reward.toLocaleString()}** ${COIN_EMOJI}\n` +
        `-# 用 \`/逼幣任務\` 點「💰 領取」即可入帳。`,
    );
  if (optOut) {
    embed.setFooter({ text: "不想再收到提醒？用 /通知設定 即可關閉" });
  }
  return embed;
};

module.exports = async (client, ctx, quest) => {
  if (!quest) return;

  try {
    if (ctx?.interaction) {
      await ctx.interaction
        .followUp({
          embeds: [buildReadyEmbed(quest)],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    const userId = ctx?.userId || ctx?.user?.id;
    const guildId = ctx?.guildId;
    if (!userId || !guildId) return;

    const enabled = await questNotifyPref.isDmEnabled(client, userId, guildId);
    if (!enabled) return;

    const masterOn = await notifyPrefs.isMasterEnabled(client, userId, guildId);
    if (!masterOn) return;

    let user = ctx?.user;
    if (!user) user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    await user
      .send({ embeds: [buildReadyEmbed(quest, { optOut: true })] })
      .catch(() => {});
  } catch (e) {
    console.log(`[ERROR] notifyQuestReady: ${e}`.red);
  }
};
