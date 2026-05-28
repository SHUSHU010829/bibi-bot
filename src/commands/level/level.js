require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");

const rankHandler = require("../../features/level/handlers/rank");
const badgesHandler = require("../../features/level/handlers/badges");
const cardThemeHandler = require("../../features/level/handlers/cardTheme");

// 注意：/level profile、/level title、/level displaybadges 已遷移至
//   /檔案、/稱號 設定、/稱號 展示徽章 / 重置展示。
//   /level rank、/level badges、/level cardtheme 後續會分別併入
//   /排行榜、/成就、商店，這裡先保留。

module.exports = {
  data: new SlashCommandBuilder()
    .setName("level")
    .setDescription("等級系統：排行榜、徽章圖鑑、卡面主題 🏅")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName("rank").setDescription("查看伺服器等級排行榜 🏆")
    )
    .addSubcommand((sub) =>
      sub.setName("badges").setDescription("查看你的徽章圖鑑 🏅")
    )
    .addSubcommand((sub) =>
      sub
        .setName("cardtheme")
        .setDescription("設定你的等級卡顏色主題 🎨")
        .addStringOption((opt) =>
          opt
            .setName("主題")
            .setDescription("選擇主題")
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),

  autocomplete: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);

    if (sub === "cardtheme" && focused.name === "主題") {
      return cardThemeHandler.autocomplete(client, interaction);
    }
    return interaction.respond([]).catch(() => {});
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "rank":
        return rankHandler.run(client, interaction);
      case "badges":
        return badgesHandler.run(client, interaction);
      case "cardtheme":
        return cardThemeHandler.run(client, interaction);
    }
  },
};
