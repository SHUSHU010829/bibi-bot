require("colors");
const { MessageFlags } = require("discord.js");

const {
  HALL_BUTTON_ID,
  buildHallContainer,
} = require("../../features/stock/stockKingView");
const { deferReplySafe } = require("../../utils/safeAck");

// 公開訊息（週冠公告 / 排行榜）上的名人堂按鈕，任何人都能按，結果只回給自己。
module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  if (interaction.customId !== HALL_BUTTON_ID) return;

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  try {
    if (!client.stockKingHistoryCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }
    const container = await buildHallContainer(client, {
      guildId: interaction.guildId,
      viewerId: interaction.user.id,
    });
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.log(`[STOCK] 名人堂按鈕失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 查詢失敗,請稍後再試。").catch(() => {});
  }
};
