require("colors");
const { MessageFlags } = require("discord.js");

const { coinSystem } = require("../../config");
const { ctxOf, renderTab, payload } = require("../../features/bank/bankHandlers");
const { submitModal, toInt } = require("../../features/bank/bankModals");
const pendingTransferService = require("../../features/economy/pendingTransferService");
const { buildOfferContainer } = require("../../features/economy/pendingTransferView");
const { fmt } = require("../../features/bank/bankView");
const { deferUpdateSafe } = require("../../utils/safeAck");

function transferNote(res) {
  switch (res.reason) {
    case "tenure_sender":
      return "⚠️ " + (res.message || "你尚未符合轉帳資格");
    case "no_member":
      return "⚠️ 找不到該成員，可能已退出伺服器";
    case "bot":
      return "⚠️ 不能轉給 bot";
    case "self":
      return "⚠️ 不能轉給自己";
    case "range":
      return `⚠️ 單筆需在 ${fmt(res.min)}~${fmt(res.max)} 之間（你輸入 ${fmt(res.amount)}）`;
    case "balance":
      return `⚠️ 餘額不足：需 ${fmt(res.need)}（含手續費 ${fmt(res.fee)}），有 ${fmt(res.balance)}`;
    case "count":
      return `⚠️ 今日轉帳次數已用完（${res.countToday}/${res.dailyCount}），提升信用分可增加次數`;
    case "cap":
      return `⚠️ 今日轉帳額度已達上限（已轉 ${fmt(res.usedToday)}/${fmt(res.dailyCap)}）`;
    case "tenure_recipient":
      return `⚠️ 對方入伺服器未滿 ${res.minDays} 天，無法收款（防洗幣）`;
    case "too_many_pending":
      return `⚠️ 待收轉帳太多（上限 ${res.max} 筆），等對方收下 / 拒收或取消後再送`;
    default:
      return "🔧 轉帳失敗，請稍後再試";
  }
}

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

    // 轉帳：收款人 id 編在 key（xfer_<targetId>）
    if (key.startsWith("xfer_")) {
      const targetId = key.slice("xfer_".length);
      const amount = toInt(interaction.fields.getTextInputValue("amount"));
      const note = interaction.fields.getTextInputValue("note");
      if (!(amount >= 1)) {
        return interaction.editReply(payload(await renderTab(client, ctx, "overview", "⚠️ 請輸入有效金額")));
      }
      const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
      const res = await pendingTransferService.createCoinOffer(client, {
        senderMember: interaction.member,
        targetMember,
        amount,
        note,
      });
      if (!res.ok) {
        return interaction.editReply(payload(await renderTab(client, ctx, "overview", transferNote(res))));
      }

      // 先扣款託管成功 → 到頻道發一則「待收轉帳」訊息（收款人可收下 / 拒收）。
      const { offer, held } = res;
      let posted = null;
      try {
        posted = await interaction.channel?.send({
          components: [buildOfferContainer(offer)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [offer.recipient_id] },
        });
      } catch (_) {
        posted = null;
      }
      if (!posted) {
        // 發訊息失敗（頻道權限等）→ 取消並退回，避免款項卡在託管。
        await pendingTransferService.cancelOffer(client, { offerId: offer.offer_id }).catch(() => {});
        return interaction.editReply(
          payload(await renderTab(client, ctx, "overview", "🔧 無法在此頻道送出待收轉帳，款項已退回，請改用 /轉帳。"))
        );
      }
      await pendingTransferService.setOfferMessage(client, offer.offer_id, posted.channelId, posted.id);

      const note2 = offer.note ? `，備註：${offer.note}` : "";
      return interaction.editReply(
        payload(
          await renderTab(
            client,
            ctx,
            "overview",
            `📮 已送出待收轉帳給 <@${offer.recipient_id}> **${fmt(held.amount)}**（含手續費 ${fmt(held.fee)}，已預扣，餘額 ${fmt(held.senderAfter)}）${note2}。對方 24 小時內未收下會自動退回；被拒收 / 逾時都不計入當日額度。`
          )
        )
      );
    }

    const result = await submitModal(client, ctx, key, interaction);
    // 需要二次確認的動作（提前解約）直接回傳現成 Container。
    if (result.container) return interaction.editReply(payload(result.container));
    const container = await renderTab(client, ctx, result.tab || "overview", result.note);
    return interaction.editReply(payload(container));
  } catch (error) {
    console.log(`[ERROR] handleBankModal:\n${error}\n${error.stack}`.red);
    await interaction.editReply({ content: "🔧 操作失敗，請稍後再試。" }).catch(() => {});
  }
};
