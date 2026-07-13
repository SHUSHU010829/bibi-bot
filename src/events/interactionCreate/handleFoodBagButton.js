require("colors");
const { MessageFlags } = require("discord.js");

const { fishing } = require("../../config");
const foodBag = require("../../features/fishing/foodBag");
const foodBagView = require("../../features/fishing/foodBagView");
const cookService = require("../../features/fishing/cookService");
const { getOrCreate: getMiningProfile } = require("../../features/mining/miningProfile");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");

const {
  OPEN_PREFIX,
  USE_ONE_PREFIX,
  USE_OK_PREFIX,
  USE_CANCEL_PREFIX,
  QTY_OPEN_PREFIX,
  QTY_SELECT_PREFIX,
  QTY_OK_PREFIX,
} = foodBagView;

function parseOwner(customId, prefix) {
  const rest = customId.slice(prefix.length);
  const sep = rest.indexOf("_");
  if (sep < 0) return { ownerId: rest, payload: "" };
  return { ownerId: rest.slice(0, sep), payload: rest.slice(sep + 1) };
}

// food_qtyok_<userId>_<qty>_<recipeId>（recipeId 含底線，故 qty 放在前面）
function parseQtyOk(customId) {
  const rest = customId.slice(QTY_OK_PREFIX.length);
  const i1 = rest.indexOf("_");
  const ownerId = rest.slice(0, i1);
  const r2 = rest.slice(i1 + 1);
  const i2 = r2.indexOf("_");
  const qty = parseInt(r2.slice(0, i2), 10);
  const recipeId = r2.slice(i2 + 1);
  return { ownerId, qty, recipeId };
}

async function openFoodBag(client, interaction, userId, guildId) {
  const profilePre = await getMiningProfile(client, userId, guildId);
  const sweepInfo = await foodBag.sweepSpoiled(client, userId, guildId, profilePre);
  const profile = sweepInfo.removed > 0
    ? await getMiningProfile(client, userId, guildId)
    : profilePre;
  const view = foodBagView.buildBagView({ userId, profile, sweepInfo });
  return interaction.editReply(view);
}

async function performUse(client, interaction, userId, guildId, instanceId, confirmOverwrite) {
  const result = await cookService.useFood(client, {
    userId,
    guildId,
    instanceId,
    confirmOverwrite,
  });
  if (result.ok) {
    return interaction.editReply(foodBagView.buildUseSuccessView({ userId, result }));
  }
  if (result.reason === "overwrite_needed") {
    return interaction.editReply(
      foodBagView.buildOverwriteConfirmView({
        userId,
        existingBuffs: result.existingBuffs,
        preview: result.preview,
        okCustomId: `${USE_OK_PREFIX}${userId}_${instanceId}`,
      })
    );
  }
  return interaction.editReply(foodBagView.buildErrorView(result.reason));
}

async function performBatchUse(client, interaction, userId, guildId, recipeId, qty, confirmOverwrite) {
  const result = await cookService.useFoodPortions(client, {
    userId,
    guildId,
    recipeId,
    qty,
    confirmOverwrite,
  });
  if (result.ok) {
    return interaction.editReply(foodBagView.buildUseSuccessView({ userId, result }));
  }
  if (result.reason === "overwrite_needed") {
    return interaction.editReply(
      foodBagView.buildOverwriteConfirmView({
        userId,
        existingBuffs: result.existingBuffs,
        preview: result.preview,
        okCustomId: `${QTY_OK_PREFIX}${userId}_${result.qty}_${recipeId}`,
        qty: result.qty,
      })
    );
  }
  return interaction.editReply(foodBagView.buildErrorView(result.reason));
}

module.exports = async (client, interaction) => {
  const isSelect = interaction.isStringSelectMenu?.();
  if (!interaction.isButton() && !isSelect) return;
  const { customId } = interaction;

  if (
    !customId.startsWith(OPEN_PREFIX) &&
    !customId.startsWith(USE_ONE_PREFIX) &&
    !customId.startsWith(USE_OK_PREFIX) &&
    !customId.startsWith(USE_CANCEL_PREFIX) &&
    !customId.startsWith(QTY_OPEN_PREFIX) &&
    !customId.startsWith(QTY_SELECT_PREFIX) &&
    !customId.startsWith(QTY_OK_PREFIX)
  ) return;

  if (!fishing?.enabled || !client.miningProfilesCollection) {
    return interaction.reply({
      content: "🔧 釣魚／烹飪系統尚未啟動！",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  try {
    // ── 打開食物倉庫 ──
    if (customId.startsWith(OPEN_PREFIX)) {
      const { ownerId } = parseOwner(customId, OPEN_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物倉庫！",
          flags: MessageFlags.Ephemeral,
        });
      }
      // 從烹飪成功訊息點來的會是公開訊息，回覆要 ephemeral 新訊息；
      // 從食用成功訊息點的本身是 ephemeral，可以直接 update。
      const fromEphemeral = !!(interaction.message?.flags?.has?.(MessageFlags.Ephemeral));
      if (fromEphemeral) {
        if (!(await deferUpdateSafe(interaction))) return;
      } else {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      }
      await openFoodBag(client, interaction, ownerId, interaction.guildId);
      return;
    }

    // ── 次數型：打開選份數食用視圖 ──
    if (customId.startsWith(QTY_OPEN_PREFIX)) {
      const { ownerId, payload: recipeId } = parseOwner(customId, QTY_OPEN_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!(await deferUpdateSafe(interaction))) return;
      const profile = await getMiningProfile(client, ownerId, interaction.guildId);
      const recipe = fishing?.recipes?.[recipeId];
      const items = foodBag
        .listFresh(profile)
        .filter((it) => it.recipeId === recipeId)
        .sort((a, b) => a.freshness - b.freshness);
      if (!recipe || items.length === 0) {
        return interaction.editReply(foodBagView.buildErrorView("not_found"));
      }
      return interaction.editReply(
        foodBagView.buildQtyChooserView({ userId: ownerId, recipeId, recipe, items })
      );
    }

    // ── 次數型：選好份數 → 食用 ──
    if (isSelect && customId.startsWith(QTY_SELECT_PREFIX)) {
      const { ownerId, payload: recipeId } = parseOwner(customId, QTY_SELECT_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!(await deferUpdateSafe(interaction))) return;
      const qty = parseInt(interaction.values?.[0], 10) || 1;
      await performBatchUse(client, interaction, ownerId, interaction.guildId, recipeId, qty, false);
      return;
    }

    // ── 次數型：覆蓋確認後批次食用 ──
    if (customId.startsWith(QTY_OK_PREFIX)) {
      const { ownerId, qty, recipeId } = parseQtyOk(customId);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!(await deferUpdateSafe(interaction))) return;
      await performBatchUse(client, interaction, ownerId, interaction.guildId, recipeId, qty, true);
      return;
    }

    // ── 食用 1 份（最舊那份）──
    if (customId.startsWith(USE_ONE_PREFIX)) {
      const { ownerId, payload: instanceId } = parseOwner(customId, USE_ONE_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      const fromEphemeral = !!(interaction.message?.flags?.has?.(MessageFlags.Ephemeral));
      if (fromEphemeral) {
        if (!(await deferUpdateSafe(interaction))) return;
      } else {
        if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
      }
      await performUse(client, interaction, ownerId, interaction.guildId, instanceId, false);
      return;
    }

    // ── 覆蓋確認後實際食用（單份）──
    if (customId.startsWith(USE_OK_PREFIX)) {
      const { ownerId, payload: instanceId } = parseOwner(customId, USE_OK_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!(await deferUpdateSafe(interaction))) return;
      await performUse(client, interaction, ownerId, interaction.guildId, instanceId, true);
      return;
    }

    // ── 取消食用 ──
    if (customId.startsWith(USE_CANCEL_PREFIX)) {
      const { ownerId } = parseOwner(customId, USE_CANCEL_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!(await deferUpdateSafe(interaction))) return;
      await interaction.editReply(foodBagView.buildCanceledView());
      return;
    }
  } catch (error) {
    console.log(`[ERROR] handleFoodBagButton (${customId}):\n${error}\n${error.stack}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(foodBagView.buildErrorView());
      } else {
        await interaction.reply({
          content: "🔧 食物倉庫操作失敗，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch { /* noop */ }
  }
};
