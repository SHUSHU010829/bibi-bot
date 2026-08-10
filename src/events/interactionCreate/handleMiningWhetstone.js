// 裝備修復按鈕處理器：劣質磨石 + 鎬子/武器/釣竿材料修復（預覽→確認）。
//
// 按鈕 customId：
//   mining_use_whetstone_inferior_<ownerId>     — 劣質磨石一鍵使用
//   mining_repair_material_<ownerId>            — 鎬子材料修復（預覽 / 確認）
//   mining_repair_weapon_<ownerId>              — 武器材料修復（預覽 / 確認）
//   mining_repair_rod_<ownerId>                 — 釣竿材料修復（預覽 / 確認）
//
// 各 parse 函式內已先比較長的 _confirm_ 後綴，不會誤匹配。
// 三組修復 prefix 第一個分歧字元不同（material/weapon/rod），彼此互不重疊。

const { MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const {
  buildBackpackView,
  parseUseWhetstoneInferiorId,
  parseUseWhetstoneWeaponId,
  parseUseWhetstoneShieldId,
  parseRepairMaterialId,
  parseRepairWeaponId,
  parseRepairRodId,
  parseRepairShieldId,
  REPAIR_MATERIAL_CONFIRM_PREFIX,
  REPAIR_WEAPON_CONFIRM_PREFIX,
  REPAIR_ROD_CONFIRM_PREFIX,
  REPAIR_SHIELD_CONFIRM_PREFIX,
  USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX,
  USE_WHETSTONE_WEAPON_CONFIRM_PREFIX,
  USE_WHETSTONE_SHIELD_CONFIRM_PREFIX,
} = require("../../features/shop/backpackView");
const mineService = require("../../features/mining/mineService");
const buildingService = require("../../features/guild_club/buildingService");
const { getOrCreate } = require("../../features/mining/miningProfile");
const {
  baseWithBonus,
  effectiveMaxOf,
} = require("../../features/mining/equipDurability");
const { mining, fishing, dungeon } = require("../../config");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");

async function getRepairDiscountPct(client, userId, guildId) {
  const buffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  return buffs.equipment_repair_discount_pct || 0;
}

function materialLabel(mat) {
  const fishDef = fishing?.fish?.[mat];
  if (fishDef) return `${fishDef.emoji} ${fishDef.name}`;
  const oreDef = mining?.ores?.[mat];
  if (oreDef) return `${oreDef.emoji} ${oreDef.name}`;
  return mat;
}

function formatCostLine(cost) {
  return Object.entries(cost || {})
    .map(([mat, qty]) => `${materialLabel(mat)} ×${qty}`)
    .join("　");
}

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;

    const customId = interaction.customId || "";

    // ── 劣質磨石（預覽 → 確認）─────────────────────────────────────────────
    const parsedInferior = parseUseWhetstoneInferiorId(customId);
    if (parsedInferior) {
      const { ownerId, confirm } = parsedInferior;

      const rl = consume(interaction.user.id, "btn:miningUseWhetstoneInferior", {
        windowMs: 2000,
        max: 1,
      });
      if (!rl.allowed) {
        await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
        return;
      }

      if (interaction.user.id !== ownerId) {
        await replyEphemeral(interaction, "🚫 這是別人的背包按鈕，請用 /背包 開自己的～");
        return;
      }

      if (!confirm) {
        // ── 預覽：用 ephemeral 純文字提示後果 + 確認鈕 ──
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        const maxDur = baseWithBonus(profile, "pickaxe");
        if ((profile.whetstone_inferior_count || 0) <= 0) {
          await replyEphemeral(interaction, "🪨 你沒有劣質磨石，可到 /商店 購買。");
          return;
        }
        if (profile.pickaxe === "wood") {
          await replyEphemeral(interaction, "⛏️ 你目前沒有可修復的鎬子（木鎬不需修復）。");
          return;
        }
        if (typeof maxDur !== "number" || maxDur < 20) {
          await replyEphemeral(
            interaction,
            `⛏️ 鎬子的耐久上限只剩 ${maxDur ?? "—"}（不含鐵匠鋪加成），不足 20 無法使用劣質磨石。`
          );
          return;
        }
        // -10 累加到 bonus（不動 base）；顯示補滿目標與上限用「有效上限」（含鐵匠鋪加成 + bonus）。
        const pickPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
        const pickEffMaxNow = effectiveMaxOf(profile, "pickaxe", pickPct);
        const pickEffMaxAfter = pickEffMaxNow - 10;
        const pickDef = mining?.pickaxes?.[profile.pickaxe] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認使用")
          .setStyle(ButtonStyle.Danger);

        await interaction.editReply({
          content:
            `🪨 確認要對 **${pickDef.name || profile.pickaxe}** 使用劣質磨石？\n` +
            `・耐久：${profile.pickaxe_durability} → ${pickEffMaxAfter}（補滿）\n` +
            `・最大耐久上限：${pickEffMaxNow} → **${pickEffMaxAfter}**（上限 -10）\n\n` +
            `-# 此操作無法撤回，最大耐久下降後無法回復。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
        });
        return;
      }

      // ── 確認使用：實際執行 ──
      // 同材料修復：確認訊息是上一步 ephemeral 純文字 reply，這裡用同樣方式 editReply。
      if (!(await deferUpdateSafe(interaction))) return;

      const result = await mineService.useInferiorWhetstone(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_whetstone: "🪨 你沒有劣質磨石，可到 /商店 購買。",
          no_pickaxe: "⛏️ 你目前沒有可修復的鎬子（木鎬不需修復）。",
          max_too_low: `⛏️ 鎬子的耐久上限只剩 ${result.maxDurability}（不含鐵匠鋪加成），不足 20 無法再使用劣質磨石。快去 /合成 一把新的吧！`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({
          content: messages[result.reason] || "🔧 使用失敗，請稍後再試。",
          components: [],
        });
        return;
      }

      await interaction.editReply({
        content: `🪨 已使用劣質磨石！鎬子耐久補滿至 **${result.durabilityAfter}**，最大耐久上限降至 ${result.maxAfter}。（剩餘 ×${result.inferiorLeft}）\n\n-# 重新打開 /背包 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-use-whetstone-inferior");
      return;
    }

    // ── Phase H+ 劣質磨石對武器（預覽 → 確認）──────────────────────────────────────
    const parsedWeaponWS = parseUseWhetstoneWeaponId(customId);
    if (parsedWeaponWS) {
      const { ownerId, confirm } = parsedWeaponWS;
      const rl = consume(interaction.user.id, "btn:miningUseWhetstoneWeapon", { windowMs: 2000, max: 1 });
      if (!rl.allowed) {
        await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
        return;
      }
      if (interaction.user.id !== ownerId) {
        await replyEphemeral(interaction, "🚫 這是別人的背包按鈕，請用 /背包 開自己的～");
        return;
      }
      if (!confirm) {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        if ((profile.whetstone_inferior_count || 0) <= 0) {
          await replyEphemeral(interaction, "🪨 你沒有劣質磨石，可到 /商店 購買。");
          return;
        }
        if (!profile.weapon || profile.weapon === "fist") {
          await replyEphemeral(interaction, "⚔️ 你目前沒有可修復的武器（赤手空拳不需修復）。");
          return;
        }
        const maxDur = baseWithBonus(profile, "weapon");
        if (typeof maxDur !== "number" || maxDur < 20) {
          await replyEphemeral(interaction, `⚔️ 武器的耐久上限只剩 ${maxDur ?? "—"}（不含鐵匠鋪加成），不足 20 無法使用劣質磨石。`);
          return;
        }
        // -10 累加到 bonus（不動 base）；顯示補滿目標與上限用「有效上限」（含鐵匠鋪加成 + bonus）。
        const weaponPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
        const effMaxNow = effectiveMaxOf(profile, "weapon", weaponPct);
        const effMaxAfter = effMaxNow - 10;
        const wdef = dungeon?.weapons?.[profile.weapon] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${USE_WHETSTONE_WEAPON_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認使用")
          .setStyle(ButtonStyle.Danger);
        await interaction.editReply({
          content:
            `🪨 確認要對 **${wdef.name || profile.weapon}** 使用劣質磨石？\n` +
            `・耐久：${profile.weapon_durability} → ${effMaxAfter}（補滿）\n` +
            `・最大耐久上限：${effMaxNow} → **${effMaxAfter}**（上限 -10）\n\n` +
            `-# 此操作無法撤回，最大耐久下降後無法回復。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
        });
        return;
      }
      if (!(await deferUpdateSafe(interaction))) return;
      const result = await mineService.useInferiorWhetstoneOnWeapon(client, {
        userId: interaction.user.id, guildId: interaction.guildId,
      });
      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_whetstone: "🪨 你沒有劣質磨石，可到 /商店 購買。",
          no_weapon: "⚔️ 你目前沒有可修復的武器。",
          max_too_low: `⚔️ 武器的耐久上限只剩 ${result.maxDurability}（不含鐵匠鋪加成），不足 20 無法再使用劣質磨石。快去 /合成 一把新的吧！`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({ content: messages[result.reason] || "🔧 使用失敗，請稍後再試。", components: [] });
        return;
      }
      const wdef = dungeon?.weapons?.[result.weaponKey] || {};
      await interaction.editReply({
        content: `🪨 已使用劣質磨石！**${wdef.name || result.weaponKey}** 耐久補滿至 **${result.durabilityAfter}**，最大耐久上限降至 ${result.maxAfter}。（剩餘 ×${result.inferiorLeft}）\n\n-# 重新打開 /背包 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-use-whetstone-weapon");
      return;
    }

    // ── Phase H+ 劣質磨石對盾（預覽 → 確認）──────────────────────────────────────
    const parsedShieldWS = parseUseWhetstoneShieldId(customId);
    if (parsedShieldWS) {
      const { ownerId, confirm } = parsedShieldWS;
      const rl = consume(interaction.user.id, "btn:miningUseWhetstoneShield", { windowMs: 2000, max: 1 });
      if (!rl.allowed) {
        await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
        return;
      }
      if (interaction.user.id !== ownerId) {
        await replyEphemeral(interaction, "🚫 這是別人的背包按鈕，請用 /背包 開自己的～");
        return;
      }
      if (!confirm) {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        if ((profile.whetstone_inferior_count || 0) <= 0) {
          await replyEphemeral(interaction, "🪨 你沒有劣質磨石，可到 /商店 購買。");
          return;
        }
        if (!profile.shield) {
          await replyEphemeral(interaction, "🛡️ 你目前沒有裝備盾牌。先 /合成 一面盾。");
          return;
        }
        const maxDur = baseWithBonus(profile, "shield");
        if (typeof maxDur !== "number" || maxDur < 20) {
          await replyEphemeral(interaction, `🛡️ 盾的耐久上限只剩 ${maxDur ?? "—"}（不含鐵匠鋪加成），不足 20 無法使用劣質磨石。`);
          return;
        }
        // -10 累加到 bonus（不動 base）；顯示補滿目標與上限用「有效上限」（含鐵匠鋪加成 + bonus）。
        const shieldPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
        const shieldEffMaxNow = effectiveMaxOf(profile, "shield", shieldPct);
        const shieldEffMaxAfter = shieldEffMaxNow - 10;
        const sdef = dungeon?.shields?.[profile.shield] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${USE_WHETSTONE_SHIELD_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認使用")
          .setStyle(ButtonStyle.Danger);
        await interaction.editReply({
          content:
            `🪨 確認要對 **${sdef.name || profile.shield}** 使用劣質磨石？\n` +
            `・耐久：${profile.shield_durability} → ${shieldEffMaxAfter}（補滿）\n` +
            `・最大耐久上限：${shieldEffMaxNow} → **${shieldEffMaxAfter}**（上限 -10）\n\n` +
            `-# 此操作無法撤回，最大耐久下降後無法回復。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
        });
        return;
      }
      if (!(await deferUpdateSafe(interaction))) return;
      const result = await mineService.useInferiorWhetstoneOnShield(client, {
        userId: interaction.user.id, guildId: interaction.guildId,
      });
      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_whetstone: "🪨 你沒有劣質磨石，可到 /商店 購買。",
          no_shield: "🛡️ 你目前沒有裝備盾牌。",
          max_too_low: `🛡️ 盾的耐久上限只剩 ${result.maxDurability}（不含鐵匠鋪加成），不足 20 無法再使用劣質磨石。快去 /合成 一面新盾吧！`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({ content: messages[result.reason] || "🔧 使用失敗，請稍後再試。", components: [] });
        return;
      }
      const sdef = dungeon?.shields?.[result.shieldKey] || {};
      await interaction.editReply({
        content: `🪨 已使用劣質磨石！**${sdef.name || result.shieldKey}** 耐久補滿至 **${result.durabilityAfter}**，最大耐久上限降至 ${result.maxAfter}。（剩餘 ×${result.inferiorLeft}）\n\n-# 重新打開 /背包 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-use-whetstone-shield");
      return;
    }

    // ── 武器修復（預覽 or 確認）──────────────────────────────────────────────
    const parsedWeapon = parseRepairWeaponId(customId);
    if (parsedWeapon) {
      const { ownerId, confirm } = parsedWeapon;
      const rl = consume(interaction.user.id, "btn:miningRepairWeapon", {
        windowMs: 2000,
        max: 3,
      });
      if (!rl.allowed) {
        await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
        return;
      }
      if (interaction.user.id !== ownerId) {
        await replyEphemeral(interaction, "🚫 這是別人的裝備按鈕，請用 /裝備 開自己的～");
        return;
      }

      if (!confirm) {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        const discountPct = await getRepairDiscountPct(client, interaction.user.id, interaction.guildId);
        const cost = mineService.applyRepairDiscount(
          mineService.getWeaponRepairCost(profile),
          discountPct
        );
        if (!cost || profile.weapon === "fist") {
          await replyEphemeral(interaction, "⚔️ 你目前沒有可修復的武器。");
          return;
        }
        const weaponPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
        const effMax = effectiveMaxOf(profile, "weapon", weaponPct);
        if (
          typeof profile.weapon_durability === "number" &&
          typeof effMax === "number" &&
          profile.weapon_durability >= effMax
        ) {
          await replyEphemeral(interaction, "✅ 武器耐久已滿，不需要修復！");
          return;
        }
        const wdef = dungeon?.weapons?.[profile.weapon] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${REPAIR_WEAPON_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認修復")
          .setStyle(ButtonStyle.Danger);
        await interaction.editReply({
          content: `🛠️ 確認要修復 **${wdef.name || profile.weapon}**（耐久 ${profile.weapon_durability} → ${effMax}）？\n\n**消耗材料**：${formatCostLine(cost)}\n\n-# 此操作無法撤回，請確認背包有足夠材料後再按確認。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
        });
        return;
      }

      if (!(await deferUpdateSafe(interaction))) return;
      const result = await mineService.repairWeaponWithMaterials(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_weapon: "⚔️ 你目前沒有可修復的武器。",
          no_recipe: "🔧 找不到該武器的合成配方，請呼叫舒舒！",
          already_full: "✅ 武器耐久已滿，不需要修復！",
          insufficient: `🪨 材料不足！${
            result.missing
              ? result.missing.map((m) => `${materialLabel(m.mat)}（需 ${m.need}，有 ${m.have}）`).join("、")
              : ""
          }`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({
          content: messages[result.reason] || "🔧 修復失敗，請稍後再試。",
          components: [],
        });
        return;
      }
      await interaction.editReply({
        content: `🛠️ 修復完成！武器耐久恢復至 **${result.durabilityAfter}**。\n消耗了：${formatCostLine(result.cost)}\n\n-# 重新打開 /裝備 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-repair-weapon");
      return;
    }

    // ── 釣竿修復（預覽 or 確認）──────────────────────────────────────────────
    const parsedRod = parseRepairRodId(customId);
    if (parsedRod) {
      const { ownerId, confirm } = parsedRod;
      const rl = consume(interaction.user.id, "btn:miningRepairRod", {
        windowMs: 2000,
        max: 3,
      });
      if (!rl.allowed) {
        await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
        return;
      }
      if (interaction.user.id !== ownerId) {
        await replyEphemeral(interaction, "🚫 這是別人的裝備按鈕，請用 /裝備 開自己的～");
        return;
      }

      if (!confirm) {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        const discountPct = await getRepairDiscountPct(client, interaction.user.id, interaction.guildId);
        const cost = mineService.applyRepairDiscount(
          mineService.getRodRepairCost(profile),
          discountPct
        );
        if (!cost || profile.fishing_rod === "bamboo") {
          await replyEphemeral(interaction, "🪝 你目前沒有可修復的釣竿。");
          return;
        }
        const rodPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
        const rodEffMax = effectiveMaxOf(profile, "rod", rodPct);
        if (
          typeof profile.rod_durability === "number" &&
          typeof rodEffMax === "number" &&
          profile.rod_durability >= rodEffMax
        ) {
          await replyEphemeral(interaction, "✅ 釣竿耐久已滿，不需要修復！");
          return;
        }
        const rdef = fishing?.rods?.[profile.fishing_rod] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${REPAIR_ROD_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認修復")
          .setStyle(ButtonStyle.Danger);
        await interaction.editReply({
          content: `🛠️ 確認要修復 **${rdef.name || profile.fishing_rod}**（耐久 ${profile.rod_durability} → ${rodEffMax}）？\n\n**消耗材料**：${formatCostLine(cost)}\n\n-# 此操作無法撤回，請確認背包/魚袋有足夠材料後再按確認。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
        });
        return;
      }

      if (!(await deferUpdateSafe(interaction))) return;
      const result = await mineService.repairRodWithMaterials(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_rod: "🪝 你目前沒有可修復的釣竿。",
          no_recipe: "🔧 找不到該釣竿的合成配方，請呼叫舒舒！",
          already_full: "✅ 釣竿耐久已滿，不需要修復！",
          insufficient: `🪨 材料不足！${
            result.missing
              ? result.missing.map((m) => `${materialLabel(m.mat)}（需 ${m.need}，有 ${m.have}）`).join("、")
              : ""
          }`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({
          content: messages[result.reason] || "🔧 修復失敗，請稍後再試。",
          components: [],
        });
        return;
      }
      await interaction.editReply({
        content: `🛠️ 修復完成！釣竿耐久恢復至 **${result.durabilityAfter}**。\n消耗了：${formatCostLine(result.cost)}\n\n-# 重新打開 /裝備 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-repair-rod");
      return;
    }

    // ── 盾牌材料修復（預覽 or 確認）──────────────────────────────────────────────
    const parsedShield = parseRepairShieldId(customId);
    if (parsedShield) {
      const { ownerId, confirm } = parsedShield;
      const rl = consume(interaction.user.id, "btn:miningRepairShield", {
        windowMs: 2000,
        max: 3,
      });
      if (!rl.allowed) {
        await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
        return;
      }
      if (interaction.user.id !== ownerId) {
        await replyEphemeral(interaction, "🚫 這是別人的裝備按鈕，請用 /裝備 開自己的～");
        return;
      }

      if (!confirm) {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        const discountPct = await getRepairDiscountPct(client, interaction.user.id, interaction.guildId);
        const cost = mineService.applyRepairDiscount(
          mineService.getShieldRepairCost(profile),
          discountPct
        );
        if (!cost || !profile.shield) {
          await replyEphemeral(interaction, "🛡️ 你目前沒有裝著可修復的盾。");
          return;
        }
        const shieldPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
        const shieldEffMax = effectiveMaxOf(profile, "shield", shieldPct);
        if (
          typeof profile.shield_durability === "number" &&
          typeof shieldEffMax === "number" &&
          profile.shield_durability >= shieldEffMax
        ) {
          await replyEphemeral(interaction, "✅ 盾牌耐久已滿，不需要修復！");
          return;
        }
        const sdef = dungeon?.shields?.[profile.shield] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${REPAIR_SHIELD_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認修復")
          .setStyle(ButtonStyle.Danger);
        await interaction.editReply({
          content: `🛠️ 確認要修復 **${sdef.name || profile.shield}**（耐久 ${profile.shield_durability} → ${shieldEffMax}）？\n\n**消耗材料**：${formatCostLine(cost)}\n\n-# 此操作無法撤回，請確認背包有足夠材料後再按確認。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
        });
        return;
      }

      if (!(await deferUpdateSafe(interaction))) return;
      const result = await mineService.repairShieldWithMaterials(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_shield: "🛡️ 你目前沒有裝著可修復的盾。",
          no_recipe: "🔧 找不到該盾牌的合成配方，請呼叫舒舒！",
          already_full: "✅ 盾牌耐久已滿，不需要修復！",
          insufficient: `🪨 材料不足！${
            result.missing
              ? result.missing.map((m) => `${materialLabel(m.mat)}（需 ${m.need}，有 ${m.have}）`).join("、")
              : ""
          }`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({
          content: messages[result.reason] || "🔧 修復失敗，請稍後再試。",
          components: [],
        });
        return;
      }
      await interaction.editReply({
        content: `🛠️ 修復完成！盾牌耐久恢復至 **${result.durabilityAfter}**。\n消耗了：${formatCostLine(result.cost)}\n\n-# 重新打開 /裝備 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-repair-shield");
      return;
    }

    // ── 鎬子材料修復（預覽 or 確認）──────────────────────────────────────────────
    const parsedRepair = parseRepairMaterialId(customId);
    if (!parsedRepair) return;

    const { ownerId, confirm } = parsedRepair;

    const rl = consume(interaction.user.id, "btn:miningRepairMaterial", {
      windowMs: 2000,
      max: 3,
    });
    if (!rl.allowed) {
      await replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyEphemeral(interaction, "🚫 這是別人的背包按鈕，請用 /背包 開自己的～");
      return;
    }

    if (!confirm) {
      // ── 預覽：顯示消耗材料 + 確認鈕（不 deferUpdate，直接 editReply）──
      if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const discountPct = await getRepairDiscountPct(client, interaction.user.id, interaction.guildId);
      const cost = mineService.applyRepairDiscount(
        mineService.getPickaxeRepairCost(profile),
        discountPct
      );

      if (!cost || profile.pickaxe === "wood") {
        await replyEphemeral(interaction, "⛏️ 你目前沒有可修復的鎬子。");
        return;
      }
      const pickPct = await buildingService.getEquipmentMaxDurabilityPct(client, interaction.user.id, interaction.guildId);
      const pickEffMax = effectiveMaxOf(profile, "pickaxe", pickPct);
      if (
        typeof profile.pickaxe_durability === "number" &&
        typeof pickEffMax === "number" &&
        profile.pickaxe_durability >= pickEffMax
      ) {
        await replyEphemeral(interaction, "✅ 鎬子耐久已滿，不需要修復！");
        return;
      }

      // 格式化材料清單
      const ores = mining?.ores || {};
      const costLines = Object.entries(cost)
        .map(([mat, qty]) => {
          const def = ores[mat];
          return def ? `${def.emoji} ${def.name} ×${qty}` : `${mat} ×${qty}`;
        })
        .join("　");

      const pickDef = mining?.pickaxes?.[profile.pickaxe] || {};
      const confirmBtn = new ButtonBuilder()
        .setCustomId(`${REPAIR_MATERIAL_CONFIRM_PREFIX}${interaction.user.id}`)
        .setLabel("確認修復")
        .setStyle(ButtonStyle.Danger);

      await interaction.editReply({
        content: `🛠️ 確認要修復 **${pickDef.name || profile.pickaxe}**（耐久 ${profile.pickaxe_durability} → ${pickEffMax}）？\n\n**消耗材料**：${costLines}\n\n-# 此操作無法撤回，請確認背包有足夠材料後再按確認。`,
        components: [new ActionRowBuilder().addComponents(confirmBtn)],
      });
      return;
    }

    // ── 確認修復：實際執行 ──
    // 注意：這個確認訊息是上一步 interaction.reply 建立的純文字 ephemeral
    // （沒帶 IsComponentsV2 flag），所以這裡只能用同樣不帶 v2 flag 的方式
    // editReply，不能塞 buildBackpackView 的 v2 容器，否則會被 Discord 拒收。
    if (!(await deferUpdateSafe(interaction))) return;

    const result = await mineService.repairPickaxeWithMaterials(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (!result.ok) {
      const messages = {
        disabled: "🔧 挖礦系統尚未啟動！",
        no_pickaxe: "⛏️ 你目前沒有可修復的鎬子。",
        no_recipe: "🔧 找不到該鎬子的合成配方，請呼叫舒舒！",
        already_full: "✅ 鎬子耐久已滿，不需要修復！",
        insufficient: `🪨 材料不足！${
          result.missing
            ? result.missing.map((m) => `${m.mat}（需 ${m.need}，有 ${m.have}）`).join("、")
            : ""
        }`,
        retry: "⏳ 操作衝突，請再試一次。",
      };
      await interaction.editReply({
        content: messages[result.reason] || "🔧 修復失敗，請稍後再試。",
        components: [],
      });
      return;
    }

    const ores = mining?.ores || {};
    const costLines = Object.entries(result.cost || {})
      .map(([mat, qty]) => {
        const def = ores[mat];
        return def ? `${def.emoji} ${def.name} ×${qty}` : `${mat} ×${qty}`;
      })
      .join("　");

    await interaction.editReply({
      content: `🛠️ 修復完成！鎬子耐久恢復至 **${result.durabilityAfter}**。\n消耗了：${costLines}\n\n-# 重新打開 /背包 可看到最新狀態。`,
      components: [],
    });
    trackSuccess("mining-repair-material");
  } catch (err) {
    logger.error(
      {
        source: "mining-whetstone",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "鎬子修復按鈕出錯"
    );
    trackError("mining-whetstone", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 操作失敗，請呼叫舒舒！");
  }
};
