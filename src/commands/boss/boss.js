require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { boss } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossView = require("../../features/boss/bossView");

async function runInfo(client, interaction) {
  if (!boss?.enabled) {
    return interaction.editReply({
      components: [
        bossView.buildErrorContainer({
          title: "🔧 BOSS 系統未啟用",
          body: "目前還沒有 BOSS 戰可以查看。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const info = await bossEngine.getBossInfo(client, interaction.guildId);
  if (!info.ok) {
    return interaction.editReply({
      components: [
        bossView.buildErrorContainer({
          title: "🌙 沒有正在進行的 BOSS 戰",
          body: "下一場 BOSS 預計在 **週六 21:00** 出現。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const container = bossView.buildInfoContainer({
    userId: interaction.user.id,
    boss: info.boss,
    ranking: info.ranking,
    totalDamage: info.totalDamage,
    comboActive: info.comboActive,
  });
  return interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("boss")
    .setDescription("查看當前 BOSS 戰況 📊")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      return await runInfo(client, interaction);
    } catch (e) {
      console.log(`[BOSS] /boss 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          bossView.buildErrorContainer({
            title: "❌ 查詢失敗",
            body: "出了點狀況，請稍後再試。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  },

  runInfo,
};
