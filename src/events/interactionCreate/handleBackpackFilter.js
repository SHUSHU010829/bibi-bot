// 背包分類篩選 handler。
// 玩家在 /背包 選單選擇分類後，以 ephemeral update 重新渲染對應區塊。
// customId 格式：backpack_cat_<userId>（StringSelectMenu）

require("colors");
const { MessageFlags } = require("discord.js");
const { buildBackpackView, BACKPACK_CATEGORIES } = require("../../features/shop/backpackView");

const PREFIX = "backpack_cat_";

module.exports = async (client, interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  const { customId } = interaction;
  if (!customId.startsWith(PREFIX)) return;

  const ownerId = customId.slice(PREFIX.length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的背包！",
      flags: MessageFlags.Ephemeral,
    });
  }

  const category = interaction.values?.[0] || "all";
  const validValues = BACKPACK_CATEGORIES.map((c) => c.value);
  if (!validValues.includes(category)) return;

  await interaction.deferUpdate();

  try {
    const view = await buildBackpackView(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
      category,
    });

    await interaction.editReply(view);
  } catch (err) {
    console.log(`[ERROR] backpack_cat handler:\n${err}`.red);
    await interaction.followUp({
      content: "🔧 切換分類失敗，請稍後再試。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
};
