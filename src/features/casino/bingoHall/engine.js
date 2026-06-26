// 賓果大廳結算（純函式）。複用單人賓果引擎的卡片/連線判定。
//
// 彩金採「彩池分配」(parimutuel)，償付永遠 ≤ 彩池，無破產風險：
//   net = pool × (1 − rake)
//   net 拆成「連線獎池」與「頭彩(jackpot)貢獻」兩塊：
//     - 連線獎池：本場分給所有「至少 1 條線」的卡，依連線數比例分配。
//     - 頭彩：每場貢獻累積；本場「連線最多者」獨得/均分整個累積頭彩
//             （含歷史滾存）。整場沒有任何人連線時，頭彩滾到下一場（越滾越大）。
//   連線滿 12 條（24 格全中）= 全餐 BINGO，是頭彩的最高展示形式。
// 房水(rake)是唯一的莊家優勢；每場幾乎都把 net 發完，長期 RTP = 1 − rake。

const { buildMarks, countLines } = require("../bingo/engine");

const FULL_HOUSE_LINES = 12; // 5 列 + 5 行 + 2 對角 = 全餐

function settleRound({ cards, drawnBalls, pool, jackpotPoolIn, rakePct, jackpotShare }) {
  const drawnSet = new Set(drawnBalls);
  const evaluated = cards.map((c) => {
    const marks = buildMarks(c.card, drawnSet);
    const lines = countLines(marks);
    return {
      cardId: c.cardId,
      userId: c.userId,
      username: c.username,
      lines,
      isFullHouse: lines >= FULL_HOUSE_LINES,
    };
  });

  const rake = Math.floor(pool * rakePct);
  const net = pool - rake;
  const jackpotContribution = Math.floor(net * jackpotShare);
  const linesPrizePool = net - jackpotContribution;
  let jackpotPool = jackpotPoolIn + jackpotContribution;

  // 連線獎：所有 ≥1 線者依連線數比例分配
  const lineCards = evaluated.filter((c) => c.lines >= 1);
  const totalLines = lineCards.reduce((s, c) => s + c.lines, 0);
  const assignment = new Map();
  let linesPaid = 0;
  if (totalLines > 0) {
    for (const c of lineCards) {
      const amt = Math.floor(linesPrizePool * (c.lines / totalLines));
      assignment.set(c.cardId, { prize: "lines", payout: amt, lines: c.lines });
      linesPaid += amt;
    }
  }
  // 連線獎沒分完的餘數滾入頭彩
  jackpotPool += linesPrizePool - linesPaid;

  // 頭彩：本場「連線最多者」獨得/均分累積頭彩
  let jackpotPaid = 0;
  let jackpotPoolOut = jackpotPool;
  let jackpotWinners = 0;
  if (lineCards.length > 0) {
    const maxLines = Math.max(...lineCards.map((c) => c.lines));
    const tops = lineCards.filter((c) => c.lines === maxLines);
    const per = Math.floor(jackpotPool / tops.length);
    for (const c of tops) {
      const prev = assignment.get(c.cardId);
      assignment.set(c.cardId, {
        prize: "jackpot",
        payout: (prev?.payout || 0) + per,
        lines: c.lines,
      });
      jackpotPaid += per;
    }
    jackpotWinners = tops.length;
    jackpotPoolOut = jackpotPool - jackpotPaid; // 餘數續滾
  }
  // 整場無人連線 → 頭彩整池滾到下一場（jackpotPoolOut = jackpotPool）

  const results = evaluated.map((c) => ({
    ...c,
    ...(assignment.get(c.cardId) || { prize: null, payout: 0 }),
  }));

  return {
    results,
    rake,
    linesPrizePool,
    linesPaid,
    jackpotContribution,
    jackpotPaid,
    jackpotPoolOut,
    jackpotWinners,
    lineWinners: lineCards.length,
  };
}

module.exports = { settleRound, FULL_HOUSE_LINES };
