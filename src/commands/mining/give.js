require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const giftService = require("../../features/mining/giftService");

function oreChoices() {
  return Object.entries(mining?.ores || {}).map(([key, def]) => ({
    name: def.name || key,
    value: key,
  }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("贈送")
    .setDescription("把背包裡的礦石送給其他玩家 🎁（每日次數有限、免手續費）")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("收禮的玩家").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("礦石")
        .setDescription("要送的礦石種類")
        .setRequired(true)
        .addChoices(...oreChoices())
    )
    .addIntegerOption((o) =>
      o
        .setName("數量")
        .setDescription("要送的數量")
        .setRequired(true)
        .setMinValue(1)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const target = interaction.options.getUser("對象");
      const ore = interaction.options.getString("礦石");
      const qty = interaction.options.getInteger("數量");

      if (target.bot) return interaction.editReply("❌ 不能送禮給 bot 啦。");
      if (target.id === interaction.user.id) {
        return interaction.editReply("❌ 不能送給自己。");
      }

      const result = await giftService.giveOre(client, {
        giverId: interaction.user.id,
        guildId: interaction.guildId,
        recipientId: target.id,
        recipientName: target.username,
        ore,
        qty,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 贈送功能尚未開放！");
        }
        if (result.reason === "no_ore") {
          return interaction.editReply("❌ 找不到這種礦石。");
        }
        if (result.reason === "daily_limit") {
          return interaction.editReply(
            `🎁 今天已經送出 ${result.usedToday}/${result.dailyMax} 次，達上限了！\n` +
              `明天再來：<t:${result.resetEpoch}:R>`
          );
        }
        if (result.reason === "insufficient") {
          return interaction.editReply(
            `🎒 你只有 **${result.have}** 顆 ${result.oreDef.name}，無法送出 ${qty} 顆。`
          );
        }
        if (result.reason === "recipient_full") {
          return interaction.editReply(
            `🎒 對方的背包快滿了（${result.used}/${result.cap}），裝不下這些礦石。`
          );
        }
        return interaction.editReply("🔧 贈送失敗，請稍後再試。");
      }

      const def = result.oreDef;
      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle("🎁 贈送成功")
        .setDescription(
          `${interaction.user} 送給 ${target} ` +
            `**${def.emoji || "⛏️"} ${def.name} ×${result.qty}**！`
        )
        .setFooter({ text: `今日贈送次數：${result.usedToday}/${result.dailyMax}` });

      await interaction.editReply({ content: `${target}`, embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /贈送:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 贈送失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
