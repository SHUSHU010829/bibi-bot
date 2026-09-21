// BOSS 共鬥按鈕處理（Phase C）
//
// customId：
//   boss_attack_<ownerId>  — 再次攻擊
//   boss_info_<ownerId>    — 查看戰況
//   boss_potion_<ownerId>  — 開體力藥水選瓶面板
//   boss_ammo_<ownerId>    — 對本場魔王投入封魔彈藥
//   boss_items_<ownerId>   — 開討伐道具面板
//   boss_item_<ownerId>_<itemKey> — 丟出某個討伐道具
//
// owner 驗證：customId 含 userId，只有本人能按。
require("colors");
const { MessageFlags } = require("discord.js");
const { boss } = require("../../config");
const attackCmd = require("../../commands/boss/attack");
const infoCmd = require("../../commands/boss/boss");
const bossView = require("../../features/boss/bossView");
const bossEngine = require("../../features/boss/bossEngine");
const bossItems = require("../../features/boss/bossItems");
const bossAnnouncer = require("../../features/boss/bossAnnouncer");
const bossBoard = require("../../features/boss/bossBoard");
const { settleAndAnnounce } = require("../../features/boss/bossSettlement");
const { getOrCreate } = require("../../features/mining/miningProfile");
const dungeonService = require("../../features/mining/dungeonService");
const { deferReplySafe } = require("../../utils/safeAck");

const PREFIX_ATTACK = "boss_attack_";
const PREFIX_INFO = "boss_info_";
const PREFIX_POTION = "boss_potion_";
const PREFIX_AMMO = "boss_ammo_";
const PREFIX_ITEMS = "boss_items_";
const PREFIX_ITEM_USE = "boss_item_";

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
  if (customId.startsWith(PREFIX_AMMO)) {
    return { action: "ammo", ownerId: customId.slice(PREFIX_AMMO.length) };
  }
  // boss_items_ 必須排在 boss_item_ 前面：後者是前者的前綴，順序反了會把面板鈕當成道具鈕。
  if (customId.startsWith(PREFIX_ITEMS)) {
    return { action: "items", ownerId: customId.slice(PREFIX_ITEMS.length) };
  }
  if (customId.startsWith(PREFIX_ITEM_USE)) {
    const rest = customId.slice(PREFIX_ITEM_USE.length);
    const sep = rest.indexOf("_");
    if (sep < 0) return null;
    return { action: "item_use", ownerId: rest.slice(0, sep), itemKey: rest.slice(sep + 1) };
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
    const count = interaction.customId === "boss_board_combo" ? (boss?.maxHitsPerCommand ?? 3) : 1;
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
    if (parsed.action === "ammo") {
      if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      const params = { userId: interaction.user.id, guildId: interaction.guildId };
      const result = await bossEngine.useSealingAmmo(client, params);
      if (!result.ok) {
        const ammo = await bossEngine.sealingAmmoState(client, params);
        return interaction.editReply({
          components: [bossView.buildSealingAmmoErrorContainer(result.reason, ammo)],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply({
        components: [
          bossView.buildSealingAmmoUsedContainer({
            userId: interaction.user.id,
            displayName: interaction.member?.displayName || interaction.user.username,
            result,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    if (parsed.action === "items") {
      if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      return await infoCmd.runItems(client, interaction);
    }
    if (parsed.action === "item_use") {
      if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      const params = { userId: interaction.user.id, guildId: interaction.guildId };
      const result = await bossItems.useItem(client, { ...params, username: interaction.user.username, itemKey: parsed.itemKey });
      if (!result.ok) {
        const inv = await bossItems.inventory(client, params);
        return interaction.editReply({
          components: [bossView.buildBossItemErrorContainer(result.reason, { def: result.def, inv })],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const displayName = interaction.member?.displayName || interaction.user.username;
      if (result.announcement) {
        bossAnnouncer
          .announceSkillEvents(client, [{
            text: result.announcement
              .replace(/\{user\}/g, displayName)
              .replace(/\{name\}/g, result.boss.name),
          }])
          .catch(() => {});
      }
      if (result.killed) {
        settleAndAnnounce(client, interaction.guild, result.boss.boss_id).catch((e) =>
          console.log(`[BOSS] settle on item kill failed: ${e.message}`.red),
        );
      } else {
        bossBoard.scheduleRefresh(client, interaction.guildId, result.phaseChanged);
        if (result.phaseChanged) {
          bossAnnouncer.announcePhase(client, result.boss, result.phaseAfter).catch(() => {});
        }
      }

      return interaction.editReply({
        components: [bossView.buildBossItemUsedContainer({ userId: interaction.user.id, displayName, result })],
        flags: MessageFlags.IsComponentsV2,
      });
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
