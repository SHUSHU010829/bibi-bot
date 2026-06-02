require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { fishing } = require("../../config");

const VEGGIE_LABELS = {
  carrot: { emoji: "🥕", name: "紅蘿蔔" },
  corn: { emoji: "🌽", name: "玉米" },
  strawberry: { emoji: "🍓", name: "草莓" },
  black_rose: { emoji: "🌹", name: "黑玫瑰" },
};

function recipeMaterialsText(recipe, fishBag, backpack, veggieBag) {
  const lines = [];
  const fish = fishing.fish || {};
  for (const [key, need] of Object.entries(recipe.materials || {})) {
    const have = fishBag[key] || 0;
    const def = fish[key] || {};
    const ok = have >= need ? "✅" : "❌";
    lines.push(`${ok} ${def.emoji || "🐟"} ${def.name || key} ×${need}（持有 ${have}）`);
  }
  for (const [key, need] of Object.entries(recipe.veggies || {})) {
    const have = (veggieBag || {})[key] || 0;
    const def = VEGGIE_LABELS[key] || {};
    const ok = have >= need ? "✅" : "❌";
    lines.push(`${ok} ${def.emoji || "🌱"} ${def.name || key} ×${need}（持有 ${have}）— 來自 /農場`);
  }
  if (recipe.coalFuel > 0) {
    const have = backpack.coal || 0;
    const ok = have >= recipe.coalFuel ? "✅" : "⚠️";
    lines.push(
      `${ok} <:ore_coal:1509063448481366106> 煤炭 ×${recipe.coalFuel}（持有 ${have}）— *煤炭烤製可選*`
    );
  }
  return lines.join("\n");
}

function describeBuff(buff) {
  if (!buff) return "";
  if (buff.type === "work_income") return `打工收入 +${Math.round(buff.value * 100)}%`;
  if (buff.type === "dungeon_atk") return `地下城 ATK +${buff.value}`;
  if (buff.type === "mine_luck") return `挖礦幸運 +${Math.round(buff.value * 100)}%`;
  if (buff.type === "all_boost") return `全屬性 +${Math.round(buff.value * 100)}%`;
  if (buff.type === "fish_fortune") return `釣魚成功率 +${Math.round(buff.value * 100)}% ・ 稀有度提升`;
  if (buff.type === "farm_yield") return `農場收成 +${Math.round(buff.value * 100)}%`;
  return `${buff.type} +${buff.value}`;
}

function describeBuffDuration(buff) {
  if (!buff) return "";
  if (buff.uses_left !== null && buff.uses_left !== undefined) {
    return `剩餘 ${buff.uses_left} 次使用`;
  }
  if (buff.expires_at) {
    return `到期 <t:${Math.floor(buff.expires_at / 1000)}:R>`;
  }
  return "";
}

// 預覽烹飪會套用的 buff 類型（與 cookService.cook 內部的 buff 選擇邏輯一致）
function previewBuffType(recipe, useCoal) {
  if (!recipe) return null;
  const coalFuel = recipe.coalFuel || 0;
  const willCoalBuff = useCoal && coalFuel > 0 && recipe.coalBuff;
  const def = willCoalBuff ? recipe.coalBuff : recipe.buff;
  return def?.type || null;
}

// ─── 覆蓋確認面板 ─────────────────────────────────────────────────────────────
const CONFIRM_PREFIX = "cook_overwrite_";
const CANCEL_PREFIX  = "cook_cancel_";

function buildOverwriteConfirmView({ recipe, recipeId, useCoal, existingBuff, userId }) {
  const newDef = (useCoal && (recipe.coalFuel || 0) > 0 && recipe.coalBuff)
    ? recipe.coalBuff
    : recipe.buff;

  const existingDesc = describeBuff(existingBuff);
  const existingDur = describeBuffDuration(existingBuff);
  const existingLine = existingDur ? `${existingDesc}（${existingDur}）` : existingDesc;

  const newLine = newDef?.label || describeBuff({ type: newDef?.type, value: newDef?.value });

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⚠️ 已有相同類型的料理效果`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前效果**：${existingLine}\n` +
        `**新的效果**：${newLine}\n\n` +
        `烹飪 ${recipe.emoji} **${recipe.name}** 會**覆蓋**目前的效果，要繼續嗎？`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 食物 buff 不會疊加；確認後材料才會被消耗。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CONFIRM_PREFIX}${userId}_${useCoal ? 1 : 0}_${recipeId}`)
          .setLabel("✅ 確認覆蓋")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${CANCEL_PREFIX}${userId}`)
          .setLabel("❌ 取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildCanceledView(recipe) {
  const container = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ❌ 已取消烹飪\n` +
        (recipe ? `沒有消耗 ${recipe.emoji} **${recipe.name}** 的任何材料。` : "沒有消耗任何材料。")
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ─── 失敗訊息 ────────────────────────────────────────────────────────────────
function buildErrorView({ recipe, result, fishBag, backpack, veggieBag }) {
  if (result.reason === "insufficient_fish" || result.reason === "insufficient_veggies") {
    const materialsText = recipeMaterialsText(recipe, fishBag, backpack, veggieBag);
    const hint = result.reason === "insufficient_veggies"
      ? "前往 /農場 種植與 /收成 取得蔬菜！"
      : "前往 /釣魚 蒐集更多魚吧！";
    const container = new ContainerBuilder()
      .setAccentColor(0xe74c3c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ❌ 材料不足\n無法烹飪 ${recipe.emoji} **${recipe.name}**`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**所需材料**\n${materialsText}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${hint}`)
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  if (result.reason === "insufficient_coal") {
    const container = new ContainerBuilder()
      .setAccentColor(0xe74c3c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ❌ 煤炭不足\n煤炭烤製 **${recipe.name}** 需要 ×${result.coalNeeded} 煤炭`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `持有煤炭：${result.coalHave} 個　需要：${result.coalNeeded} 個`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 💡 不勾選「煤炭烤製」可用普通版本，效果稍弱但無需煤炭。"
        )
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  return { content: "🔧 烹飪失敗，請稍後再試。" };
}

// ─── 成功訊息 ────────────────────────────────────────────────────────────────
function buildSuccessView({ recipe, result, userId }) {
  const { isCoalEnhanced, coalUsed, newBuff } = result;
  const accentColor = isCoalEnhanced ? 0xff6b35 : 0x2ecc71;

  const buffDesc = describeBuff(newBuff);

  let durationDesc = "";
  if (newBuff.uses_left !== null && newBuff.uses_left !== undefined) {
    durationDesc = `持續 ${newBuff.uses_left} 次使用`;
  } else if (newBuff.expires_at) {
    durationDesc = `持續至 <t:${Math.floor(newBuff.expires_at / 1000)}:R>`;
  }

  const coalLine = isCoalEnhanced
    ? `\n🪨 消耗煤炭 ×${coalUsed}，獲得**強化版**效果！`
    : recipe.coalFuel > 0
    ? `\n-# 💡 加入 ${recipe.coalFuel} 個煤炭可升級效果（勾選「煤炭烤製」選項）`
    : "";

  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${recipe.emoji} ${recipe.name} 烹飪完成！${isCoalEnhanced ? " 🔥" : ""}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✨ **獲得 Buff**：${buffDesc}\n⏱️ ${durationDesc}${coalLine}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${recipe.description || ""}`)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`fish_bag_${userId}`)
          .setLabel("查看背包")
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
  CONFIRM_PREFIX,
  CANCEL_PREFIX,
  previewBuffType,
  buildOverwriteConfirmView,
  buildCanceledView,
  buildErrorView,
  buildSuccessView,
};
