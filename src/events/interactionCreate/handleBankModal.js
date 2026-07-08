require("colors");
const { MessageFlags } = require("discord.js");

const { coinSystem } = require("../../config");
const { ctxOf, renderTab, payload } = require("../../features/bank/bankHandlers");
const { submitModal } = require("../../features/bank/bankModals");
const { deferUpdateSafe } = require("../../utils/safeAck");

// /銀行 Modal 送出：解析輸入 → 呼叫對應動作 → 原地更新 Hub 訊息。
module.exports = async (client, interaction) => {
  if (!interaction.isModalSubmit?.()) return;
  const cid = interaction.customId;
  if (!cid?.startsWith("bankmodal_")) return;

  const rest = cid.slice("bankmodal_".length);
  const idx = rest.indexOf("_");
  if (idx < 0) return;
  const ownerId = rest.slice(0, idx);
  const key = rest.slice(idx + 1);

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的銀行操作！",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferUpdateSafe(interaction))) return;

  try {
    if (!coinSystem?.enabled) return interaction.editReply({ content: "🔧 金幣系統尚未啟動。" });
    const ctx = ctxOf(interaction);
    const { tab, note } = await submitModal(client, ctx, key, interaction);
    const container = await renderTab(client, ctx, tab || "overview", note);
    return interaction.editReply(payload(container));
  } catch (error) {
    console.log(`[ERROR] handleBankModal:\n${error}\n${error.stack}`.red);
    await interaction.editReply({ content: "🔧 操作失敗，請稍後再試。" }).catch(() => {});
  }
};
