require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, fishing } = require("../../config");
const orePriceEngine = require("../../features/market/orePriceEngine");

// 礦石 + 魚類選項，value 格式 "ore:<key>" / "fish:<key>"
function itemChoices() {
  const choices = [];
  for (const [key, def] of Object.entries(mining?.ores || {})) {
    choices.push({ name: `${def.name}（礦石）`, value: `ore:${key}` });
  }
  for (const [key, def] of Object.entries(fishing?.fish || {})) {
    choices.push({ name: `${def.name}（魚類）`, value: `fish:${key}` });
  }
  return choices;
}

function fmtDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr || "";
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

function trendLabel(cur, base) {
  if (!base) return "▬";
  const pct = Math.round((cur / base - 1) * 100);
  if (pct > 0) return `▲ +${pct}%`;
  if (pct < 0) return `▼ ${pct}%`;
  return "▬ ±0%";
}

const SPARK = "▁▂▃▄▅▆▇█";

function sparkline(values) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v) => SPARK[Math.round(((v - min) / span) * (SPARK.length - 1))])
    .join("");
}

// ── 單一礦石近 7 天走勢 ──────────────────────────────────────────────────────
async function renderOreTrend(client, oreKey) {
  const def = mining.ores[oreKey];
  const history = await orePriceEngine.getPriceHistory(client, oreKey, 7);

  const today = await orePriceEngine.getDailyPrices(client);
  const todayStr = today.date;
  const todayPrice = today.prices?.[oreKey];
  if (typeof todayPrice === "number" && !history.some((h) => h.date === todayStr)) {
    history.push({ date: todayStr, price: todayPrice });
  }

  const base = def.price || 0;
  if (!history.length) {
    return new ContainerBuilder()
      .setAccentColor(0x3498db)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${def.emoji || "⛏️"} ${def.name} 價格走勢\n基礎價 **${base.toLocaleString()}** 幣\n\n尚無歷史行情紀錄，明天起會逐日累積 📈`,
        ),
      );
  }

  const lines = history.map((h) => {
    const tag = h.date === todayStr ? "（今日）" : "";
    return `\`${fmtDate(h.date)}\`${tag}　${h.price.toLocaleString()} 幣　${trendLabel(h.price, base)}`;
  });

  return new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${def.emoji || "⛏️"} ${def.name} 價格走勢\n基礎價 **${base.toLocaleString()}** 幣　近 ${history.length} 天`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${sparkline(history.map((h) => h.price))}\n${lines.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 行情每日 00:00 更新（台北時間）"),
    );
}

// ── 單一魚類近 7 天走勢 ──────────────────────────────────────────────────────
async function renderFishTrend(client, fishKey) {
  const def = fishing?.fish?.[fishKey];
  if (!def) return null;

  const history = await orePriceEngine.getFishPriceHistory(client, fishKey, 7);

  const today = await orePriceEngine.getDailyFishPrices(client);
  const todayStr = today.date;
  const todayPrice = today.prices?.[fishKey];
  if (typeof todayPrice === "number" && !history.some((h) => h.date === todayStr)) {
    history.push({ date: todayStr, price: todayPrice });
  }

  const base = def.price || 0;
  if (!history.length) {
    return new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${def.emoji} ${def.name} 價格走勢\n基礎價 **${base.toLocaleString()}** 幣\n\n尚無歷史行情紀錄，明天起會逐日累積 📈`,
        ),
      );
  }

  const lines = history.map((h) => {
    const tag = h.date === todayStr ? "（今日）" : "";
    return `\`${fmtDate(h.date)}\`${tag}　${h.price.toLocaleString()} 幣　${trendLabel(h.price, base)}`;
  });

  return new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${def.emoji} ${def.name} 價格走勢\n基礎價 **${base.toLocaleString()}** 幣　近 ${history.length} 天`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${sparkline(history.map((h) => h.price))}\n${lines.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 行情每日 00:00 更新（台北時間）"),
    );
}

// ── 今日全礦石 + 全魚類行情 ──────────────────────────────────────────────────
async function renderToday(client) {
  const [oreMarket, fishMarket] = await Promise.all([
    orePriceEngine.getDailyPrices(client),
    orePriceEngine.getDailyFishPrices(client),
  ]);

  const oreLines = Object.entries(mining.ores).map(([key, def]) => {
    const base = def.price || 0;
    const cur = typeof oreMarket.prices[key] === "number" ? oreMarket.prices[key] : base;
    return `${def.emoji || "⛏️"} ${def.name}　${base.toLocaleString()} → **${cur.toLocaleString()}** 幣　${trendLabel(cur, base)}`;
  });

  const fishLines = Object.entries(fishing?.fish || {}).map(([key, def]) => {
    const base = def.price || 0;
    const cur = typeof fishMarket.prices[key] === "number" ? fishMarket.prices[key] : base;
    return `${def.emoji} ${def.name}　${base.toLocaleString()} → **${cur.toLocaleString()}** 幣　${trendLabel(cur, base)}`;
  });

  return new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 📊 今日行情 — ${fmtDate(oreMarket.date)}`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**⛏️ 礦石**\n${oreLines.join("\n")}`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🐟 魚類**\n${fishLines.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 明日行情將於 00:00 更新　·　/行情 [物品] 看走勢",
      ),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("行情")
    .setDescription("查看今日礦石與魚類收購價，或查看近 7 天走勢 📊")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("物品")
        .setDescription("查看特定礦石或魚類近 7 天走勢，不選則顯示今日全部行情")
        .setRequired(false)
        .addChoices(...itemChoices()),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !mining?.oreMarket?.enabled) {
        return interaction.editReply("🔧 行情系統尚未啟動！");
      }

      const itemArg = interaction.options.getString("物品");

      let container;
      if (!itemArg) {
        container = await renderToday(client);
      } else {
        const [itemType, itemKey] = itemArg.split(":");
        if (itemType === "fish") {
          container = await renderFishTrend(client, itemKey);
          if (!container) return interaction.editReply("❌ 找不到這種魚。");
        } else {
          container = await renderOreTrend(client, itemKey);
        }
      }

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /行情:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查詢行情失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
