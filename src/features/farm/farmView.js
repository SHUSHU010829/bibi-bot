const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { farming } = require("../../config");
const { resolveLiveStatus } = require("./farmService");
const { bagStatusLine } = require("../mining/bagStatus");

const ACCENT = {
  empty: 0x95a5a6,
  growing: 0x4a90a4,
  ready: 0x2ecc71,
  rotted: 0x7f4a2f,
  raided: 0xe74c3c,
};

function statusBadge(plot) {
  const now = Date.now();
  if (!plot.crop) return "🟫 空地";
  if (plot.status === "rotted") return "🥀 已枯萎";
  if (plot.status === "raided") return `${plot.raid?.monsterEmoji || "👾"} 被入侵！`;
  if (plot.status === "ready") return "🌟 可收成";
  if (plot.ready_at) {
    const epoch = Math.floor(plot.ready_at / 1000);
    return `🌱 成熟：<t:${epoch}:R>`;
  }
  return "🌱 成長中";
}

function plotLine(plot) {
  const idx = plot.plotIndex + 1;
  if (!plot.crop) {
    return `**地塊 ${idx}**　🟫 空地（可種植）`;
  }
  const cropDef = farming.crops?.[plot.crop] || {};
  const cropName = `${cropDef.emoji || "🌱"} ${cropDef.name || plot.crop}`;
  let extra = "";
  if (plot.yield_bonus_pct > 0) {
    extra += `　・收成 +${Math.round(plot.yield_bonus_pct * 100)}%`;
  }
  if (plot.expires_at && plot.status === "ready") {
    const epoch = Math.floor(plot.expires_at / 1000);
    extra += `　・凋萎於 <t:${epoch}:R>`;
  }
  return `**地塊 ${idx}**　${cropName}　${statusBadge(plot)}${extra}`;
}

// 依地塊狀態決定底下要顯示哪些按鈕（成熟 → 收成；空 → 種植；成長中 → 施肥）
// stamina=0 + 被入侵時，把防禦按鈕替換成「設陷阱」備案（30% 救回作物）。
function plotButtonRow(plot, userId, { stamina } = {}) {
  const row = new ActionRowBuilder();
  if (!plot.crop || plot.status === "rotted") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`farm_plant_${userId}_${plot.plotIndex}`)
        .setLabel(plot.status === "rotted" ? "清掉並種植" : "種植")
        .setEmoji("🌱")
        .setStyle(ButtonStyle.Primary),
    );
  } else if (plot.status === "ready") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`farm_harvest_${userId}_${plot.plotIndex}`)
        .setLabel("收成")
        .setEmoji("🌟")
        .setStyle(ButtonStyle.Success),
    );
  } else if (plot.status === "raided") {
    if (stamina === 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_trap_${userId}_${plot.plotIndex}`)
          .setLabel("設陷阱（沒體力備案・30% 機率救回）")
          .setEmoji("🪤")
          .setStyle(ButtonStyle.Secondary),
      );
    } else {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_defend_${userId}_${plot.plotIndex}`)
          .setLabel("防禦（耗 1 體力 + 武器）")
          .setEmoji("⚔️")
          .setStyle(ButtonStyle.Danger),
      );
    }
  } else {
    // growing
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`farm_fert_${userId}_${plot.plotIndex}`)
        .setLabel("施肥")
        .setEmoji("💧")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return row;
}

// 主畫面：每塊地一個獨立區塊 + 緊接該地塊的 ActionRow（符合 UX 規則 #1）
function buildFarmContainer({ plots, userId, plotCount, maxPlots, stamina, trapBlocksRemaining, trapBlocksUsedThisOpen, foodYieldPct = 0, worldYieldPct = 0 }) {
  const now = Date.now();
  const resolvedPlots = plots.map((p) => resolveLiveStatus(p, now));
  const readyCount = resolvedPlots.filter((p) => p.status === "ready").length;
  const accent =
    readyCount > 0 ? ACCENT.ready : (resolvedPlots.some((p) => p.status === "raided") ? ACCENT.raided : ACCENT.growing);

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🌾 你的農場（${plotCount} / ${maxPlots} 格${readyCount > 0 ? ` ・ 🌟 ${readyCount} 塊可收成` : ""}）`,
      ),
    );

  if (foodYieldPct > 0 || worldYieldPct > 0) {
    const parts = [];
    if (foodYieldPct > 0) parts.push(`🍱 食物 +${Math.round(foodYieldPct * 100)}%`);
    if (worldYieldPct > 0) parts.push(`🌍 世界活動 +${Math.round(worldYieldPct * 100)}%`);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 全農場收成加成（疊加在地塊肥料 % 之上）：${parts.join("　・　")}`,
      ),
    );
  }

  if ((trapBlocksRemaining || 0) > 0 || (trapBlocksUsedThisOpen || 0) > 0) {
    const lines = [];
    if (trapBlocksUsedThisOpen > 0) {
      lines.push(`🪤 **高級陷阱抵擋了 ${trapBlocksUsedThisOpen} 次本次來犯**`);
    }
    if (trapBlocksRemaining > 0) {
      lines.push(`-# 高級陷阱剩餘 ${trapBlocksRemaining} 次保護`);
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  }
  container.addSeparatorComponents(new SeparatorBuilder());

  const emptyCount = resolvedPlots.filter((p) => !p.crop || p.status === "rotted").length;
  const growingCount = resolvedPlots.filter((p) => p.crop && p.status === "growing").length;
  if (readyCount >= 2 || emptyCount >= 2 || growingCount >= 2) {
    const bulkRow = new ActionRowBuilder();
    if (readyCount >= 2) {
      bulkRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_harvestall_${userId}`)
          .setLabel(`一鍵收成全部（${readyCount} 塊）`)
          .setEmoji("🌟")
          .setStyle(ButtonStyle.Success),
      );
    }
    if (growingCount >= 2) {
      bulkRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_fertall_${userId}`)
          .setLabel(`一鍵施肥成長中（${growingCount} 塊）`)
          .setEmoji("💧")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (emptyCount >= 2) {
      bulkRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_plantall_${userId}`)
          .setLabel(`一鍵種植全部（${emptyCount} 塊）`)
          .setEmoji("🌱")
          .setStyle(ButtonStyle.Primary),
      );
    }
    container.addActionRowComponents(bulkRow);
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  for (const p of resolvedPlots) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(plotLine(p)));
    container.addActionRowComponents(plotButtonRow(p, userId, { stamina }));
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 💡 點各地塊下方按鈕即可種植／收成／施肥，底部按鈕可一鍵操作與擴建",
    ),
  );

  // 擴建快捷
  if (plotCount < maxPlots) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_expand_${userId}`)
          .setLabel("擴建農場")
          .setEmoji("🏗️")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return container;
}

// 成功訊息（Container），附「回到農場」快捷按鈕。收成／施肥／防禦等結果共用。
function buildSuccessContainer(title, body, userId, accent = 0x2ecc71) {
  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_view_${userId}`)
          .setLabel("回到農場")
          .setEmoji("🌾")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

// 一鍵收成結果 Container（純呈現）：把多塊地的收成聚合成作物明細＋總收益。
// /農場 收成（免填地塊）與農場面板的「一鍵收成」按鈕共用同一份，避免兩邊各印一次而漏更新。
function buildHarvestAllContainer({ results, bagFull, userId }) {
  const cropAgg = new Map();
  let totalCoins = 0;
  let totalWorldBonus = 0;
  const bonusAgg = new Map();
  for (const r of results) {
    totalCoins += r.coins || 0;
    totalWorldBonus += r.worldYieldCountBonus || 0;
    const entry = cropAgg.get(r.crop) || { def: r.cropDef, count: 0, coins: 0 };
    entry.count += r.harvestCount || 1;
    entry.coins += r.coins || 0;
    cropAgg.set(r.crop, entry);
    for (const d of r.bonusDrops || []) {
      bonusAgg.set(d.kind, (bonusAgg.get(d.kind) || 0) + d.amount);
    }
  }

  const cropLines = [...cropAgg.values()].map(
    (e) => `${e.def.emoji} **${e.def.name}** ×${e.count}（+${e.coins.toLocaleString()} 幣）`,
  );
  if (totalWorldBonus > 0) cropLines.push(`-# 含世界事件額外產出 +${totalWorldBonus} 個`);
  const bonusLines = [];
  if (bonusAgg.get("fragment")) bonusLines.push(`✨ 傳說碎片 ×${bonusAgg.get("fragment")}`);
  if (bonusAgg.get("rare_bait")) bonusLines.push(`✨ 稀有魚餌 ×${bonusAgg.get("rare_bait")}`);

  const last = results[results.length - 1];
  const body = [
    `🌾 收成 **${results.length}** 塊地`,
    ...cropLines,
    `💰 總收益：**+${totalCoins.toLocaleString()} 幣**`,
    ...bonusLines,
    bagFull
      ? `-# 🥬 菜籃中途滿了（${bagFull.used}/${bagFull.cap}），剩下的地塊還沒收，賣菜後再收一次`
      : bagStatusLine({
          label: "菜籃",
          used: last?.veggieBagUsed,
          cap: last?.veggieBagCap,
          enforceAt: farming.bagLimitEnforceAt,
          sellHint: "到 `/背包` →「🌾 農場」賣菜",
        }) || null,
  ].filter(Boolean).join("\n");

  return buildSuccessContainer("🌟 一鍵收成完成", body, userId);
}

module.exports = {
  buildFarmContainer,
  plotLine,
  plotButtonRow,
  buildSuccessContainer,
  buildHarvestAllContainer,
};
