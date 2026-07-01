require("colors");
const { MessageFlags } = require("discord.js");
const sellCmd = require("../../commands/mining/sell");
const { SELL_MODAL_QTY_PREFIX, parseSellTarget } = require("../../features/shop/sellableItems");

module.exports = async (client, interaction) => {
  if (!interaction.isModalSubmit()) return;
  const cid = interaction.customId || "";
  if (!cid.startsWith(SELL_MODAL_QTY_PREFIX)) return;

  try {
    const target = parseSellTarget(cid.slice(SELL_MODAL_QTY_PREFIX.length));
    if (!target) return;
    if (interaction.user.id !== target.ownerId) {
      return interaction.reply({ content: "🚫 這不是你的背包。", flags: MessageFlags.Ephemeral });
    }
    return await sellCmd.handleSellModalSubmit(client, interaction, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      itemType: target.itemType,
      itemKey: target.itemKey,
    });
  } catch (err) {
    console.log(`[ERROR] handleSellModalSubmit:\n${err}\n${err.stack}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: "🔧 賣出處理失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "🔧 賣出處理失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral });
      }
    } catch (_) { /* noop */ }
  }
};
