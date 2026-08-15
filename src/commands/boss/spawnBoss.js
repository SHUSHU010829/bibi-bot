require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { boss } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossView = require("../../features/boss/bossView");
const bossAnnouncer = require("../../features/boss/bossAnnouncer");

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("spawnboss")
    .setDescription("[DEV] 立刻召喚一隻 BOSS ⚔️")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o.setName("名字").setDescription("BOSS 名稱（預設使用 saturdaySpawn 設定）").setRequired(false),
    )
    .addStringOption((o) =>
      o.setName("emoji").setDescription("BOSS emoji").setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("血量")
        .setDescription("自訂血量（不填會依預估參戰人數 × 社群平均戰力計算）")
        .setMinValue(1)
        .setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("持續分鐘")
        .setDescription(`戰鬥持續分鐘數（預設 ${boss?.durationMinutes ?? 30}）`)
        .setMinValue(1)
        .setMaxValue(720)
        .setRequired(false),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!boss?.enabled) {
        return interaction.editReply({
          components: [
            bossView.buildErrorContainer({
              title: "🔧 BOSS 系統未啟用",
              body: "目前還沒辦法召喚 BOSS。",
            }),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      const name = interaction.options.getString("名字") || undefined;
      const emoji = interaction.options.getString("emoji") || undefined;
      const hp = interaction.options.getInteger("血量") ?? undefined;
      const durationMinutes = interaction.options.getInteger("持續分鐘");
      const durationMs = durationMinutes != null ? durationMinutes * 60 * 1000 : undefined;

      const res = await bossEngine.spawnBoss(client, {
        guildId: interaction.guildId,
        name,
        emoji,
        hp,
        durationMs,
      });

      if (!res.ok) {
        if (res.reason === "already_active") {
          return interaction.editReply({
            components: [
              bossView.buildErrorContainer({
                title: "⚔️ 已有 BOSS 在場",
                body: `**${res.boss.emoji} ${res.boss.name}** 仍在進行中（HP ${(res.boss.current_hp ?? 0).toLocaleString()}/${(res.boss.max_hp ?? 0).toLocaleString()}）。`,
                hint: "等這場結算後才能再召喚",
              }),
            ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
        }
        return interaction.editReply({
          components: [
            bossView.buildErrorContainer({
              title: "❌ 召喚失敗",
              body: `原因：\`${res.reason}\``,
            }),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      bossAnnouncer.announceSpawn(client, res.boss).catch((e) =>
        console.log(`[BOSS] announceSpawn failed: ${e.message}`.red),
      );

      console.log(
        `[BOSS] manual spawn by ${interaction.user.id}: ${res.boss.boss_id} hp=${res.boss.max_hp}`.cyan,
      );

      return interaction.editReply({
        content: `✅ 已召喚 ${res.boss.emoji} **${res.boss.name}**（HP ${res.boss.max_hp.toLocaleString()}）`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      console.log(`[BOSS] /spawnboss 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          bossView.buildErrorContainer({
            title: "❌ 召喚失敗",
            body: "出了點狀況，請看 console。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
  },
};
