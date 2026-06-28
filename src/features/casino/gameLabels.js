// 賭場遊戲的中文顯示標籤，所有玩家 / admin 看得到的賭場結算（economyDashboard、casinoStats、
// economyDailyReport…）一律從這裡取，避免分散多份各自漏更新而印出英文 key。
// 新增賭場遊戲時務必同步補進這裡的兩個 map。

const GAME_LABELS = {
  slot: "🎰 拉霸",
  sicbo: "🎲 骰寶",
  blackjack: "🃏 21 點",
  hilo: "🔼 HI-LO",
  keno: "🗺️ 尋寶",
  dragonGate: "🐉 射龍門",
  roulette: "🎡 輪盤",
  poker: "🃏 德州撲克",
  lottery: "🎟️ 樂透",
  horseRacing: "🐎 賽馬",
  crash: "🚀 火箭",
  baccarat: "🎴 百家樂",
  bingo: "🔢 賓果",
  bingoHall: "🔢 賓果廳",
  casinoHoldem: "🃏 賭場德州撲克",
  fishPrawnCrab: "🦀 魚蝦蟹",
  luckyWheel: "🎡 幸運轉盤",
  mines: "💣 踩地雷",
  multiplierWheel: "🎯 倍率輪盤",
  plinko: "🔵 彈珠台",
  redPacket: "🧧 紅包",
  russianRoulette: "🔫 俄羅斯輪盤",
  scratch: "🎫 刮刮樂",
  tower: "🗼 爬塔",
  unknown: "❓ 未分類",
};

// 給日報表格用的短標籤，無 emoji，固定 2~4 字以維持等寬欄位對齊。
const GAME_SHORT_LABELS = {
  slot: "拉霸",
  sicbo: "骰寶",
  blackjack: "21點",
  hilo: "HiLo",
  keno: "尋寶",
  dragonGate: "射龍門",
  roulette: "輪盤",
  poker: "德州",
  lottery: "樂透",
  horseRacing: "賽馬",
  crash: "火箭",
  baccarat: "百家樂",
  bingo: "賓果",
  bingoHall: "賓果廳",
  casinoHoldem: "賭場德州",
  fishPrawnCrab: "魚蝦蟹",
  luckyWheel: "幸運轉盤",
  mines: "踩地雷",
  multiplierWheel: "倍率輪盤",
  plinko: "彈珠台",
  redPacket: "紅包",
  russianRoulette: "俄羅斯輪盤",
  scratch: "刮刮樂",
  tower: "爬塔",
  unknown: "未分類",
};

function gameLabel(game) {
  return GAME_LABELS[game] || `❓ ${game}`;
}

function gameShortLabel(game) {
  return GAME_SHORT_LABELS[game] || game;
}

module.exports = { GAME_LABELS, GAME_SHORT_LABELS, gameLabel, gameShortLabel };
