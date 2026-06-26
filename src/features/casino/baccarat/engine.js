// 百家樂（Baccarat）純邏輯：發牌、補牌規則、結算。
// 無 DB / Discord 依賴，純函式方便模擬驗證。

const RANK_LABELS = {
  1: "A",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
};

const SUITS = ["♠", "♥", "♦", "♣"];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 從無限牌靴抽一張牌：rank 1-13 均勻，隨機花色（純美觀）。
function drawCard() {
  return { rank: randInt(1, 13), suit: SUITS[randInt(0, SUITS.length - 1)] };
}

// 牌面點數：A=1，2-9 照面值，10/J/Q/K=0。
function cardValue(card) {
  if (card.rank >= 10) return 0;
  return card.rank;
}

function handTotal(cards) {
  return cards.reduce((s, c) => s + cardValue(c), 0) % 10;
}

function cardLabel(card) {
  return `${RANK_LABELS[card.rank]}${card.suit}`;
}

// 莊家標準補牌表：依莊家前兩張點數與閒家第三張牌的點數（0-9）決定是否補牌。
// playerThirdValue 為 null 代表閒家沒補（莊家在 0-5 補、6-7 停）。
function bankerShouldDraw(bankerTotal, playerThirdValue) {
  if (bankerTotal <= 2) return true;
  if (playerThirdValue === null) {
    return bankerTotal <= 5;
  }
  switch (bankerTotal) {
    case 3:
      return playerThirdValue !== 8;
    case 4:
      return playerThirdValue >= 2 && playerThirdValue <= 7;
    case 5:
      return playerThirdValue >= 4 && playerThirdValue <= 7;
    case 6:
      return playerThirdValue === 6 || playerThirdValue === 7;
    default:
      return false; // 7 停牌
  }
}

// 發一局，回傳完整牌局結果。
function deal() {
  const player = [drawCard(), drawCard()];
  const banker = [drawCard(), drawCard()];

  let playerTotal = handTotal(player);
  let bankerTotal = handTotal(banker);

  const natural = playerTotal >= 8 || bankerTotal >= 8;

  let playerThirdValue = null;
  if (!natural) {
    if (playerTotal <= 5) {
      const third = drawCard();
      player.push(third);
      playerThirdValue = cardValue(third);
      playerTotal = handTotal(player);
    }
    if (bankerShouldDraw(bankerTotal, playerThirdValue)) {
      banker.push(drawCard());
      bankerTotal = handTotal(banker);
    }
  }

  let outcome;
  if (playerTotal > bankerTotal) outcome = "player";
  else if (bankerTotal > playerTotal) outcome = "banker";
  else outcome = "tie";

  const playerPair = player[0].rank === player[1].rank;
  const bankerPair = banker[0].rank === banker[1].rank;

  return {
    player,
    banker,
    playerTotal,
    bankerTotal,
    outcome,
    playerPair,
    bankerPair,
  };
}

// 結算單一注，回傳 { won, push, payout, multiplier }。
//   payout 是「拿回的總額」（含本金）；輸 = 0；和局 PUSH = 退回本金。
//   multiplier 是純獎金倍率（不含本金），輸 / push 為 0。
function settleBet(bet, result) {
  const amount = bet.amount;
  const lose = { won: false, push: false, payout: 0, multiplier: 0 };

  switch (bet.type) {
    case "banker": {
      if (result.outcome === "banker") {
        const winnings = Math.floor(amount * 0.95);
        return { won: true, push: false, payout: amount + winnings, multiplier: 0.95 };
      }
      if (result.outcome === "tie") {
        return { won: false, push: true, payout: amount, multiplier: 0 };
      }
      return lose;
    }

    case "player": {
      if (result.outcome === "player") {
        return { won: true, push: false, payout: amount * 2, multiplier: 1 };
      }
      if (result.outcome === "tie") {
        return { won: false, push: true, payout: amount, multiplier: 0 };
      }
      return lose;
    }

    case "tie": {
      if (result.outcome === "tie") {
        return { won: true, push: false, payout: amount * 9, multiplier: 8 };
      }
      return lose;
    }

    case "banker_pair": {
      if (result.bankerPair) {
        return { won: true, push: false, payout: amount * 12, multiplier: 11 };
      }
      return lose;
    }

    case "player_pair": {
      if (result.playerPair) {
        return { won: true, push: false, payout: amount * 12, multiplier: 11 };
      }
      return lose;
    }

    default:
      return lose;
  }
}

function settleRound(bets, result) {
  const results = bets.map((bet) => ({
    bet,
    ...settleBet(bet, result),
  }));
  const totalBet = bets.reduce((s, b) => s + b.amount, 0);
  const totalPayout = results.reduce((s, r) => s + r.payout, 0);
  return { result, totalBet, totalPayout, results };
}

module.exports = {
  drawCard,
  cardValue,
  handTotal,
  cardLabel,
  bankerShouldDraw,
  deal,
  settleBet,
  settleRound,
  RANK_LABELS,
};
