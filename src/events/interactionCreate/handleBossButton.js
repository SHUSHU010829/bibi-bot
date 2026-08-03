// BOSS 共鬥按鈕處理（Phase C）
//
// customId：
//   boss_attack_<ownerId>  — 再次攻擊
//   boss_info_<ownerId>    — 查看戰況
//   boss_potion_<ownerId>  — 開體力藥水選瓶面板
//
// owner 驗證：customId 含 userId，只有本人能按。
require("colors");
const { MessageFlags } = require("discord.js");
const attackCmd = require("../../commands/boss/attack");
const infoCmd = require("../../commands/boss/boss");
const bossView = require("../../features/boss/bossView");
const { getOrCreate } = require("../../features/mining/miningProfile");
const dungeonService = require("../../features/mining/dungeonService");
const { deferReplySafe } = require("../../utils/safeAck");

const PREFIX_ATTACK = "boss_attack_";
const PREFIX_INFO = "boss_info_";
const PREFIX_POTION = "boss_potion_";

function parseOwner(customId) {
  if (customId.startsWith(PREFIX_ATTACK)) {
    return { action: "attack", ownerId: customId.slice(PREFIX_ATTACK.length) };
  }
  if (customId.startsWith(PREFIX_INFO)) {
    return { action: "info", ownerId: customId.slice(PREFIX_INFO.length) };
  }
  if (customId.startsWith(PREFIX_POTION)) {
    return { action: "potion", ownerId: customId.slice(PREFIX_POTION.length) };
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

  // 置頂看板的共用攻擊鈕（無 owner 鎖，任何人都能點）
  if (interaction.customId === "boss_board_attack" || interaction.customId === "boss_board_combo") {
    const count = interaction.customId === "boss_board_combo" ? 5 : 1;
    try {
      if (!(await deferReplySafe(interaction, {}))) return;
      return await attackCmd.runAttack(client, interaction, count);
    } catch (e) {
      console.log(`[BOSS] 看板攻擊鈕失敗：${e.stack || e.message}`.red);
      const payload = {
        components: [bossView.buildErrorContainer({ title: "❌ 操作失敗", body: "出了點狀況，請稍後再試。" })],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
      return interaction.reply(payload);
    }
  }

  const parsed = parseOwner(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.ownerId) {
    return ephemeralError(interaction, "這個按鈕是別人的，請自己 /攻擊 或 /boss 查看戰況。");
  }
  try {
    if (parsed.action === "attack") {
      if (!(await deferReplySafe(interaction, {}))) return;
      return await attackCmd.runAttack(client, interaction);
    }
    if (parsed.action === "info") {
      if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      return await infoCmd.runInfo(client, interaction);
    }
    if (parsed.action === "potion") {
      if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const club = await dungeonService.getMemberClub(
        client,
        interaction.user.id,
        interaction.guildId,
      );
      const max = dungeonService.staminaMax(interaction.member, club);
      const st = dungeonService.resolveStamina(profile, max);
      return interaction.editReply({
        components: [
          bossView.buildStaminaPotionPickerContainer({
            userId: interaction.user.id,
            displayName: interaction.member?.displayName || interaction.user.username,
            profile,
            stamina: st.stamina,
            staminaMax: max,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
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
