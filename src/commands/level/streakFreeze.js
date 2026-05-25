require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { levelSystem } = require("../../config");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("補簽卡")
    .setDescription("查看你的補簽卡庫存與規則 🛡️")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    try {
      if (!client.userLevelsCollection) {
        return interaction.reply({
          content: "🔧 等級系統尚未啟動",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cfg = levelSystem.daily;
      const max = cfg.maxStreakFreezeStock ?? 3;
      const every = cfg.streakFreezeUnlockEvery ?? 30;

      const doc = await client.userLevelsCollection.findOne({
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      const stock = doc?.streakFreezes || 0;
      const streak = doc?.streak || 0;
      const nextMilestone = every > 0 ? Math.ceil((streak + 1) / every) * every : null;
      const remainToNext = nextMilestone != null ? nextMilestone - streak : null;

      const lines = [
        `## 🛡️ 補簽卡`,
        `目前庫存：**${stock} / ${max}**`,
        `當前連勝：**${streak}** 天`,
      ];
      if (every > 0) {
        lines.push(
          `每連續 **${every}** 天簽到 +1 張（庫存上限 ${max}）`
        );
        if (remainToNext != null) {
          if (stock >= max) {
            lines.push(`-# 庫存已滿，下次里程碑不會再 +1`);
          } else {
            lines.push(`-# 距離下次保護卡：再連續簽到 **${remainToNext}** 天`);
          }
        }
      }
      lines.push("");
      lines.push(
        `規則：當你「漏簽 1 天」時自動消耗 1 張，連勝不歸零繼續累積。漏 2 天以上仍會歸零。`
      );

      await interaction.reply({
        content: lines.join("\n"),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /補簽卡:\n${error}\n${error.stack}`.red);
      const reply = { content: "🔧 載入失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};
