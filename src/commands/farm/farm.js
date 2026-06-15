require("colors");
const {
  MessageFlags,
  InteractionContextType,
  ApplicationCommandOptionType,
} = require("discord.js");

const { farming } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const farmService = require("../../features/farm/farmService");
const { buildFarmContainer } = require("../../features/farm/farmView");
const { resolveStamina, staminaMax, getMemberClub } = require("../../features/mining/dungeonService");
const worldEventBuffs = require("../../features/world_event/worldEventBuffs");
const { getFoodFarmYieldBonus } = require("../../features/fishing/cookService");

const harvestCmd = require("./harvest");
const fertilizeCmd = require("./fertilize");

// 把獨立指令模組的 builder 轉成 /農場 底下的 subcommand
function toSubcommand(mod) {
  const json = typeof mod.data.toJSON === "function" ? mod.data.toJSON() : mod.data;
  return {
    type: ApplicationCommandOptionType.Subcommand,
    name: json.name,
    description: json.description,
    options: json.options || [],
  };
}

module.exports = {
  data: {
    name: "農場",
    description: "農場：查看狀態、收成、施肥 🌾",
    contexts: [InteractionContextType.Guild],
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "查看",
        description: "查看你的農場狀態 🌾",
        options: [],
      },
      toSubcommand(harvestCmd),
      toSubcommand(fertilizeCmd),
    ],
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "收成") return harvestCmd.run(client, interaction);
    if (sub === "施肥") return fertilizeCmd.run(client, interaction);

    await interaction.deferReply();
    try {
      if (!farming?.enabled) return interaction.editReply("🔧 農場系統尚未啟動！");

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const profile = await getOrCreate(client, userId, guildId);
      const plotCount = farmService.getPlotCount(profile);
      let plots = await farmService.getPlots(client, userId, guildId, plotCount);

      // 隨機觸發 raid（種下後超過 minElapsedMs 即可能，無論成熟與否）；
      // 高級陷阱優先抵擋，剩餘次數歸 0 後才會 markRaid。
      let trapBlocksRemaining = profile.advanced_trap_uses || 0;
      let trapBlocksUsedThisOpen = 0;
      for (const p of plots) {
        if (farmService.shouldTriggerRaid(p) && !p.raid?.active) {
          if (trapBlocksRemaining > 0) {
            trapBlocksRemaining -= 1;
            trapBlocksUsedThisOpen += 1;
            continue;
          }
          const raid = await farmService.markRaid(client, {
            userId, guildId, plotIndex: p.plotIndex, fromStatus: p.status,
          });
          if (raid) {
            p.status = "raided";
            p.raid = raid;
          }
        }
      }
      if (trapBlocksUsedThisOpen > 0) {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId },
          { $inc: { advanced_trap_uses: -trapBlocksUsedThisOpen }, $set: { updatedAt: new Date() } },
        );
      }

      const club = await getMemberClub(client, interaction.user.id, interaction.guildId);
      const sMax = staminaMax(interaction.member, club);
      const stamina = resolveStamina(profile, sMax).stamina;

      const worldYieldPct = (worldEventBuffs.getCachedBuffs().farm_yield_pct || 0) / 100;
      const foodYieldPct = getFoodFarmYieldBonus(profile);

      const container = buildFarmContainer({
        plots,
        userId,
        plotCount,
        maxPlots: farming.maxPlots || 8,
        stamina,
        trapBlocksRemaining,
        trapBlocksUsedThisOpen,
        foodYieldPct,
        worldYieldPct,
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
