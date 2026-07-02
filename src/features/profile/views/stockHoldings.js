require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { stockSystem } = require("../../../config");
const portfolioService = require("../../stock/portfolioService");
const shortService = require("../../stock/shortService");

const SELL_BUTTON_PREFIX = "pf_stksell_";
const COVER_BUTTON_PREFIX = "pf_stkcover_";
const REFRESH_BUTTON_PREFIX = "pf_stkrefresh_";

function buildSellCustomId(symbol, ownerUid) {
  return `${SELL_BUTTON_PREFIX}${symbol}_${ownerUid}`;
}

function buildCoverCustomId(symbol, ownerUid) {
  return `${COVER_BUTTON_PREFIX}${symbol}_${ownerUid}`;
}

function buildRefreshCustomId(ownerUid) {
  return `${REFRESH_BUTTON_PREFIX}${ownerUid}`;
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
  const shorts = await shortService.getAllShorts(client, userId, guildId);
  if (positions.length === 0 && shorts.length === 0) {
    return { content: "📭 目前沒有任何持股。可用 `/股市 買` 開始投資,或 `/股市 融券` 做空。" };
  }

  const symbols = [
    ...new Set([...positions.map((p) => p.symbol), ...shorts.map((s) => s.symbol)]),
  ];
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

    const hasStop = p.stopLoss != null;
    const hasTake = p.takeProfit != null;
    let triggerLine;
    if (hasStop || hasTake) {
      const stopPart = hasStop
        ? `📉 停損 **${p.stopLoss.toLocaleString()}**`
        : "📉 停損 未設定";
      const takePart = hasTake
        ? `📈 停利 **${p.takeProfit.toLocaleString()}**`
        : "📈 停利 未設定";
      triggerLine = `　🔔 ${stopPart} ｜ ${takePart}`;
    } else {
      triggerLine = `　-# 🔔 未設定停損 / 停利　用 \`/股市 停損停利\` 設定`;
    }

    positionViews.push({
      symbol: p.symbol,
      shares: p.shares,
      text:
        `\`${p.symbol}\` ${m.name}\n` +
        `　持股 **${p.shares}** ｜ 均價 ${p.avgCost.toFixed(2)} ｜ 現價 ${price.toFixed(1)}\n` +
        `　損益 **${sign}${Math.round(pnl).toLocaleString()}**（${sign}${pnlPct.toFixed(2)}%）\n` +
        triggerLine,
    });
    if (!best || pnl > best.pnl) best = { symbol: p.symbol, name: m.name, pnl };
    if (!worst || pnl < worst.pnl)
      worst = { symbol: p.symbol, name: m.name, pnl };
  }

  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const sign = totalPnl >= 0 ? "+" : "";

  // 融券部位（做空）：未實現損益 = (放空均價 − 現價) × 股數
  const shortViews = [];
  let shortPnlTotal = 0;
  for (const sp of shorts) {
    const m = marketBySymbol.get(sp.symbol);
    if (!m) continue;
    const price = m.currentPrice;
    const pnl = shortService.unrealizedShortPnl(sp, price);
    shortPnlTotal += pnl;
    const sign = pnl >= 0 ? "+" : "";
    const pnlPct = sp.avgShort > 0 ? ((sp.avgShort - price) / sp.avgShort) * 100 : 0;
    shortViews.push({
      symbol: sp.symbol,
      shares: sp.shares,
      text:
        `\`${sp.symbol}\` ${m.name}\n` +
        `　放空 **${sp.shares}** ｜ 均價 ${sp.avgShort.toFixed(2)} ｜ 現價 ${price.toFixed(1)}\n` +
        `　浮動損益 **${sign}${Math.round(pnl).toLocaleString()}**（${sign}${pnlPct.toFixed(2)}%）`,
    });
  }

  const displayName = member?.displayName || target.username;
  const accent = totalPnl >= 0 ? 0x2ecc71 : 0xe74c3c;

  const summaryLines = [];
  if (positionViews.length > 0) {
    summaryLines.push(
      `💵 總投入：**${Math.round(totalCost).toLocaleString()}**`,
      `📊 現值：**${Math.round(totalValue).toLocaleString()}**`,
      `${totalPnl >= 0 ? "📈" : "📉"} 總損益：**${sign}${Math.round(totalPnl).toLocaleString()}**（${sign}${totalPnlPct.toFixed(2)}%）`,
    );
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

  // 融券部位區塊：每筆一個 Section，右側掛「🔄 回補」按鈕
  if (shortViews.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("### 📉 融券部位（做空）")
      );
    for (const sv of shortViews) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(sv.text))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(buildCoverCustomId(sv.symbol, target.id))
              .setLabel(`回補 ${sv.symbol}`)
              .setEmoji("🔄")
              .setStyle(ButtonStyle.Primary)
          )
      );
    }
    const sSign = shortPnlTotal >= 0 ? "+" : "";
    summaryLines.push(
      `📉 融券浮動損益：**${sSign}${Math.round(shortPnlTotal).toLocaleString()}**`
    );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(summaryLines.join("\n"))
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildRefreshCustomId(target.id))
          .setLabel("重新整理")
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return {
    useV2: true,
    components: [container],
  };
}

module.exports = {
  buildStockHoldingsView,
  SELL_BUTTON_PREFIX,
  COVER_BUTTON_PREFIX,
  REFRESH_BUTTON_PREFIX,
};
