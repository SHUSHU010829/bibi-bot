// 開獎號碼產生器(純函數)。

const crypto = require("crypto");
const { pickRandomNumbers, getLotteryConfig } = require("./numbers");

/**
 * 為指定玩法抽出開獎號碼。
 */
function generateWinningNumbers(lotteryType) {
  const cfg = getLotteryConfig(lotteryType);
  if (!cfg) throw new Error(`unknown lotteryType: ${lotteryType}`);
  return pickRandomNumbers(cfg.pickCount, cfg.range);
}

/**
 * 抽一顆「加碼球」：範圍同主號，但排除已開出的主號（保證是新號碼）。
 * @returns {number}
 */
function generateBonusBall(lotteryType, excludeNumbers = []) {
  const cfg = getLotteryConfig(lotteryType);
  if (!cfg) throw new Error(`unknown lotteryType: ${lotteryType}`);
  const exclude = new Set(excludeNumbers);
  if (exclude.size >= cfg.range) return null;
  let n;
  do {
    n = crypto.randomInt(1, cfg.range + 1);
  } while (exclude.has(n));
  return n;
}

/**
 * 產生 drawId 字串(以週日日期為 key,符合每週開一期的設計)。
 * @param {Date} scheduledAt 開獎時間
 * @param {string} lotteryType
 * @param {string} dateStr YYYYMMDD,Asia/Taipei
 */
function buildDrawId(dateStr, lotteryType) {
  return `${dateStr}-${lotteryType}`;
}

module.exports = {
  generateWinningNumbers,
  generateBonusBall,
  buildDrawId,
};
