// 釣魚 / 收成等結果訊息用的「背包快滿 / 超量」提示行（單行 -# 小字）。
// 與挖礦的 backpackSpaceLine 同概念，抽成共用模組給魚袋 / 菜籃共用。
//
// enforced=false（寬限期）：超量只提醒、不擋下動作。
// enforced=true：超量會在 service 端擋下，這裡只提醒清空間。
// 回傳空字串＝還很空、不需要提示。
function bagStatusLine({ label, used, cap, enforced = false, sellHint = "用 `/賣出` 換金幣" }) {
  if (typeof cap !== "number" || cap <= 0 || typeof used !== "number") return "";
  const free = cap - used;
  if (used >= cap) {
    return enforced
      ? `-# 🔴 ${label}已滿（${used}/${cap}）！${sellHint}`
      : `-# 🔴 ${label}已超過上限（${used}/${cap}）！寬限期間照常進行，但${sellHint}；期限後超出將擋下`;
  }
  if (free <= 5) {
    return `-# 🟡 ${label}快滿了（剩 ${free} 格・${used}/${cap}），${sellHint}`;
  }
  return "";
}

module.exports = { bagStatusLine };
