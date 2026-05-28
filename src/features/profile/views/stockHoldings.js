require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { stockSystem } = require("../../../config");
const portfolioService = require("../../stock/portfolioService");

const SELL_BUTTON_PREFIX = "pf_stksell_";

function buildSellCustomId(symbol, ownerUid) {
  return `${SELL_BUTTON_PREFIX}${symbol}_${ownerUid}`;
}

async function buildStockHoldingsView(client, { target, member, guildId }) {
  if (!stockSystem?.enabled) return { content: "🔧 股市系統未啟用。" };
  if (!client.userPortfolioCollection || !client.stockMarketCollection) {
    return { content: "🔧 股市系統尚未就緒。" };
  }

  const userId = target.id;
  const positions = await portfolioService.getAllPositions(
    client,
    userId,
    guildId
  );
  if (positions.length === 0) {
    return { content: "📭 目前沒有任何持股。可用 `/股市 買` 開始投資。" };
  }

  const symbols = positions.map((p) => p.symbol);
  const marketRows = await client.stockMarketCollection
    .find({ guildId, symbol: { $in: symbols } })
    .toArray();
  const marketBySymbol = new Map(marketRows.map((m) => [m.symbol, m]));

  let totalCost = 0;
  let totalValue = 0;
  let best = null;
  let worst = null;
  // 每一筆持股的文字內容 + 是否仍可賣(shares > 0)。
  const positionViews = [];

  for (const p of positions) {
    const m = marketBySymbol.get(p.symbol);
    if (!m) continue;
    const price = m.currentPrice;
    const cost = p.avgCost * p.shares;
    const value = price * p.shares;
    const pnl = value - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    totalCost += cost;
    totalValue += value;
    const sign = pnl >= 0 ? "+" : "";
    positionViews.push({
      symbol: p.symbol,
      shares: p.shares,
      text:
        `\`${p.symbol}\` ${m.name}\n` +
        `　持股 **${p.shares}** ｜ 均價 ${p.avgCost.toFixed(2)} ｜ 現價 ${price.toFixed(1)}\n` +
        `　損益 **${sign}${Math.round(pnl).toLocaleString()}**（${sign}${pnlPct.toFixed(2)}%）`,
    });
    if (!best || pnl > best.pnl) best = { symbol: p.symbol, name: m.name, pnl };
    if (!worst || pnl < worst.pnl)
      worst = { symbol: p.symbol, name: m.name, pnl };
  }

  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const sign = totalPnl >= 0 ? "+" : "";

  const displayName = member?.displayName || target.username;
  const accent = totalPnl >= 0 ? 0x2ecc71 : 0xe74c3c;

  const summaryLines = [
    `💵 總投入：**${Math.round(totalCost).toLocaleString()}**`,
    `📊 現值：**${Math.round(totalValue).toLocaleString()}**`,
    `${totalPnl >= 0 ? "📈" : "📉"} 總損益：**${sign}${Math.round(totalPnl).toLocaleString()}**（${sign}${totalPnlPct.toFixed(2)}%）`,
  ];
  if (best) {
    const s = best.pnl >= 0 ? "+" : "";
    summaryLines.push(
      `🏆 最大獲利：\`${best.symbol}\` ${best.name}（${s}${Math.round(best.pnl).toLocaleString()}）`
    );
  }
  if (worst && worst.symbol !== best?.symbol) {
    const s = worst.pnl >= 0 ? "+" : "";
    summaryLines.push(
      `💀 最大虧損：\`${worst.symbol}\` ${worst.name}（${s}${Math.round(worst.pnl).toLocaleString()}）`
    );
  }

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 💼 ${displayName} 的持股`)
    )
    .addSeparatorComponents(new SeparatorBuilder());

  // 每筆持股做成一個 Section,文字在左、🔴 賣出 按鈕在右(Components V2 的 accessory)。
  // 沒持股的(shares = 0)只顯示文字,不掛按鈕。
  for (const pv of positionViews) {
    if (pv.shares > 0) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(pv.text)
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(buildSellCustomId(pv.symbol, target.id))
              .setLabel(`賣 ${pv.symbol}`)
              .setEmoji("🔴")
              .setStyle(ButtonStyle.Danger)
          )
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(pv.text)
      );
    }
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(summaryLines.join("\n"))
    );

  return {
    useV2: true,
    components: [container],
  };
}

module.exports = { buildStockHoldingsView, SELL_BUTTON_PREFIX };
