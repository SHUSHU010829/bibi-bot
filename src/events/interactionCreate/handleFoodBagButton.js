require("colors");
const { MessageFlags } = require("discord.js");

const { fishing } = require("../../config");
const foodBag = require("../../features/fishing/foodBag");
const foodBagView = require("../../features/fishing/foodBagView");
const cookService = require("../../features/fishing/cookService");
const { getOrCreate: getMiningProfile } = require("../../features/mining/miningProfile");

const {
  OPEN_PREFIX,
  USE_ONE_PREFIX,
  USE_OK_PREFIX,
  USE_CANCEL_PREFIX,
} = foodBagView;

function parseOwner(customId, prefix) {
  const rest = customId.slice(prefix.length);
  const sep = rest.indexOf("_");
  if (sep < 0) return { ownerId: rest, payload: "" };
  return { ownerId: rest.slice(0, sep), payload: rest.slice(sep + 1) };
}

async function openFoodBag(client, interaction, userId, guildId, asUpdate) {
  const profilePre = await getMiningProfile(client, userId, guildId);
  const sweepInfo = await foodBag.sweepSpoiled(client, userId, guildId, profilePre);
  const profile = sweepInfo.removed > 0
    ? await getMiningProfile(client, userId, guildId)
    : profilePre;
  const view = foodBagView.buildBagView({ userId, profile, sweepInfo });
  return asUpdate ? interaction.editReply(view) : interaction.editReply(view);
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
        instance: result.instance,
        existingBuff: result.existingBuff,
        preview: result.preview,
      })
    );
  }
  return interaction.editReply(foodBagView.buildErrorView(result.reason));
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;

  if (
    !customId.startsWith(OPEN_PREFIX) &&
    !customId.startsWith(USE_ONE_PREFIX) &&
    !customId.startsWith(USE_OK_PREFIX) &&
    !customId.startsWith(USE_CANCEL_PREFIX)
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
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      await openFoodBag(client, interaction, ownerId, interaction.guildId, fromEphemeral);
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
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      await performUse(client, interaction, ownerId, interaction.guildId, instanceId, false);
      return;
    }

    // ── 覆蓋確認後實際食用 ──
    if (customId.startsWith(USE_OK_PREFIX)) {
      const { ownerId, payload: instanceId } = parseOwner(customId, USE_OK_PREFIX);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "❌ 這不是你的食物！",
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferUpdate();
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
      await interaction.deferUpdate();
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
