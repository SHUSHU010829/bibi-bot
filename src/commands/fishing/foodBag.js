require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { fishing } = require("../../config");
const foodBag = require("../../features/fishing/foodBag");
const foodBagView = require("../../features/fishing/foodBagView");
const { getOrCreate: getMiningProfile } = require("../../features/mining/miningProfile");
const { appendNav } = require("../../features/playerStatus/statusNav");

module.exports = {
  ephemeral: true,
  channelBuckets: ["fishing", "farm"],
  data: new SlashCommandBuilder()
    .setName("食物")
    .setDescription("打開食物倉庫，查看囤的料理 + 食用 🥡")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    try {
      if (!fishing?.enabled || !client.miningProfilesCollection) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply("🔧 釣魚／烹飪系統尚未啟動！");
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const profilePre = await getMiningProfile(client, userId, guildId);
      const sweepInfo = await foodBag.sweepSpoiled(client, userId, guildId, profilePre);
      const profile = sweepInfo.removed > 0
        ? await getMiningProfile(client, userId, guildId)
        : profilePre;

      const view = foodBagView.buildBagView({ userId, profile, sweepInfo });
      appendNav(view, userId, "food");
      await interaction.editReply(view);
    } catch (error) {
      console.log(`[ERROR] /食物:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 食物倉庫查詢失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
