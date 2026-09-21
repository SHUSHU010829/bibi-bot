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
const bossBoard = require("../../features/boss/bossBoard");
const bossAnnouncer = require("../../features/boss/bossAnnouncer");
const { settleAndAnnounce } = require("../../features/boss/bossSettlement");

function hpLine(hp, maxHp) {
  const pct = maxHp > 0 ? Math.round(hp / maxHp * 100) : 0;
  return `${hp.toLocaleString()} / ${maxHp.toLocaleString()}（${pct}%）`;
}

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("bosshp")
    .setDescription("[DEV] 直接砍掉 / 設定當前 BOSS 的血量 🩸")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o.setName("扣血").setDescription("直接扣掉的血量").setMinValue(1).setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("扣百分比")
        .setDescription("扣掉最大血量的百分之幾")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("剩餘血量")
        .setDescription("直接把當前血量設成這個值（0 = 立刻打倒並結算發獎）")
        .setMinValue(0)
        .setRequired(false),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const cut = interaction.options.getInteger("扣血");
      const cutPct = interaction.options.getInteger("扣百分比");
      const setHp = interaction.options.getInteger("剩餘血量");
      const given = [cut, cutPct, setHp].filter((v) => v != null);

      if (given.length !== 1) {
        return interaction.editReply({
          components: [
            bossView.buildErrorContainer({
              title: "❌ 請只填一種調整方式",
              body: `**扣血**、**扣百分比**、**剩餘血量** 三選一，目前填了 **${given.length}** 個。`,
              hint: "例：`扣血:50000`（砍掉 5 萬血）、`扣百分比:30`（砍掉三成）、`剩餘血量:0`（直接打倒）",
            }),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      const res = await bossEngine.adminAdjustHp(client, {
        guildId: interaction.guildId,
        cut,
        cutPct,
        setHp,
        adminId: interaction.user.id,
      });

      if (!res.ok) {
        const title = res.reason === "no_active" ? "🌙 沒有正在進行的 BOSS" : "❌ 調整失敗";
        const body = res.reason === "no_active"
          ? "目前沒有 active 狀態的 BOSS 可以調整血量。"
          : res.reason === "expired"
            ? "這場 BOSS 剛剛結束了，血量沒有被改動。"
            : `原因：\`${res.reason}\``;
        return interaction.editReply({
          components: [bossView.buildErrorContainer({ title, body })],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      console.log(
        `[BOSS] admin hp edit by ${interaction.user.id}: ${res.boss.boss_id} `
        + `${res.before} → ${res.after}/${res.maxHp}${res.killed ? " (killed)" : ""}`.cyan,
      );

      if (res.killed) {
        settleAndAnnounce(client, interaction.guild, res.boss.boss_id).catch((e) =>
          console.log(`[BOSS] settle on admin kill failed: ${e.message}`.red),
        );
      } else {
        bossBoard.scheduleRefresh(client, interaction.guildId, true);
        if (res.phaseChanged) {
          bossAnnouncer.announcePhase(client, res.boss, res.phaseAfter).catch(() => {});
        }
      }

      const lines = [
        `✅ ${res.boss.emoji} **${res.boss.name}** 血量已調整`,
        `${hpLine(res.before, res.maxHp)} → **${hpLine(res.after, res.maxHp)}**`,
        `變動：**${res.delta >= 0 ? "-" : "+"}${Math.abs(res.delta).toLocaleString()}**`,
      ];
      if (res.phaseChanged) {
        lines.push(`階段：${bossEngine.phaseDef(res.phaseBefore).label} → **${bossEngine.phaseDef(res.phaseAfter).label}**`);
      }
      lines.push(
        res.killed
          ? "-# 血量歸零＝本場已打倒，照常結算發獎（沒有擊殺者獎勵）"
          : "-# 只有戰況看板會跟著更新，不會公告是管理員改的",
      );

      return interaction.editReply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.log(`[BOSS] /bosshp 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          bossView.buildErrorContainer({
            title: "❌ 調整失敗",
            body: "出了點狀況，請看 console。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
  },
};
