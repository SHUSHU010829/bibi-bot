require("colors");
const {
  InteractionContextType,
  MessageFlags,
  ApplicationCommandOptionType,
} = require("discord.js");

const { boss } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossSummon = require("../../features/boss/bossSummon");
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
  const ammo = await bossEngine.sealingAmmoState(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  const container = bossView.buildInfoContainer({
    userId: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.username,
    boss: info.boss,
    ranking: info.ranking,
    totalDamage: info.totalDamage,
    comboActive: info.comboActive,
    guild: interaction.guild,
    ammo,
  });
  return interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runSummonProgress(client, interaction) {
  if (!boss?.enabled || !boss?.summon?.enabled) {
    return interaction.editReply({
      components: [
        bossView.buildErrorContainer({
          title: "🔧 討伐能量未啟用",
          body: "目前還沒開放靠地下城召喚魔王的功能。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const p = await bossSummon.progress(client, interaction.guildId, interaction.user.id);
  return interaction.editReply({
    components: [bossView.buildSummonProgressContainer(p)],
    flags: MessageFlags.IsComponentsV2,
  });
}

const attackCmd = require("./attack");

// 把 /攻擊 的 builder 轉成 /魔王 底下的 subcommand
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
    name: "魔王",
    description: "BOSS 戰：攻擊與戰況 ⚔️",
    contexts: [InteractionContextType.Guild],
    options: [
      toSubcommand(attackCmd),
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "戰況",
        description: "查看當前 BOSS 戰況 📊",
        options: [],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "召喚進度",
        description: "查看討伐能量：打地下城累積，集滿自動召喚魔王 🔮",
        options: [],
      },
    ],
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "攻擊") {
      return attackCmd.run(client, interaction);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (sub === "召喚進度") {
        return await runSummonProgress(client, interaction);
      }
      return await runInfo(client, interaction);
    } catch (e) {
      console.log(`[BOSS] /魔王 戰況 失敗：${e.stack || e.message}`.red);
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
