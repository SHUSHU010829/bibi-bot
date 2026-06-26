// 俄羅斯輪盤（左輪）結算（純函數）。
//
// 規則：N 位玩家各押相同賭注 ante 進池。隨機一位「中彈」者輸掉，
// 其餘人平分池底（扣 rake 房水）。中彈機率對每位玩家均等，房水是唯一莊家優勢。

function randInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// players: [{ userId, username, ante }]
// 回傳 { loserIndex, loserId, pot, rake, perWinner, payouts:[{userId, amount}] }
function resolve(players, { rakePct = 0.05, rng = Math.random } = {}) {
  const pot = players.reduce((s, p) => s + p.ante, 0);
  const loserIndex = randInt(0, players.length - 1, rng);
  const loserId = players[loserIndex].userId;

  const winners = players.filter((_, i) => i !== loserIndex);
  const distributable = Math.floor(pot * (1 - rakePct));
  const perWinner = winners.length > 0 ? Math.floor(distributable / winners.length) : 0;

  const payouts = winners.map((w) => ({ userId: w.userId, amount: perWinner }));
  const rake = pot - perWinner * winners.length;

  return { loserIndex, loserId, pot, rake, perWinner, payouts };
}

module.exports = { resolve, randInt };
