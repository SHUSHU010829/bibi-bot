require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const orePriceEngine = require("../../features/market/orePriceEngine");

// 礦石選項（純文字，避免自訂 emoji 在下拉顯示成原始字串）
function oreChoices() {
  return Object.entries(mining?.ores || {}).map(([key, def]) => ({
    name: def.name || key,
    value: key,
  }));
}

function fmtDate(dateStr) {
  // YYYYMMDD → YYYY-MM-DD
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

// 把一串價格畫成 sparkline
function sparkline(values) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / span) * (SPARK.length - 1));
      return SPARK[idx];
    })
    .join("");
}

// 單一礦石近 7 天走勢
async function renderTrend(client, oreKey) {
  const def = mining.ores[oreKey];
  const history = await orePriceEngine.getPriceHistory(client, oreKey, 7);

  // 確保今日行情已 freeze，使其也出現在走勢中
  const today = await orePriceEngine.getDailyPrices(client);
  const todayStr = today.date;
  const todayPrice = today.prices?.[oreKey];
  if (
    typeof todayPrice === "number" &&
    !history.some((h) => h.date === todayStr)
  ) {
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
    const trend = trendLabel(h.price, base);
    const tag = h.date === todayStr ? "（今日）" : "";
    return `\`${fmtDate(h.date)}\`${tag}　${h.price.toLocaleString()} 幣　${trend}`;
  });
  const spark = sparkline(history.map((h) => h.price));

  return new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${def.emoji || "⛏️"} ${def.name} 價格走勢\n基礎價 **${base.toLocaleString()}** 幣　近 ${history.length} 天`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${spark}\n${lines.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 行情每日 00:00 更新（台北時間）"),
    );
}

// 今日全礦石行情
async function renderToday(client) {
  const { date, prices } = await orePriceEngine.getDailyPrices(client);

  const lines = Object.entries(mining.ores).map(([key, def]) => {
    const base = def.price || 0;
    const cur = typeof prices[key] === "number" ? prices[key] : base;
    return `${def.emoji || "⛏️"} ${def.name}　${base.toLocaleString()} → **${cur.toLocaleString()}** 幣　${trendLabel(cur, base)}`;
  });

  return new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📊 今日礦石行情 — ${fmtDate(date)}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 明日行情將於 00:00 更新　·　/行情 [礦石] 看走勢",
      ),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("行情")
    .setDescription("查看今日礦石收購價，或指定礦石的近 7 天走勢 📊")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("礦石")
        .setDescription("查看特定礦石近 7 天價格走勢，不選則顯示今日全部行情")
        .setRequired(false)
        .addChoices(...oreChoices()),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !mining?.oreMarket?.enabled) {
        return interaction.editReply("🔧 礦石市價系統尚未啟動！");
      }

      const oreArg = interaction.options.getString("礦石");
      const container = oreArg
        ? await renderTrend(client, oreArg)
        : await renderToday(client);

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
