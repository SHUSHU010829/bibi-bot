require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { stockSystem } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const { MONEY_EMOJI } = require("../../constants/coin");

function getDividendConfig() {
  return stockSystem?.dividend || {};
}

function getPoolBySymbol(symbol) {
  return (stockSystem?.pool || []).find((p) => p.symbol === symbol) || null;
}

// 計算單筆持倉的本週應發配息
function computePayout(shares, currentPrice, annualYield, weeksPerYear, minPerHolder) {
  if (shares <= 0 || annualYield <= 0 || currentPrice <= 0) return 0;
  const raw = shares * currentPrice * annualYield / weeksPerYear;
  const floored = Math.floor(raw);
  if (floored >= 1) return floored;
  return minPerHolder || 1;
}

async function payoutForStock(client, guildId, stockDoc) {
  const cfg = getDividendConfig();
  const weeksPerYear = cfg.weeksPerYear || 52;
  const minPerHolder = cfg.minPayoutPerHolder ?? 1;

  const poolEntry = getPoolBySymbol(stockDoc.symbol);
  const annualYield = poolEntry?.dividendYield ?? 0;
  if (annualYield <= 0) return null;

  const holders = await client.userPortfolioCollection
    .find({ guildId, symbol: stockDoc.symbol, shares: { $gt: 0 } })
    .toArray();
  if (holders.length === 0) return null;

  const perSharePerWeek = (stockDoc.currentPrice * annualYield) / weeksPerYear;
  let totalPaid = 0;
  let recipients = 0;
  const recipientDetails = [];

  for (const h of holders) {
    const payout = computePayout(h.shares, stockDoc.currentPrice, annualYield, weeksPerYear, minPerHolder);
    if (payout <= 0) continue;
    try {
      const result = await grantCoins(client, {
        userId: h.userId,
        guildId,
        amount: payout,
        source: "stock_dividend",
        meta: {
          symbol: stockDoc.symbol,
          shares: h.shares,
          perSharePerWeek: Number(perSharePerWeek.toFixed(4)),
          annualYield,
        },
      });
      if (result) {
        totalPaid += result.granted;
        recipients += 1;
        recipientDetails.push({
          userId: h.userId,
          shares: h.shares,
          payout: result.granted,
        });
        await client.stockTransactionsCollection.insertOne({
          userId: h.userId,
          guildId,
          symbol: stockDoc.symbol,
          side: "dividend",
          shares: h.shares,
          price: stockDoc.currentPrice,
          payout: result.granted,
          annualYield,
          timestamp: new Date(),
        }).catch(() => {});
      }
    } catch (e) {
      console.log(`[DIV] grantCoins failed user=${h.userId} symbol=${stockDoc.symbol}: ${e?.message || e}`.yellow);
    }
  }

  return {
    symbol: stockDoc.symbol,
    name: stockDoc.name,
    annualYield,
    currentPrice: stockDoc.currentPrice,
    perSharePerWeek: Number(perSharePerWeek.toFixed(4)),
    recipients,
    totalPaid,
    recipientDetails,
  };
}

async function payoutAll(client, guildId) {
  if (!client.stockMarketCollection || !client.userPortfolioCollection) return [];
  const stocks = await client.stockMarketCollection
    .find({ guildId, enabled: { $ne: false } })
    .toArray();
  const summaries = [];
  for (const s of stocks) {
    const result = await payoutForStock(client, guildId, s);
    if (result && result.recipients > 0) summaries.push(result);
  }
  return summaries;
}

async function announce(client, guildId, summaries) {
  const channelId = stockSystem?.reportChannelId;
  if (!channelId) return;
  if (summaries.length === 0) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const totalAll = summaries.reduce((a, b) => a + b.totalPaid, 0);
  const totalRecipientHits = summaries.reduce((a, b) => a + b.recipients, 0);

  const lines = summaries.map((s) => {
    const yieldPct = (s.annualYield * 100).toFixed(1);
    return (
      `\`${s.symbol}\` ${s.name}\n` +
      `　每股 **${s.perSharePerWeek.toFixed(2)}** credits` +
      `（年化 ${yieldPct}%・現價 ${s.currentPrice.toFixed(1)}）\n` +
      `　共發放 ${s.recipients} 位股東 **${s.totalPaid.toLocaleString()}** credits`
    );
  });

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📨 逼逼股市｜本週配息派發\n${lines.join("\n\n")}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**本週總配發**\n${totalAll.toLocaleString()} credits（累計 ${totalRecipientHits} 筆派息）`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

// 彙總每位用戶在各股的本週配息，逐一 DM
async function sendDmNotifications(client, summaries) {
  if (!summaries || summaries.length === 0) return;

  const perUser = new Map();
  for (const s of summaries) {
    for (const r of s.recipientDetails || []) {
      let entry = perUser.get(r.userId);
      if (!entry) {
        entry = { userId: r.userId, total: 0, items: [] };
        perUser.set(r.userId, entry);
      }
      entry.total += r.payout;
      entry.items.push({
        symbol: s.symbol,
        name: s.name,
        shares: r.shares,
        payout: r.payout,
        annualYield: s.annualYield,
        currentPrice: s.currentPrice,
        perSharePerWeek: s.perSharePerWeek,
      });
    }
  }

  for (const entry of perUser.values()) {
    try {
      const user = await client.users.fetch(entry.userId).catch(() => null);
      if (!user) continue;

      const lines = entry.items
        .sort((a, b) => b.payout - a.payout)
        .map((it) => {
          const yieldPct = (it.annualYield * 100).toFixed(1);
          return (
            `\`${it.symbol}\` ${it.name}\n` +
            `　持股 **${it.shares}** ｜ 每股 ${it.perSharePerWeek.toFixed(2)}（年化 ${yieldPct}%）\n` +
            `　本次入帳 **${it.payout.toLocaleString()}** credits`
          );
        });

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${MONEY_EMOJI} 你本週的股息入帳\n${lines.join("\n\n")}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**本週合計**\n**${entry.total.toLocaleString()}** credits（共 ${entry.items.length} 支股票）`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await user
        .send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    } catch (e) {
      console.log(`[DIV] DM 失敗 user=${entry.userId}: ${e?.message || e}`.yellow);
    }
  }
}

module.exports = {
  payoutAll,
  payoutForStock,
  announce,
  sendDmNotifications,
  computePayout,
};
