// 背包品項太多時的「選擇要賣出的…」下拉選單 → 開啟輸入數量彈窗（同 sellm_open_ 按鈕）。
// customId 格式：sellm_pick_<ownerId>_<itemType>，選項 value 為 itemKey。

require("colors");
const { MessageFlags } = require("discord.js");
const sellCmd = require("../../commands/mining/sell");
const { SELL_PICK_PREFIX } = require("../../features/shop/sellableItems");

module.exports = async (client, interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  const cid = interaction.customId || "";
  if (!cid.startsWith(SELL_PICK_PREFIX)) return;

  const [ownerId, itemType] = cid.slice(SELL_PICK_PREFIX.length).split("_");
  const itemKey = interaction.values?.[0];
  if (!ownerId || !itemType || !itemKey) return;

  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "🚫 這不是你的背包。", flags: MessageFlags.Ephemeral });
  }

  try {
    await sellCmd.openSellQtyModal(client, interaction, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      itemType,
      itemKey,
    });
  } catch (err) {
    console.log(`[ERROR] handleSellPickSelect:\n${err}\n${err.stack}`.red);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: "🔧 開啟賣出視窗失敗，請稍後再試。",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
};
