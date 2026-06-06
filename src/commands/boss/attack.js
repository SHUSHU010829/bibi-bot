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

async function runAttack(client, interaction) {
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

  const result = await bossEngine.applyAttack(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
  });

  if (!result.ok) {
    const container = buildAttackErrorContainer(result);
    return interaction.editReply({
      components: [container],
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

  // 階段變化 / Combo 觸發 → 公告（背景跑，不擋玩家回覆）
  if (result.phaseChanged && !result.killed) {
    bossAnnouncer.announcePhase(client, result.boss, result.phaseAfter).catch(() => {});
  }
  if (result.comboTriggered) {
    bossAnnouncer.announceCombo(client, result.boss, interaction.user.id).catch(() => {});
  }

  // 擊殺立即結算
  if (result.killed) {
    settleAndAnnounce(client, interaction.guild, result.boss.boss_id).catch((e) =>
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
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    const allowedChannelId = boss?.attackChannelId;
    if (allowedChannelId && interaction.channelId !== allowedChannelId) {
      return interaction.reply({
        components: [
          bossView.buildErrorContainer({
            title: "🚫 這裡不能攻擊 BOSS",
            body: `請到 <#${allowedChannelId}> 使用 \`/攻擊\` 指令。`,
            hint: "限定頻道是為了讓戰況集中、避免洗版",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply();
    try {
      return await runAttack(client, interaction);
    } catch (e) {
      console.log(`[BOSS] /攻擊 失敗：${e.stack || e.message}`.red);
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
