// /檔案 分頁註冊與可見性規則
//
// viewOther : 是否允許在 [用戶] 不是自己時顯示（個人財務性資料設 false）
// publicSafe: 是否允許在非 ephemeral（公開）訊息顯示（含敏感金額類設 false）
//
// 切換按鈕只會渲染「對當前 (target, ephemeral) 組合可見」的分頁；
// 若使用者直接呼叫 /檔案 分頁:錢包 但沒開私密，dispatcher 會自動升為 ephemeral。

const TABS = [
  { key: "level",        label: "等級卡",    emoji: "📇", viewOther: true,  publicSafe: true  },
  { key: "miner",        label: "礦工檔案",  emoji: "⛏️", viewOther: true,  publicSafe: true  },
  { key: "wallet",       label: "錢包",      emoji: "💰", viewOther: false, publicSafe: false },
  { key: "backpack",     label: "背包",      emoji: "🎒", viewOther: false, publicSafe: false },
  { key: "casino",       label: "賭場紀錄",  emoji: "🎰", viewOther: false, publicSafe: false },
  { key: "stock",        label: "持股",      emoji: "📈", viewOther: false, publicSafe: false },
  { key: "achievements", label: "成就",      emoji: "🏆", viewOther: false, publicSafe: true  },
];

const TAB_BY_KEY = new Map(TABS.map((t) => [t.key, t]));
const DEFAULT_TAB = "level";

function visibleTabs({ isSelf, ephemeral }) {
  return TABS.filter((t) => {
    if (!isSelf && !t.viewOther) return false;
    if (!ephemeral && !t.publicSafe) return false;
    return true;
  });
}

function canViewTab(tabKey, { isSelf, ephemeral }) {
  const tab = TAB_BY_KEY.get(tabKey);
  if (!tab) return false;
  if (!isSelf && !tab.viewOther) return false;
  if (!ephemeral && !tab.publicSafe) return false;
  return true;
}

// 非 publicSafe 的分頁必須強制 ephemeral；用於 /檔案 初次叫用時自動升級。
function mustForceEphemeral(tabKey) {
  const tab = TAB_BY_KEY.get(tabKey);
  return tab ? !tab.publicSafe : false;
}

module.exports = {
  TABS,
  TAB_BY_KEY,
  DEFAULT_TAB,
  visibleTabs,
  canViewTab,
  mustForceEphemeral,
};
