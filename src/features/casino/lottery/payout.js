// 樂透派彩計算(純函數,不寫 DB)。
// 6/49: 頭獎 70%、二獎 15%、三獎 10%、四獎固定 100/張、剩 5% 滾下期。
//        頭獎沒人中 → 頭獎 share 滾下期,二/三獎照常按 share 分配。
// 3/20: 頭獎 80%、二獎固定 50/張、剩 20% 滾下期。

/**
 * 6/49 派彩。
 * @param {object} params
 * @param {number} params.pool 當期彩池
 * @param {number} params.fourthPrizeFixed 四獎固定金額
 * @param {Array<{ ticketId: string, matched: number }>} params.tickets
 * @returns {{
 *   prizes: { jackpot, second, third, fourth, rolledOver },
 *   ticketAssignments: Array<{ ticketId, prize|null, payoutAmount }>,
 * }}
 */
function calculatePayout649({ pool, fourthPrizeFixed, tickets }) {
  const jackpotShare = Math.floor(pool * 0.7);
  const secondShare = Math.floor(pool * 0.15);
  const thirdShare = Math.floor(pool * 0.1);

  const jackpotTickets = tickets.filter((t) => t.matched === 6);
  const secondTickets = tickets.filter((t) => t.matched === 5);
  const thirdTickets = tickets.filter((t) => t.matched === 4);
  const fourthTickets = tickets.filter((t) => t.matched === 3);

  let jackpotPayout = 0;
  let jackpotPerWinner = 0;
  let secondPayout = 0;
  let secondPerWinner = 0;
  let thirdPayout = 0;
  let thirdPerWinner = 0;
  let rolledOver = 0;

  // 二/三獎照常發(獨立於頭獎是否有人中)
  if (secondTickets.length > 0) {
    secondPerWinner = Math.floor(secondShare / secondTickets.length);
    secondPayout = secondPerWinner * secondTickets.length;
  }
  if (thirdTickets.length > 0) {
    thirdPerWinner = Math.floor(thirdShare / thirdTickets.length);
    thirdPayout = thirdPerWinner * thirdTickets.length;
  }

  if (jackpotTickets.length === 0) {
    // 頭獎沒人中 → 頭獎 share 全滾下期,二/三獎已照發
    rolledOver = pool - secondPayout - thirdPayout;
  } else {
    jackpotPerWinner = Math.floor(jackpotShare / jackpotTickets.length);
    jackpotPayout = jackpotPerWinner * jackpotTickets.length;
    // 5% 留作下期底池 + 頭獎均分餘數
    rolledOver =
      pool - jackpotShare - secondShare - thirdShare + (jackpotShare - jackpotPayout);
  }

  const fourthPayout = fourthTickets.length * fourthPrizeFixed;

  const ticketAssignments = tickets.map((t) => {
    if (t.matched === 6) return { ticketId: t.ticketId, prize: "jackpot", payoutAmount: jackpotPerWinner };
    if (t.matched === 5) return { ticketId: t.ticketId, prize: "second", payoutAmount: secondPerWinner };
    if (t.matched === 4) return { ticketId: t.ticketId, prize: "third", payoutAmount: thirdPerWinner };
    if (t.matched === 3) return { ticketId: t.ticketId, prize: "fourth", payoutAmount: fourthPrizeFixed };
    return { ticketId: t.ticketId, prize: null, payoutAmount: 0 };
  });

  return {
    prizes: {
      jackpot: {
        amount: jackpotPayout,
        winnerCount: jackpotTickets.length,
        perWinner: jackpotPerWinner,
        ticketIds: jackpotTickets.map((t) => t.ticketId),
      },
      second: {
        amount: secondPayout,
        winnerCount: secondTickets.length,
        perWinner: secondPerWinner,
        ticketIds: secondTickets.map((t) => t.ticketId),
      },
      third: {
        amount: thirdPayout,
        winnerCount: thirdTickets.length,
        perWinner: thirdPerWinner,
        ticketIds: thirdTickets.map((t) => t.ticketId),
      },
      fourth: {
        amount: fourthPayout,
        winnerCount: fourthTickets.length,
        perWinner: fourthPrizeFixed,
      },
      rolledOver: {
        amount: rolledOver,
      },
    },
    ticketAssignments,
  };
}

/**
 * 3/20 派彩。
 */
function calculatePayout320({ pool, secondPrizeFixed, tickets }) {
  const jackpotShare = Math.floor(pool * 0.8);

  const jackpotTickets = tickets.filter((t) => t.matched === 3);
  const secondTickets = tickets.filter((t) => t.matched === 2);

  let jackpotPayout = 0;
  let jackpotPerWinner = 0;
  let rolledOver = 0;
  const secondPayout = secondTickets.length * secondPrizeFixed;

  if (jackpotTickets.length === 0) {
    // 頭獎沒人中 → 全部滾(含本期收進來的二獎固定額,因為沒從彩池扣)
    rolledOver = pool;
  } else {
    jackpotPerWinner = Math.floor(jackpotShare / jackpotTickets.length);
    jackpotPayout = jackpotPerWinner * jackpotTickets.length;
    // 20% 留作下期 + 頭獎均分餘數;二獎是系統固定支出,不從 pool 扣
    rolledOver = pool - jackpotShare + (jackpotShare - jackpotPayout);
  }

  const ticketAssignments = tickets.map((t) => {
    if (t.matched === 3) return { ticketId: t.ticketId, prize: "jackpot", payoutAmount: jackpotPerWinner };
    if (t.matched === 2) return { ticketId: t.ticketId, prize: "second", payoutAmount: secondPrizeFixed };
    return { ticketId: t.ticketId, prize: null, payoutAmount: 0 };
  });

  return {
    prizes: {
      jackpot: {
        amount: jackpotPayout,
        winnerCount: jackpotTickets.length,
        perWinner: jackpotPerWinner,
        ticketIds: jackpotTickets.map((t) => t.ticketId),
      },
      second: {
        amount: secondPayout,
        winnerCount: secondTickets.length,
        perWinner: secondPrizeFixed,
      },
      rolledOver: {
        amount: rolledOver,
      },
    },
    ticketAssignments,
  };
}

function calculatePayout({ lotteryType, pool, tickets, config }) {
  if (lotteryType === "6_49") {
    return calculatePayout649({
      pool,
      fourthPrizeFixed: config.fourthPrizeFixed ?? 100,
      tickets,
    });
  }
  if (lotteryType === "3_20") {
    return calculatePayout320({
      pool,
      secondPrizeFixed: config.secondPrizeFixed ?? 50,
      tickets,
    });
  }
  throw new Error(`unknown lotteryType: ${lotteryType}`);
}

module.exports = {
  calculatePayout,
  calculatePayout649,
  calculatePayout320,
};
