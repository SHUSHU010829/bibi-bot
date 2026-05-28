// /檔案 分頁 dispatcher：根據選定 tab 呼叫對應 view builder，
// 並接上分頁切換按鈕（最多 5 顆／列，必要時拆兩列）。

require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { TABS, TAB_BY_KEY, visibleTabs } = require("./tabs");
const { buildLevelCardView } = require("./views/levelCard");
const { buildMinerProfileView } = require("./views/minerProfile");
const { buildWalletView } = require("./views/wallet");
const { buildBackpackView } = require("./views/backpack");
const { buildCasinoStatsView } = require("./views/casinoStats");
const { buildStockHoldingsView } = require("./views/stockHoldings");
const { buildAchievementsView } = require("./views/achievements");

const BUILDERS = {
  level: buildLevelCardView,
  miner: buildMinerProfileView,
  wallet: buildWalletView,
  backpack: buildBackpackView,
  casino: buildCasinoStatsView,
  stock: buildStockHoldingsView,
  achievements: buildAchievementsView,
};

// customId 格式：pf|<tab>|<targetUid>|<eph>
// - eph: "1"=ephemeral, "0"=public
// 限制 100 字內（Discord 規定），上限 ~60 chars 綽綽有餘。
const CUSTOM_ID_PREFIX = "pf|";

function buildCustomId(tabKey, targetUid, ephemeral) {
  return `${CUSTOM_ID_PREFIX}${tabKey}|${targetUid}|${ephemeral ? "1" : "0"}`;
}

function parseCustomId(customId) {
  if (!customId || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const parts = customId.slice(CUSTOM_ID_PREFIX.length).split("|");
  if (parts.length !== 3) return null;
  const [tabKey, targetUid, ephFlag] = parts;
  return { tabKey, targetUid, ephemeral: ephFlag === "1" };
}

// 依當前可見的分頁與 active tab 渲染按鈕列；最多 5 顆／列。
function buildNavRows({ activeTab, targetUid, ephemeral, isSelf }) {
  const tabs = visibleTabs({ isSelf, ephemeral });
  if (tabs.length <= 1) return []; // 只剩自己這頁就不渲染導覽列

  const rows = [];
  for (let i = 0; i < tabs.length; i += 5) {
    const slice = tabs.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      slice.map((t) =>
        new ButtonBuilder()
          .setCustomId(buildCustomId(t.key, targetUid, ephemeral))
          .setLabel(t.label)
          .setEmoji(t.emoji)
          .setStyle(
            t.key === activeTab ? ButtonStyle.Primary : ButtonStyle.Secondary
          )
          .setDisabled(t.key === activeTab)
      )
    );
    rows.push(row);
  }
  return rows;
}

// 把 view 包成可直接送出的 payload（merge 導覽列、Ephemeral flag）
function wrapPayload(view, navRows, ephemeral) {
  const useV2 = !!view.useV2;
  const components = [...(view.components || []), ...navRows];
  const baseFlags = useV2 ? MessageFlags.IsComponentsV2 : 0;
  const flags = baseFlags | (ephemeral ? MessageFlags.Ephemeral : 0);

  // V2 模式禁止 embeds；classic 模式禁止 V2 layout components
  // 都 default 為空陣列以便編輯訊息時清掉前一頁殘留
  return {
    content: view.content || "",
    embeds: useV2 ? [] : view.embeds || [],
    components,
    files: view.files || [],
    flags,
  };
}

async function renderTab(
  client,
  { tabKey, target, viewer, member, guildId, ephemeral, options = {} }
) {
  const tab = TAB_BY_KEY.get(tabKey);
  if (!tab) {
    return wrapPayload({ content: "❌ 找不到該分頁" }, [], ephemeral);
  }

  const isSelf = target.id === viewer.id;

  // 權限：viewOther / publicSafe
  if (!isSelf && !tab.viewOther) {
    return wrapPayload(
      { content: "🔒 這個分頁只能查看自己的資料" },
      buildNavRows({
        activeTab: tabKey,
        targetUid: target.id,
        ephemeral,
        isSelf,
      }),
      ephemeral
    );
  }
  if (!ephemeral && !tab.publicSafe) {
    return wrapPayload(
      {
        content:
          "🔒 這個分頁僅限私密模式查看，請重新呼叫 `/檔案 私密:True 分頁:" +
          tab.label +
          "`",
      },
      buildNavRows({
        activeTab: tabKey,
        targetUid: target.id,
        ephemeral,
        isSelf,
      }),
      ephemeral
    );
  }

  const build = BUILDERS[tabKey];
  let view;
  try {
    view = await build(client, { target, member, guildId, ...options });
  } catch (error) {
    console.log(
      `[ERROR] /檔案 tab=${tabKey} build failed:\n${error}\n${error.stack}`
        .red
    );
    view = { content: "🔧 載入失敗，請稍後再試！" };
  }

  const navRows = buildNavRows({
    activeTab: tabKey,
    targetUid: target.id,
    ephemeral,
    isSelf,
  });

  return wrapPayload(view, navRows, ephemeral);
}

module.exports = {
  renderTab,
  buildCustomId,
  parseCustomId,
  CUSTOM_ID_PREFIX,
};
