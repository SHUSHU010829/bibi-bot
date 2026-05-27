// 加權隨機：吃 { key: weight } 物件，依權重回傳一個 key。
function weightedRandom(weights) {
  const entries = Object.entries(weights || {}).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;

  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}

module.exports = { weightedRandom };
