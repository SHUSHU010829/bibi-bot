require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require("discord.js");

const { fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const cookService = require("./cookService");
const { COAL_EMOJI, fishLabel, veggieLabel } = require("./cookMaterials");

// customId 規約：
//   cookTab_<userId>_<category>                       — 切換效果分類分頁
//   cookConfirm_<userId>_<recipeId>_<mode>_<amt>      — 開啟確認步驟（先選煤炭烤製＋份數）；mode: n(普通)/c(煤炭)，amt: 1/all
//   cookGo_<userId>_<recipeId>_<mode>_<amt>           — 確認後真正烹飪
//   cookCancel_<userId>_<category>                    — 取消確認，回到廚房分頁
//   cookCustom_<userId>_<recipeId>                    — 開啟「自訂份數」modal
//   cookModal_<recipeId>                              — modal 送出（份數 + 煤炭烤製）
const COOK_TAB_PREFIX = "cookTab_";
const COOK_CONFIRM_PREFIX = "cookConfirm_";
const COOK_GO_PREFIX = "cookGo_";
const COOK_CANCEL_PREFIX = "cookCancel_";
const COOK_CUSTOM_PREFIX = "cookCustom_";
const COOK_MODAL_PREFIX = "cookModal_";

// 依 buff.type 分類食譜（一種食譜只屬一類）。
const COOK_CATS = [
  { id: "mine", label: "挖礦", emoji: "⛏️", types: ["mine_luck"] },
  { id: "fish", label: "釣魚", emoji: "🎣", types: ["fish_fortune"] },
  { id: "work", label: "打工", emoji: "💼", types: ["work_income"] },
  { id: "battle", label: "戰鬥", emoji: "⚔️", types: ["dungeon_atk"] },
  { id: "farm", label: "農場", emoji: "🌾", types: ["farm_yield"] },
  { id: "all", label: "全能", emoji: "✨", types: ["all_boost"] },
];
const COOK_CAT_IDS = COOK_CATS.map((c) => c.id);

function recipesForCategory(catId) {
  const cat = COOK_CATS.find((c) => c.id === catId);
  if (!cat) return [];
  const recipes = fishing?.recipes || {};
  return Object.entries(recipes)
    .filter(([, r]) => cat.types.includes(r.buff?.type))
    .map(([id, r]) => ({ id, recipe: r }));
}

function describeBuff(buff) {
  if (!buff) return "";
  if (buff.label) return buff.label;
  if (buff.type === "work_income") return `打工收入 +${Math.round(buff.value * 100)}%`;
  if (buff.type === "dungeon_atk") return `地下城 ATK +${buff.value}`;
  if (buff.type === "mine_luck") return `挖礦幸運 +${Math.round(buff.value * 100)}%`;
  if (buff.type === "all_boost") return `全屬性 +${Math.round(buff.value * 100)}%`;
  if (buff.type === "fish_fortune") return `釣魚成功率 +${Math.round(buff.value * 100)}% ・ 稀有度提升`;
  if (buff.type === "farm_yield") return `農場收成 +${Math.round(buff.value * 100)}%`;
  return `${buff.type} +${buff.value}`;
}

function materialsText(recipe, profile) {
  const fishBag = profile.fish_bag || {};
  const veggieBag = profile.veggie_bag || {};
  const backpack = profile.backpack || {};
  const lines = [];
  for (const [key, need] of Object.entries(recipe.materials || {})) {
    const have = fishBag[key] || 0;
    lines.push(`${have >= need ? "✅" : "❌"} ${fishLabel(key)} ×${need}（有 ${have}）`);
  }
  for (const [key, need] of Object.entries(recipe.veggies || {})) {
    const have = veggieBag[key] || 0;
    lines.push(`${have >= need ? "✅" : "❌"} ${veggieLabel(key)} ×${need}（有 ${have}）`);
  }
  if (recipe.coalFuel > 0) {
    const have = backpack.coal || 0;
    lines.push(`${COAL_EMOJI} 煤炭 ×${recipe.coalFuel} / 份（有 ${have}・煤炭烤製用）`);
  }
  return lines.join("\n");
}

// ─── 分類分頁選單 ──────────────────────────────────────────────────────────────
// 用一個 StringSelectMenu 取代 6 顆按鈕，省下 6 個元件，避免「全能」分類
// 6 道食譜時撞到 Discord 40 元件上限。
function tabSelectRow(userId, current) {
  const currentCat = COOK_CATS.find((c) => c.id === current) || COOK_CATS[0];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${COOK_TAB_PREFIX}${userId}`)
    .setPlaceholder(`${currentCat.emoji} ${currentCat.label}加成料理`)
    .addOptions(
      COOK_CATS.map((cat) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${cat.label}加成料理`)
          .setValue(cat.id)
          .setEmoji(cat.emoji)
          .setDefault(cat.id === current),
      ),
    );
  return new ActionRowBuilder().addComponents(select);
}

function renderRecipe(container, { id, recipe }, profile, userId) {
  const normalMax = cookService.maxCookable(profile, recipe, { useCoal: false });
  const hasCoal = (recipe.coalFuel || 0) > 0;
  const coalMax = hasCoal ? cookService.maxCookable(profile, recipe, { useCoal: true }) : 0;

  const effectNormal = describeBuff(recipe.buff);
  const effectCoal = hasCoal ? describeBuff(recipe.coalBuff) : "";

  const body =
    `## ${recipe.emoji} ${recipe.name}\n` +
    materialsText(recipe, profile) +
    `\n**效果**：${effectNormal}` +
    (effectCoal ? `\n**🔥 煤炭加強**：${effectCoal}` : "") +
    `\n**目前可烹飪**：${normalMax} 份` +
    (hasCoal ? `（煤炭烤製 ${coalMax} 份）` : "");

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${COOK_CONFIRM_PREFIX}${userId}_${id}_n_1`)
      .setLabel("烹飪 ×1")
      .setEmoji("🍳")
      .setStyle(ButtonStyle.Success)
      .setDisabled(normalMax < 1),
  );
  if (normalMax >= 2) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${COOK_CONFIRM_PREFIX}${userId}_${id}_n_all`)
        .setLabel(`全部（${normalMax} 份）`)
        .setEmoji("🍳")
        .setStyle(ButtonStyle.Success),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${COOK_CUSTOM_PREFIX}${userId}_${id}`)
      .setLabel("自訂份數")
      .setEmoji("🔢")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(normalMax < 1),
  );
  container.addActionRowComponents(row);
}

// ─── 烹飪工坊（分頁 + 按鈕）─────────────────────────────────────────────────────
async function buildWorkshopView(client, { userId, guildId, displayName, category = "mine" }) {
  if (!COOK_CAT_IDS.includes(category)) category = "mine";
  const profile = await getOrCreate(client, userId, guildId);

  const cat = COOK_CATS.find((c) => c.id === category);
  const container = new ContainerBuilder().setAccentColor(0xe67e22);
  container.addActionRowComponents(tabSelectRow(userId, category));
  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🍳 ${displayName} 的廚房\n### ${cat.emoji} ${cat.label}加成料理`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 「×1 / 全部」會先讓你確認是否煤炭烤製與份數再下鍋；「🔢 自訂份數」可輸入指定份數並選擇煤炭烤製（效果更強，煤炭按份數疊加）",
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const list = recipesForCategory(category);
  if (list.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("這個分類目前沒有食譜。"),
    );
  } else {
    for (const item of list) renderRecipe(container, item, profile, userId);
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 魚來自 /釣魚、蔬菜來自 /農場、煤炭來自 /挖礦。煮好的食物進食物倉庫，用 `/食物` 食用。",
    ),
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

// ─── 確認步驟（先選煤炭烤製 + 份數，確認才烹飪）─────────────────────────────────
function buildConfirmView({ recipe, recipeId, profile, userId, category, mode, qtySpec }) {
  const hasCoal = (recipe.coalFuel || 0) > 0;
  const useCoal = mode === "c" && hasCoal;
  const max = cookService.maxCookable(profile, recipe, { useCoal });

  const qty =
    qtySpec === "all"
      ? Math.max(1, max)
      : Math.max(1, Math.floor(Number(qtySpec) || 1));
  const enough = max >= qty;

  const buffDef = useCoal && recipe.coalBuff ? recipe.coalBuff : recipe.buff;
  const effect = describeBuff(buffDef);

  const costLines = [];
  for (const [key, need] of Object.entries(recipe.materials || {})) {
    costLines.push(`${fishLabel(key)} ×${need * qty}`);
  }
  for (const [key, need] of Object.entries(recipe.veggies || {})) {
    costLines.push(`${veggieLabel(key)} ×${need * qty}`);
  }
  if (useCoal) costLines.push(`${COAL_EMOJI} 煤炭 ×${recipe.coalFuel * qty}`);

  const modeLabel = useCoal ? "🔥 煤炭烤製（效果加強・保鮮更久）" : "🍳 普通烤製";

  const container = new ContainerBuilder()
    .setAccentColor(useCoal ? 0xff6b35 : 0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${recipe.emoji} ${recipe.name}\n下鍋前先確認烤製方式與份數`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**烤製方式**：${modeLabel}\n` +
          `**份數**：${qty} 份${qtySpec === "all" ? "（目前可做的全部）" : ""}\n` +
          `**消耗材料**：${costLines.join("・") || "—"}\n` +
          `**食用效果**：${effect}`,
      ),
    );

  if (!enough) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ⚠️ 材料${useCoal ? "／煤炭" : ""}不足，目前最多只能做 ${max} 份。`,
      ),
    );
  }

  const row = new ActionRowBuilder();
  if (hasCoal) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${COOK_CONFIRM_PREFIX}${userId}_${recipeId}_${useCoal ? "n" : "c"}_${qtySpec}`)
        .setLabel(useCoal ? "改用普通烤製" : "改用煤炭烤製")
        .setEmoji(useCoal ? "🍳" : "🔥")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${COOK_GO_PREFIX}${userId}_${recipeId}_${useCoal ? "c" : "n"}_${qtySpec}`)
      .setLabel(`確認製作 ×${qty}`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!enough),
  );
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${COOK_CUSTOM_PREFIX}${userId}_${recipeId}`)
      .setLabel("自訂份數")
      .setEmoji("🔢")
      .setStyle(ButtonStyle.Primary),
  );
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${COOK_CANCEL_PREFIX}${userId}_${category}`)
      .setLabel("取消")
      .setEmoji("↩️")
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(row);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

// ─── 失敗訊息 ────────────────────────────────────────────────────────────────
function buildErrorView({ recipe, result }) {
  if (result.reason === "insufficient_fish" || result.reason === "insufficient_veggies") {
    const missing = result.reason === "insufficient_fish" ? result.missingFish : result.missingVeggies;
    const labelOf = result.reason === "insufficient_fish" ? fishLabel : veggieLabel;
    const lines = missing.map((m) => {
      const key = m.fish ?? m.veggie;
      return `${labelOf(key)} ×${m.need}（你有 ${m.have}，還缺 ${m.need - m.have}）`;
    });
    const hint = result.reason === "insufficient_veggies"
      ? "前往 /農場 種植與收成取得蔬菜！"
      : "前往 /釣魚 蒐集更多魚吧！";
    const container = new ContainerBuilder()
      .setAccentColor(0xe74c3c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ❌ 材料不足\n無法烹飪 ${recipe.emoji} **${recipe.name}** ×${result.qty || 1}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**還缺**\n${lines.join("\n")}`),
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  if (result.reason === "insufficient_coal") {
    const container = new ContainerBuilder()
      .setAccentColor(0xe74c3c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ❌ 煤炭不足\n煤炭烤製 **${recipe.name}** ×${result.qty || 1} 需要 ${COAL_EMOJI} 煤炭 ×${result.coalNeeded}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `持有煤炭：${result.coalHave} 個　需要：${result.coalNeeded} 個（還缺 ${result.coalNeeded - result.coalHave}）`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 💡 改用「烹飪」普通版本可不耗煤炭，效果稍弱；或到 /挖礦 多挖點煤炭。",
        ),
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  return { content: "🔧 烹飪失敗，請稍後再試。" };
}

// ─── 成功訊息 ────────────────────────────────────────────────────────────────
function buildSuccessView({ recipe, result, userId }) {
  const { isCoalEnhanced, coalUsed, buffDef, instance, qty = 1 } = result;
  const accentColor = isCoalEnhanced ? 0xff6b35 : 0x2ecc71;
  const effectLabel = buffDef?.label || describeBuff(buffDef);

  const coalLine = isCoalEnhanced
    ? `\n🔥 消耗 ${COAL_EMOJI} 煤炭 ×${coalUsed}（每份 ${recipe.coalFuel}），保鮮時間 ×${fishing.foodStorage?.coalMultiplier || 1.5}`
    : recipe.coalFuel > 0
      ? `\n-# 💡 加 ${recipe.coalFuel} 煤炭 / 份可升級效果＋延長保鮮（按「煤炭烤製」）`
      : "";

  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${recipe.emoji} ${recipe.name} ×${qty} 出爐！${isCoalEnhanced ? " 🔥" : ""}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🥡 **已收進食物倉庫（${qty} 份）**\n✨ 食用後效果：${effectLabel}${coalLine}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 食物新鮮度會隨時間衰減（一週後變廚餘堆肥）。隨時用 `/食物` 查看與食用。",
      ),
    );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`food_open_${userId}`)
      .setLabel("🥡 查看食物倉庫")
      .setStyle(ButtonStyle.Primary),
  );
  if (qty === 1 && instance) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`food_useone_${userId}_${instance.id}`)
        .setLabel("✨ 立刻食用")
        .setStyle(ButtonStyle.Success),
    );
  }
  container.addActionRowComponents(actionRow);

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
  COOK_TAB_PREFIX,
  COOK_CONFIRM_PREFIX,
  COOK_GO_PREFIX,
  COOK_CANCEL_PREFIX,
  COOK_CUSTOM_PREFIX,
  COOK_MODAL_PREFIX,
  COOK_CAT_IDS,
  COOK_CATS,
  buildWorkshopView,
  buildConfirmView,
  buildErrorView,
  buildSuccessView,
};
