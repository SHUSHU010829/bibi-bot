// 烹飪工坊按鈕 handler：分類分頁切換 + 按鈕烹飪（可一次多份、煤炭按份數疊加）。
//
// customId：
//   cookTab_<userId>_<category>             — 切換效果分類分頁
//   cookDo_<userId>_<recipeId>_<mode>_<amt> — 烹飪；mode: n(普通)/c(煤炭)，amt: 1/all

require("colors");
const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

const { fishing } = require("../../config");
const cookService = require("../../features/fishing/cookService");
const { getOrCreate } = require("../../features/mining/miningProfile");
const cookView = require("../../features/fishing/cookView");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

const {
  COOK_TAB_PREFIX,
  COOK_DO_PREFIX,
  COOK_CUSTOM_PREFIX,
  COOK_MODAL_PREFIX,
  COOK_CAT_IDS,
  COOK_CATS,
} = cookView;

const COAL_YES = /^(是|要|y|yes|true|1|o|ok|煤炭)/i;

function parseOwnerAndRest(customId, prefix) {
  const rest = customId.slice(prefix.length);
  const sep = rest.indexOf("_");
  if (sep < 0) return { ownerId: rest, rest: "" };
  return { ownerId: rest.slice(0, sep), rest: rest.slice(sep + 1) };
}

// 由 buff.type 反查食譜所屬分類，刷新時停留在同一分頁。
function categoryForRecipe(recipeId) {
  const type = fishing?.recipes?.[recipeId]?.buff?.type;
  const cat = COOK_CATS.find((c) => c.types.includes(type));
  return cat?.id || "mine";
}

async function refreshKitchen(client, interaction, category) {
  const view = await cookView.buildWorkshopView(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    displayName:
      interaction.member?.displayName ||
      interaction.user.displayName ||
      interaction.user.username,
    category,
  });
  await interaction.editReply(view);
}

// 執行烹飪並回應（interaction 須已 deferUpdate）：成功/失敗 followUp（ephemeral）＋刷新廚房。
async function executeCook(client, interaction, recipeId, useCoal, qty) {
  const recipe = fishing?.recipes?.[recipeId];
  if (!recipe) return;
  const category = categoryForRecipe(recipeId);

  if (qty < 1) {
    await refreshKitchen(client, interaction, category).catch(() => {});
    return;
  }

  const result = await cookService.cook(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    recipeId,
    useCoal,
    qty,
  });

  if (!result.ok) {
    const errView = cookView.buildErrorView({ recipe, result });
    await interaction.followUp({
      ...errView,
      flags: (errView.flags || 0) | MessageFlags.Ephemeral,
    });
    await refreshKitchen(client, interaction, category).catch(() => {});
    return;
  }

  await interaction.followUp({
    ...cookView.buildSuccessView({ recipe, result, userId: interaction.user.id }),
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
  await refreshKitchen(client, interaction, category).catch(() => {});

  applyQuestHooks(
    client,
    {
      interaction,
      user: interaction.user,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      username: interaction.user.username,
    },
    [{ questId: "weekly_cook_50", delta: result.qty }],
  ).catch(() => {});
}

async function showCustomModal(client, interaction, recipeId) {
  const recipe = fishing?.recipes?.[recipeId];
  if (!recipe) return;
  const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
  const normalMax = cookService.maxCookable(profile, recipe, { useCoal: false });
  const coalMax = cookService.maxCookable(profile, recipe, { useCoal: true });

  const modal = new ModalBuilder()
    .setCustomId(`${COOK_MODAL_PREFIX}${recipeId}`)
    .setTitle(`烹飪 ${recipe.name}`.slice(0, 45));

  const qtyInput = new TextInputBuilder()
    .setCustomId("qty")
    .setLabel("份數")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`輸入數字（目前最多可煮 ${normalMax} 份）`)
    .setValue("1")
    .setRequired(true)
    .setMaxLength(6);

  const coalInput = new TextInputBuilder()
    .setCustomId("coal")
    .setLabel(`煤炭烤製？每份 ${recipe.coalFuel} 煤炭・最多 ${coalMax} 份`.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("輸入「是」啟用煤炭烤製，留空為普通")
    .setRequired(false)
    .setMaxLength(4);

  modal.addComponents(
    new ActionRowBuilder().addComponents(qtyInput),
    new ActionRowBuilder().addComponents(coalInput),
  );

  await interaction.showModal(modal);
}

module.exports = async (client, interaction) => {
  // ── Modal 送出：自訂份數 ───────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith(COOK_MODAL_PREFIX)) return;
    const recipeId = interaction.customId.slice(COOK_MODAL_PREFIX.length);
    const recipe = fishing?.recipes?.[recipeId];
    if (!recipe) return;

    const qtyRaw = (interaction.fields.getTextInputValue("qty") || "").trim();
    const coalRaw = (interaction.fields.getTextInputValue("coal") || "").trim();
    const qty = Number.parseInt(qtyRaw, 10);
    const useCoal = coalRaw !== "" && COAL_YES.test(coalRaw);

    if (!Number.isInteger(qty) || qty < 1) {
      return interaction.reply({
        content: `❌ 份數要填正整數（你填了「${qtyRaw || "空白"}」）。`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferUpdate().catch(() => {});
    try {
      await executeCook(client, interaction, recipeId, useCoal, qty);
    } catch (err) {
      console.log(`[ERROR] cookModal handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  if (!interaction.isButton()) return;
  const { customId } = interaction;

  // 分類分頁切換
  if (customId.startsWith(COOK_TAB_PREFIX)) {
    const { ownerId, rest: category } = parseOwnerAndRest(customId, COOK_TAB_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ 這不是你的廚房！", flags: MessageFlags.Ephemeral });
    }
    if (!COOK_CAT_IDS.includes(category)) return;
    await interaction.deferUpdate();
    try {
      await refreshKitchen(client, interaction, category);
    } catch (err) {
      console.log(`[ERROR] cookTab handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  // 自訂份數 → 開 modal（不可先 defer，showModal 必須是首個回應）
  if (customId.startsWith(COOK_CUSTOM_PREFIX)) {
    const { ownerId, rest: recipeId } = parseOwnerAndRest(customId, COOK_CUSTOM_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ 這不是你的廚房！", flags: MessageFlags.Ephemeral });
    }
    try {
      await showCustomModal(client, interaction, recipeId);
    } catch (err) {
      console.log(`[ERROR] cookCustom handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  // 一鍵烹飪（×1 / 全部）
  if (customId.startsWith(COOK_DO_PREFIX)) {
    const { ownerId, rest } = parseOwnerAndRest(customId, COOK_DO_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ 這不是你的廚房！", flags: MessageFlags.Ephemeral });
    }
    const parts = rest.split("_");
    const amt = parts.pop();
    const mode = parts.pop();
    const recipeId = parts.join("_");
    const recipe = fishing?.recipes?.[recipeId];
    if (!recipe) return;

    await interaction.deferUpdate();
    try {
      const useCoal = mode === "c";
      let qty = 1;
      if (amt === "all") {
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        qty = cookService.maxCookable(profile, recipe, { useCoal });
      }
      await executeCook(client, interaction, recipeId, useCoal, qty);
    } catch (err) {
      console.log(`[ERROR] cookDo handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }
};
