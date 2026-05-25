// /樂透資訊 — 查看當期彩池、開獎倒數、票數。

require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { getLotteryConfig, listLotteryTypes } = require("../../features/casino/lottery/numbers");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("樂透資訊")
    .setDescription("查看當期樂透資訊 ℹ️")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.lotteryDrawsCollection) {
        return interaction.editReply("🔧 樂透系統尚未啟動。");
      }

      const lines = [];
      for (const t of listLotteryTypes()) {
        const cfg = getLotteryConfig(t);
        const draw = await client.lotteryDrawsCollection.findOne({
          lotteryType: t,
          status: "open",
        });
        if (!draw) {
          lines.push(`${cfg.emoji} **${cfg.label}**:當期尚未開放`);
          continue;
        }
        const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
        const userTickets = await client.lotteryTicketsCollection.countDocuments({
          drawId: draw.drawId,
          userId: interaction.user.id,
        });
        lines.push(
          `${cfg.emoji} **${cfg.label}** 第 ${draw.drawNumber} 期\n` +
            `彩池:**${draw.pool.toLocaleString()}** credits\n` +
            `總票數:${draw.totalTickets || 0}(你有 ${userTickets} 張)\n` +
            `開獎倒數:<t:${drawAtUnix}:R>`
        );
      }

      await interaction.editReply(lines.join("\n\n"));
    } catch (err) {
      console.log(`[ERROR] /樂透資訊:\n${err}\n${err.stack}`.red);
      await interaction.editReply("🔧 查詢失敗。").catch(() => {});
    }
  },
};
