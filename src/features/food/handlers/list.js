require("colors");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require("discord.js");

const { CATEGORY_DISPLAY } = require("../../../constants/foodCategories");

const PAGE_TEXT_LIMIT = 3500;
const ITEMS_PER_PAGE = 50;
const PAGINATION_TIMEOUT = 5 * 60 * 1000;
const ACCENT_COLOR = 0x00ae86;

function paginateArray(array, itemsPerPage) {
  const pages = [];
  for (let i = 0; i < array.length; i += itemsPerPage) {
    pages.push(array.slice(i, i + itemsPerPage));
  }
  return pages;
}

function createPaginationButtons(currentPage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("first")
      .setLabel("⏮️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("prev")
      .setLabel("◀️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("page_info")
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("next")
      .setLabel("▶️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages - 1),
    new ButtonBuilder()
      .setCustomId("last")
      .setLabel("⏭️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages - 1)
  );
}

function createCategoryPages(category, foodList) {
  const pages = [];

  if (category === "beverage") {
    const byStore = {};
    foodList.forEach((food) => {
      const store = food.beverageStore || "其他";
      (byStore[store] = byStore[store] || []).push(food.name);
    });

    let current = "";
    for (const [store, items] of Object.entries(byStore)) {
      const block = `**${store}**：${items.join(", ")}`;
      if (current && current.length + block.length + 1 > PAGE_TEXT_LIMIT) {
        pages.push(current);
        current = block;
      } else {
        current = current ? `${current}\n${block}` : block;
      }
    }
    if (current) pages.push(current);
  } else {
    const itemPages = paginateArray(foodList, ITEMS_PER_PAGE);
    itemPages.forEach((items) => {
      pages.push(items.map((f) => f.name).join(", "));
    });
  }

  return pages.length > 0 ? pages : ["（無資料）"];
}

function createAllCategoriesPages(categorizedFood) {
  const order = [
    "breakfast",
    "lunch",
    "dinner",
    "snack",
    "beverage",
    "uncategorized",
  ];

  const blocks = [];
  for (const cat of order) {
    const foods = categorizedFood[cat];
    if (!foods || foods.length === 0) continue;

    const heading =
      cat === "uncategorized"
        ? "**⚠️ 未分類（舊資料）**"
        : `**${CATEGORY_DISPLAY[cat] || cat}**`;

    if (cat === "beverage") {
      const byStore = {};
      foods.forEach((f) => {
        const store = f.beverageStore || "其他";
        (byStore[store] = byStore[store] || []).push(f.name);
      });
      const storeText = Object.entries(byStore)
        .map(([s, items]) => `**${s}**：${items.join(", ")}`)
        .join("\n");
      blocks.push(`${heading}\n${storeText}`);
    } else {
      blocks.push(`${heading}\n${foods.map((f) => f.name).join(", ")}`);
    }
  }

  const pages = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > PAGE_TEXT_LIMIT) {
      pages.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) pages.push(current);

  return pages.length > 0 ? pages : ["目前沒有可供選擇的食物選項。"];
}

function buildPageContainer({
  headerTitle,
  pages,
  currentPage,
  withControls = true,
  uncategorizedNotice = null,
}) {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerTitle),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(pages[currentPage]),
    );

  if (uncategorizedNotice) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${uncategorizedNotice}`),
      );
  }

  if (pages.length > 1) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 第 ${currentPage + 1} / ${pages.length} 頁`,
        ),
      );
    if (withControls) {
      container.addActionRowComponents(
        createPaginationButtons(currentPage, pages.length),
      );
    }
  }

  return container;
}

async function run(client, interaction) {
  const collection = client.collection;
  const category = interaction.options.getString("類別");

  await interaction.deferReply();

  try {
    const query = category ? { category } : {};
    const foodList = await collection.find(query).toArray();

    if (foodList.length === 0) {
      const msg = category
        ? `目前沒有 ${CATEGORY_DISPLAY[category]} 選項。`
        : "目前沒有可供選擇的食物選項。";
      await interaction.editReply(msg);
      return;
    }

    let headerTitle;
    let pages;
    let uncategorizedNotice = null;

    if (category) {
      headerTitle = `## 📚 ${CATEGORY_DISPLAY[category]} 選項`;
      pages = createCategoryPages(category, foodList);
    } else {
      const categorized = {
        breakfast: [],
        lunch: [],
        dinner: [],
        snack: [],
        beverage: [],
        uncategorized: [],
      };
      foodList.forEach((food) => {
        if (food.category && categorized[food.category]) {
          categorized[food.category].push(food);
        } else if (!food.category) {
          categorized.uncategorized.push(food);
        }
      });

      headerTitle = "## 📚 食物清單";
      pages = createAllCategoriesPages(categorized);
      if (categorized.uncategorized.length > 0) {
        uncategorizedNotice = `發現 ${categorized.uncategorized.length} 筆未分類的舊資料，請執行遷移腳本：node scripts/migrateFoodData.js`;
      }
    }

    let currentPage = 0;
    const message = await interaction.editReply({
      components: [
        buildPageContainer({
          headerTitle,
          pages,
          currentPage,
          uncategorizedNotice,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

    if (pages.length <= 1) return;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: PAGINATION_TIMEOUT,
    });

    collector.on("collect", async (btnInteraction) => {
      if (btnInteraction.user.id !== interaction.user.id) {
        return btnInteraction.reply({
          content:
            "這不是你的清單！請使用 /美食圖鑑 清單 查看你自己的清單。",
          flags: MessageFlags.Ephemeral,
        });
      }

      switch (btnInteraction.customId) {
        case "first":
          currentPage = 0;
          break;
        case "prev":
          currentPage = Math.max(0, currentPage - 1);
          break;
        case "next":
          currentPage = Math.min(pages.length - 1, currentPage + 1);
          break;
        case "last":
          currentPage = pages.length - 1;
          break;
      }

      await btnInteraction.update({
        components: [
          buildPageContainer({
            headerTitle,
            pages,
            currentPage,
            uncategorizedNotice,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    });

    collector.on("end", () => {
      interaction
        .editReply({
          components: [
            buildPageContainer({
              headerTitle,
              pages,
              currentPage,
              uncategorizedNotice,
              withControls: false,
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    });
  } catch (error) {
    console.log(
      `[ERROR] An error occurred inside the food list:\n${error}`.red
    );
    await interaction
      .editReply("🔧 獲取食物清單失敗，請呼叫舒舒！")
      .catch(() => {});
  }
}

module.exports = { run };
