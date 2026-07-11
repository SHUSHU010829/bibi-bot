require("colors");

const { DateTime } = require("luxon");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { registerCron } = require("../../utils/cronRegistry");
const { bank, stockSystem, coinSystem } = require("../../config");
const goldService = require("../../features/bank/goldService");

const U = () => bank?.gold?.unitLabel || "克";

function fmt(n) {
  return Math.round(n || 0).toLocaleString();
}

function timezone() {
  return coinSystem?.daily?.resetTimezone || "Asia/Taipei";
}

// 每日黃金報價播報就發在股市播報的同一個頻道（可用 bank.gold.broadcast.channelId 覆寫）。
function resolveChannelId() {
  const b = bank?.gold?.broadcast || {};
  return b.channelId || stockSystem?.broadcastChannelId || stockSystem?.reportChannelId || null;
}

async function postGoldDaily(client) {
  const channelId = resolveChannelId();
  if (!channelId) return { skipped: "no_channel" };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { skipped: "no_channel" };

  const today = DateTime.now().setZone(timezone());
  const yestStr = today.minus({ days: 1 }).toFormat("yyyyMMdd");

  const prices = await goldService.getPrices();
  const spot = prices.spot;
  const prevSpot = goldService.spotPrice(yestStr);
  const base = bank?.gold?.basePrice || spot;

  const dayChg = prevSpot > 0 ? ((spot - prevSpot) / prevSpot) * 100 : 0;
  const dayArrow = dayChg > 0 ? "🔺" : dayChg < 0 ? "🔻" : "➖";
  const daySign = dayChg > 0 ? "+" : "";
  const baseChg = base > 0 ? (spot / base - 1) * 100 : 0;
  const baseTrend =
    baseChg > 0 ? `▲ +${Math.round(baseChg)}%` : baseChg < 0 ? `▼ ${Math.round(baseChg)}%` : "▬ ±0%";
  const color = dayChg > 0 ? 0x2ecc71 : dayChg < 0 ? 0xe74c3c : 0xf1c40f;

  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🪙 今日純金報價\n-# ${today.toFormat("yyyy/MM/dd")}　每日浮動貴金屬`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `現貨價 **${fmt(spot)}** 幣/${U()}　${dayArrow} ${daySign}${dayChg.toFixed(1)}%（昨日 ${fmt(prevSpot)}）\n` +
          `基準線 ${fmt(base)} 幣　${baseTrend}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🟢 銀行買進 **${fmt(prices.buy)}**　　🔴 銀行賣出 **${fmt(prices.sell)}**　（幣/${U()}）`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# /銀行 → 🪙 黃金存摺 買賣純金・可查看平均成本與現在賣出的損益",
      ),
    );

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch((e) => console.log(`[GOLD] daily broadcast send failed: ${e?.message || e}`.yellow));
  return { posted: true, spot, dayChg };
}

module.exports = async (client) => {
  const g = bank?.gold;
  if (!g?.enabled || !g?.broadcast?.enabled) {
    console.log(`[GOLD] 黃金每日播報未啟用，跳過排程`.gray);
    return;
  }
  registerCron(client, {
    name: "gold.dailyBroadcast",
    label: "每日黃金報價播報",
    schedule: g.broadcast.cronSchedule || "0 9 * * *",
    timezone: timezone(),
    runner: () => postGoldDaily(client),
  });
};

module.exports.postGoldDaily = postGoldDaily;
