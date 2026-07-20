require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { boss } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossView = require("../../features/boss/bossView");
const bossAnnouncer = require("../../features/boss/bossAnnouncer");
const bossRewards = require("../../features/boss/bossRewards");
const bossBoard = require("../../features/boss/bossBoard");

async function runAttack(client, interaction, forcedCount) {
  if (!boss?.enabled) {
    return interaction.editReply({
      components: [
        bossView.buildErrorContainer({
          title: "🔧 BOSS 系統未啟用",
          body: "目前還沒有 BOSS 戰可以打。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const count = forcedCount ?? Math.max(1, Math.min(5, interaction.options?.getInteger?.("次數") ?? 1));
  const params = {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
  };

  if (count === 1) {
    const result = await bossEngine.applyAttack(client, params);
    if (!result.ok) {
      return interaction.editReply({
        components: [buildAttackErrorContainer(result)],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    const displayName =
      interaction.member?.displayName || interaction.user.username;
    const container = bossView.buildAttackResultContainer({
      userId: interaction.user.id,
      displayName,
      result,
    });
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    if (!result.killed) {
      bossBoard.scheduleRefresh(client, interaction.guildId, result.phaseChanged);
    }
    if (result.phaseChanged && !result.killed) {
      bossAnnouncer.announcePhase(client, result.boss, result.phaseAfter).catch(() => {});
    }
    if (result.comboTriggered) {
      bossAnnouncer.announceCombo(client, result.boss, interaction.user.id).catch(() => {});
    }
    if (result.killed) {
      settleAndAnnounce(client, interaction.guild, result.boss.boss_id).catch((e) =>
        console.log(`[BOSS] settle on kill failed: ${e.message}`.red),
      );
    }
    return;
  }

  const combo = await bossEngine.applyComboAttack(client, params, count);
  if (!combo.ok) {
    return interaction.editReply({
      components: [buildAttackErrorContainer(combo.errorResult || { reason: combo.reason })],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const displayName =
    interaction.member?.displayName || interaction.user.username;
  const { container } = bossView.buildComboResultContainer({
    userId: interaction.user.id,
    displayName,
    hits: combo.hits,
    stopReason: combo.stopReason,
  });
  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });

  if (!combo.killed) {
    bossBoard.scheduleRefresh(client, interaction.guildId, combo.phaseChanged);
  }
  if (combo.phaseChanged && !combo.killed) {
    bossAnnouncer
      .announcePhase(client, combo.lastResult.boss, combo.lastResult.phaseAfter)
      .catch(() => {});
  }
  if (combo.comboTriggered) {
    bossAnnouncer.announceCombo(client, combo.lastResult.boss, interaction.user.id).catch(() => {});
  }
  if (combo.killed) {
    settleAndAnnounce(client, interaction.guild, combo.lastResult.boss.boss_id).catch((e) =>
      console.log(`[BOSS] settle on kill failed: ${e.message}`.red),
    );
  }
}

async function settleAndAnnounce(client, guild, bossId) {
  const bossDoc = await client.bossEventsCollection.findOne({ boss_id: bossId });
  if (!bossDoc) return;
  if (bossDoc.settled_at) return;
  const settlement = await bossEngine.settleBoss(client, bossDoc);
  if (!settlement) return;
  await bossRewards.distribute(client, guild, settlement);
  await bossAnnouncer.announceSettlement(client, settlement);
}

function buildAttackErrorContainer(result) {
  if (result.reason === "disabled") {
    return bossView.buildErrorContainer({
      title: "🔧 BOSS 系統未啟用",
      body: "目前還沒有 BOSS 戰可以打。",
    });
  }
  if (result.reason === "no_active") {
    return bossView.buildErrorContainer({
      title: "🌙 沒有正在進行的 BOSS 戰",
      body: "下一場 BOSS 預計在 **週六 21:00** 出現，準備好你的武器吧！",
      hint: "可以先 /合成 強化武器、/烹飪 製作 buff，迎接挑戰。",
    });
  }
  if (result.reason === "expired") {
    return bossView.buildErrorContainer({
      title: "⏳ BOSS 已逃離戰場",
      body: "這場 BOSS 戰已經結束，結算公告稍後就會出來！",
    });
  }
  if (result.reason === "attack_limit") {
    return bossView.buildErrorContainer({
      title: "⚔️ 你已用完本場攻擊次數",
      body: `每位玩家每場 BOSS 最多攻擊 **${result.limit}** 次，已用 **${result.used}** 次。`,
      hint: "看看 /boss 查戰況、為隊友加油！",
    });
  }
  if (result.reason === "no_stamina") {
    const tail = result.nextRegenAt
      ? `\n下一點體力：<t:${Math.floor(result.nextRegenAt / 1000)}:R>`
      : "";
    return bossView.buildErrorContainer({
      title: "😮‍💨 體力耗盡",
      body: `BOSS 攻擊需要體力（與地下城共用），目前 **0/${result.max}**。${tail}`,
      hint: "每小時自動回復 1 點。",
    });
  }
  return bossView.buildErrorContainer({
    title: "❌ 攻擊失敗",
    body: "出了點狀況，請稍後再試。",
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("攻擊")
    .setDescription("攻擊當前出現的 BOSS！⚔️")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o
        .setName("次數")
        .setDescription("連擊幾刀（1-5，預設 1）。Combo 需要多人接力，旺場時建議一刀一刀打。")
        .setMinValue(1)
        .setMaxValue(5),
    ),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      return await runAttack(client, interaction);
    } catch (e) {
      console.log(`[BOSS] /魔王 攻擊 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          bossView.buildErrorContainer({
            title: "❌ 攻擊失敗",
            body: "出了點狀況，請稍後再試。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  },

  runAttack,
  settleAndAnnounce,
  buildAttackErrorContainer,
};
