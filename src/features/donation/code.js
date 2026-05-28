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

module.exports = { generateCode, extractCode, tierForAmount };
