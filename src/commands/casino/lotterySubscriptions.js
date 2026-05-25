// /樂透訂閱列表 — 查看自己的訂閱 + 提供取消按鈕。

require("colors");
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { getLotteryConfig } = require("../../features/casino/lottery/numbers");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("樂透訂閱列表")
    .setDescription("查看與管理自己的樂透訂閱 📋")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.lotterySubscriptionsCollection) {
        return interaction.editReply("🔧 樂透系統尚未啟動。");
      }
      const subs = await client.lotterySubscriptionsCollection
        .find({
          userId: interaction.user.id,
          guildId: interaction.guildId,
          status: { $in: ["active", "insufficient"] },
        })
        .sort({ createdAt: -1 })
        .toArray();

      if (subs.length === 0) {
        return interaction.editReply(
          "你目前沒有進行中的樂透訂閱。用 `/樂透訂閱` 建立一筆吧!"
        );
      }

      const lines = [];
      const components = [];
      for (const s of subs) {
        const cfg = getLotteryConfig(s.lotteryType);
        const label = cfg?.label || s.lotteryType;
        lines.push(
          `**${label}** ・ 號碼 ${s.numbers.join(" ・ ")}\n` +
            `剩餘 ${s.drawsRemaining}/${s.totalDraws} 期 × ${s.ticketsPerDraw} 張 ・ 已花費 ${(s.totalSpent || 0).toLocaleString()} ・ 已得 ${(s.totalWon || 0).toLocaleString()}`
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`lotterysub_cancel_${s.subscriptionId}`)
            .setLabel(`取消 ${label} 訂閱`)
            .setStyle(ButtonStyle.Danger)
        );
        components.push(row);
      }

      await interaction.editReply({
        content: lines.join("\n\n"),
        components: components.slice(0, 5),
      });
    } catch (err) {
      console.log(`[ERROR] /樂透訂閱列表:\n${err}\n${err.stack}`.red);
      await interaction.editReply("🔧 查詢失敗。").catch(() => {});
    }
  },
};
