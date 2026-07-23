// /排行榜 類別註冊：定義所有可選類別與支援的時間區間。
// 每個類別的 fetcher 函式統一回傳 { rows, total, myRank?, myDetail? }，
// 由 render.js 用同一套樣板呈現。

const fetchLevel = require("./fetchers/level");
const fetchMessages = require("./fetchers/messages");
const fetchVoice = require("./fetchers/voice");
const fetchChannels = require("./fetchers/channels");
const fetchMining = require("./fetchers/mining");
const fetchMiningValue = require("./fetchers/miningValue");
const fetchMiningDiamond = require("./fetchers/miningDiamond");
const fetchTitles = require("./fetchers/titles");
const fetchWeeklySummary = require("./fetchers/weeklySummary");
const { fetchCasinoWinners, fetchCasinoLosers } = require("./fetchers/casino");
const fetchSwordBreaker = require("./fetchers/swordBreaker");

const PERIODS = {
  today: "今天",
  week: "本週",
  month: "本月",
  all: "全部時間",
};

const CATEGORIES = [
  {
    key: "level",
    label: "等級",
    emoji: "🏆",
    accent: 0xffd700,
    description: "依累積 XP 排名（全時）",
    periods: ["all"],
    defaultPeriod: "all",
    fetch: fetchLevel,
  },
  {
    key: "messages",
    label: "訊息",
    emoji: "💬",
    accent: 0x5865f2,
    description: "依訊息數排名",
    periods: ["today", "week", "month", "all"],
    defaultPeriod: "today",
    fetch: fetchMessages,
  },
  {
    key: "voice",
    label: "語音時長",
    emoji: "🎤",
    accent: 0x9b59b6,
    description: "依語音分鐘數排名",
    periods: ["today", "week", "month", "all"],
    defaultPeriod: "today",
    fetch: fetchVoice,
  },
  {
    key: "channels",
    label: "頻道熱度",
    emoji: "📺",
    accent: 0x3498db,
    description: "依頻道訊息與活躍人數排名",
    periods: ["today", "week", "month", "all"],
    defaultPeriod: "today",
    fetch: fetchChannels,
  },
  {
    key: "mining",
    label: "挖礦次數（週）",
    emoji: "⛏️",
    accent: 0xe67e22,
    description: "本週挖礦數量，週一頒發礦坑之王 👑",
    periods: ["week"],
    defaultPeriod: "week",
    fetch: fetchMining,
  },
  {
    key: "mining_value",
    label: "挖礦市值",
    emoji: "💎",
    accent: 0xf1c40f,
    description: "依礦石總市值排名（qty × 單價）",
    periods: ["week", "month", "all"],
    defaultPeriod: "week",
    fetch: fetchMiningValue,
  },
  {
    key: "mining_diamond",
    label: "鑽石獵人",
    emoji: "💠",
    accent: 0x00bcd4,
    description: "依累計挖到的鑽石數排名（全時）",
    periods: ["all"],
    defaultPeriod: "all",
    fetch: fetchMiningDiamond,
  },
  {
    key: "titles",
    label: "稱號收藏",
    emoji: "🎖️",
    accent: 0xe91e63,
    description: "依已解鎖稱號數排名（全時）",
    periods: ["all"],
    defaultPeriod: "all",
    fetch: fetchTitles,
  },
  {
    key: "weekly",
    label: "週報總覽",
    emoji: "📅",
    accent: 0x1abc9c,
    description: "本週挖礦 / 市值 / 稱號 Top 3 一覽",
    periods: ["week"],
    defaultPeriod: "week",
    fetch: fetchWeeklySummary,
  },
  {
    key: "sword_breaker",
    label: "斷劍王",
    emoji: "☠️",
    accent: 0x992d22,
    description: "把 🔥 傳說之劍 砍斷最多次（每週一結算，第一名遭亡靈制詛咒）",
    periods: ["week", "all"],
    defaultPeriod: "week",
    fetch: fetchSwordBreaker,
  },
  {
    key: "casino_winners",
    label: "賭場贏家",
    emoji: "💰",
    accent: 0x2ecc71,
    description: "賭場淨賺最多",
    periods: ["today", "week", "month"],
    defaultPeriod: "week",
    fetch: fetchCasinoWinners,
  },
  {
    key: "casino_losers",
    label: "賭場輸家",
    emoji: "💸",
    accent: 0xe74c3c,
    description: "賭場淨虧最多",
    periods: ["today", "week", "month"],
    defaultPeriod: "week",
    fetch: fetchCasinoLosers,
  },
];

const CAT_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
const DEFAULT_CATEGORY = "level";

function normalize(categoryKey, periodKey) {
  const cat = CAT_BY_KEY.get(categoryKey) || CAT_BY_KEY.get(DEFAULT_CATEGORY);
  const period = cat.periods.includes(periodKey) ? periodKey : cat.defaultPeriod;
  return { cat, period };
}

function periodLabel(period) {
  return PERIODS[period] || period;
}

module.exports = {
  CATEGORIES,
  CAT_BY_KEY,
  DEFAULT_CATEGORY,
  PERIODS,
  normalize,
  periodLabel,
};
