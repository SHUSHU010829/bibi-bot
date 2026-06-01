const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
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
  釣魚道具: "🎣",
};

// 顏色身份組：每件商品各自一個 Container，accent 即為顏色預覽
function buildColorCategoryView(catIndex, cat, items, page, totalPages, cats) {
  const start = page * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  const catEmoji = CATEGORY_EMOJI[cat] || "🛒";
  const components = [];

  const headerContainer = new ContainerBuilder().setAccentColor(0xffd166);
  headerContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🛒 商店 — ${catEmoji} ${cat || ""}\n-# 左側色條即為顏色預覽`
    )
  );
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
  headerContainer.addActionRowComponents(new ActionRowBuilder().addComponents(catSelect));
  components.push(headerContainer);

  if (pageItems.length === 0) {
    const empty = new ContainerBuilder().setAccentColor(0xffd166);
    empty.addTextDisplayComponents(new TextDisplayBuilder().setContent("這個分類目前沒有商品。"));
    components.push(empty);
  } else {
    for (const it of pageItems) {
      const hex = it.payload?.hex;
      const colorInt = hex ? parseInt(hex.replace("#", ""), 16) : 0x7289da;
      const meta = itemMeta(it);
      const head = `**${it.name}** — **${it.price.toLocaleString()}** ${MONEY_EMOJI}${meta ? `（${meta}）` : ""}`;
      let desc = it.description;
      if (hex) {
        desc += `\n-# 🎨 色碼：\`${hex}\``;
      } else if (it.type === "role_color_custom") {
        desc += "\n-# 🎨 購買後可輸入任意 HEX 色碼（如 \`#FF5733\`）";
      }

      const itemContainer = new ContainerBuilder().setAccentColor(colorInt);
      itemContainer.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${head}\n${desc}`))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`shop_buy_${it.id}`)
              .setLabel("購買")
              .setEmoji("🛒")
              .setStyle(ButtonStyle.Success)
          )
      );
      components.push(itemContainer);
    }
  }

  const footerContainer = new ContainerBuilder().setAccentColor(0xffd166);
  footerContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# 第 ${page + 1} / ${totalPages} 頁`)
  );
  const nav = (action, emoji, disabled, style = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`shop_nav_${catIndex}_${page}_${action}`)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);
  footerContainer.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      nav("first", "⏮️", page === 0),
      nav("prev", "◀️", page === 0),
      nav("refresh", "🔄", false, ButtonStyle.Primary),
      nav("next", "▶️", page >= totalPages - 1),
      nav("last", "⏭️", page >= totalPages - 1)
    )
  );
  components.push(footerContainer);

  return { components, flags: MessageFlags.IsComponentsV2 };
}

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
  if (item.type === "mining_stamina_potion") return `+${item.payload?.restore || 0} 體力`;
  return null;
}

function getItemsByCategory(catIndex) {
  const cats = getCategories();
  const cat = cats[catIndex];
  if (!cat) return { cat: null, items: [] };
  return { cat, items: getCatalog().filter((i) => i.category === cat) };
}

// 組出商店面板（Components V2：公開、可翻頁、每件商品一個區塊 + 購買鈕配件）。
// catIndex / page 皆會被夾在合法範圍內。
function buildShopView(catIndex = 0, page = 0) {
  const cats = getCategories();
  if (!Number.isInteger(catIndex) || catIndex < 0 || catIndex >= cats.length) {
    catIndex = 0;
  }
  const { cat, items } = getItemsByCategory(catIndex);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (!Number.isInteger(page) || page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  // 顏色身份組：每件各自一個 Container + accent 色預覽
  if (cat === "顏色身份組") {
    return buildColorCategoryView(catIndex, cat, items, page, totalPages, cats);
  }

  const start = page * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  const catEmoji = CATEGORY_EMOJI[cat] || "🛒";

  const container = new ContainerBuilder().setAccentColor(0xffd166);

  // 標題
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🛒 商店 — ${catEmoji} ${cat || ""}\n-# 點商品右側的「購買」按鈕，會先跳出確認再扣款`
    )
  );

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
  container.addActionRowComponents(new ActionRowBuilder().addComponents(catSelect));

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // 每件商品一個區塊：左側文字 + 右側購買鈕
  if (pageItems.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("這個分類目前沒有商品。")
    );
  } else {
    pageItems.forEach((it, idx) => {
      const meta = itemMeta(it);
      const head = `**${it.name}** — **${it.price.toLocaleString()}** ${MONEY_EMOJI}${meta ? `（${meta}）` : ""}`;
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`${head}\n${it.description}`)
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`shop_buy_${it.id}`)
              .setLabel("購買")
              .setEmoji("🛒")
              .setStyle(ButtonStyle.Success)
          )
      );
      if (idx < pageItems.length - 1) {
        container.addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
        );
      }
    });
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // 頁碼資訊
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# 第 ${page + 1} / ${totalPages} 頁`)
  );

  // 分頁列（action 寫進 customId 確保唯一，目標頁由處理器計算後交給本函式夾範圍）
  const nav = (action, emoji, disabled, style = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`shop_nav_${catIndex}_${page}_${action}`)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      nav("first", "⏮️", page === 0),
      nav("prev", "◀️", page === 0),
      nav("refresh", "🔄", false, ButtonStyle.Primary),
      nav("next", "▶️", page >= totalPages - 1),
      nav("last", "⏭️", page >= totalPages - 1)
    )
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = { buildShopView, getItemsByCategory, PAGE_SIZE };
