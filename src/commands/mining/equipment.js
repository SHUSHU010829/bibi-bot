require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { mining } = require("../../config");
const workshopView = require("../../features/workshop/workshopView");

const CATEGORY_TO_TAB = {
  pickaxe: "craft",
  weapon: "craft",
  rod: "craft",
};

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("裝備")
    .setDescription("打開工坊：查看裝備、合成、修復都在這裡 🛠️")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("分頁")
        .setDescription("直接跳到指定分頁；不填則開「裝備」分頁")
        .setRequired(false)
        .addChoices(
          { name: "裝備", value: "equipment" },
          { name: "合成", value: "craft" },
          { name: "修復", value: "repair" },
        ),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const tab = interaction.options.getString("分頁") || "equipment";
      const view = await workshopView.buildView(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        displayName:
          interaction.member?.displayName ||
          interaction.user.displayName ||
          interaction.user.username,
        tab,
      });
      await interaction.editReply(view);
    } catch (error) {
      console.log(`[ERROR] /裝備:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 開工坊失敗，請呼叫舒舒！").catch(() => {});
    }
  },

  CATEGORY_TO_TAB,
};
