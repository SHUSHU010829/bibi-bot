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
function buildFarmContainer({ plots, userId, plotCount, maxPlots, stamina }) {
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
    )
    .addSeparatorComponents(new SeparatorBuilder());

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
      "-# 💡 `/種植 作物 地塊` 種下、`/收成` 收成、`/施肥 肥料 數量 地塊` 加速、`/農場擴建` 解鎖更多地塊",
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

module.exports = {
  buildFarmContainer,
  plotLine,
  plotButtonRow,
};
