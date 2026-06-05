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
const foodBag = require("./foodBag");

// customId prefix（給 handler / cook 成功訊息共用）
const OPEN_PREFIX     = "food_open_";     // food_open_<userId>
const USE_ONE_PREFIX  = "food_useone_";   // food_useone_<userId>_<instanceId>
const USE_OK_PREFIX   = "food_useok_";    // food_useok_<userId>_<instanceId>
const USE_CANCEL_PREFIX = "food_usecancel_"; // food_usecancel_<userId>

function freshnessTag(fresh) {
  const pct = Math.round(fresh * 100);
  if (fresh >= 0.8) return `🟢 新鮮（${pct}%）`;
  if (fresh >= 0.5) return `🟡 普通（${pct}%）`;
  if (fresh >= 0.2) return `🟠 偏舊（${pct}%）`;
  return `🔴 快壞了（${pct}%）`;
}

function buffShortDesc(type, value) {
  if (type === "work_income") return `打工收入 +${Math.round(value * 100)}%`;
  if (type === "dungeon_atk") return `地下城 ATK +${Math.round(value)}`;
  if (type === "mine_luck") return `挖礦幸運 +${Math.round(value * 100)}%`;
  if (type === "all_boost") return `全屬性 +${Math.round(value * 100)}%`;
  if (type === "fish_fortune") return `釣魚成功率 +${Math.round(value * 100)}%`;
  if (type === "farm_yield") return `農場收成 +${Math.round(value * 100)}%`;
  return `${type}`;
}

function buildOverwriteConfirmView({ userId, instance, existingBuff, preview }) {
  const recipe = preview.recipe;
  const newDesc = buffShortDesc(preview.type, preview.value);
  const existingDesc = buffShortDesc(existingBuff.type, existingBuff.value);
  const existingDur =
    existingBuff.uses_left != null
      ? `剩 ${existingBuff.uses_left} 次`
      : existingBuff.expires_at
        ? `<t:${Math.floor(existingBuff.expires_at / 1000)}:R> 到期`
        : "";
  const baseDesc = buffShortDesc(preview.type, preview.baseValue);
  const freshPct = Math.round(preview.freshness * 100);

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ⚠️ 食用會覆蓋現有效果`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前生效**：${existingDesc}${existingDur ? `（${existingDur}）` : ""}\n` +
        `**即將食用**：${recipe.emoji} ${recipe.name} → ${newDesc}\n` +
        `-# 新鮮度 ${freshPct}%（最強為 ${baseDesc}）\n\n` +
        `食用後**現有效果會被覆蓋**，要繼續嗎？`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${USE_OK_PREFIX}${userId}_${instance.id}`)
          .setLabel("✅ 確認食用（覆蓋）")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${USE_CANCEL_PREFIX}${userId}`)
          .setLabel("❌ 取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function buildUseSuccessView({ userId, result }) {
  const { instance, preview, newBuff, overwritten } = result;
  const recipe = preview.recipe;
  const freshPct = Math.round(preview.freshness * 100);
  const desc = buffShortDesc(newBuff.type, newBuff.value);
  let duration = "";
  if (newBuff.uses_left != null) duration = `（共 ${newBuff.uses_left} 次）`;
  else if (newBuff.expires_at) duration = `（<t:${Math.floor(newBuff.expires_at / 1000)}:R> 到期）`;

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🍽️ 享用 ${recipe.emoji} ${recipe.name}！`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✨ **效果**：${desc}${duration}\n` +
        `-# 食用當下新鮮度 ${freshPct}%${overwritten ? "・已覆蓋舊效果" : ""}`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${OPEN_PREFIX}${userId}`)
          .setLabel("🥡 返回食物倉庫")
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function buildBagView({ userId, profile, sweepInfo }) {
  const recipes = fishing?.recipes || {};
  const fresh = foodBag.listFresh(profile);
  const groups = foodBag.groupByRecipe(fresh);

  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🥡 食物倉庫（${fresh.length} 份）`
      )
    );

  if (sweepInfo?.removed > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🗑 剛清掉 ${sweepInfo.removed} 份腐壞食物 → +${sweepInfo.removed} 廚餘堆肥`
      )
    );
  }

  if (groups.size === 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `📭 倉庫是空的。\n用 \`/烹飪 <食物>\` 做幾份囤起來吧！`
        )
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  // 按平均新鮮度由低到高排（最該優先吃的在上面）
  const entries = [...groups.entries()].map(([rid, arr]) => {
    const avg = arr.reduce((s, it) => s + it.freshness, 0) / arr.length;
    return { recipeId: rid, items: arr, avg };
  });
  entries.sort((a, b) => a.avg - b.avg);

  for (const { recipeId, items } of entries) {
    const recipe = recipes[recipeId];
    if (!recipe) continue;
    const oldest = items[0];
    const newest = items[items.length - 1];
    const oldestPct = Math.round(oldest.freshness * 100);
    const newestPct = Math.round(newest.freshness * 100);

    const buffDef = oldest.useCoal && (recipe.coalFuel || 0) > 0 && recipe.coalBuff
      ? recipe.coalBuff
      : recipe.buff;
    const effectFull = buffDef?.label || buffShortDesc(buffDef?.type, buffDef?.value);

    const rangeText = items.length === 1
      ? freshnessTag(oldest.freshness)
      : `最舊 ${oldestPct}% ～ 最新 ${newestPct}%`;

    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## ${recipe.emoji} ${recipe.name}　×${items.length}${oldest.useCoal ? " 🔥" : ""}\n` +
          `**新鮮度**：${rangeText}\n` +
          `**效果**：${effectFull}\n` +
          `-# 食用會挑「最舊那份」（${oldestPct}%）`
        )
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${USE_ONE_PREFIX}${userId}_${oldest.id}`)
            .setLabel(`✨ 食用 1 份（${oldestPct}%）`)
            .setStyle(ButtonStyle.Success)
        )
      );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 新鮮度會隨時間衰減（普通食物 7 天歸零、煤炭烤製 ×${fishing.foodStorage?.coalMultiplier || 1.5}）。\n` +
        `-# 歸零的食物會自動轉成廚餘堆肥，下次打開倉庫時清理。`
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function buildCanceledView() {
  const container = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ❌ 已取消食用\n食物還在倉庫裡，可以晚點再用。`)
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function buildErrorView(reason) {
  const text =
    reason === "spoiled" ? "這份食物已經腐壞，無法食用（下次打開倉庫會被清成堆肥）。"
    : reason === "not_found" ? "這份食物已經不在你的倉庫了。"
    : reason === "invalid_recipe" ? "找不到這份食物對應的食譜。"
    : reason === "disabled" ? "🔧 釣魚／烹飪系統尚未啟動。"
    : "🔧 食用失敗，請稍後再試。";
  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ❌ 無法食用\n${text}`)
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

module.exports = {
  OPEN_PREFIX,
  USE_ONE_PREFIX,
  USE_OK_PREFIX,
  USE_CANCEL_PREFIX,
  freshnessTag,
  buffShortDesc,
  buildBagView,
  buildOverwriteConfirmView,
  buildUseSuccessView,
  buildCanceledView,
  buildErrorView,
};
