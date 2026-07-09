require("colors");
const { MessageFlags } = require("discord.js");

const { coinSystem, bank } = require("../../config");
const goldService = require("../../features/bank/goldService");
const loanService = require("../../features/bank/loanService");
const depositService = require("../../features/bank/depositService");
const { ctxOf, renderTab, payload } = require("../../features/bank/bankHandlers");
const { buildModal, buildTransferModal } = require("../../features/bank/bankModals");
const { fmt } = require("../../features/bank/bankView");
const { deferUpdateSafe } = require("../../utils/safeAck");

// /銀行 Hub 的下拉導覽、使用者選擇與快捷按鈕：全部原地更新同一則 ephemeral 訊息。
module.exports = async (client, interaction) => {
  const isButton = interaction.isButton?.();
  const isSelect = interaction.isStringSelectMenu?.();
  const isUserSelect = interaction.isUserSelectMenu?.();
  if (!isButton && !isSelect && !isUserSelect) return;
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

  // 開啟 Modal 的回應：showModal 必須是第一個回應，不能先 deferUpdate。
  if (isButton && action.startsWith("open_")) {
    const modal = buildModal(ownerId, action.slice(5));
    if (!modal) return;
    return interaction.showModal(modal).catch((e) => {
      console.log(`[ERROR] handleBankButton showModal: ${e.message}`.red);
    });
  }
  // 選定收款人 → 跳出轉帳金額 Modal
  if (isUserSelect && action === "xferuser") {
    const targetId = interaction.values?.[0];
    if (!targetId) return;
    return interaction.showModal(buildTransferModal(ownerId, targetId)).catch((e) => {
      console.log(`[ERROR] handleBankButton transfer modal: ${e.message}`.red);
    });
  }

  if (!(await deferUpdateSafe(interaction))) return;
  const ctx = ctxOf(interaction);
  const uLabel = bank?.gold?.unitLabel || "克";

  const show = (tab, note) => renderTab(client, ctx, tab, note).then((c) => interaction.editReply(payload(c)));

  try {
    if (!coinSystem?.enabled) return show("overview", "🔧 金幣系統尚未啟動");

    // 下拉導覽
    if (isSelect && action === "nav") {
      const tab = interaction.values?.[0] || "overview";
      return show(tab);
    }

    // 開啟轉帳頁（選收款人）
    if (action === "xferstart") return show("transfer");

    // 定存分頁
    if (action.startsWith("deppage_")) {
      ctx.page = parseInt(action.slice("deppage_".length), 10) || 0;
      return show("deposit");
    }

    // 賣出全部黃金
    if (action === "goldsellall") {
      const holding = await goldService.getHolding(client, ctx.userId, ctx.guildId);
      if (holding <= 0) return show("gold", "⚠️ 金庫沒有黃金可賣");
      const res = await goldService.sell(client, { ...ctx, units: holding });
      if (!res.ok) return show("gold", "🔧 賣出失敗，請稍後再試");
      return show("gold", `✅ 已賣出全部 **${fmt(res.units)}** ${uLabel}（+${fmt(res.gain)} 幣）`);
    }

    // 一鍵還清貸款
    if (action.startsWith("loanrepay_")) {
      const loanId = action.slice("loanrepay_".length);
      const res = await loanService.repay(client, { ...ctx, loanId });
      if (!res.ok) {
        if (res.reason === "notfound") return show("loan", "⚠️ 這筆貸款已不存在或已還清");
        if (res.reason === "wallet")
          return show("loan", `⚠️ 餘額不足！還清需要 **${fmt(res.outstanding)}**，錢包只有 ${fmt(res.wallet)}（可用 /銀行 貸款 還款 部分還款）`);
        return show("loan", "🔧 還款失敗，請稍後再試");
      }
      return show("loan", res.cleared ? `✅ 貸款 \`${loanId}\` 已全部還清！📈` : `✅ 已還款 **${fmt(res.pay)}**，尚欠 **${fmt(res.remaining)}**`);
    }

    // 領回到期定存
    if (action.startsWith("depclaim_")) {
      const depositId = action.slice("depclaim_".length);
      const res = await depositService.claim(client, { ...ctx, depositId });
      if (!res.ok) return show("deposit", "⚠️ 此存單無法領回（可能已領過）");
      return show("deposit", `✅ 已領回 \`${depositId}\`：**${fmt(res.payout)}**（本金 ${fmt(res.principal)}＋息 ${fmt(res.interest)}）`);
    }

    // 領回到期黃金定存
    if (action.startsWith("goldclaim_")) {
      const depositId = action.slice("goldclaim_".length);
      const res = await goldService.claimTerm(client, { ...ctx, depositId });
      if (!res.ok) {
        if (res.reason === "loan_frozen")
          return show("gold", `🔒 有逾期貸款未清（待還 ${fmt(res.block.outstanding)}），領回暫停。請先到貸款頁還款`);
        return show("gold", "⚠️ 此黃金存單無法領回（可能已領過）");
      }
      return show("gold", `✅ 黃金定存到期領回 **${fmt(res.payoutUnits)}** ${uLabel}`);
    }
  } catch (error) {
    console.log(`[ERROR] handleBankButton:\n${error}\n${error.stack}`.red);
    await interaction.editReply({ content: "🔧 操作失敗，請稍後再試。" }).catch(() => {});
  }
};
