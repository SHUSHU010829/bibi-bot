require("colors");

const { SlashCommandBuilder } = require("discord.js");

const {
  CATEGORY_CHOICES,
} = require("../../constants/foodCategories");

const listHandler = require("../../features/food/handlers/list");
const rankingHandler = require("../../features/food/handlers/ranking");
const storesHandler = require("../../features/food/handlers/stores");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("美食圖鑑")
    .setDescription("食物與飲料：清單、排行榜、飲料店 🍽️")
    .addSubcommand((sub) =>
      sub
        .setName("清單")
        .setDescription("查看現在食物列表... 📚")
        .addStringOption((option) =>
          option
            .setName("類別")
            .setDescription("選擇要查看的食物類別（不選則顯示所有）")
            .addChoices(...CATEGORY_CHOICES)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("排行榜")
        .setDescription("查看最受歡迎的食物排行榜 🏆")
        .addStringOption((option) =>
          option
            .setName("類別")
            .setDescription("選擇要查看的食物類別（不選則顯示總排行）")
            .addChoices(...CATEGORY_CHOICES)
        )
        .addIntegerOption((option) =>
          option
            .setName("數量")
            .setDescription("顯示前幾名（預設：10，最多：20）")
            .setMinValue(5)
            .setMaxValue(20)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("飲料店").setDescription("查看所有可用的飲料店清單 🥤")
    ),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "清單":
        return listHandler.run(client, interaction);
      case "排行榜":
        return rankingHandler.run(client, interaction);
      case "飲料店":
        return storesHandler.run(client, interaction);
    }
  },
};
