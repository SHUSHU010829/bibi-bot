const crypto = require("node:crypto");
const { donation } = require("../../config");

// 與 bibi-website src/lib/donation/code.ts 同一套字母表（去掉 0/1/I/L/O）
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** 產生 6 字元短碼，例 "DON-AB12CD"。entropy ≈ 30 bits。 */
function generateCode() {
  const bytes = crypto.randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `DON-${s}`;
}

/**
 * 從 PatronNote 抽取第一個合法 code。
 * 大小寫不敏感、允許前後有其他文字。
 */
function extractCode(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.toUpperCase().match(/DON-([23456789A-HJKMNPQRSTUVWXYZ]{6})/);
  return m ? `DON-${m[1]}` : null;
}

/**
 * 抖內身份組顯示文案（統一口徑）：
 *  - 一般贊助（donor）→「贈舒人」
 *  - 頂級贊助（vipDonor）→「滿腹詩舒」
 * DM、website success 摘要等所有對外文案都應走這裡，避免各處名稱不一致。
 */
function roleName(tier) {
  return tier?.role === "vipDonor" ? "滿腹詩舒" : "贈舒人";
}

// 付款平台顯示名。webhook 只會寫入 ecpay / opay，manual 用於管理員手動核發
// （街口、轉帳等不經金流的管道）。未知值一律歸到「其他管道」，不要猜成歐付寶。
const PLATFORM_LABELS = {
  ecpay: "綠界",
  opay: "歐付寶",
  manual: "其他管道",
};

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || PLATFORM_LABELS.manual;
}

/** 商品（SKU）定義；找不到時回 null。回傳物件帶上 id 方便呼叫端直接用。 */
function skuById(skuId) {
  const def = donation?.skus?.[skuId];
  return def ? { id: skuId, ...def } : null;
}

/** 全部商品（SKU），依 config 宣告順序。 */
function skuList() {
  return Object.entries(donation?.skus || {}).map(([id, def]) => ({ id, ...def }));
}

/** 依金額找方案；找不到時回 null（< 50 元 或設定錯誤）。 */
function tierForAmount(amountNtd) {
  const tiers = donation?.tiers || [];
  for (const t of tiers) {
    if (amountNtd >= t.minAmount && (t.maxAmount === null || amountNtd <= t.maxAmount)) {
      return t;
    }
  }
  return null;
}

/**
 * 方案 A — 依「實際付款金額」線性換算金幣，級距內平滑浮動。
 *
 * 動機：原本同一級距內金幣固定（付 150 跟付 499 都拿 2000），玩家沒有誘因
 * 多付，理性上一定壓在級距最低。改成「多付一元就多拿金幣」即可消除此誘因，
 * 同時保留級距制的其他福利（角色 / 道具 / luck / 卡面 / 稱號）。
 *
 * 規則：
 *  - 級距內：從 (本階 minAmount → 本階 coins) 線性內插到
 *    (下一階 minAmount → 下一階 coins)，邊界因此平滑無斷層。
 *  - 最高階（maxAmount === null）：以本階隱含費率 (coins / minAmount) 每元延伸。
 *  - 結果四捨五入到 10 的倍數，且不低於本階 coins（保底）。
 *  - 金額未達門檻（找不到級距）回 0。
 *
 * 註：各階的 coins 本身即為「已依目前經濟調校」的錨點，內插只是讓中間值連續。
 */
function coinsForAmount(amountNtd) {
  const tiers = donation?.tiers || [];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const inTier =
      amountNtd >= t.minAmount && (t.maxAmount === null || amountNtd <= t.maxAmount);
    if (!inTier) continue;

    const next = tiers[i + 1] || null;
    let coins;
    if (t.maxAmount === null || !next) {
      // 最高階：以本階費率每元延伸（付越多線性越多）
      const rate = t.coins / t.minAmount;
      coins = t.coins + (amountNtd - t.minAmount) * rate;
    } else {
      // 級距內：本階底 → 下一階底 線性內插
      const slope = (next.coins - t.coins) / (next.minAmount - t.minAmount);
      coins = t.coins + (amountNtd - t.minAmount) * slope;
    }
    coins = Math.round(coins / 10) * 10;
    return Math.max(coins, t.coins);
  }
  return 0;
}

module.exports = {
  generateCode,
  extractCode,
  roleName,
  platformLabel,
  skuById,
  skuList,
  tierForAmount,
  coinsForAmount,
};
