// 贊助限定卡面（donor）的自訂卡號共用邏輯：權限判定、驗證、寫入。
// 供 /卡號 指令與背包彈窗共用，確保規則一致。

const { donation } = require("../../config");

const MAX_LEN = 20;
const VALID_RE = /^[A-Za-z0-9]{1,20}$/;
const DONOR_THEME_ITEM_ID = donation?.themes?.donor || "theme_donor";

// 背包按鈕 / 彈窗 customId（集中於此，避免多檔各寫一份而漂移）
const CARDNO_OPEN_ID = "shop_cardno_open";
const CARDNO_MODAL_ID = "shop_cardno_modal";

// 每 4 字一組以空白分隔（與卡面顯示一致）。
function groupBy4(s) {
  return String(s).match(/.{1,4}/g).join(" ");
}

// 是否擁有贊助限定卡面（永久 perk）。
async function ownsDonorCard(client, userId, guildId) {
  if (!client.userInventoryCollection) return false;
  const item = await client.userInventoryCollection
    .findOne({
      userId,
      guildId,
      type: "wallet_theme",
      itemId: DONOR_THEME_ITEM_ID,
    })
    .catch(() => null);
  return !!item;
}

// 驗證並正規化（不寫 DB）。回傳 { ok:true, value } 或 { ok:false, reason }。
function normalize(raw) {
  const s = String(raw || "").trim();
  if (!VALID_RE.test(s)) {
    return {
      ok: false,
      reason:
        s.length > MAX_LEN
          ? `最多 ${MAX_LEN} 字（目前 ${s.length} 字）`
          : "只能使用英文（A–Z）與數字（0–9），不能有空白或符號",
    };
  }
  return { ok: true, value: s.toUpperCase() };
}

// 設定（含權限判定 + 驗證 + 寫入）。raw 為空字串/空白 → 清除。
// 回傳：{ ok:true, value } / { ok:true, cleared:true } / { ok:false, error }。
// error === "locked" 代表非贊助者。
async function setCustomCardNumber(client, { userId, guildId, raw }) {
  if (!client.userLevelsCollection) {
    return { ok: false, error: "系統尚未就緒，請稍後再試" };
  }
  if (!(await ownsDonorCard(client, userId, guildId))) {
    return { ok: false, error: "locked" };
  }

  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    await client.userLevelsCollection.updateOne(
      { userId, guildId },
      { $set: { customCardNumber: null, updatedAt: new Date() } },
      { upsert: true }
    );
    return { ok: true, cleared: true };
  }

  const norm = normalize(trimmed);
  if (!norm.ok) return { ok: false, error: norm.reason };

  await client.userLevelsCollection.updateOne(
    { userId, guildId },
    { $set: { customCardNumber: norm.value, updatedAt: new Date() } },
    { upsert: true }
  );
  return { ok: true, value: norm.value };
}

module.exports = {
  MAX_LEN,
  DONOR_THEME_ITEM_ID,
  CARDNO_OPEN_ID,
  CARDNO_MODAL_ID,
  groupBy4,
  ownsDonorCard,
  normalize,
  setCustomCardNumber,
};
