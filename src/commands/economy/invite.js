require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { inviteSystem } = require("../../config");

module.exports = {
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

      const embed = new EmbedBuilder()
        .setTitle("✉️ 你的邀請統計")
        .setColor(0x5865f2)
        .addFields(
          { name: "✅ 有效邀請", value: `${active} 人`, inline: true },
          { name: "💨 已退坑", value: `${left} 人`, inline: true },
          { name: "↩️ 已扣回", value: `${clawedBack} 人`, inline: true },
          {
            name: "💰 累積獲得",
            value: `${totalReward.toLocaleString()} 金幣`,
            inline: true,
          },
          {
            name: "💸 累積扣回",
            value: `${totalClawback.toLocaleString()} 金幣`,
            inline: true,
          },
          {
            name: "📊 淨收益",
            value: `${netCoins.toLocaleString()} 金幣`,
            inline: true,
          }
        )
        .setFooter({
          text: `每邀請 1 人 +${inviteSystem.rewardAmount} 金幣・${inviteSystem.clawbackDays} 天內退坑扣回`,
        });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /邀請:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 邀請統計讀取失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
