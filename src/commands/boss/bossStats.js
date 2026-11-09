require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { boss } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossPlayerStats = require("../../features/boss/bossPlayerStats");
const bossView = require("../../features/boss/bossView");

const SOURCES = ["scheduled", "summon", "manual"];

function hpMultFor(source) {
  if (source === "summon") return boss?.summon?.summonHpMult ?? 1;
  if (source === "scheduled") return boss?.saturdaySpawn?.hpMult ?? 1;
  return 1;
}

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("bossstats")
    .setDescription("[DEV] 魔王血量報表：下一場怎麼估、近期每場打了多少 📈")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("類型")
        .setDescription("要預估哪一種場次（預設週六固定場）")
        .addChoices(...SOURCES.map((v) => ({ name: boss?.sourceLabels?.[v] || v, value: v })))
        .setRequired(false),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const source = interaction.options.getString("類型") || "scheduled";
      const guildId = interaction.guildId;
      const scaled = await bossEngine.computeScaledHp(client, guildId, hpMultFor(source), source);
      const hits = bossEngine.baseAttackLimitFor({ spawn_source: source });
      const forecast = await bossPlayerStats.forecast(client, guildId, source, hits);
      const { fights } = await bossPlayerStats.recentFights(client, guildId, null, 5);
      return interaction.editReply({
        components: [
          bossView.buildBossStatsReportContainer({ guild: interaction.guild, source, scaled, forecast, fights }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (e) {
      console.log(`[BOSS] /bossstats 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          bossView.buildErrorContainer({ title: "❌ 報表產生失敗", body: "出了點狀況，請看 console。" }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  },
};
