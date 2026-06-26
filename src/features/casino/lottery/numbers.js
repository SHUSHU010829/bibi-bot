// 樂透號碼處理:挑選、驗證、比對。
// 使用 crypto.randomInt 確保開獎與隨機選號的隨機性。

const crypto = require("crypto");

const LOTTERY_CONFIG = {
  "6_49": {
    range: 49,
    pickCount: 6,
    label: "大樂透",
    emoji: "🎰",
  },
  "3_20": {
    range: 20,
    pickCount: 3,
    label: "小樂透",
    emoji: "🎫",
  },
  power_38_8: {
    range: 38,
    pickCount: 6,
    label: "威力彩",
    emoji: "⚡",
    // 第二區：1~8 選 1，與第一區獨立（號碼可重疊，分屬不同區）
    special: { range: 8, pickCount: 1, label: "第二區" },
  },
};

function getLotteryConfig(lotteryType) {
  return LOTTERY_CONFIG[lotteryType] || null;
}

function listLotteryTypes() {
  return Object.keys(LOTTERY_CONFIG);
}

/**
 * 隨機抽 N 個不重複號碼。
 * @param {number} count 要抽幾個
 * @param {number} max 號碼上限(含)
 * @returns {number[]} 排序後的號碼陣列
 */
function pickRandomNumbers(count, max) {
  if (count > max) {
    throw new Error(`pickRandomNumbers: count(${count}) > max(${max})`);
  }
  const picked = new Set();
  while (picked.size < count) {
    const n = crypto.randomInt(1, max + 1);
    picked.add(n);
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * 驗證玩家輸入的號碼。
 * @returns {{ ok: boolean, numbers?: number[], error?: string }}
 */
function validateNumbers(rawInput, lotteryType) {
  const cfg = getLotteryConfig(lotteryType);
  if (!cfg) return { ok: false, error: "玩法不存在" };

  if (typeof rawInput !== "string") {
    return { ok: false, error: "號碼格式錯誤" };
  }

  const tokens = rawInput
    .split(/[\s,，、.。/\\\-+]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length !== cfg.pickCount) {
    return {
      ok: false,
      error: `${cfg.label}需要選 ${cfg.pickCount} 個號碼,你輸入了 ${tokens.length} 個`,
    };
  }

  const numbers = [];
  for (const t of tokens) {
    const n = Number(t);
    if (!Number.isInteger(n)) {
      return { ok: false, error: `「${t}」不是有效號碼` };
    }
    if (n < 1 || n > cfg.range) {
      return {
        ok: false,
        error: `「${n}」超出範圍(1-${cfg.range})`,
      };
    }
    numbers.push(n);
  }

  const unique = new Set(numbers);
  if (unique.size !== numbers.length) {
    return { ok: false, error: "號碼不能重複" };
  }

  return { ok: true, numbers: [...unique].sort((a, b) => a - b) };
}

/**
 * 驗證包牌輸入(7-N 個號碼)。
 */
function validateWheelingNumbers(rawInput, lotteryType, maxBaseNumbers) {
  const cfg = getLotteryConfig(lotteryType);
  if (!cfg) return { ok: false, error: "玩法不存在" };

  if (typeof rawInput !== "string") {
    return { ok: false, error: "號碼格式錯誤" };
  }

  const tokens = rawInput
    .split(/[\s,,、.。/\\\-+]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length <= cfg.pickCount) {
    return {
      ok: false,
      error: `包牌需要選超過 ${cfg.pickCount} 個號碼(目前 ${tokens.length} 個)`,
    };
  }
  if (tokens.length > maxBaseNumbers) {
    return {
      ok: false,
      error: `包牌最多 ${maxBaseNumbers} 個號碼(目前 ${tokens.length} 個)`,
    };
  }

  const numbers = [];
  for (const t of tokens) {
    const n = Number(t);
    if (!Number.isInteger(n)) {
      return { ok: false, error: `「${t}」不是有效號碼` };
    }
    if (n < 1 || n > cfg.range) {
      return {
        ok: false,
        error: `「${n}」超出範圍(1-${cfg.range})`,
      };
    }
    numbers.push(n);
  }

  const unique = new Set(numbers);
  if (unique.size !== numbers.length) {
    return { ok: false, error: "號碼不能重複" };
  }

  return { ok: true, numbers: [...unique].sort((a, b) => a - b) };
}

/**
 * 比對中獎號碼數。
 */
function countMatches(ticketNumbers, winningNumbers) {
  const winSet = new Set(winningNumbers);
  let matched = 0;
  for (const n of ticketNumbers) {
    if (winSet.has(n)) matched++;
  }
  return matched;
}

/**
 * 包牌:把 base 號碼展開成所有 C(n, pickCount) 組合。
 */
function generateCombinations(baseNumbers, pickCount) {
  const sorted = [...baseNumbers].sort((a, b) => a - b);
  const result = [];

  function pick(start, current) {
    if (current.length === pickCount) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < sorted.length; i++) {
      current.push(sorted[i]);
      pick(i + 1, current);
      current.pop();
    }
  }

  pick(0, []);
  return result;
}

/**
 * 該玩法是否有第二區（威力彩式雙區）。
 */
function hasSecondZone(lotteryType) {
  return !!getLotteryConfig(lotteryType)?.special;
}

/**
 * 隨機抽第二區號碼（pickCount 為 1 時回傳單一數字）。
 */
function pickRandomSpecial(lotteryType) {
  const cfg = getLotteryConfig(lotteryType);
  if (!cfg?.special) return null;
  const picked = pickRandomNumbers(cfg.special.pickCount, cfg.special.range);
  return cfg.special.pickCount === 1 ? picked[0] : picked;
}

/**
 * 驗證玩家輸入的第二區號碼（單一數字）。
 * @returns {{ ok: boolean, value?: number, error?: string }}
 */
function validateSpecial(rawInput, lotteryType) {
  const cfg = getLotteryConfig(lotteryType);
  if (!cfg?.special) return { ok: false, error: "此玩法沒有第二區" };
  const label = cfg.special.label || "第二區";
  const range = cfg.special.range;
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    return { ok: false, error: `請輸入${label}號碼(1-${range})` };
  }
  const n = Number(rawInput.trim());
  if (!Number.isInteger(n) || n < 1 || n > range) {
    return { ok: false, error: `${label}必須是 1-${range} 的整數` };
  }
  return { ok: true, value: n };
}

/**
 * 一組號碼裡是否存在長度 ≥ minRun 的連號（連續整數）。
 * 例：[3,7,8,9,20] minRun=3 → true（7・8・9）。
 */
function hasConsecutiveRun(numbers, minRun) {
  if (!Array.isArray(numbers) || numbers.length < minRun) return false;
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run >= minRun) return true;
  }
  return false;
}

/**
 * 數學公式 C(n, k)。
 */
function combinationCount(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

module.exports = {
  LOTTERY_CONFIG,
  getLotteryConfig,
  listLotteryTypes,
  pickRandomNumbers,
  validateNumbers,
  validateWheelingNumbers,
  countMatches,
  generateCombinations,
  combinationCount,
  hasConsecutiveRun,
  hasSecondZone,
  pickRandomSpecial,
  validateSpecial,
};
