require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");

const workService = require("../../features/work/workService");
const workView = require("../../features/work/workView");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("打工")
    .setDescription("打工賺取收入 💼（選工作類型、有隨機事件、有冷卻與每日上限）")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const avail = await workService.checkAvailability(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      if (!avail.ok) {
        if (avail.reason === "cooldown") {
          return interaction.editReply(workView.buildCooldownMessage(avail.readyAt));
        }
        if (avail.reason === "daily_limit") {
          return interaction.editReply(workView.buildDailyLimitMessage(avail));
        }
        return interaction.editReply(workView.buildDisabledMessage());
      }

      await interaction.editReply(
        workView.buildChoiceMessage(interaction.user.id, {
          claimsToday: avail.claimsToday,
          maxClaims: avail.maxClaims,
        })
      );
    } catch (error) {
      console.log(`[ERROR] /打工:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 打工失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
