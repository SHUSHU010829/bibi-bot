require("colors");
const { MessageFlags } = require("discord.js");
const {
  BUTTON_PREFIX,
  queryHistory,
  buildContainer,
  parsePagerCustomId,
} = require("../../features/economy/coinHistory");

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const cid = interaction.customId;
  if (!cid?.startsWith(`${BUTTON_PREFIX}_`)) return;
  if (cid.startsWith(`${BUTTON_PREFIX}_noop_`)) return;

  const parsed = parsePagerCustomId(cid);
  if (!parsed) return;

  if (interaction.user.id !== parsed.ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的金流紀錄！請自己呼叫 `/我的金流紀錄`。",
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (err?.code === 10062) return;
    throw err;
  }

  try {
    if (!client.coinTransactionsCollection) {
      return interaction.editReply({ content: "🔧 金幣系統尚未啟動。" });
    }

    const result = await queryHistory(client, {
      userId: parsed.ownerId,
      guildId: interaction.guildId,
      direction: parsed.direction,
      category: parsed.category,
      period: parsed.period,
      page: parsed.page,
    });

    const displayName =
      interaction.member?.displayName || interaction.user.username;

    const container = buildContainer({
      result,
      filters: {
        period: parsed.period,
        direction: parsed.direction,
        category: parsed.category,
      },
      displayName,
      ownerId: parsed.ownerId,
    });

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] handleCoinHistoryButton:\n${error}\n${error.stack}`.red);
    await interaction
      .editReply({ content: "❌ 翻頁失敗，請重新呼叫 `/我的金流紀錄`。" })
      .catch(() => {});
  }
};
