// /檔案 分頁註冊。
//
// /檔案 永遠是本人、公開訊息，所以這裡不再需要 viewOther / publicSafe 規則，
// 也不再需要 ephemeral 強制提升。分頁切換按鈕只限本人點擊（在 dispatcher 驗證）。

const TABS = [
  { key: "level",        label: "等級卡",    emoji: "📇" },
  { key: "miner",        label: "礦工檔案",  emoji: "⛏️" },
  { key: "wallet",       label: "錢包",      emoji: "💰" },
  { key: "casino",       label: "賭場紀錄",  emoji: "🎰" },
  { key: "achievements", label: "成就",      emoji: "🏆" },
];

const TAB_BY_KEY = new Map(TABS.map((t) => [t.key, t]));
const DEFAULT_TAB = "level";

module.exports = { TABS, TAB_BY_KEY, DEFAULT_TAB };
