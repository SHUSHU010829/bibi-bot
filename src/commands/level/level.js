require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");

const cardThemeHandler = require("../../features/level/handlers/cardTheme");

// 注意：/level 的多數子指令已遷移至：
//   - /level profile / title / displaybadges → /檔案、/稱號
//   - /level badges → /檔案 分頁:成就
//   - /level rank → /排行榜（類別:等級）
// 只剩 /level cardtheme，後續會併入商店再移除。

module.exports = {
  data: new SlashCommandBuilder()
    .setName("level")
    .setDescription("等級系統：卡面主題 🎨")
    .setContexts(InteractionContextType.Guild)
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
    if (sub === "cardtheme") {
      return cardThemeHandler.run(client, interaction);
    }
  },
};
