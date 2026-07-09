require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem } = require("../../config");
const { ctxOf, renderTab, payload } = require("../../features/bank/bankHandlers");

// 指令只負責「開頁」；買/賣/存/借等動作全部在頁面上用按鈕 + Modal 完成（見 bankModals / handleBankButton / handleBankModal）。
const SUB_TO_TAB = {
  總覽: "overview",
  信用: "credit",
  定存: "deposit",
  黃金: "gold",
  貸款: "loan",
};

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("銀行")
    .setDescription("逼逼銀行：信用分、定存、黃金存摺、貸款一站搞定 🏦")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("總覽").setDescription("錢包、信用分、定存、黃金、貸款一次看"))
    .addSubcommand((s) => s.setName("信用").setDescription("信用評等與各項銀行權益"))
    .addSubcommand((s) => s.setName("定存").setDescription("定期存款（開戶 / 提款 / 領回）"))
    .addSubcommand((s) => s.setName("黃金").setDescription("黃金存摺（買進 / 賣出 / 精煉 / 定存）"))
    .addSubcommand((s) => s.setName("貸款").setDescription("貸款（借款 / 還款）"))
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) return interaction.editReply("🔧 金幣系統尚未啟動！");
      if (!client.userCoinsCollection) return interaction.editReply("🔧 銀行系統尚未啟動，請聯絡舒舒！");

      const ctx = ctxOf(interaction);
      const tab = SUB_TO_TAB[interaction.options.getSubcommand()] || "overview";
      const container = await renderTab(client, ctx, tab);
      return interaction.editReply(payload(container));
    } catch (error) {
      console.log(`[ERROR] /銀行:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 銀行指令執行失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
