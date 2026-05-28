require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { MONEY_EMOJI } = require("../../constants/coin");
const { inviteSystem } = require("../../config");
const {
  computeReward,
  countTodayRewardedInvites,
  getDailyCap,
} = require("../../features/invite/rewardFormula");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("邀請")
    .setDescription("查看你的伺服器邀請統計 ✉️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!inviteSystem?.enabled) {
        return interaction.editReply("🔧 邀請追蹤系統尚未啟動！");
      }
      if (!client.inviteRecordsCollection) {
        return interaction.editReply("🔧 邀請追蹤系統尚未啟動，請聯絡舒舒！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const agg = await client.inviteRecordsCollection
        .aggregate([
          { $match: { guildId, inviterId: userId } },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
              totalReward: { $sum: { $ifNull: ["$rewardGranted", 0] } },
              totalClawback: { $sum: { $ifNull: ["$clawedBackAmount", 0] } },
            },
          },
        ])
        .toArray();

      let active = 0;
      let left = 0;
      let clawedBack = 0;
      let totalReward = 0;
      let totalClawback = 0;
      for (const row of agg) {
        totalReward += row.totalReward || 0;
        totalClawback += row.totalClawback || 0;
        if (row._id === "active") active = row.count;
        else if (row._id === "left") left = row.count;
        else if (row._id === "clawed_back") clawedBack = row.count;
      }

      const netCoins = totalReward - totalClawback;
      const nextReward = computeReward(active);
      const cap = Math.max(0, Math.floor(inviteSystem.rewardMax || 0));
      const atCap = cap > 0 && nextReward >= cap;

      const dailyCap = getDailyCap();
      const todayUsed = dailyCap > 0
        ? await countTodayRewardedInvites(client, guildId, userId)
        : 0;
      const todayRemaining = dailyCap > 0 ? Math.max(0, dailyCap - todayUsed) : null;

      const footerText =
        `基礎 ${inviteSystem.rewardAmount} + 每多 1 人 +${inviteSystem.rewardStep || 0}` +
        (cap > 0 ? `（上限 ${cap}）` : "") +
        (inviteSystem.inviteeWelcomeBonus > 0
          ? `・新成員歡迎金 ${inviteSystem.inviteeWelcomeBonus}`
          : "") +
        `・${inviteSystem.clawbackDays} 天內退坑扣回`;

      const container = new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# ✉️ 你的邀請統計"),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**人數統計**\n` +
              `✅ 有效邀請：**${active}** 人\n` +
              `💨 已退坑：**${left}** 人\n` +
              `↩️ 已扣回：**${clawedBack}** 人`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**金幣統計**\n` +
              `${MONEY_EMOJI} 累積獲得：**${totalReward.toLocaleString()}** 金幣\n` +
              `💸 累積扣回：**${totalClawback.toLocaleString()}** 金幣\n` +
              `📊 淨收益：**${netCoins.toLocaleString()}** 金幣`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🎯 下一筆邀請可獲得**\n` +
              (todayRemaining === 0
                ? "今日已達邀請次數上限，明日再開放"
                : `${nextReward.toLocaleString()} 金幣${atCap ? "（已達單筆上限）" : ""}`) +
              (dailyCap > 0
                ? `\n\n**🗓️ 今日剩餘有獎次數**\n${todayRemaining} / ${dailyCap} 次`
                : ""),
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# ${footerText}`),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /邀請:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 邀請統計讀取失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
