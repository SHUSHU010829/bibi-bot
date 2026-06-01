// 農場系統按鈕處理器（Phase D）
//
// 支援的 customId：
//   farm_plant_<ownerId>_<plotIndex>   — 該地塊提示玩家用 /種植 指令
//   farm_harvest_<ownerId>_<plotIndex> — 直接收成該地塊
//   farm_fert_<ownerId>_<plotIndex>    — 提示玩家用 /施肥 指令
//   farm_defend_<ownerId>_<plotIndex>  — 戰鬥防禦
//   farm_expand_<ownerId>              — 直接走擴建流程
//   farm_view_<ownerId>                — 重新顯示農場（從收成後跳回）

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { farming } = require("../../config");
const farmService = require("../../features/farm/farmService");
const { buildFarmContainer } = require("../../features/farm/farmView");
const { getOrCreate } = require("../../features/mining/miningProfile");

const PREFIXES = ["farm_plant_", "farm_harvest_", "farm_fert_", "farm_defend_", "farm_expand_", "farm_view_"];

function parseCustomId(customId) {
  for (const p of PREFIXES) {
    if (!customId.startsWith(p)) continue;
    const action = p.slice(5, -1);
    const rest = customId.slice(p.length);
    const sepIdx = rest.indexOf("_");
    if (sepIdx < 0) return { action, ownerId: rest, plotIndex: null };
    return {
      action,
      ownerId: rest.slice(0, sepIdx),
      plotIndex: Number.parseInt(rest.slice(sepIdx + 1), 10),
    };
  }
  return null;
}

async function renderFarm(interaction, client) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = farmService.getPlotCount(profile);
  const plots = await farmService.getPlots(client, userId, guildId, plotCount);
  // 嘗試 raid roll
  for (const p of plots) {
    if (farmService.shouldTriggerRaid(p) && !p.raid?.active) {
      const raid = await farmService.markRaid(client, {
        userId, guildId, plotIndex: p.plotIndex,
      });
      if (raid) {
        p.status = "raided";
        p.raid = raid;
      }
    }
  }
  const container = buildFarmContainer({
    plots,
    userId,
    plotCount,
    maxPlots: farming.maxPlots || 8,
  });
  return container;
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的農場！",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { action, plotIndex } = parsed;

  try {
    if (action === "view") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const container = await renderFarm(interaction, client);
      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    if (action === "harvest") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await farmService.harvestCrop(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        plotIndex,
      });
      if (!result.ok) {
        return interaction.editReply({
          content: result.reason === "rotted"
            ? "🥀 作物已枯萎，地塊已清空。"
            : result.reason === "under_raid"
            ? "⚔️ 地塊被入侵中，請先防禦。"
            : result.reason === "not_ready"
            ? "⏱️ 還沒成熟。"
            : "🔧 收成失敗。",
          flags: MessageFlags.Ephemeral,
        });
      }
      const def = result.cropDef;
      const yieldText = result.yieldBonus > 0
        ? `（+${Math.round(result.yieldBonus * 100)}% 收成）`
        : "";
      const bonusText = result.bonusDrops
        .map((d) => d.kind === "fragment" ? `✨ 傳說碎片 ×${d.amount}` : `✨ 稀有魚餌 ×${d.amount}`)
        .join("、");
      return interaction.editReply({
        content: `🌟 收成 **${def.emoji} ${def.name}** ×1 → **+${result.coins} 幣** ${yieldText}${bonusText ? "\n" + bonusText : ""}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === "defend") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await farmService.defendRaid(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        plotIndex,
      });
      if (!result.ok) {
        if (result.reason === "no_raid") {
          return interaction.editReply({ content: "⚠️ 沒有正在進行的入侵。", flags: MessageFlags.Ephemeral });
        }
        if (result.reason === "no_stamina") {
          return interaction.editReply({ content: "🔋 體力不足，無法防禦。", flags: MessageFlags.Ephemeral });
        }
        if (result.reason === "no_weapon") {
          return interaction.editReply({ content: "🗡️ 你沒有武器！先到 `/合成` 打造一把劍。", flags: MessageFlags.Ephemeral });
        }
        return interaction.editReply({ content: "🔧 防禦失敗。", flags: MessageFlags.Ephemeral });
      }
      const monster = result.monster;
      const lines = result.won
        ? [
            `⚔️ 擊退了 **${monster.monsterEmoji} ${monster.monsterName}**！`,
            `💰 戰利品：+${result.coinsGained} 幣` + (result.slimeGained > 0 ? `、💧 怪物黏液 ×${result.slimeGained}` : ""),
            `🌟 作物保住了，可立即 \`/收成 地塊:${plotIndex + 1}\``,
          ]
        : [
            `💀 被 **${monster.monsterEmoji} ${monster.monsterName}** 擊敗，作物被毀！`,
            `下次更早回來收成吧 🥲`,
          ];
      if (result.weaponBroke) lines.push(`💥 武器斷裂，已換回赤手！`);
      else if (typeof result.weaponDurabilityAfter === "number") {
        lines.push(`-# 武器耐久剩 ${result.weaponDurabilityAfter}`);
      }
      return interaction.editReply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
    }

    if (action === "plant") {
      return interaction.reply({
        content: `🌱 請使用指令 \`/種植 作物:<選擇> 地塊:${plotIndex + 1}\` 來種植`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === "fert") {
      return interaction.reply({
        content: `💧 請使用指令 \`/施肥 肥料:<選擇> 地塊:${plotIndex + 1}\` 來施肥`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === "expand") {
      return interaction.reply({
        content: "🏗️ 請使用指令 `/農場擴建` 來擴建",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.log(`[ERROR] handleFarmButton:\n${error}\n${error.stack}`.red);
    if (interaction.deferred) {
      await interaction.editReply("🔧 操作失敗，請呼叫舒舒！").catch(() => {});
    } else {
      await interaction.reply({ content: "🔧 操作失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
};
