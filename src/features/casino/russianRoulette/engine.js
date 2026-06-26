// 俄羅斯輪盤（左輪）結算（純函數）。
//
// 規則：N 位玩家各押相同賭注 ante 進池。依「模式」決定子彈數 K（中彈人數），
// 隨機抽 K 位中彈者輸光，其餘生還者平分池底（扣 rake 房水）。
// 模式可調整刺激度，最硬核的「地獄」只留 1 人生還（只有一枚空彈）。

// 各模式 → 依人數 n 算出子彈數（中彈人數）。至少 1 中彈、至少留 1 生還。
const MODES = {
  standard: { label: "標準（1 發子彈）", emoji: "🔫", bullets: () => 1 },
  intense: { label: "刺激（半數中彈）", emoji: "💥", bullets: (n) => Math.max(1, Math.floor(n / 2)) },
  lastman: { label: "地獄（只剩 1 人生還）", emoji: "💀", bullets: (n) => n - 1 },
};

function modeBullets(mode, n) {
  const m = MODES[mode] || MODES.standard;
  return Math.max(1, Math.min(m.bullets(n), n - 1));
}

function shuffleIndices(n, rng) {
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// players: [{ userId, username, ante }]
// 回傳 { loserIndices, loserIds, winnerIds, pot, rake, perWinner, payouts, bullets }
function resolve(players, { bullets = 1, rakePct = 0.05, rng = Math.random } = {}) {
  const n = players.length;
  const k = Math.max(1, Math.min(bullets, n - 1));
  const loserSet = new Set(shuffleIndices(n, rng).slice(0, k));

  const losers = players.filter((_, i) => loserSet.has(i));
  const winners = players.filter((_, i) => !loserSet.has(i));

  const pot = players.reduce((s, p) => s + p.ante, 0);
  const distributable = Math.floor(pot * (1 - rakePct));
  const perWinner = winners.length > 0 ? Math.floor(distributable / winners.length) : 0;
  const payouts = winners.map((w) => ({ userId: w.userId, amount: perWinner }));
  const rake = pot - perWinner * winners.length;

  return {
    loserIndices: [...loserSet].sort((a, b) => a - b),
    loserIds: losers.map((l) => l.userId),
    winnerIds: winners.map((w) => w.userId),
    pot,
    rake,
    perWinner,
    payouts,
    bullets: k,
  };
}

module.exports = { resolve, MODES, modeBullets };
