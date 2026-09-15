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

  const maxHits = boss?.maxHitsPerCommand ?? 3;
  const count = Math.max(1, Math.min(maxHits, forcedCount ?? interaction.options?.getInteger?.("次數") ?? 1));
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
        components: [buildAttackErrorContainer(result, interaction.user.id)],
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
    if (result.skillBroken && !result.killed) {
      bossAnnouncer.announceSkillEvents(client, [result.skillBroken]).catch(() => {});
    }
    // 反攻號角是全場的事：戰鬥頻道也要看到，次數用完的人才知道可以回來。
    if (result.rally) {
      bossAnnouncer.announceSkillEvents(client, [result.rally]).catch(() => {});
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
      components: [buildAttackErrorContainer(combo.errorResult || { reason: combo.reason }, interaction.user.id)],
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
  if (combo.skillsBroken?.length && !combo.killed) {
    bossAnnouncer.announceSkillEvents(client, combo.skillsBroken).catch(() => {});
  }
  const rallies = combo.hits.map((h) => h.rally).filter(Boolean);
  if (rallies.length) {
    bossAnnouncer.announceSkillEvents(client, rallies).catch(() => {});
  }
  if (combo.killed) {
    settleAndAnnounce(client, interaction.guild, combo.lastResult.boss.boss_id).catch((e) =>
      console.log(`[BOSS] settle on kill failed: ${e.message}`.red),
    );
  }
}

// 次數用完不代表出局：召喚場全場砍滿一輪刀數就會吹反攻號角，所有人再開一輪。
function rallyHint() {
  const r = boss?.rally || {};
  if (!r.enabled) return "看看 /boss 查戰況、為隊友加油！";
  return `召喚出來的魔王在全場累積 ${r.hitsPerRally ?? 0} 刀還沒倒下時會吹「反攻號角」，`
    + `所有人的出刀次數 +${r.attackBonus ?? 0}（最多 ${r.maxRallies ?? 0} 次）——先 /魔王 戰況 盯著，號角一響就回來。`;
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

function buildAttackErrorContainer(result, userId) {
  if (result.reason === "disabled") {
    return bossView.buildErrorContainer({
      title: "🔧 BOSS 系統未啟用",
      body: "目前還沒有 BOSS 戰可以打。",
    });
  }
  if (result.reason === "no_active") {
    return bossView.buildErrorContainer({
      title: "🌙 沒有正在進行的 BOSS 戰",
      body: `下一場固定 BOSS 在 **週六 21:00** 出現，準備好你的武器吧！\n${bossView.summonWindowHint()}`,
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
    const container = bossView.buildErrorContainer({
      title: "⚔️ 你已用完本場攻擊次數",
      body: `每位玩家每場 BOSS 最多攻擊 **${result.limit}** 次，已用 **${result.used}** 次。`,
      hint: rallyHint(),
    });
    return bossView.addSealingAmmoOffer(container, userId, result.ammo);
  }
  if (result.reason === "attack_cooldown") {
    const container = bossView.buildErrorContainer({
      title: "⏱️ 出刀冷卻中",
      body: `每刀之間要間隔 **${result.cooldownSec}** 秒，下一刀 <t:${Math.floor(result.nextAt / 1000)}:R> 可以砍。\n⚔️ 本場已出手：**${result.used}/${result.limit}** 次`,
      hint: "冷卻是為了讓整場戰鬥撐得久一點——趁空檔 /烹飪 補 buff、看 /魔王 戰況 等破綻窗口。",
    });
    return bossView.addSealingAmmoOffer(container, userId, result.ammo);
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
        .setDescription(
          `連擊幾刀（1-${boss?.maxHitsPerCommand ?? 3}，預設 1）。連擊會一次扣掉同樣份數的出刀冷卻。`,
        )
        .setMinValue(1)
        .setMaxValue(boss?.maxHitsPerCommand ?? 3),
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
