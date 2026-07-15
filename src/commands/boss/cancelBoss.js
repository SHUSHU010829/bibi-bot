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

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("clearboss")
    .setDescription("[DEV] 強制中止當前 BOSS（不結算、不發獎）🧹")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const active = await bossEngine.getActiveBoss(client, interaction.guildId);
      if (!active) {
        return interaction.editReply({
          components: [
            bossView.buildErrorContainer({
              title: "🌙 沒有正在進行的 BOSS",
              body: "目前沒有 active 狀態的 BOSS 可以清除。",
            }),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      await client.bossEventsCollection.updateOne(
        { boss_id: active.boss_id, status: "active" },
        {
          $set: {
            status: "aborted",
            settled_at: Date.now(),
            aborted_by: interaction.user.id,
          },
        },
      );

      console.log(
        `[BOSS] manual abort by ${interaction.user.id}: ${active.boss_id} hp=${active.current_hp}/${active.max_hp}`.cyan,
      );

      const announceId = boss?.announceChannelId;
      if (announceId) {
        const ch = await client.channels.fetch(announceId).catch(() => null);
        if (ch?.isTextBased?.()) {
          await ch
            .send({
              content: `🧹 **${active.emoji} ${active.name}** 已被管理員清除，本場不發放獎勵。`,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
        }
      }

      return interaction.editReply({
        content: `✅ 已清除 ${active.emoji} **${active.name}**（HP ${active.current_hp.toLocaleString()}/${active.max_hp.toLocaleString()}）\n-# 此場不結算、不發獎`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      console.log(`[BOSS] /clearboss 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          bossView.buildErrorContainer({
            title: "❌ 清除失敗",
            body: "出了點狀況，請看 console。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
  },
};
