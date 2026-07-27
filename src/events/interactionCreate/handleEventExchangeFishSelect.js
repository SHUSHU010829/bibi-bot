require("colors");
const { MessageFlags } = require("discord.js");
const eventExchangeService = require("../../features/event/eventExchangeService");
const {
  buildExchangeView,
  parseFishSelectId,
} = require("../../features/event/eventExchangeView");

// /兌換所 面板上的「依魚種篩選」下拉選單處理器。
// customId = evtxfish_<ownerId>（見 features/event/eventExchangeView.js）。
module.exports = async (client, interaction) => {
  if (!interaction.isStringSelectMenu?.()) return;
  const parsed = parseFishSelectId(interaction.customId || "");
  if (!parsed) return;

  if (interaction.user.id !== parsed.ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的兌換所面板！請自己用 `/兌換所` 開啟。",
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const selectedFish = interaction.values?.[0] || "all";
    const { active, items } = await eventExchangeService.listExchanges(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    const view = buildExchangeView({
      ownerId: interaction.user.id,
      active,
      items,
      selectedFish,
    });
    await interaction.update(view);
  } catch (error) {
    console.log(`[ERROR] 兌換所魚種篩選:\n${error}\n${error.stack}`.red);
    return interaction
      .reply({ content: "🔧 切換失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
};
