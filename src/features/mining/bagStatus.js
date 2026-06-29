// 釣魚 / 收成等結果訊息用的「背包快滿 / 超量」提示行（單行 -# 小字）。
// 與挖礦的 backpackSpaceLine 同概念，抽成共用模組給魚袋 / 菜籃共用。
//
// 強制與否由 config 的 bagLimitEnforceAt（ISO 時間字串）決定：
//   未到期（寬限期）：超量只提醒、不擋下動作，並顯示倒數到期日。
//   已到期：超量會在 service 端擋下，這裡只提醒清空間。
//   bagLimitEnforceAt 為空 → 永遠寬限（不強制）。

// 解析 bagLimitEnforceAt → epoch ms（無效 / 空值回 null）
function enforceTs(enforceAt) {
  if (!enforceAt) return null;
  const t = typeof enforceAt === "number" ? enforceAt : Date.parse(enforceAt);
  return Number.isFinite(t) ? t : null;
}

// 現在是否已進入強制限制階段
function isBagLimitEnforced(enforceAt) {
  const t = enforceTs(enforceAt);
  return t != null && Date.now() >= t;
}

// 回傳空字串＝還很空、不需要提示。
function bagStatusLine({ label, used, cap, enforceAt, sellHint = "用 `/賣出` 換金幣" }) {
  if (typeof cap !== "number" || cap <= 0 || typeof used !== "number") return "";
  const t = enforceTs(enforceAt);
  const enforced = t != null && Date.now() >= t;
  const free = cap - used;
  if (used >= cap) {
    if (enforced) return `-# 🔴 ${label}已滿（${used}/${cap}）！${sellHint}`;
    const deadline = t ? `（寬限期到 <t:${Math.floor(t / 1000)}:D>）` : "";
    return `-# 🔴 ${label}已超過上限（${used}/${cap}）！寬限期間照常進行${deadline}，但${sellHint}；到期後超出將擋下`;
  }
  if (free <= 5) {
    return `-# 🟡 ${label}快滿了（剩 ${free} 格・${used}/${cap}），${sellHint}`;
  }
  return "";
}

module.exports = { bagStatusLine, isBagLimitEnforced };
