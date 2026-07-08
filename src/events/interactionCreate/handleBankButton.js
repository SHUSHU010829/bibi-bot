require("colors");
const { MessageFlags } = require("discord.js");

const { coinSystem, bank } = require("../../config");
const creditService = require("../../features/bank/creditService");
const goldService = require("../../features/bank/goldService");
const loanService = require("../../features/bank/loanService");
const { creditCard, fmt } = require("../../features/bank/bankView");

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const cid = interaction.customId;
  if (!cid?.startsWith("bank_")) return;

  const rest = cid.slice(5);
  const idx = rest.indexOf("_");
  if (idx < 0) return;
  const ownerId = rest.slice(0, idx);
  const action = rest.slice(idx + 1);

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的銀行帳戶！請自己呼叫 `/銀行`。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const username = interaction.member?.displayName || interaction.user.username;
  const avatarHash = interaction.user.avatar;
  const member = interaction.member;
  const displayName = username;

  try {
    if (!coinSystem?.enabled) {
      return interaction.reply({ content: "🔧 金幣系統尚未啟動。", flags: MessageFlags.Ephemeral });
    }

    if (action === "credit") {
      const limits = await creditService.getLimits(client, userId, guildId, member);
      return interaction.reply({
        components: [creditCard(limits, displayName)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    if (action === "goldsellall") {
      if (!bank?.gold?.enabled) {
        return interaction.reply({ content: "🔧 黃金存摺尚未開放。", flags: MessageFlags.Ephemeral });
      }
      const U = bank.gold.unitLabel || "克";
      const holding = await goldService.getHolding(client, userId, guildId);
      if (holding <= 0) {
        return interaction.reply({ content: `🪙 你的金庫沒有黃金可賣。`, flags: MessageFlags.Ephemeral });
      }
      const res = await goldService.sell(client, { userId, guildId, username, member, avatarHash, units: holding });
      if (!res.ok) {
        return interaction.reply({ content: "🔧 黃金賣出失敗，請稍後再試。", flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content:
          `🪙 已賣出全部 **${fmt(res.units)}** ${U}（單價 ${fmt(res.prices.sell)}／共 +${fmt(res.gain)} 幣）\n` +
          `・錢包餘額：**${fmt(res.balanceAfter)}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action.startsWith("loanrepay_")) {
      if (!bank?.loan?.enabled) {
        return interaction.reply({ content: "🔧 貸款功能尚未開放。", flags: MessageFlags.Ephemeral });
      }
      const loanId = action.slice("loanrepay_".length);
      const res = await loanService.repay(client, { userId, guildId, member, username, avatarHash, loanId });
      if (!res.ok) {
        if (res.reason === "notfound") {
          return interaction.reply({ content: "📭 這筆貸款已不存在或已還清。", flags: MessageFlags.Ephemeral });
        }
        if (res.reason === "wallet") {
          return interaction.reply({
            content: `💰 餘額不足！還清需要 **${fmt(res.outstanding)}**，錢包只有 ${fmt(res.wallet)}。可用 \`/貸款 還款 金額:<數字>\` 部分還款。`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({ content: "🔧 還款失敗，請稍後再試。", flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: res.cleared
          ? `✅ 貸款 \`${loanId}\` 已全部還清！還款 ${fmt(res.pay)}，錢包剩 **${fmt(res.walletAfter)}** 📈`
          : `✅ 已還款 **${fmt(res.pay)}**，尚欠 **${fmt(res.remaining)}**，錢包剩 ${fmt(res.walletAfter)}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.log(`[ERROR] handleBankButton:\n${error}\n${error.stack}`.red);
    await interaction
      .reply({ content: "🔧 操作失敗，請稍後再試。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
};
