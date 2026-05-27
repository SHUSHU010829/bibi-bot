const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { getCatalog, getCategories } = require("./catalog");
const { MONEY_EMOJI } = require("../../constants/coin");

const PAGE_SIZE = 5;

const CATEGORY_EMOJI = {
  顏色身份組: "🎨",
  加成藥水: "🧪",
  卡面風格: "🎴",
  自訂稱號: "🪪",
  挖礦道具: "⛏️",
};

// 每件商品在清單上顯示的「效期 / 數量」提示。
function itemMeta(item) {
  if (item.type === "wallet_theme" || item.type === "mining_backpack") return "永久";
  if (item.durationDays) return `${item.durationDays} 天`;
  const m = item.payload?.durationMinutes;
  if (m) {
    if (m % 1440 === 0) return `${m / 1440} 天`;
    if (m % 60 === 0) return `${m / 60} 小時`;
    return `${m} 分鐘`;
  }
  if (item.type === "mining_luck_potion") return `${item.payload?.uses || 0} 次`;
  return null;
}

function getItemsByCategory(catIndex) {
  const cats = getCategories();
  const cat = cats[catIndex];
  if (!cat) return { cat: null, items: [] };
  return { cat, items: getCatalog().filter((i) => i.category === cat) };
}

// 組出商店面板（公開、可翻頁、每件商品一顆購買鈕）。catIndex / page 皆會被夾在合法範圍內。
function buildShopView(catIndex = 0, page = 0) {
  const cats = getCategories();
  if (!Number.isInteger(catIndex) || catIndex < 0 || catIndex >= cats.length) {
    catIndex = 0;
  }
  const { cat, items } = getItemsByCategory(catIndex);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (!Number.isInteger(page) || page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const start = page * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  const catEmoji = CATEGORY_EMOJI[cat] || "🛒";

  const embed = new EmbedBuilder()
    .setColor(0xffd166)
    .setTitle(`🛒 商店 — ${catEmoji} ${cat || ""}`)
    .setFooter({ text: `第 ${page + 1} / ${totalPages} 頁 ・ 點下方按鈕直接購買` });

  if (pageItems.length === 0) {
    embed.setDescription("這個分類目前沒有商品。");
  } else {
    embed.setDescription(
      pageItems
        .map((it) => {
          const meta = itemMeta(it);
          const head = `**${it.name}** — **${it.price.toLocaleString()}** ${MONEY_EMOJI}${meta ? `（${meta}）` : ""}`;
          return `${head}\n${it.description}`;
        })
        .join("\n\n")
    );
  }

  const components = [];

  // 分類下拉選單（取代分頁標籤）
  const catSelect = new StringSelectMenuBuilder()
    .setCustomId("shop_cat")
    .setPlaceholder("切換分類…")
    .addOptions(
      cats.slice(0, 25).map((c, idx) => ({
        label: `${CATEGORY_EMOJI[c] || "🛒"} ${c}`.slice(0, 100),
        value: String(idx),
        default: idx === catIndex,
      }))
    );
  components.push(new ActionRowBuilder().addComponents(catSelect));

  // 每件商品一顆購買鈕
  if (pageItems.length > 0) {
    const buyRow = new ActionRowBuilder();
    for (const it of pageItems) {
      buyRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_buy_${it.id}`)
          .setLabel(it.name.slice(0, 25))
          .setEmoji("🛒")
          .setStyle(ButtonStyle.Success)
      );
    }
    components.push(buyRow);
  }

  // 分頁列（action 寫進 customId 確保唯一，目標頁由處理器計算後交給本函式夾範圍）
  const nav = (action, emoji, disabled, style = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`shop_nav_${catIndex}_${page}_${action}`)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  components.push(
    new ActionRowBuilder().addComponents(
      nav("first", "⏮️", page === 0),
      nav("prev", "◀️", page === 0),
      nav("refresh", "🔄", false, ButtonStyle.Primary),
      nav("next", "▶️", page >= totalPages - 1),
      nav("last", "⏭️", page >= totalPages - 1)
    )
  );

  return { embeds: [embed], components };
}

module.exports = { buildShopView, getItemsByCategory, PAGE_SIZE };
