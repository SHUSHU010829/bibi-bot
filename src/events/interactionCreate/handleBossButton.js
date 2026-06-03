// BOSS 共鬥按鈕處理（Phase C）
//
// customId：
//   boss_attack_<ownerId>  — 再次攻擊
//   boss_info_<ownerId>    — 查看戰況
//
// owner 驗證：customId 含 userId，只有本人能按。
require("colors");
const { MessageFlags } = require("discord.js");
const attackCmd = require("../../commands/boss/attack");
const infoCmd = require("../../commands/boss/boss");
const bossView = require("../../features/boss/bossView");

const PREFIX_ATTACK = "boss_attack_";
const PREFIX_INFO = "boss_info_";

function parseOwner(customId) {
  if (customId.startsWith(PREFIX_ATTACK)) {
    return { action: "attack", ownerId: customId.slice(PREFIX_ATTACK.length) };
  }
  if (customId.startsWith(PREFIX_INFO)) {
    return { action: "info", ownerId: customId.slice(PREFIX_INFO.length) };
  }
  return null;
}

async function ephemeralError(interaction, body) {
  const container = bossView.buildErrorContainer({
    title: "🚫 不是你的按鈕",
    body,
  });
  return interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const parsed = parseOwner(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.ownerId) {
    return ephemeralError(interaction, "這個按鈕是別人的，請自己 /攻擊 或 /boss 查看戰況。");
  }
  try {
    if (parsed.action === "attack") {
      await interaction.deferReply();
      return await attackCmd.runAttack(client, interaction);
    }
    if (parsed.action === "info") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await infoCmd.runInfo(client, interaction);
    }
  } catch (e) {
    console.log(`[BOSS] 按鈕處理失敗：${e.stack || e.message}`.red);
    const container = bossView.buildErrorContainer({
      title: "❌ 操作失敗",
      body: "出了點狀況，請稍後再試。",
    });
    const payload = {
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    return interaction.reply(payload);
  }
};
