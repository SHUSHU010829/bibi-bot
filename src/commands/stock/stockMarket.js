// /股市 — 整合股票買/賣/走勢/配息/報價的子指令。
//
// 「報價」子指令會顯示一個互動面板:
//   - 列出所有上市股票的當前報價
//   - 用下拉選單選個股後,跳出「買入 / 賣出 / 走勢」按鈕
//   - 買入 / 賣出 → 開啟 Modal 輸入股數 → 直接成交
//   - 走勢 → 在面板上附上走勢圖,並提供 1d / 1w / 1m 切換鈕
//
// 這樣使用者不需要再手動輸入股票代號,點按鈕就能完成買賣。

require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const { stockSystem } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const { checkServerTenure } = require("../../features/economy/eligibility");
const {
  buyMarket,
  sellMarket,
  isMarketOpen,
} = require("../../features/stock/tradeService");
const triggerService = require("../../features/stock/triggerService");
const portfolioService = require("../../features/stock/portfolioService");
const { buildChartContainer } = require("../../features/stock/chartView");
const { getDailyVolume, invalidate: invalidateVolume } = require("../../features/stock/volumeService");
const {
  buildStockHoldingsView,
} = require("../../features/profile/views/stockHoldings");

const DIVIDEND_PERIOD_MS = {
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
};

const TRADE_PERIOD_MS = {
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
};

const TRADE_PERIOD_LABEL = {
  "1w": "近 7 天",
  "1m": "近 30 天",
  "3m": "近 90 天",
};

const QUOTE_PANEL_TIMEOUT_MS = 5 * 60 * 1000;

// 為了讓 addChoices 可以用,先從 config 的 pool 取靜態股票清單;
// 若 DB 有額外股票,報價面板仍會以 DB 為準。
function getStaticSymbolChoices() {
  const pool = stockSystem?.pool || [];
  return pool.slice(0, 25).map((p) => ({
    name: `${p.symbol} ${p.name}`,
    value: p.symbol,
  }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("股市")
    .setDescription("股票市場:買賣、走勢、配息 📈")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("買")
        .setDescription("以市價買入股票 🟢")
        .addStringOption((o) =>
          o
            .setName("股票代號")
            .setDescription("從下拉選單選擇上市股票")
            .setRequired(true)
            .addChoices(...getStaticSymbolChoices())
        )
        .addIntegerOption((o) =>
          o
            .setName("數量")
            .setDescription("買入股數")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("賣")
        .setDescription("以市價賣出股票 🔴")
        .addStringOption((o) =>
          o
            .setName("股票代號")
            .setDescription("從下拉選單選擇上市股票")
            .setRequired(true)
            .addChoices(...getStaticSymbolChoices())
        )
        .addStringOption((o) =>
          o
            .setName("數量")
            .setDescription("股數,或填 all 全部賣出")
            .setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("走勢")
        .setDescription("查看單一股票的歷史走勢 📜")
        .addStringOption((o) =>
          o
            .setName("股票代號")
            .setDescription("從下拉選單選擇上市股票")
            .setRequired(true)
            .addChoices(...getStaticSymbolChoices())
        )
        .addStringOption((o) =>
          o
            .setName("期間")
            .setDescription("查詢期間(預設 1w)")
            .addChoices(
              { name: "近 24 小時", value: "1d" },
              { name: "近 7 天", value: "1w" },
              { name: "近 30 天", value: "1m" }
            )
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("配息")
        .setDescription("查詢自己過去領到的股息明細 💰")
        .addStringOption((o) =>
          o
            .setName("期間")
            .setDescription("查詢期間(預設 1m)")
            .addChoices(
              { name: "近 30 天", value: "1m" },
              { name: "近 90 天", value: "3m" }
            )
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("紀錄")
        .setDescription("查詢自己過去的股票買賣成交紀錄 📒")
        .addStringOption((o) =>
          o
            .setName("期間")
            .setDescription("查詢期間(預設 1m)")
            .addChoices(
              { name: "近 7 天", value: "1w" },
              { name: "近 30 天", value: "1m" },
              { name: "近 90 天", value: "3m" }
            )
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("股票代號")
            .setDescription("只看單一股票(預設全部)")
            .setRequired(false)
            .addChoices(...getStaticSymbolChoices())
        )
    )
    .addSubcommand((s) =>
      s
        .setName("報價")
        .setDescription("打開互動報價面板,用按鈕直接買賣 📊")
    )
    .addSubcommand((s) =>
      s
        .setName("持股")
        .setDescription("查看自己的持股、損益與一鍵賣出 💼")
    )
    .addSubcommand((s) =>
      s
        .setName("停損停利")
        .setDescription("設定股票自動停損 / 停利價（命中時開盤掃描會全倉自動賣出）🔔")
        .addStringOption((o) =>
          o
            .setName("股票代號")
            .setDescription("要設定的股票")
            .setRequired(true)
            .addChoices(...getStaticSymbolChoices())
        )
        .addNumberOption((o) =>
          o
            .setName("停損價")
            .setDescription("跌到此價自動賣出（須低於現價，留 1% 緩衝）；填 0 取消停損")
            .setRequired(false)
            .setMinValue(0)
        )
        .addNumberOption((o) =>
          o
            .setName("停利價")
            .setDescription("漲到此價自動賣出（須高於現價，留 1% 緩衝）；填 0 取消停利")
            .setRequired(false)
            .setMinValue(0)
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "買") return runBuy(client, interaction);
    if (sub === "賣") return runSell(client, interaction);
    if (sub === "走勢") return runHistory(client, interaction);
    if (sub === "配息") return runDividends(client, interaction);
    if (sub === "紀錄") return runTradeHistory(client, interaction);
    if (sub === "報價") return runQuotePanel(client, interaction);
    if (sub === "持股") return runHoldings(client, interaction);
    if (sub === "停損停利") return runSetTriggers(client, interaction);
  },
};

// ──────────────────────────── /股市 停損停利 ────────────────────────────
async function runSetTriggers(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    const tenure = checkServerTenure(interaction.member);
    if (!tenure.ok) return interaction.editReply(tenure.message);

    const symbol = interaction.options.getString("股票代號").toUpperCase().trim();
    const rawStop = interaction.options.getNumber("停損價");
    const rawTake = interaction.options.getNumber("停利價");

    if (rawStop == null && rawTake == null) {
      const position = await portfolioService.getPosition(
        client,
        interaction.user.id,
        interaction.guildId,
        symbol,
      );
      if (!position || position.shares <= 0) {
        return interaction.editReply(`❌ 你沒有持有 \`${symbol}\`。`);
      }
      const market = await client.stockMarketCollection.findOne({
        guildId: interaction.guildId,
        symbol,
      });
      const priceLabel = market ? market.currentPrice.toLocaleString() : "—";
      const stopLabel =
        position.stopLoss != null
          ? `**${position.stopLoss.toLocaleString()}**`
          : "未設定";
      const takeLabel =
        position.takeProfit != null
          ? `**${position.takeProfit.toLocaleString()}**`
          : "未設定";
      const lines = [
        `# 🔔 ${market?.name || symbol}（${symbol}）目前設定`,
        `現價：${priceLabel} ・ 持股 ${position.shares} 股`,
        `📉 停損價：${stopLabel}`,
        `📈 停利價：${takeLabel}`,
        `-# 要修改：再次執行 \`/股市 停損停利\` 並填入新價（填 0 可清除單一欄位）。`,
      ];
      return interaction.editReply(lines.join("\n"));
    }

    // 0 = 清除該欄
    const stopLoss = rawStop === 0 ? null : rawStop;
    const takeProfit = rawTake === 0 ? null : rawTake;

    if (stopLoss == null && takeProfit == null) {
      const position = await portfolioService.getPosition(
        client,
        interaction.user.id,
        interaction.guildId,
        symbol,
      );
      if (!position) return interaction.editReply(`❌ 你沒有持有 \`${symbol}\`。`);
      await triggerService.clearTriggers(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        symbol,
      });
      return interaction.editReply(`✅ 已清除 \`${symbol}\` 的停損 / 停利設定。`);
    }

    const result = await triggerService.setTriggers(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      symbol,
      stopLoss,
      takeProfit,
    });
    if (!result.ok) {
      if (result.reason === "no_position") {
        return interaction.editReply(`❌ 你沒有持有 \`${symbol}\`，無法設定觸發。`);
      }
      if (result.reason === "no_symbol") {
        return interaction.editReply(`❌ 找不到股票代號 \`${symbol}\`。`);
      }
      if (result.reason === "stop_too_close") {
        return interaction.editReply(
          `❌ 停損價太靠近現價（${result.currentPrice.toLocaleString()}），請至少留 1% 緩衝以避免抖動立刻觸發。`,
        );
      }
      if (result.reason === "take_too_close") {
        return interaction.editReply(
          `❌ 停利價太靠近現價（${result.currentPrice.toLocaleString()}），請至少留 1% 緩衝以避免抖動立刻觸發。`,
        );
      }
      return interaction.editReply("🔧 設定失敗，請稍後再試。");
    }

    const lines = [
      `# 🔔 停損 / 停利設定成功`,
      `**${result.name}（${result.symbol}）**　現價：${result.currentPrice.toLocaleString()}`,
      `📉 停損價：${result.stopLoss != null ? result.stopLoss.toLocaleString() : "未設定"}`,
      `📈 停利價：${result.takeProfit != null ? result.takeProfit.toLocaleString() : "未設定"}`,
      `-# 開盤時段每分鐘掃描一次，命中即全倉自動賣出 + 私訊通知；同股每 24 小時最多自動成交一次。`,
    ];
    return interaction.editReply(lines.join("\n"));
  } catch (err) {
    console.log(`[ERROR] /股市 停損停利:\n${err}\n${err.stack}`.red);
    return interaction.editReply("🔧 設定失敗，請呼叫舒舒！").catch(() => {});
  }
}

// ──────────────────────────── /股市 買 ────────────────────────────
async function runBuy(client, interaction) {
  await interaction.deferReply();
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.stockMarketCollection || !client.userCoinsCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }
    const tenure = checkServerTenure(interaction.member);
    if (!tenure.ok) return interaction.editReply(tenure.message);

    if (!isMarketOpen()) {
      return interaction.editReply("🌙 目前非開盤時間(09:00–21:00 Asia/Taipei)。");
    }

    const symbol = interaction.options.getString("股票代號").toUpperCase().trim();
    const shares = interaction.options.getInteger("數量");

    const result = await buyMarket(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.member?.displayName || interaction.user.username,
      member: interaction.member,
      symbol,
      shares,
    });

    if (!result.ok) return interaction.editReply(result.message);

    await interaction.editReply({
      components: [buildBuyResultContainer(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.log(`[STOCK] /股市 買 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 買入失敗,請稍後再試。").catch(() => {});
  }
}

function buildImpactLine(impact, side) {
  if (!impact || !impact.delta) return null;
  const arrow = side === "buy" ? "📈" : "📉";
  const verb = side === "buy" ? "推升" : "壓低";
  const sign = impact.delta >= 0 ? "+" : "";
  return `${arrow} 你的${side === "buy" ? "買" : "賣"}單${verb}股價 ${impact.before.toFixed(1)} → **${impact.after.toFixed(1)}**（${sign}${impact.delta.toFixed(1)}）`;
}

function buildBuyResultContainer(result) {
  const c = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🟢 買入成交｜${result.symbol} ${result.name}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**成交價**\n**${result.price.toFixed(1)}** × ${result.shares} 股`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**本金**\n${result.totalCost.toLocaleString()}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**手續費**\n${result.fee.toLocaleString()}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**總扣款**\n**${result.totalOut.toLocaleString()}**`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前持有**\n${result.newShares} 股`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**平均成本**\n${result.newAvgCost.toFixed(2)}`
      )
    );

  const impactLine = buildImpactLine(result.impact, "buy");
  if (impactLine) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(impactLine));
  }

  return c
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**餘額**\n${result.balanceAfter.toLocaleString()}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`
      )
    );
}

// ──────────────────────────── /股市 賣 ────────────────────────────
async function runSell(client, interaction) {
  await interaction.deferReply();
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.stockMarketCollection || !client.userPortfolioCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }
    const tenure = checkServerTenure(interaction.member);
    if (!tenure.ok) return interaction.editReply(tenure.message);

    if (!isMarketOpen()) {
      return interaction.editReply("🌙 目前非開盤時間(09:00–21:00 Asia/Taipei)。");
    }

    const symbol = interaction.options.getString("股票代號").toUpperCase().trim();
    const rawAmount = interaction.options.getString("數量").trim().toLowerCase();
    let shares;
    if (rawAmount === "all") {
      shares = "all";
    } else {
      shares = parseInt(rawAmount, 10);
      if (!Number.isInteger(shares) || shares <= 0) {
        return interaction.editReply("❌ 數量需為正整數或 `all`。");
      }
    }

    const result = await sellMarket(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.member?.displayName || interaction.user.username,
      member: interaction.member,
      symbol,
      shares,
    });
    if (!result.ok) return interaction.editReply(result.message);

    await interaction.editReply({
      components: [buildSellResultContainer(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.log(`[STOCK] /股市 賣 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 賣出失敗,請稍後再試。").catch(() => {});
  }
}

function buildSellResultContainer(result) {
  const pnlSign = result.pnl >= 0 ? "+" : "";
  const pnlPct =
    result.avgCost > 0 ? ((result.price - result.avgCost) / result.avgCost) * 100 : 0;

  const container = new ContainerBuilder()
    .setAccentColor(result.pnl >= 0 ? 0x2ecc71 : 0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔴 賣出成交｜${result.symbol} ${result.name}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**成交價**\n**${result.price.toFixed(1)}** × ${result.shares} 股`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**毛收入**\n${result.proceeds.toLocaleString()}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**手續費**\n${result.fee.toLocaleString()}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**淨入帳**\n**${result.netProceeds.toLocaleString()}**`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**平均成本**\n${result.avgCost.toFixed(2)}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**本筆損益**\n**${pnlSign}${result.pnl.toLocaleString()}**(${pnlSign}${pnlPct.toFixed(2)}%)`
      )
    );

  const impactLine = buildImpactLine(result.impact, "sell");
  if (impactLine) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(impactLine));
  }

  return container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**剩餘持股**\n${result.remainingShares} 股`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**餘額**\n${result.balanceAfter.toLocaleString()}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`
      )
    );
}

// ──────────────────────────── /股市 走勢 ────────────────────────────
async function runHistory(client, interaction) {
  await interaction.deferReply();
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.stockMarketCollection || !client.stockPricesCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }
    const guildId = interaction.guildId;
    const symbol = interaction.options.getString("股票代號").toUpperCase().trim();
    const period = interaction.options.getString("期間") || "1w";

    const { container, attachment } = await buildChartContainer(client, {
      guildId,
      symbol,
      period,
    });
    if (!container) {
      return interaction.editReply(attachment); // 此時 attachment 是錯誤訊息字串
    }

    await interaction.editReply({
      components: [container],
      files: attachment ? [attachment] : [],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.log(`[STOCK] /股市 走勢 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 查詢失敗,請稍後再試。").catch(() => {});
  }
}

// ──────────────────────────── /股市 配息 ────────────────────────────
async function runDividends(client, interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.stockTransactionsCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const period = interaction.options.getString("期間") || "1m";
    const periodMs = DIVIDEND_PERIOD_MS[period] || DIVIDEND_PERIOD_MS["1m"];
    const since = new Date(Date.now() - periodMs);

    const rows = await client.stockTransactionsCollection
      .find({ userId, guildId, side: "dividend", timestamp: { $gte: since } })
      .sort({ timestamp: -1 })
      .toArray();

    if (rows.length === 0) {
      return interaction.editReply(`📭 你在所選期間內沒有配息紀錄。`);
    }

    const bySymbol = new Map();
    let grandTotal = 0;
    for (const r of rows) {
      let agg = bySymbol.get(r.symbol);
      if (!agg) {
        agg = {
          symbol: r.symbol,
          count: 0,
          total: 0,
          lastShares: r.shares,
          lastAt: r.timestamp,
        };
        bySymbol.set(r.symbol, agg);
      }
      agg.count += 1;
      agg.total += r.payout || 0;
      grandTotal += r.payout || 0;
    }

    const symbols = [...bySymbol.keys()];
    let nameBySymbol = new Map();
    if (client.stockMarketCollection) {
      const markets = await client.stockMarketCollection
        .find({ guildId, symbol: { $in: symbols } })
        .toArray();
      nameBySymbol = new Map(markets.map((m) => [m.symbol, m.name]));
    }

    const summaryLines = [...bySymbol.values()]
      .sort((a, b) => b.total - a.total)
      .map((s) => {
        const name = nameBySymbol.get(s.symbol) || "";
        return `\`${s.symbol}\` ${name}　×${s.count} 次　**${s.total.toLocaleString()}** credits`;
      });

    const recentLines = rows.slice(0, 10).map((r) => {
      const ts = new Date(r.timestamp);
      const date = `${ts.getMonth() + 1}/${ts.getDate()}`;
      const name = nameBySymbol.get(r.symbol) || "";
      return `\`${date}\`　\`${r.symbol}\` ${name}　持股 ${r.shares}　+**${(r.payout || 0).toLocaleString()}**`;
    });

    const periodLabel = period === "3m" ? "近 90 天" : "近 30 天";

    const container = new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${MONEY_EMOJI} ${interaction.member?.displayName || interaction.user.username} 的配息紀錄\n${summaryLines.join("\n")}`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**期間**\n${periodLabel}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**派息次數**\n${rows.length}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**合計入帳**\n**${grandTotal.toLocaleString()}** credits`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**最近明細**\n${recentLines.join("\n") || "—"}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 配息紀錄保留 90 天 ・ <t:${Math.floor(Date.now() / 1000)}:R>`
        )
      );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.log(`[STOCK] /股市 配息 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 查詢失敗,請稍後再試。").catch(() => {});
  }
}

// ──────────────────────────── /股市 紀錄 ────────────────────────────
async function runTradeHistory(client, interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.stockTransactionsCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const period = interaction.options.getString("期間") || "1m";
    const periodMs = TRADE_PERIOD_MS[period] || TRADE_PERIOD_MS["1m"];
    const since = new Date(Date.now() - periodMs);

    const filterSymbol = interaction.options.getString("股票代號");
    const query = {
      userId,
      guildId,
      side: { $in: ["buy", "sell"] },
      timestamp: { $gte: since },
    };
    if (filterSymbol) query.symbol = filterSymbol.toUpperCase().trim();

    const rows = await client.stockTransactionsCollection
      .find(query)
      .sort({ timestamp: -1 })
      .toArray();

    if (rows.length === 0) {
      return interaction.editReply(
        filterSymbol
          ? `📭 你在所選期間內沒有 \`${filterSymbol.toUpperCase().trim()}\` 的買賣紀錄。`
          : `📭 你在所選期間內沒有買賣紀錄。`
      );
    }

    // 統計買 / 賣與已實現損益
    let buyCount = 0;
    let sellCount = 0;
    let buyShares = 0;
    let sellShares = 0;
    let buyAmount = 0; // 含手續費總支出
    let sellAmount = 0; // 扣手續費後淨入帳
    let totalFee = 0;
    let realizedPnl = 0;
    for (const r of rows) {
      totalFee += r.fee || 0;
      if (r.side === "buy") {
        buyCount += 1;
        buyShares += r.shares || 0;
        buyAmount += r.totalCost != null ? r.totalCost + (r.fee || 0) : 0;
      } else {
        sellCount += 1;
        sellShares += r.shares || 0;
        sellAmount += (r.proceeds || 0) - (r.fee || 0);
        realizedPnl += r.pnl || 0;
      }
    }

    // 撈股票名稱
    const symbols = [...new Set(rows.map((r) => r.symbol))];
    let nameBySymbol = new Map();
    if (client.stockMarketCollection) {
      const markets = await client.stockMarketCollection
        .find({ guildId, symbol: { $in: symbols } })
        .toArray();
      nameBySymbol = new Map(markets.map((m) => [m.symbol, m.name]));
    }

    const recentLines = rows.slice(0, 15).map((r) => {
      const ts = new Date(r.timestamp);
      const date = `${ts.getMonth() + 1}/${ts.getDate()}`;
      const name = nameBySymbol.get(r.symbol) || "";
      const price = (r.price || 0).toFixed(1);
      if (r.side === "buy") {
        return `\`${date}\`　🟢 買　\`${r.symbol}\` ${name}　${r.shares} 股 @ ${price}`;
      }
      const pnl = r.pnl || 0;
      const pnlSign = pnl >= 0 ? "+" : "";
      return `\`${date}\`　🔴 賣　\`${r.symbol}\` ${name}　${r.shares} 股 @ ${price}　**${pnlSign}${pnl.toLocaleString()}**`;
    });

    const pnlSign = realizedPnl >= 0 ? "+" : "";
    const titleSuffix = filterSymbol
      ? `｜${filterSymbol.toUpperCase().trim()}`
      : "";

    const container = new ContainerBuilder()
      .setAccentColor(realizedPnl >= 0 ? 0x2ecc71 : 0xe74c3c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 📒 ${interaction.member?.displayName || interaction.user.username} 的買賣紀錄${titleSuffix}`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**期間**\n${TRADE_PERIOD_LABEL[period] || "近 30 天"}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**買入**\n${buyCount} 筆 ・ ${buyShares} 股\n支出 ${buyAmount.toLocaleString()}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**賣出**\n${sellCount} 筆 ・ ${sellShares} 股\n淨入帳 ${sellAmount.toLocaleString()}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**手續費合計**\n${totalFee.toLocaleString()}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**已實現損益**\n**${pnlSign}${realizedPnl.toLocaleString()}** credits`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**最近成交**\n${recentLines.join("\n") || "—"}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 買賣紀錄保留 90 天 ・ 已實現損益僅計算賣出 ・ <t:${Math.floor(Date.now() / 1000)}:R>`
        )
      );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.log(`[STOCK] /股市 紀錄 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 查詢失敗,請稍後再試。").catch(() => {});
  }
}

// ──────────────────────────── /股市 持股 ────────────────────────────
async function runHoldings(client, interaction) {
  await interaction.deferReply();
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.userPortfolioCollection || !client.stockMarketCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }

    const view = await buildStockHoldingsView(client, {
      target: interaction.user,
      member: interaction.member,
      guildId: interaction.guildId,
    });

    if (!view.components || view.components.length === 0) {
      return interaction.editReply(view.content || "📭 目前沒有任何持股。");
    }

    await interaction.editReply({
      components: view.components,
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.log(`[STOCK] /股市 持股 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 查詢持股失敗,請稍後再試。").catch(() => {});
  }
}

// ──────────────────────────── /股市 報價 ────────────────────────────
// 互動式報價面板:用下拉選單 + 按鈕操作買 / 賣 / 看走勢,不需要再手動輸入股票代號。
async function runQuotePanel(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
    if (!client.stockMarketCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }

    const guildId = interaction.guildId;
    const stocks = await client.stockMarketCollection
      .find({ guildId })
      .sort({ symbol: 1 })
      .toArray();
    if (stocks.length === 0) {
      return interaction.editReply("📭 目前沒有任何上市股票。");
    }

    let selected = null; // 當前選中的 symbol
    let volumeBySymbol = await fetchDailyVolumeMap(client, guildId, stocks);

    const refreshVolumes = async () => {
      volumeBySymbol = await fetchDailyVolumeMap(client, guildId, stocks);
    };

    const buildComponents = (disabled = false) => {
      const select = new StringSelectMenuBuilder()
        .setCustomId("stkq_pick")
        .setPlaceholder("選擇要操作的股票")
        .setDisabled(disabled)
        .addOptions(
          stocks.slice(0, 25).map((s) => ({
            label: `${s.symbol} ${s.name}`,
            description: `當前 ${(s.currentPrice || 0).toFixed(1)}`,
            value: s.symbol,
            default: selected === s.symbol,
          }))
        );

      const noPick = !selected;
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("stkq_buy")
          .setLabel("🟢 買入")
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled || noPick),
        new ButtonBuilder()
          .setCustomId("stkq_sell")
          .setLabel("🔴 賣出")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(disabled || noPick),
        new ButtonBuilder()
          .setCustomId("stkq_chart_1d")
          .setLabel("📜 1d")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || noPick),
        new ButtonBuilder()
          .setCustomId("stkq_chart_1w")
          .setLabel("📜 1w")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || noPick),
        new ButtonBuilder()
          .setCustomId("stkq_chart_1m")
          .setLabel("📜 1m")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || noPick)
      );

      return [new ActionRowBuilder().addComponents(select), buttons];
    };

    const message = await interaction.editReply({
      content: "",
      embeds: [buildPanelEmbed(stocks, selected, { volumeBySymbol })],
      components: buildComponents(),
    });

    const collector = message.createMessageComponentCollector({
      time: QUOTE_PANEL_TIMEOUT_MS,
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== interaction.user.id) {
        return i.reply({
          content: "🚫 這是別人的報價面板。",
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        if (i.customId === "stkq_pick") {
          selected = i.values[0];
          await i.update({
            content: "",
            embeds: [buildPanelEmbed(stocks, selected, { volumeBySymbol })],
            components: buildComponents(),
          });
          collector.resetTimer();
          return;
        }

        if (i.customId.startsWith("stkq_chart_")) {
          if (!selected) return i.deferUpdate();
          await i.deferUpdate();
          const period = i.customId.replace("stkq_chart_", "");
          const { container, attachment } = await buildChartContainer(client, {
            guildId,
            symbol: selected,
            period,
          });
          if (!container) {
            await i.followUp({
              content: attachment,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          await i.followUp({
            components: [container],
            files: attachment ? [attachment] : [],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          collector.resetTimer();
          return;
        }

        if (i.customId === "stkq_buy" || i.customId === "stkq_sell") {
          if (!selected) return i.deferUpdate();
          const isBuy = i.customId === "stkq_buy";
          const modal = new ModalBuilder()
            .setCustomId(`stkq_modal_${isBuy ? "buy" : "sell"}_${selected}`)
            .setTitle(`${isBuy ? "買入" : "賣出"} ${selected}`)
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("shares")
                  .setLabel(isBuy ? "買入股數" : "賣出股數(可填 all)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMinLength(1)
                  .setMaxLength(6)
                  .setPlaceholder(isBuy ? "例如 10" : "例如 10 或 all")
              )
            );
          await i.showModal(modal);

          const submitted = await i
            .awaitModalSubmit({
              time: 60 * 1000,
              filter: (m) =>
                m.user.id === interaction.user.id &&
                m.customId === `stkq_modal_${isBuy ? "buy" : "sell"}_${selected}`,
            })
            .catch(() => null);

          if (!submitted) return;
          await submitted.deferReply({ flags: MessageFlags.Ephemeral });

          const rawShares = submitted.fields.getTextInputValue("shares").trim();

          if (!isMarketOpen()) {
            return submitted.editReply(
              "🌙 目前非開盤時間(09:00–21:00 Asia/Taipei)。"
            );
          }
          const tenure = checkServerTenure(interaction.member);
          if (!tenure.ok) return submitted.editReply(tenure.message);

          if (isBuy) {
            const shares = parseInt(rawShares, 10);
            if (!Number.isInteger(shares) || shares <= 0) {
              return submitted.editReply("❌ 股數需為正整數。");
            }
            const result = await buyMarket(client, {
              userId: interaction.user.id,
              guildId,
              username:
                interaction.member?.displayName || interaction.user.username,
              member: interaction.member,
              symbol: selected,
              shares,
            });
            if (!result.ok) return submitted.editReply(result.message);
            await submitted.editReply({
              components: [buildBuyResultContainer(result)],
              flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            });
          } else {
            let shares;
            const low = rawShares.toLowerCase();
            if (low === "all") {
              shares = "all";
            } else {
              shares = parseInt(rawShares, 10);
              if (!Number.isInteger(shares) || shares <= 0) {
                return submitted.editReply("❌ 股數需為正整數或 `all`。");
              }
            }
            const result = await sellMarket(client, {
              userId: interaction.user.id,
              guildId,
              username:
                interaction.member?.displayName || interaction.user.username,
              member: interaction.member,
              symbol: selected,
              shares,
            });
            if (!result.ok) return submitted.editReply(result.message);
            await submitted.editReply({
              components: [buildSellResultContainer(result)],
              flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            });
          }

          // 剛成交，把該股的量快取打掉再重撈，讓今日量立刻反映
          invalidateVolume({ guildId, symbol: selected });

          const refreshed = await client.stockMarketCollection
            .find({ guildId })
            .sort({ symbol: 1 })
            .toArray();
          stocks.length = 0;
          stocks.push(...refreshed);
          await refreshVolumes();
          try {
            await interaction.editReply({
              content: "",
              embeds: [buildPanelEmbed(stocks, selected, { volumeBySymbol })],
              components: buildComponents(),
            });
          } catch {
            /* 訊息已過期可忽略 */
          }
          collector.resetTimer();
        }
      } catch (err) {
        console.log(`[STOCK] /股市 報價 互動失敗:${err?.stack || err}`.red);
      }
    });

    collector.on("end", async () => {
      try {
        await interaction.editReply({
          content: "",
          embeds: [
            buildPanelEmbed(stocks, selected, { expired: true, volumeBySymbol }),
          ],
          components: buildComponents(true),
        });
      } catch {
        /* 忽略 */
      }
    });
  } catch (err) {
    console.log(`[STOCK] /股市 報價 失敗:${err?.stack || err}`.red);
    await interaction.editReply("❌ 開啟報價面板失敗。").catch(() => {});
  }
}

function buildPanelEmbed(stocks, selected, { expired = false, volumeBySymbol } = {}) {
  const open = isMarketOpen();
  const marketLabel = open ? "🟢 開盤中" : "🌙 收盤";
  const volMap = volumeBySymbol || new Map();

  // 等寬欄位:代號|名稱|報價|今日量
  const maxName = Math.max(...stocks.map((s) => [...s.name].length), 4);
  const padName = (name) => {
    const w = [...name].length;
    return name + "　".repeat(Math.max(0, maxName - w));
  };
  const rows = stocks.map((s) => {
    const tag = selected === s.symbol ? "▶︎" : "・";
    const price = (s.currentPrice || 0).toFixed(1).padStart(7, " ");
    const vol = volMap.get(s.symbol);
    const volLabel = vol && vol.totalShares > 0
      ? `量 \`${String(vol.totalShares).padStart(5, " ")}\``
      : "量 \`    -\`";
    return `${tag} \`${s.symbol}\`　${padName(s.name)}　\`${price}\`　${volLabel}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("📊 股市報價")
    .setColor(open ? 0x2ecc71 : 0x95a5a6)
    .setDescription(`**${marketLabel}**\n\n${rows.join("\n")}`)
    .setFooter({
      text: `手續費 1%(最低 ${stockSystem.minFee} 逼幣)・ 持股上限 ${stockSystem.maxSharesPerUser} 股 ・ 量=今日成交股數${expired ? " ・ 已逾時" : ""}`,
    })
    .setTimestamp();

  if (selected) {
    const cur = stocks.find((s) => s.symbol === selected);
    if (cur) {
      const vol = volMap.get(cur.symbol);
      const volLine = vol && vol.totalShares > 0
        ? `\n今日量 **${vol.totalShares.toLocaleString()}** 股 ・ 買 ${vol.buyShares.toLocaleString()} / 賣 ${vol.sellShares.toLocaleString()}`
        : `\n今日量 — （尚無成交）`;
      embed.addFields({
        name: "目前選擇",
        value: `\`${cur.symbol}\` **${cur.name}** ・ 當前報價 **${(cur.currentPrice || 0).toFixed(1)}**${volLine}`,
      });
    }
  } else {
    embed.addFields({
      name: "操作說明",
      value: "從下拉選擇一支股票後,下方按鈕會解鎖",
    });
  }

  return embed;
}

async function fetchDailyVolumeMap(client, guildId, stocks) {
  const map = new Map();
  await Promise.all(
    stocks.map(async (s) => {
      try {
        const vol = await getDailyVolume(client, { guildId, symbol: s.symbol });
        map.set(s.symbol, vol);
      } catch (err) {
        console.log(`[STOCK] daily volume fetch failed (${s.symbol}): ${err.message}`);
      }
    }),
  );
  return map;
}
