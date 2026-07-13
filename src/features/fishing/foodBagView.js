require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");

const { fishing } = require("../../config");
const foodBag = require("./foodBag");

// customId prefix（給 handler / cook 成功訊息共用）
const OPEN_PREFIX     = "food_open_";     // food_open_<userId>
const USE_ONE_PREFIX  = "food_useone_";   // food_useone_<userId>_<instanceId>
const USE_OK_PREFIX   = "food_useok_";    // food_useok_<userId>_<instanceId>
const USE_CANCEL_PREFIX = "food_usecancel_"; // food_usecancel_<userId>
// 次數型食物：選份數食用（recipeId 內含底線，故 qty 一律放在 recipeId 前面）
const QTY_OPEN_PREFIX = "food_useqty_";   // food_useqty_<userId>_<recipeId>
const QTY_SELECT_PREFIX = "food_qtysel_"; // food_qtysel_<userId>_<recipeId>（value = qty）
const QTY_OK_PREFIX   = "food_qtyok_";    // food_qtyok_<userId>_<qty>_<recipeId>

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

// okCustomId：確認覆蓋後要觸發的按鈕 customId（單份走 instance、多份走 qty+recipe）。
function buildOverwriteConfirmView({ userId, existingBuffs, preview, okCustomId, qty = 1 }) {
  const recipe = preview.recipe;
  const newDesc = buffShortDesc(preview.type, preview.value);
  const existingLines = existingBuffs.map((b) => {
    const desc = buffShortDesc(b.type, b.value);
    const dur =
      b.uses_left != null
        ? `剩 ${b.uses_left} 次`
        : b.expires_at
          ? `<t:${Math.floor(b.expires_at / 1000)}:R> 到期`
          : "";
    return `・${desc}${dur ? `（${dur}）` : ""}`;
  });
  const baseDesc = buffShortDesc(preview.type, preview.baseValue);
  const freshPct = Math.round(preview.freshness * 100);
  const isAllBoost = preview.type === "all_boost";
  const conflictNote = isAllBoost
    ? "全屬性與其他單屬性 buff 互斥"
    : existingBuffs.some((b) => b.type === "all_boost")
      ? "單屬性與全屬性 buff 互斥"
      : "同類型 buff 互斥";
  const qtyLabel = qty > 1 ? ` ×${qty} 份` : "";

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ⚠️ 食用會覆蓋現有效果`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前生效**：\n${existingLines.join("\n")}\n` +
        `**即將食用**：${recipe.emoji} ${recipe.name}${qtyLabel} → ${newDesc}\n` +
        `-# 新鮮度 ${freshPct}%（最強為 ${baseDesc}）・${conflictNote}\n\n` +
        `食用後**上述效果會全部被覆蓋**，要繼續嗎？`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(okCustomId)
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

// 次數型食物選份數食用的中間視圖（StringSelect 選 1..N 份）。
function buildQtyChooserView({ userId, recipeId, recipe, items }) {
  const oldest = items[0];
  const buffDef = oldest.useCoal && (recipe.coalFuel || 0) > 0 && recipe.coalBuff
    ? recipe.coalBuff
    : recipe.buff;
  const usesPer = buffDef?.uses || 1;
  const total = items.length;
  const maxPick = Math.min(total, 25);

  const options = [];
  for (let n = 1; n <= maxPick; n++) {
    options.push({
      label: `食用 ${n} 份`,
      description: `累計 +${n * usesPer} 次效果`,
      value: String(n),
    });
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🍽️ ${recipe.emoji} ${recipe.name}：要吃幾份？`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**效果**：${buffDef?.label || buffShortDesc(buffDef?.type, buffDef?.value)}\n` +
        `-# 每份 +${usesPer} 次，可累計。倉庫共有 ${total} 份，` +
        `會從最舊那份開始吃${total > 25 ? "（一次最多選 25 份）" : ""}。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${QTY_SELECT_PREFIX}${userId}_${recipeId}`)
          .setPlaceholder("選擇食用份數")
          .addOptions(options)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${USE_CANCEL_PREFIX}${userId}`)
          .setLabel("❌ 取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function buildUseSuccessView({ userId, result }) {
  const { preview, newBuff, overwritten, accumulated, qty = 1 } = result;
  const recipe = preview.recipe;
  const freshPct = Math.round(preview.freshness * 100);
  const desc = buffShortDesc(newBuff.type, newBuff.value);
  let duration = "";
  if (newBuff.uses_left != null) duration = `（共 ${newBuff.uses_left} 次）`;
  else if (newBuff.expires_at) duration = `（<t:${Math.floor(newBuff.expires_at / 1000)}:R> 到期）`;
  const qtyTitle = qty > 1 ? ` ×${qty}` : "";
  const note = accumulated
    ? "・已累計到現有效果"
    : overwritten
      ? "・已覆蓋舊效果"
      : "";

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🍽️ 享用 ${recipe.emoji} ${recipe.name}${qtyTitle}！`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✨ **效果**：${desc}${duration}\n` +
        `-# 食用當下新鮮度 ${freshPct}%${note}`
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
    const isUseBased = buffDef?.uses != null;

    const rangeText = items.length === 1
      ? freshnessTag(oldest.freshness)
      : `最舊 ${oldestPct}% ～ 最新 ${newestPct}%`;
    const hint = isUseBased
      ? "-# 次數型可累計；多份時可選要吃幾份（從最舊開始）"
      : `-# 食用會挑「最舊那份」（${oldestPct}%）`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${recipe.emoji} ${recipe.name}　×${items.length}${oldest.useCoal ? " 🔥" : ""}\n` +
        `**新鮮度**：${rangeText}\n` +
        `**效果**：${effectFull}\n` +
        hint
      )
    );

    // 次數型且有多份 → 選份數食用；否則單份食用最舊那份。
    if (isUseBased && items.length > 1) {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${QTY_OPEN_PREFIX}${userId}_${recipeId}`)
            .setLabel(`🍽️ 選份數食用（1–${items.length} 份）`)
            .setStyle(ButtonStyle.Success)
        )
      );
    } else {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${USE_ONE_PREFIX}${userId}_${oldest.id}`)
            .setLabel(`✨ 食用 1 份（${oldestPct}%）`)
            .setStyle(ButtonStyle.Success)
        )
      );
    }
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
  QTY_OPEN_PREFIX,
  QTY_SELECT_PREFIX,
  QTY_OK_PREFIX,
  freshnessTag,
  buffShortDesc,
  buildBagView,
  buildOverwriteConfirmView,
  buildQtyChooserView,
  buildUseSuccessView,
  buildCanceledView,
  buildErrorView,
};
