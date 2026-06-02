require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { farming } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const farmService = require("../../features/farm/farmService");
const { buildFarmContainer } = require("../../features/farm/farmView");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("農場")
    .setDescription("查看你的農場狀態 🌾")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      if (!farming?.enabled) return interaction.editReply("🔧 農場系統尚未啟動！");

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const profile = await getOrCreate(client, userId, guildId);
      const plotCount = farmService.getPlotCount(profile);
      let plots = await farmService.getPlots(client, userId, guildId, plotCount);

      // 隨機觸發 raid（種下後超過 minElapsedMs 即可能，無論成熟與否）
      for (const p of plots) {
        if (farmService.shouldTriggerRaid(p) && !p.raid?.active) {
          const raid = await farmService.markRaid(client, {
            userId, guildId, plotIndex: p.plotIndex, fromStatus: p.status,
          });
          if (raid) {
            p.status = "raided";
            p.raid = raid;
          }
        }
      }

      const container = buildFarmContainer({
        plots,
        userId,
        plotCount,
        maxPlots: farming.maxPlots || 8,
      });

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /農場:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 農場讀取失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
