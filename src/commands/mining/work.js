require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { work } = require("../../config");
const workService = require("../../features/work/workService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("打工")
    .setDescription("打工賺取穩定收入 💼（有冷卻時間，每日次數有上限）")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const result = await workService.doWork(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        username: interaction.user.username,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 打工系統尚未啟動！");
        }
        if (result.reason === "cooldown") {
          const readyEpoch = Math.floor(result.readyAt / 1000);
          return interaction.editReply(
            `💼 你還在休息！下次可打工：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`
          );
        }
        if (result.reason === "daily_limit") {
          return interaction.editReply(
            `💼 今天已經打工 ${result.claimsToday}/${result.maxClaims} 次，達上限了！\n` +
              `明天再來：<t:${result.resetEpoch}:R>`
          );
        }
        return interaction.editReply("🔧 打工失敗，請稍後再試。");
      }

      const readyEpoch = Math.floor(result.newCooldownAt / 1000);
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("💼 打工完成")
        .setDescription(`你${result.job}，獲得了 **+${result.amount.toLocaleString()}** 🪙`)
        .addFields(
          {
            name: "目前餘額",
            value: `${result.balance.toLocaleString()} 🪙`,
            inline: true,
          },
          {
            name: "今日次數",
            value: `${result.claimsToday}/${result.maxClaims}`,
            inline: true,
          },
          {
            name: "下次可打工",
            value: `<t:${readyEpoch}:R>`,
            inline: true,
          }
        )
        .setFooter({ text: "想要更高報酬？試試 /挖礦 吧！" });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /打工:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 打工失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
