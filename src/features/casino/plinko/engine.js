// Plinko 核心引擎：純函數，不接觸 DB / Discord。
//
// 規則：
//   - 玩家下注、選風險（低/中/高）與排數（8/12/16）。
//   - 彈珠從頂端落下，每一排往左或往右各 50%（二項分布）。
//   - 落到底部某個格子，乘上該格倍率即為派彩。payout = floor(bet × multiplier)。
//   - 一翻定生死，沒有收手機制。
//
// 倍率表（multipliers[risk][rows]）由 config 提供，房費已內含在表內
//   （中央格 < 1 會吃掉本金、邊緣格高倍）。rows 排 → rows+1 個落點格。
//   落點 index = 整段路程往右的次數（0..rows）。

function floorPayout(bet, multiplier) {
  return Math.floor(bet * multiplier + 1e-9);
}

// 模擬一次落球，回傳路徑（L/R）與落點格 index。
function dropBall(rows, rng = Math.random) {
  const path = [];
  let rights = 0;
  for (let i = 0; i < rows; i += 1) {
    if (rng() < 0.5) {
      path.push("L");
    } else {
      path.push("R");
      rights += 1;
    }
  }
  return { path, bucket: rights };
}

// 取某個風險 / 排數的倍率表。table 形如 { low: {8:[...]}, medium:{...}, high:{...} }
function payoutRow(table, risk, rows) {
  const byRisk = table?.[risk];
  const row = byRisk?.[String(rows)] || byRisk?.[rows];
  return Array.isArray(row) ? row : null;
}

function play({ bet, risk, rows, multipliers, rng = Math.random }) {
  const row = payoutRow(multipliers, risk, rows);
  if (!row || row.length !== rows + 1) {
    throw new Error(`plinko: 缺少 ${risk}/${rows} 倍率表`);
  }
  const { path, bucket } = dropBall(rows, rng);
  const multiplier = row[bucket];
  const payout = floorPayout(bet, multiplier);
  return {
    bet,
    risk,
    rows,
    path,
    bucket,
    multiplier,
    payout,
    net: payout - bet,
    row,
  };
}

module.exports = {
  play,
  dropBall,
  payoutRow,
  floorPayout,
};
