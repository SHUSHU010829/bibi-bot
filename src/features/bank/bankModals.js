require("colors");
const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

const { bank, coinSystem } = require("../../config");
const goldService = require("./goldService");
const loanService = require("./loanService");
const depositService = require("./depositService");
const { fmt, earlyWithdrawConfirm } = require("./bankView");

const U = () => bank?.gold?.unitLabel || "克";

function toInt(v) {
  const n = parseInt(String(v ?? "").replace(/[, ]/g, ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

// 金庫容量不足（UX #2）：寫清楚上限、已佔用（含定存鎖倉）、還剩多少，以及怎麼擴充。
function capacityNote(vault) {
  const lock = vault.locked > 0 ? `（含定存鎖倉 ${fmt(vault.locked)}）` : "";
  return {
    tab: "gold",
    note:
      `⚠️ **金庫放不下了**：容量 **${fmt(vault.capacity)}** ${U()}，已存 **${fmt(vault.used)}** ${U()}${lock}，只剩 **${fmt(vault.free)}** ${U()} 可放\n` +
      `-# 提升信用評等可擴充金庫；金庫外的財富只能留在錢包，每週照課財富稅`,
  };
}

// 賣出損益文字（像股市）：本次相對平均成本賺 / 賠多少。
function pnlText(pnl) {
  if (typeof pnl !== "number") return "損益 —";
  if (pnl > 0) return `賺 📈 **+${fmt(pnl)}** 幣`;
  if (pnl < 0) return `賠 📉 **−${fmt(Math.abs(pnl))}** 幣`;
  return "損益 ➖ 打平";
}

// action → { title, tab, fields:[{id,label,placeholder,required}], submit(client,ctx,values)->{tab,note} }
const ACTIONS = {
  goldbuy: {
    title: "買進純金",
    tab: "gold",
    fields: [{ id: "units", label: `買進克數`, placeholder: "例如 10" }],
    submit: async (client, ctx, v) => {
      const units = toInt(v.units);
      if (!(units >= 1)) return { tab: "gold", note: "⚠️ 請輸入有效克數" };
      const res = await goldService.buy(client, { ...ctx, units });
      if (!res.ok) {
        if (res.reason === "range") return { tab: "gold", note: `⚠️ 需在 ${fmt(res.min)}~${fmt(res.max)} ${U()} 之間` };
        if (res.reason === "balance") return { tab: "gold", note: `⚠️ 餘額不足，買 ${fmt(units)} ${U()} 需 ${fmt(res.cost)}（有 ${fmt(res.balance)}）` };
        if (res.reason === "capacity") return capacityNote(res.vault);
        return { tab: "gold", note: "🔧 買進失敗，請稍後再試" };
      }
      return { tab: "gold", note: `✅ 買進 **${fmt(res.units)}** ${U()}（共 ${fmt(res.cost)} 幣），平均成本 ${fmt(res.avgCost)} 幣/${U()}，金庫 ${fmt(res.holding)}／${fmt(res.capacity)} ${U()}` };
    },
  },
  goldsell: {
    title: "賣出純金",
    tab: "gold",
    fields: [{ id: "units", label: "賣出克數", placeholder: "例如 10" }],
    submit: async (client, ctx, v) => {
      const units = toInt(v.units);
      if (!(units >= 1)) return { tab: "gold", note: "⚠️ 請輸入有效克數" };
      const res = await goldService.sell(client, { ...ctx, units });
      if (!res.ok) {
        if (res.reason === "holding") return { tab: "gold", note: `⚠️ 金庫只有 ${fmt(res.holding)} ${U()}` };
        return { tab: "gold", note: "🔧 賣出失敗，請稍後再試" };
      }
      return { tab: "gold", note: `✅ 賣出 **${fmt(res.units)}** ${U()}（+${fmt(res.gain)} 幣），${pnlText(res.pnl)}，金庫剩 ${fmt(res.holding)} ${U()}` };
    },
  },
  goldrefine: {
    title: "精煉純金",
    tab: "gold",
    fields: [{ id: "units", label: "精煉出的純金克數", placeholder: "例如 5" }],
    submit: async (client, ctx, v) => {
      const units = toInt(v.units);
      if (!(units >= 1)) return { tab: "gold", note: "⚠️ 請輸入有效克數" };
      const res = await goldService.refine(client, { ...ctx, units });
      if (!res.ok) {
        if (res.reason === "ore") return { tab: "gold", note: `⚠️ 黃金礦不足：需 ${fmt(res.needOre)}，有 ${fmt(res.haveOre)}（去 /挖礦 挖黃金）` };
        if (res.reason === "coal") return { tab: "gold", note: `⚠️ 煤炭不足：需 ${fmt(res.needCoal)}，有 ${fmt(res.haveCoal)}（去 /挖礦 挖煤炭）` };
        if (res.reason === "max") return { tab: "gold", note: `⚠️ 單次最多精煉 ${fmt(res.maxBatch)} ${U()}` };
        if (res.reason === "capacity") return capacityNote(res.vault);
        return { tab: "gold", note: "🔧 精煉失敗，請稍後再試" };
      }
      const coal = res.needCoal > 0 ? `＋${fmt(res.needCoal)} 煤炭` : "";
      return { tab: "gold", note: `✅ 精煉 ${fmt(res.needOre)} 黃金礦${coal} → +**${fmt(res.units)}** ${U()}，金庫 ${fmt(res.holding)}／${fmt(res.capacity)} ${U()}` };
    },
  },
  goldterm: {
    title: "黃金定存",
    tab: "gold",
    fields: [
      { id: "units", label: "鎖倉克數", placeholder: "例如 20" },
      { id: "days", label: `天數（${(bank?.gold?.term?.terms || []).map((t) => `${t.days}天+${(t.rate * 100).toFixed(0)}%`).join(" ") || "7"}）`, placeholder: "7" },
    ],
    submit: async (client, ctx, v) => {
      const units = toInt(v.units);
      const days = toInt(v.days);
      if (!(units >= 1)) return { tab: "gold", note: "⚠️ 請輸入有效克數" };
      if (!goldService.findTerm(days)) {
        const valid = (bank?.gold?.term?.terms || []).map((t) => t.days).join("／");
        return { tab: "gold", note: `⚠️ 天數請填：${valid}` };
      }
      const res = await goldService.openTerm(client, { ...ctx, units, days });
      if (!res.ok) {
        if (res.reason === "min") return { tab: "gold", note: `⚠️ 最少 ${fmt(res.minUnits)} ${U()}` };
        if (res.reason === "slots") return { tab: "gold", note: `⚠️ 黃金定存已滿（最多 ${res.maxActive} 筆）` };
        if (res.reason === "holding") return { tab: "gold", note: `⚠️ 金庫只有 ${fmt(res.holding)} ${U()}` };
        return { tab: "gold", note: "🔧 黃金定存失敗，請稍後再試" };
      }
      const u = Math.floor(new Date(res.maturesAt).getTime() / 1000);
      return { tab: "gold", note: `✅ 黃金定存 \`${res.depositId}\`：${fmt(res.units)}${U()}・${res.days} 天・到期 **${fmt(res.units + res.interestUnits)}**${U()}（<t:${u}:R>）` };
    },
  },
  depopen: {
    title: "開立定期存款",
    tab: "deposit",
    fields: [
      { id: "amount", label: "存款金額", placeholder: "例如 10000" },
      { id: "days", label: `天數（${(coinSystem?.deposit?.terms || []).map((t) => `${t.days}天+${(t.rate * 100).toFixed(0)}%`).join(" ") || "7"}）`, placeholder: "30" },
    ],
    submit: async (client, ctx, v) => {
      const amount = toInt(v.amount);
      const days = toInt(v.days);
      if (!(amount >= 1)) return { tab: "deposit", note: "⚠️ 請輸入有效金額" };
      if (depositService.termRate(days) == null) {
        const valid = (depositService.cfg().terms || []).map((t) => t.days).join("／");
        return { tab: "deposit", note: `⚠️ 天數請填：${valid}` };
      }
      const res = await depositService.open(client, { ...ctx, amount, days });
      if (!res.ok) {
        if (res.reason === "range") return { tab: "deposit", note: `⚠️ 單筆需在 ${fmt(res.min)}~${fmt(res.max)} 之間` };
        if (res.reason === "slots") return { tab: "deposit", note: `⚠️ 定存已達上限（最多 ${res.maxActive} 筆）` };
        if (res.reason === "balance") return { tab: "deposit", note: `⚠️ 錢包只有 ${fmt(res.balance)}` };
        return { tab: "deposit", note: "🔧 開戶失敗，請稍後再試" };
      }
      const u = Math.floor(new Date(res.maturesAt).getTime() / 1000);
      return { tab: "deposit", note: `✅ 定存 \`${res.depositId}\`：本金 ${fmt(res.amount)}・${res.days} 天・到期 **${fmt(res.amount + res.interest)}**（<t:${u}:R>）` };
    },
  },
  depclaimid: {
    title: "領回 / 提早解約定存",
    tab: "deposit",
    fields: [{ id: "depositId", label: "存單 ID（未到期會扣違約金）", placeholder: "dep_xxxxxxxx" }],
    submit: async (client, ctx, v) => {
      const depositId = String(v.depositId || "").trim();
      const pre = await depositService.previewClaim(client, { ...ctx, depositId });
      if (!pre.ok) {
        if (pre.reason === "notfound") return { tab: "deposit", note: "⚠️ 找不到此存單" };
        if (pre.reason === "claimed") return { tab: "deposit", note: "⚠️ 此存單已領過" };
        return { tab: "deposit", note: "🔧 領回失敗，請稍後再試" };
      }
      // 未到期＝提前解約，會扣違約金＋信用分 → 先跳確認，不直接執行。
      if (!pre.matured) {
        return { container: earlyWithdrawConfirm({ ownerId: ctx.userId, ...pre }) };
      }
      const res = await depositService.claim(client, { ...ctx, depositId });
      if (!res.ok) {
        if (res.reason === "notfound") return { tab: "deposit", note: "⚠️ 找不到此存單" };
        if (res.reason === "claimed") return { tab: "deposit", note: "⚠️ 此存單已領過" };
        return { tab: "deposit", note: "🔧 領回失敗，請稍後再試" };
      }
      return {
        tab: "deposit",
        note: `✅ 已領回 \`${depositId}\`：本金 ${fmt(res.principal)}＋息 ${fmt(res.interest)} = **${fmt(res.payout)}**`,
      };
    },
  },
  loantake: {
    title: "申請貸款",
    tab: "loan",
    fields: [{ id: "amount", label: "借款金額", placeholder: "例如 50000" }],
    submit: async (client, ctx, v) => {
      const amount = toInt(v.amount);
      if (!(amount >= 1)) return { tab: "loan", note: "⚠️ 請輸入有效金額" };
      const res = await loanService.take(client, { ...ctx, amount });
      if (!res.ok) {
        if (res.reason === "min") return { tab: "loan", note: `⚠️ 貸款最少 ${fmt(res.minAmount)}` };
        if (res.reason === "tier") return { tab: "loan", note: `🔒 ${res.tier.emoji} ${res.tier.name} 尚無貸款額度，提升信用分後開放` };
        if (res.reason === "cap") return { tab: "loan", note: `⚠️ 超過信用額度 ${fmt(res.loanCap)}（${res.tier.emoji} ${res.tier.name}）` };
        if (res.reason === "default_block") return { tab: "loan", note: "🔴 有違約貸款未清，請先還清" };
        if (res.reason === "active") return { tab: "loan", note: `⚠️ 已有貸款在身（最多 ${res.maxActive} 筆）` };
        return { tab: "loan", note: "🔧 借款失敗，請稍後再試" };
      }
      const u = Math.floor(new Date(res.dueAt).getTime() / 1000);
      return { tab: "loan", note: `✅ 貸款核准 \`${res.loanId}\`：撥款 **${fmt(res.amount)}**，到期需還 **${fmt(res.dueAmount)}**（<t:${u}:R>）` };
    },
  },
  loanrepay: {
    title: "償還貸款",
    tab: "loan",
    fields: [{ id: "amount", label: "償還金額（留空＝全額還清）", required: false, placeholder: "留空全還" }],
    submit: async (client, ctx, v) => {
      const raw = String(v.amount || "").trim();
      const amount = raw ? toInt(v.amount) : undefined;
      if (raw && !(amount >= 1)) return { tab: "loan", note: "⚠️ 請輸入有效金額或留空" };
      const res = await loanService.repay(client, { ...ctx, amount });
      if (!res.ok) {
        if (res.reason === "notfound") return { tab: "loan", note: "📭 沒有需要償還的貸款" };
        if (res.reason === "wallet") return { tab: "loan", note: `⚠️ 餘額不足：需 ${fmt(res.outstanding)}（可部分還），有 ${fmt(res.wallet)}` };
        return { tab: "loan", note: "🔧 還款失敗，請稍後再試" };
      }
      if (!res.cleared) return { tab: "loan", note: `✅ 已還款 **${fmt(res.pay)}**，尚欠 **${fmt(res.remaining)}**` };
      return { tab: "loan", note: res.creditGain > 0
        ? `✅ 貸款 \`${res.loan.loanId}\` 已全部還清，信用分 +${res.creditGain} 📈`
        : `✅ 貸款 \`${res.loan.loanId}\` 已全部還清\n-# 持有未滿 ${loanService.cfg().creditMinHoldDays ?? 0} 天，本次未累積信用分` };
    },
  },
};

function buildModal(userId, key) {
  const def = ACTIONS[key];
  if (!def) return null;
  const modal = new ModalBuilder().setCustomId(`bankmodal_${userId}_${key}`).setTitle(def.title);
  for (const f of def.fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label)
      .setStyle(TextInputStyle.Short)
      .setRequired(f.required !== false);
    if (f.placeholder) input.setPlaceholder(f.placeholder);
    if (f.maxLength) input.setMaxLength(f.maxLength);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

// 轉帳彈窗（收款人已由 UserSelect 選定，id 編進 customId）
function buildTransferModal(userId, targetId) {
  const modal = new ModalBuilder()
    .setCustomId(`bankmodal_${userId}_xfer_${targetId}`)
    .setTitle("轉帳給玩家");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("amount")
        .setLabel("轉帳金額")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("例如 1000"),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("note")
        .setLabel("備註（選填）")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(80),
    ),
  );
  return modal;
}

async function submitModal(client, ctx, key, interaction) {
  const def = ACTIONS[key];
  if (!def) return { tab: "overview", note: "⚠️ 未知的操作" };
  const values = {};
  for (const f of def.fields) {
    values[f.id] = interaction.fields.getTextInputValue(f.id);
  }
  return def.submit(client, ctx, values);
}

module.exports = { ACTIONS, buildModal, buildTransferModal, submitModal, toInt };
