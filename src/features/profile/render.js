// /檔案 dispatcher：永遠以本人、公開訊息呈現，按鈕只限本人切換分頁。
// customId 格式：pf|<tab>|<ownerUid>，handler 會比對 interaction.user.id === ownerUid。

require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");

const { TABS, TAB_BY_KEY } = require("./tabs");
const { buildLevelCardView } = require("./views/levelCard");
const { buildMinerProfileView } = require("./views/minerProfile");
const { buildWalletView } = require("./views/wallet");
const { buildCasinoStatsView } = require("./views/casinoStats");
const { buildAchievementsView } = require("./views/achievements");

const BUILDERS = {
  level: buildLevelCardView,
  miner: buildMinerProfileView,
  wallet: buildWalletView,
  casino: buildCasinoStatsView,
  achievements: buildAchievementsView,
};

const CUSTOM_ID_PREFIX = "pf|";

function buildCustomId(tabKey, ownerUid) {
  return `${CUSTOM_ID_PREFIX}${tabKey}|${ownerUid}`;
}

function parseCustomId(customId) {
  if (!customId || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const parts = customId.slice(CUSTOM_ID_PREFIX.length).split("|");
  if (parts.length !== 2) return null;
  const [tabKey, ownerUid] = parts;
  return { tabKey, ownerUid };
}

// 每列最多 5 顆按鈕,目前 5 個分頁剛好一列。
function buildNavRows({ activeTab, ownerUid }) {
  const rows = [];
  for (let i = 0; i < TABS.length; i += 5) {
    const slice = TABS.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      slice.map((t) =>
        new ButtonBuilder()
          .setCustomId(buildCustomId(t.key, ownerUid))
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

// 所有分頁統一用 Components V2 呈現。沒有 V2 components 的 view（例如錯誤
// 訊息只回傳 { content }）會在這裡自動包成 ContainerBuilder + TextDisplay，
// 避免訊息一旦帶上 IsComponentsV2 旗標就無法在 editReply 中拆掉的問題。
function wrapPayload(view, navRows) {
  let viewComponents = view.components;
  if (!viewComponents || viewComponents.length === 0) {
    const fallbackText = view.content || "—";
    viewComponents = [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(fallbackText)
      ),
    ];
  }
  return {
    components: [...viewComponents, ...navRows],
    files: view.files || [],
    flags: MessageFlags.IsComponentsV2,
  };
}

async function renderTab(client, { tabKey, target, member, guildId }) {
  const tab = TAB_BY_KEY.get(tabKey);
  if (!tab) {
    return wrapPayload({ content: "❌ 找不到該分頁" }, []);
  }

  const build = BUILDERS[tabKey];
  let view;
  try {
    view = await build(client, { target, member, guildId });
  } catch (error) {
    console.log(
      `[ERROR] /檔案 tab=${tabKey} build failed:\n${error}\n${error.stack}`
        .red
    );
    view = { content: "🔧 載入失敗，請稍後再試！" };
  }

  const navRows = buildNavRows({ activeTab: tabKey, ownerUid: target.id });
  return wrapPayload(view, navRows);
}

module.exports = {
  renderTab,
  buildCustomId,
  parseCustomId,
  CUSTOM_ID_PREFIX,
};
