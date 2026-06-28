require("colors");
const { MessageFlags } = require("discord.js");
const sellCmd = require("../../commands/mining/sell");
const { deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const cid = interaction.customId || "";

  try {
    if (cid.startsWith(sellCmd.SELL_CANCEL_PREFIX)) {
      const ownerId = cid.slice(sellCmd.SELL_CANCEL_PREFIX.length);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: "🚫 這不是你的賣出確認。", flags: MessageFlags.Ephemeral });
      }
      return interaction.update({ components: [], content: "已取消這次賣出。" }).catch(() => {});
    }

    if (cid.startsWith(sellCmd.SELL_CONFIRM_PREFIX)) {
      const rest = cid.slice(sellCmd.SELL_CONFIRM_PREFIX.length);
      const parts = rest.split("_");
      if (parts.length < 4) return;

      const [ownerId, itemType, qtyToken, ...keyParts] = parts;
      const itemKey = keyParts.join("_");
      const qtyArg = qtyToken === "all" ? null : Number(qtyToken);

      if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: "🚫 這不是你的賣出確認。", flags: MessageFlags.Ephemeral });
      }
      if (qtyToken !== "all" && (!Number.isFinite(qtyArg) || qtyArg <= 0)) return;

      if (!(await deferUpdateSafe(interaction))) return;
      return await sellCmd.executeSell(client, interaction, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        itemType,
        itemKey,
        qtyArg,
      });
    }
  } catch (err) {
    console.log(`[ERROR] handleSellConfirmButton:\n${err}\n${err.stack}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: "🔧 賣出處理失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "🔧 賣出處理失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral });
      }
    } catch (_) { /* noop */ }
  }
};
