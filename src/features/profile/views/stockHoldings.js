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
// 分頁 / 切換 tab / 重新整理共用同一顆 nav 按鈕：pf_stknav_<tab>_<page>_<ownerUid>
const NAV_BUTTON_PREFIX = "pf_stknav_";
const PAGE_SIZE = 6;

function buildSellCustomId(symbol, ownerUid) {
  return `${SELL_BUTTON_PREFIX}${symbol}_${ownerUid}`;
}

function buildCoverCustomId(symbol, ownerUid) {
  return `${COVER_BUTTON_PREFIX}${symbol}_${ownerUid}`;
}

// slot 只用來讓同一訊息內各按鈕的 custom_id 唯一（Discord 不允許重複），handler 不解讀它
function buildNavCustomId(tab, page, ownerUid, slot) {
  return `${NAV_BUTTON_PREFIX}${tab}_${page}_${ownerUid}_${slot}`;
}

function parseNavCustomId(customId) {
  if (!customId?.startsWith(NAV_BUTTON_PREFIX)) return null;
  const parts = customId.slice(NAV_BUTTON_PREFIX.length).split("_");
  if (parts.length < 4) return null;
  const [tab, pageStr, ownerUid] = parts;
  return { tab: tab === "short" ? "short" : "long", page: parseInt(pageStr, 10) || 0, ownerUid };
}

async function buildStockHoldingsView(client, { target, member, guildId, tab, page = 0 }) {
  if (!stockSystem?.enabled) return { content: "🔧 股市系統未啟用。" };
  if (!client.userPortfolioCollection || !client.stockMarketCollection) {
    return { content: "🔧 股市系統尚未就緒。" };
  }

  const userId = target.id;
  const positions = await portfolioService.getAllPositions(client, userId, guildId);
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

  // ── 持股（做多）
  let totalCost = 0;
  let totalValue = 0;
  let best = null;
  let worst = null;
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
      const stopPart = hasStop ? `📉 停損 **${p.stopLoss.toLocaleString()}**` : "📉 停損 未設定";
      const takePart = hasTake ? `📈 停利 **${p.takeProfit.toLocaleString()}**` : "📈 停利 未設定";
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
    if (!worst || pnl < worst.pnl) worst = { symbol: p.symbol, name: m.name, pnl };
  }
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  // ── 融券（做空）：未實現損益 = (放空均價 − 現價) × 股數
  const warnMs = (stockSystem?.short?.expiryWarnHours ?? 0) * 60 * 60 * 1000;
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
    const deadline = shortService.shortDeadline(sp);
    let deadlineLine = "";
    if (deadline) {
      const epoch = Math.floor(deadline.getTime() / 1000);
      const soon = warnMs > 0 && deadline.getTime() - Date.now() <= warnMs;
      deadlineLine = `\n　${soon ? "⚠️ 即將到期，" : "⏰ "}強制收盤 <t:${epoch}:R>`;
    }
    shortViews.push({
      symbol: sp.symbol,
      shares: sp.shares,
      text:
        `\`${sp.symbol}\` ${m.name}\n` +
        `　放空 **${sp.shares}** ｜ 均價 ${sp.avgShort.toFixed(2)} ｜ 現價 ${price.toFixed(1)}\n` +
        `　浮動損益 **${sign}${Math.round(pnl).toLocaleString()}**（${sign}${pnlPct.toFixed(2)}%）` +
        deadlineLine,
    });
  }

  // ── 決定要顯示哪個分頁：未指定時，有持股先看持股，否則看融券
  let activeTab = tab === "long" || tab === "short" ? tab : positionViews.length === 0 && shortViews.length > 0 ? "short" : "long";
  const items = activeTab === "short" ? shortViews : positionViews;
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(0, page), totalPages - 1);
  const pageItems = items.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE);

  const displayName = member?.displayName || target.username;
  const accent = activeTab === "short"
    ? shortPnlTotal >= 0 ? 0x2ecc71 : 0xe74c3c
    : totalPnl >= 0 ? 0x2ecc71 : 0xe74c3c;

  const titleText = activeTab === "short"
    ? `## 📉 ${displayName} 的融券部位`
    : `## 💼 ${displayName} 的持股`;
  const pageNote = totalPages > 1 ? `　-# 第 ${curPage + 1}/${totalPages} 頁` : "";

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText + pageNote))
    // tab 切換列：切到另一分頁一律回第 0 頁
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildNavCustomId("long", 0, target.id, "tab"))
          .setLabel(`持股 (${positionViews.length})`)
          .setEmoji("💼")
          .setStyle(activeTab === "long" ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildNavCustomId("short", 0, target.id, "tab"))
          .setLabel(`融券 (${shortViews.length})`)
          .setEmoji("📉")
          .setStyle(activeTab === "short" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (pageItems.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        activeTab === "short"
          ? "📭 目前沒有融券部位。可用 `/股市 融券` 做空。"
          : "📭 目前沒有持股。可用 `/股市 買` 開始投資。",
      ),
    );
  } else if (activeTab === "short") {
    for (const sv of pageItems) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(sv.text))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(buildCoverCustomId(sv.symbol, target.id))
              .setLabel(`回補 ${sv.symbol}`)
              .setEmoji("🔄")
              .setStyle(ButtonStyle.Primary),
          ),
      );
    }
  } else {
    for (const pv of pageItems) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(pv.text))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(buildSellCustomId(pv.symbol, target.id))
              .setLabel(`賣 ${pv.symbol}`)
              .setEmoji("🔴")
              .setStyle(ButtonStyle.Danger),
          ),
      );
    }
  }

  // ── 分頁對應的摘要
  const summaryLines = [];
  if (activeTab === "short") {
    const sSign = shortPnlTotal >= 0 ? "+" : "";
    summaryLines.push(`📉 融券浮動損益：**${sSign}${Math.round(shortPnlTotal).toLocaleString()}**`);
    if (stockSystem?.short?.maxHoldDays) {
      summaryLines.push(`-# 融券持有滿 ${stockSystem.short.maxHoldDays} 天到期強制收盤，到期前 ${stockSystem.short.expiryWarnHours ?? 0} 小時會私訊提醒`);
    }
  } else if (positionViews.length > 0) {
    const sign = totalPnl >= 0 ? "+" : "";
    summaryLines.push(
      `💵 總投入：**${Math.round(totalCost).toLocaleString()}**`,
      `📊 現值：**${Math.round(totalValue).toLocaleString()}**`,
      `${totalPnl >= 0 ? "📈" : "📉"} 總損益：**${sign}${Math.round(totalPnl).toLocaleString()}**（${sign}${totalPnlPct.toFixed(2)}%）`,
    );
    if (best) {
      const s = best.pnl >= 0 ? "+" : "";
      summaryLines.push(`🏆 最大獲利：\`${best.symbol}\` ${best.name}（${s}${Math.round(best.pnl).toLocaleString()}）`);
    }
    if (worst && worst.symbol !== best?.symbol) {
      const s = worst.pnl >= 0 ? "+" : "";
      summaryLines.push(`💀 最大虧損：\`${worst.symbol}\` ${worst.name}（${s}${Math.round(worst.pnl).toLocaleString()}）`);
    }
  }

  if (summaryLines.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(summaryLines.join("\n")));
  }

  // ── 分頁 / 重新整理列
  const navRow = new ActionRowBuilder();
  if (totalPages > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildNavCustomId(activeTab, curPage - 1, target.id, "prev"))
        .setLabel("上一頁")
        .setEmoji("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(curPage === 0),
      new ButtonBuilder()
        .setCustomId(buildNavCustomId(activeTab, curPage, target.id, "ind"))
        .setLabel(`${curPage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(buildNavCustomId(activeTab, curPage + 1, target.id, "next"))
        .setLabel("下一頁")
        .setEmoji("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(curPage >= totalPages - 1),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(buildNavCustomId(activeTab, curPage, target.id, "rf"))
      .setLabel("重新整理")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(navRow);

  return {
    useV2: true,
    components: [container],
  };
}

module.exports = {
  buildStockHoldingsView,
  parseNavCustomId,
  SELL_BUTTON_PREFIX,
  COVER_BUTTON_PREFIX,
  NAV_BUTTON_PREFIX,
};
