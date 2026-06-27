// 搶紅包金額拆分（純函數，不接觸 DB / Discord）。
//
// 兩種手氣模式：
//   even   — 均分：每包 floor(total/count)，餘數隨機灑到幾包 +1。
//   lucky  — 隨機（微信「二倍均值法」變形）：每包在 [0, 2×剩餘均值] 間隨機，
//            總和 = total、最後一包拿光剩餘。允許單包是 0 元 —— 一般紅包也
//            偶爾會出現「拿到 0 元」，傻瓜紅包就不會一看就被識破。
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

// 二倍均值法（下限放到 0）：第 k 包（還剩 n 人、剩 m 元）→ random in [0, floor(2m/n)]，
// 最後一包拿光剩餘。允許單包是 0 元，讓傻瓜紅包（全 0）不會被「出現 0 元」直接識破。
function splitLucky(total, count, rng = Math.random) {
  const shares = [];
  let remaining = total;
  for (let i = 0; i < count; i += 1) {
    const peopleLeft = count - i;
    if (peopleLeft === 1) {
      shares.push(remaining);
      break;
    }
    const maxDraw = Math.max(0, Math.floor((2 * remaining) / peopleLeft));
    const draw = randInt(0, maxDraw, rng);
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
