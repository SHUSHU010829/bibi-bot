// 鎬子修復按鈕處理器：劣質磨鎬石（使用）+ 材料修復（預覽→確認）。
//
// 按鈕 customId：
//   mining_use_whetstone_inferior_<ownerId>   — 劣質磨鎬石一鍵使用
//   mining_repair_material_<ownerId>           — 材料修復：顯示消耗預覽並附確認鈕
//   mining_repair_material_confirm_<ownerId>   — 材料修復確認，實際執行扣料
//
// 注意：_inferior_ 是 _whetstone_ 的超集；parseRepairMaterialId 也先比長的。
// handler 已正確地先比最長的 prefix，不會誤匹配。

const { MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const {
  buildBackpackView,
  parseUseWhetstoneInferiorId,
  parseRepairMaterialId,
  REPAIR_MATERIAL_CONFIRM_PREFIX,
  USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX,
} = require("../../features/shop/backpackView");
const mineService = require("../../features/mining/mineService");
const { getOrCreate } = require("../../features/mining/miningProfile");
const { mining } = require("../../config");

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

    // ── 劣質磨鎬石（預覽 → 確認）─────────────────────────────────────────────
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
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        const maxDur = profile.pickaxe_max_durability;
        if ((profile.whetstone_inferior_count || 0) <= 0) {
          await replyEphemeral(interaction, "🪨 你沒有劣質磨鎬石，可到 /商店 購買。");
          return;
        }
        if (profile.pickaxe === "wood") {
          await replyEphemeral(interaction, "⛏️ 你目前沒有可修復的鎬子（木鎬不需修復）。");
          return;
        }
        if (typeof maxDur !== "number" || maxDur < 20) {
          await replyEphemeral(
            interaction,
            `⛏️ 鎬子最大耐久只剩 ${maxDur ?? "—"}，不足 20 無法使用劣質磨鎬石。`
          );
          return;
        }
        const pickDef = mining?.pickaxes?.[profile.pickaxe] || {};
        const confirmBtn = new ButtonBuilder()
          .setCustomId(`${USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX}${interaction.user.id}`)
          .setLabel("確認使用")
          .setStyle(ButtonStyle.Danger);

        await interaction.reply({
          content:
            `🪨 確認要對 **${pickDef.name || profile.pickaxe}** 使用劣質磨鎬石？\n` +
            `・耐久：${profile.pickaxe_durability} → ${maxDur}（補滿）\n` +
            `・最大耐久上限：${maxDur} → **${maxDur - 10}**（-10）\n\n` +
            `-# 此操作無法撤回，最大耐久下降後無法回復。`,
          components: [new ActionRowBuilder().addComponents(confirmBtn)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // ── 確認使用：實際執行 ──
      // 同材料修復：確認訊息是上一步 ephemeral 純文字 reply，這裡用同樣方式 editReply。
      await interaction.deferUpdate();

      const result = await mineService.useInferiorWhetstone(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      if (!result.ok) {
        const messages = {
          disabled: "🔧 挖礦系統尚未啟動！",
          no_whetstone: "🪨 你沒有劣質磨鎬石，可到 /商店 購買。",
          no_pickaxe: "⛏️ 你目前沒有可修復的鎬子（木鎬不需修復）。",
          max_too_low: `⛏️ 鎬子最大耐久只剩 ${result.maxDurability}，不足 20 無法再使用劣質磨鎬石。快去 /合成 一把新的吧！`,
          retry: "⏳ 操作衝突，請再試一次。",
        };
        await interaction.editReply({
          content: messages[result.reason] || "🔧 使用失敗，請稍後再試。",
          components: [],
        });
        return;
      }

      await interaction.editReply({
        content: `🪨 已使用劣質磨鎬石！鎬子耐久補滿至 **${result.durabilityAfter}**，最大耐久上限降至 ${result.maxAfter}。（剩餘 ×${result.inferiorLeft}）\n\n-# 重新打開 /背包 可看到最新狀態。`,
        components: [],
      });
      trackSuccess("mining-use-whetstone-inferior");
      return;
    }

    // ── 材料修復（預覽 or 確認）──────────────────────────────────────────────
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
      // ── 預覽：顯示消耗材料 + 確認鈕（不 deferUpdate，直接 reply）──
      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const cost = mineService.getPickaxeRepairCost(profile);

      if (!cost || profile.pickaxe === "wood") {
        await replyEphemeral(interaction, "⛏️ 你目前沒有可修復的鎬子。");
        return;
      }
      if (
        typeof profile.pickaxe_durability === "number" &&
        typeof profile.pickaxe_max_durability === "number" &&
        profile.pickaxe_durability >= profile.pickaxe_max_durability
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

      await interaction.reply({
        content: `🛠️ 確認要修復 **${pickDef.name || profile.pickaxe}**（耐久 ${profile.pickaxe_durability} → ${profile.pickaxe_max_durability}）？\n\n**消耗材料**：${costLines}\n\n-# 此操作無法撤回，請確認背包有足夠材料後再按確認。`,
        components: [new ActionRowBuilder().addComponents(confirmBtn)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ── 確認修復：實際執行 ──
    // 注意：這個確認訊息是上一步 interaction.reply 建立的純文字 ephemeral
    // （沒帶 IsComponentsV2 flag），所以這裡只能用同樣不帶 v2 flag 的方式
    // editReply，不能塞 buildBackpackView 的 v2 容器，否則會被 Discord 拒收。
    await interaction.deferUpdate();

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
