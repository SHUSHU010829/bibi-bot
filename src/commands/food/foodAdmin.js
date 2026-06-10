require("colors");

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
} = require("discord.js");

const {
  CATEGORY_CHOICES,
} = require("../../constants/foodCategories");

const addHandler = require("../../features/food/handlers/add");
const batchHandler = require("../../features/food/handlers/batch");
const importHandler = require("../../features/food/handlers/import");
const deleteHandler = require("../../features/food/handlers/delete");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("food-admin")
    .setDescription("[ADMIN] 食物資料管理（新增/批次/匯入/刪除）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("擴增食物列表")
        .addStringOption((option) =>
          option
            .setName("食物名稱")
            .setDescription("新增食物的名稱")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("類別")
            .setDescription("選擇食物類別")
            .setRequired(true)
            .addChoices(...CATEGORY_CHOICES)
        )
        .addStringOption((option) =>
          option
            .setName("飲料店")
            .setDescription("飲料店名稱（僅在類別為飲料時需要填寫）")
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("batch")
        .setDescription("一次新增多個食物（用逗號分隔）")
        .addStringOption((option) =>
          option
            .setName("食物清單")
            .setDescription("食物名稱，用逗號分隔（例如：蛋餅,三明治,漢堡）")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("類別")
            .setDescription("選擇食物類別")
            .setRequired(true)
            .addChoices(...CATEGORY_CHOICES)
        )
        .addStringOption((option) =>
          option
            .setName("飲料店")
            .setDescription("飲料店名稱（僅在類別為飲料時需要填寫）")
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("import")
        .setDescription("快速匯入整個飲料店的菜單（支援大量品項）🥤")
        .addStringOption((option) =>
          option
            .setName("飲料店")
            .setDescription("飲料店名稱（例如：可不可紅茶）")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName("菜單")
            .setDescription("每行一個品項，或用逗號/分號分隔")
            .setRequired(true)
        )
        .addBooleanOption((option) =>
          option
            .setName("覆蓋現有")
            .setDescription("是否刪除該店現有菜單後重新匯入（預設：否）")
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("刪除既有食物項目")
        .addStringOption((option) =>
          option
            .setName("食物名稱")
            .setDescription(
              "Name of the food to delete (use /美食圖鑑 清單 to look up names)"
            )
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName("類別")
            .setDescription("Pick a food category (specify when the name is ambiguous)")
            .addChoices(...CATEGORY_CHOICES)
        )
        .addStringOption((option) =>
          option
            .setName("飲料店")
            .setDescription("Beverage store name (required only when category is beverage)")
            .setAutocomplete(true)
        )
    ),

  autocomplete: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "add":
        return addHandler.autocomplete(client, interaction);
      case "batch":
        return batchHandler.autocomplete(client, interaction);
      case "import":
        return importHandler.autocomplete(client, interaction);
      case "delete":
        return deleteHandler.autocomplete(client, interaction);
    }
    return interaction.respond([]).catch(() => {});
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "add":
        return addHandler.run(client, interaction);
      case "batch":
        return batchHandler.run(client, interaction);
      case "import":
        return importHandler.run(client, interaction);
      case "delete":
        return deleteHandler.run(client, interaction);
    }
  },
};
