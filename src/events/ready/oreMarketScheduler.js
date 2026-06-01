require("colors");

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { mining } = require("../../config");
const orePriceEngine = require("../../features/market/orePriceEngine");
const { registerCron } = require("../../utils/cronRegistry");

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

async function announce(client, date, prices) {
  const channelId = mining?.oreMarket?.announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const lines = Object.entries(mining.ores).map(([key, def]) => {
    const base = def.price || 0;
    const cur = typeof prices[key] === "number" ? prices[key] : base;
    return `${def.emoji || "⛏️"} ${def.name}　${base.toLocaleString()} → **${cur.toLocaleString()}** 幣　${trendLabel(cur, base)}`;
  });

  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 📊 今日礦石行情 — ${fmtDate(date)}`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 行情每日 00:00 更新　·　用 /賣出 趁高點出貨，/行情 看走勢",
      ),
    );

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch((e) => console.log(`[MARKET] 行情公告發送失敗：${e.message}`.yellow));
}

async function runDailyMarket(client) {
  const date = orePriceEngine.todayDate();
  const { prices } = await orePriceEngine.getDailyPrices(client, date);
  const removed = await orePriceEngine.pruneOld(client);
  await announce(client, date, prices);
  return { date, removed: removed || 0, ores: Object.keys(prices).length };
}

module.exports = async (client) => {
  if (!mining?.enabled || !mining?.oreMarket?.enabled) return;

  const cfg = mining.oreMarket;
  registerCron(client, {
    name: "oreMarket.freeze",
    label: "礦石每日行情",
    schedule: cfg.cronSchedule || "0 0 * * *",
    timezone: cfg.timezone || "Asia/Taipei",
    runner: () => runDailyMarket(client),
  });
};
