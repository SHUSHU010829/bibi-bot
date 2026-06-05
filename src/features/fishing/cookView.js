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
  const { isCoalEnhanced, coalUsed, buffDef, instance } = result;
  const accentColor = isCoalEnhanced ? 0xff6b35 : 0x2ecc71;

  const effectLabel = buffDef?.label || describeBuff({ type: buffDef?.type, value: buffDef?.value });

  const coalLine = isCoalEnhanced
    ? `\n🪨 消耗煤炭 ×${coalUsed}，這份食物的**保鮮時間 ×${fishing.foodStorage?.coalMultiplier || 1.5}**`
    : recipe.coalFuel > 0
    ? `\n-# 💡 加入 ${recipe.coalFuel} 個煤炭可升級效果＋延長保鮮（勾選「煤炭烤製」選項）`
    : "";

  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${recipe.emoji} ${recipe.name} 出爐！${isCoalEnhanced ? " 🔥" : ""}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🥡 **已收進食物倉庫**\n` +
        `✨ 食用後效果：${effectLabel}${coalLine}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 食物新鮮度會隨時間衰減（一週後變廚餘堆肥）。隨時用 \`/食物\` 查看與食用。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`food_open_${userId}`)
          .setLabel("🥡 查看食物倉庫")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`food_useone_${userId}_${instance.id}`)
          .setLabel("✨ 立刻食用")
          .setStyle(ButtonStyle.Success)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
  buildErrorView,
  buildSuccessView,
};
