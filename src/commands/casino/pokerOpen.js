require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");

const { casino } = require("../../config");
const { createTable } = require("../../features/casino/poker/service");

function getCfg() {
  return casino?.poker || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("多人德州")
    .setDescription("開一桌多人德州撲克 🃏（會自動建立執行緒，桌面在裡面跑）")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("開桌")
        .setDescription("建立新牌桌並自動開執行緒")
        .addIntegerOption((opt) =>
          opt
            .setName("max_players")
            .setDescription("最多玩家人數")
            .setRequired(true)
            .setMinValue(getCfg().minPlayers ?? 2)
            .setMaxValue(getCfg().maxPlayers ?? 8)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("blind")
            .setDescription("大盲注金額（小盲為一半）")
            .setRequired(true)
            .setMinValue(getCfg().minBlind ?? 10)
        )
    )
    .toJSON(),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      const sub = interaction.options.getSubcommand();
      if (sub !== "開桌") {
        return interaction.editReply("未知子指令。");
      }
      const maxPlayers = interaction.options.getInteger("max_players");
      const blind = interaction.options.getInteger("blind");

      const result = await createTable(client, interaction, { maxPlayers, blind });
      if (result.error) return interaction.editReply(result.error);

      const buyIn = result.doc.buyIn.toLocaleString();
      const cfg = getCfg();
      const ttlMin = Math.round((cfg.gameTtlSeconds || 900) / 60);
      return interaction.editReply(
        `🃏 **${interaction.member?.displayName || interaction.user.username}** 開了一桌德州撲克 → ${result.thread}\n` +
          `進桌費 **${buyIn}** credits ・ 大盲 **${blind}** ・ 上限 **${maxPlayers}** 人 ・ 倒數 **${ttlMin}** 分鐘\n` +
          `其他人到 ${result.thread} 點「🪑 加入」入座，開桌者按「🃏 開始」開局！`
      );
    } catch (err) {
      console.log(`[ERROR] /賭場 多人德州 開桌:\n${err}\n${err.stack}`.red);
      await interaction
        .editReply("🔧 開桌失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
