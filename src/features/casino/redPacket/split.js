// 搶紅包金額拆分（純函數，不接觸 DB / Discord）。
//
// 兩種手氣模式：
//   even   — 均分：每包 floor(total/count)，餘數隨機灑到幾包 +1。
//   lucky  — 隨機（微信「二倍均值法」）：每包在 [1, 2×剩餘均值] 間隨機，
//            保證每包 ≥ 1、總和 = total、後面的人一定有得拿。
//
// 兩種模式都先「預先算好」整個 shares 陣列，再於搶的時候依序發放，
// 確保併發下每包金額是固定的、不會因為搶的順序而被重算。

function randInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// 均分：餘數 r 包各 +1，再洗牌讓 +1 落點隨機。
function splitEven(total, count, rng = Math.random) {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  const shares = [];
  for (let i = 0; i < count; i += 1) {
    shares.push(base + (i < remainder ? 1 : 0));
  }
  for (let i = shares.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shares[i], shares[j]] = [shares[j], shares[i]];
  }
  return shares;
}

// 二倍均值法：第 k 包（還剩 n 人、剩 m 元）→ random in [1, max(1, floor(2m/n))]，
// 最後一包拿光剩餘。保證每包 ≥ 1。
function splitLucky(total, count, rng = Math.random) {
  const shares = [];
  let remaining = total;
  for (let i = 0; i < count; i += 1) {
    const peopleLeft = count - i;
    if (peopleLeft === 1) {
      shares.push(remaining);
      break;
    }
    // 預留每個後面的人至少 1 元
    const maxDraw = Math.max(1, Math.min(remaining - (peopleLeft - 1), Math.floor((2 * remaining) / peopleLeft)));
    const draw = randInt(1, maxDraw, rng);
    shares.push(draw);
    remaining -= draw;
  }
  return shares;
}

function buildShares(total, count, mode = "lucky", rng = Math.random) {
  if (mode === "even") return splitEven(total, count, rng);
  return splitLucky(total, count, rng);
}

module.exports = { buildShares, splitEven, splitLucky };
