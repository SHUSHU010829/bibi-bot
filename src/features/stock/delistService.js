require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { stockSystem } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const { roundPrice } = require("./priceEngine");
const shortService = require("./shortService");

// 個股下市：由稀有「基本面崩壞」觸發把 fairValue 一併砍到地板 → 股票黏在地板進整理期
// → 期滿未回升則按最後收盤價強制結算（多頭退幣、融券強制回補）→ 停牌 → 冷卻後換新股補位。
// 均值回歸讓純價格觸發不可能成立，故觸發走此服務的每日低機率 roll，而非隨機事件池。

const DAY_MS = 24 * 60 * 60 * 1000;

function cfg() {
  return stockSystem?.delisting || {};
}

function isEnabled() {
  return cfg().enabled === true;
}

// symbol 的產業別：現役 pool + 候補 pool 為單一來源
function stockType(symbol) {
  const all = [...(stockSystem?.pool || []), ...(stockSystem?.candidatePool || [])];
  return all.find((p) => p.symbol === symbol)?.type || null;
}

function pickCrashHeadline() {
  const list = cfg().crashHeadlines || [];
  if (list.length === 0) return { name: "基本面崩壞", detail: "公司營運出現重大危機" };
  return list[Math.floor(Math.random() * list.length)];
}

async function announce(client, container) {
  if (cfg().announce === false) return;
  const channelId = stockSystem?.announceChannelId || stockSystem?.reportChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

async function dm(client, userId, container) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  await user
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

// ── 進入下市整理期：崩 fairValue + currentPrice + openPrice（重設當日參考價，避免漲跌停把價格拉回）
async function enterWarning(client, market) {
  const floor = market.floor || 1;
  const crashPrice = roundPrice(floor * (cfg().crashFairMult ?? 1.05));
  const headline = pickCrashHeadline();
  const now = new Date();

  await client.stockMarketCollection.updateOne(
    { _id: market._id },
    {
      $set: {
        currentPrice: crashPrice,
        openPrice: crashPrice,
        fairValue: crashPrice,
        momentum: 0,
        listingStatus: "warning",
        statusSince: now,
        recoverStreak: 0,
        crashHeadline: headline.name,
        updatedAt: now,
      },
    },
  );
  if (client.stockPricesCollection) {
    await client.stockPricesCollection
      .insertOne({ guildId: market.guildId, symbol: market.symbol, price: crashPrice, timestamp: now, source: "delist_crash" })
      .catch(() => {});
  }

  const graceDays = cfg().delistGraceDays ?? 3;
  const escapePrice = roundPrice(floor * (cfg().recoverThresholdPct ?? 1.3));
  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⚠️ 下市警報｜${market.name}（\`${market.symbol}\`）`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${headline.name}**\n${headline.detail}\n\n` +
          `${market.name} 基本面崩壞，股價殺至 **${crashPrice.toFixed(1)}**，進入 **${graceDays} 天下市整理期**。\n` +
          `整理期間僅開放**賣出 / 回補**，暫停買進與放空。`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 若整理期內未能連續 ${cfg().recoverDays ?? 3} 天站上 ${escapePrice.toFixed(1)} 則正式下市，屆時持股將按最後收盤價強制結算退幣。趁早出場。`,
      ),
    );
  await announce(client, container);
  console.log(`[STOCK-DELIST] ${market.symbol} 進入下市整理（${headline.name}）`.yellow);
}

// ── 強制結算並下市：多頭按結算價退幣、融券強制回補，最後停牌
async function settleAndDelist(client, market) {
  const guildId = market.guildId;
  const symbol = market.symbol;
  const basis = cfg().settlementPriceBasis || "lastClose";
  const settlementPrice = basis === "floor" ? (market.floor || 1) : market.currentPrice;
  const now = new Date();

  // 先把結算價寫回現價，讓 coverShort 以此價回補
  await client.stockMarketCollection.updateOne(
    { _id: market._id },
    { $set: { currentPrice: settlementPrice, updatedAt: now } },
  );

  // 融券強制回補（必須在停牌前，coverShort 會擋 enabled:false）
  let shortsCovered = 0;
  const shorts = client.stockShortsCollection
    ? await client.stockShortsCollection.find({ guildId, symbol, shares: { $gt: 0 } }).toArray()
    : [];
  for (const sp of shorts) {
    const res = await shortService
      .coverShort(client, { userId: sp.userId, guildId, symbol, shares: "all", forced: true, reason: "delist" })
      .catch(() => null);
    if (res?.ok) {
      shortsCovered += 1;
      const c = new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 📉 ${market.name} 已下市\n你的融券 **${res.shares}** 股已按 每股 **${settlementPrice.toFixed(1)}** 強制回補，結算入帳 **${res.settlement.toLocaleString()}**（損益 ${res.pnl >= 0 ? "+" : ""}${res.pnl.toLocaleString()}）。`,
          ),
        );
      await dm(client, sp.userId, c);
    }
  }

  // 多頭強制結算退幣
  let holdersSettled = 0;
  let totalPaid = 0;
  const positions = client.userPortfolioCollection
    ? await client.userPortfolioCollection.find({ guildId, symbol, shares: { $gt: 0 } }).toArray()
    : [];
  for (const pos of positions) {
    const payout = Math.floor(pos.shares * settlementPrice);
    if (payout > 0) {
      await grantCoins(client, {
        userId: pos.userId,
        guildId,
        username: pos.username,
        amount: payout,
        source: "stock_delist_settlement",
        meta: { symbol, shares: pos.shares, price: settlementPrice },
      }).catch(() => null);
    }
    await client.userPortfolioCollection.deleteOne({ _id: pos._id }).catch(() => {});
    holdersSettled += 1;
    totalPaid += payout;
    const c = new ContainerBuilder()
      .setAccentColor(0x95a5a6)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 📉 ${market.name}（\`${symbol}\`）已下市\n你持有的 **${pos.shares}** 股已按 每股 **${settlementPrice.toFixed(1)}** 強制結算，退回 **${payout.toLocaleString()}** credits。`,
        ),
      );
    await dm(client, pos.userId, c);
  }

  // 停牌：撤下現役、記錄下市時間供冷卻換股
  await client.stockMarketCollection.updateOne(
    { _id: market._id },
    { $set: { listingStatus: "delisted", enabled: false, delistedAt: now, replaced: false, updatedAt: now } },
  );

  const container = new ContainerBuilder()
    .setAccentColor(0x992d22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📉 正式下市｜${market.name}（\`${symbol}\`）`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `整理期結束仍未站回門檻，${market.name} 已下市停牌。\n` +
          `已按 每股 **${settlementPrice.toFixed(1)}** 強制結算：股東 **${holdersSettled}** 人（退幣 ${totalPaid.toLocaleString()}）、融券 **${shortsCovered}** 筆。`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${cfg().relistCooldownDays ?? 7} 天後將有新股上市補位。`,
      ),
    );
  await announce(client, container);
  console.log(`[STOCK-DELIST] ${symbol} 正式下市｜股東 ${holdersSettled}・融券 ${shortsCovered}`.red);
}

// ── 推進整理期中的個股：到期下市 / 站回門檻洗白
async function advanceWarnings(client, guildId, nowMs) {
  const graceDays = cfg().delistGraceDays ?? 3;
  const recoverDays = cfg().recoverDays ?? 3;
  const warnings = await client.stockMarketCollection
    .find({ guildId, listingStatus: "warning" })
    .toArray();

  for (const m of warnings) {
    const since = m.statusSince ? new Date(m.statusSince).getTime() : nowMs;
    if (nowMs - since >= graceDays * DAY_MS) {
      await settleAndDelist(client, m);
      continue;
    }
    const escapePrice = (m.floor || 1) * (cfg().recoverThresholdPct ?? 1.3);
    if (m.currentPrice >= escapePrice) {
      const streak = (m.recoverStreak || 0) + 1;
      if (streak >= recoverDays) {
        await client.stockMarketCollection.updateOne(
          { _id: m._id },
          { $set: { listingStatus: "normal", recoverStreak: 0, updatedAt: new Date() }, $unset: { crashHeadline: "" } },
        );
        const c = new ContainerBuilder()
          .setAccentColor(0x2ecc71)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# ✅ 撤銷下市警報｜${m.name}（\`${m.symbol}\`）\n股價連續站回門檻，${m.name} 脫離下市整理，恢復正常交易。`,
            ),
          );
        await announce(client, c);
      } else {
        await client.stockMarketCollection.updateOne({ _id: m._id }, { $set: { recoverStreak: streak } });
      }
    } else if (m.recoverStreak) {
      await client.stockMarketCollection.updateOne({ _id: m._id }, { $set: { recoverStreak: 0 } });
    }
  }
}

// ── 每日低機率抽觸發：對一支合格 meme 股打基本面崩壞
async function rollNewTrigger(client, guildId) {
  if (Math.random() >= (cfg().dailyTriggerChance ?? 0.04)) return;

  const maxC = cfg().maxConcurrentDelisting ?? 0;
  if (maxC > 0) {
    const active = await client.stockMarketCollection.countDocuments({
      guildId,
      $or: [{ listingStatus: "warning" }, { listingStatus: "delisted", replaced: { $ne: true } }],
    });
    if (active >= maxC) return;
  }

  const eligibleTypes = cfg().eligibleTypes || ["meme"];
  const normals = await client.stockMarketCollection
    .find({ guildId, enabled: { $ne: false }, listingStatus: { $ne: "warning" } })
    .toArray();
  const eligible = normals.filter((m) => eligibleTypes.includes(stockType(m.symbol)));
  if (eligible.length === 0) return;

  const target = eligible[Math.floor(Math.random() * eligible.length)];
  await enterWarning(client, target);
}

// ── 換新股補位：冷卻期滿的下市股，各補一支尚未上市過的候補新股
async function relist(client, guildId, nowMs) {
  const candidates = stockSystem?.candidatePool || [];
  if (candidates.length === 0) return;
  const cooldownMs = (cfg().relistCooldownDays ?? 7) * DAY_MS;

  const ready = await client.stockMarketCollection
    .find({ guildId, listingStatus: "delisted", replaced: { $ne: true } })
    .toArray();
  const dueList = ready.filter((m) => {
    const at = m.delistedAt ? new Date(m.delistedAt).getTime() : nowMs;
    return nowMs - at >= cooldownMs;
  });
  if (dueList.length === 0) return;

  const usedSymbols = new Set(await client.stockMarketCollection.distinct("symbol", { guildId }));
  const available = candidates.filter((c) => !usedSymbols.has(c.symbol));
  const anyStock = await client.stockMarketCollection.findOne({ guildId, enabled: { $ne: false } });
  const sentiment = anyStock?.marketSentiment || stockSystem?.defaultMarketSentiment || "sideways";

  for (const old of dueList) {
    const pick = available.shift();
    if (!pick) break;
    usedSymbols.add(pick.symbol);
    const now = new Date();
    await client.stockMarketCollection.insertOne({
      guildId,
      symbol: pick.symbol,
      name: pick.name,
      currentPrice: pick.initialPrice,
      openPrice: pick.initialPrice,
      fairValue: pick.initialPrice,
      momentum: 0,
      sigma: pick.sigma,
      floor: pick.floor,
      marketSentiment: sentiment,
      enabled: true,
      listingStatus: "normal",
      listedAt: now,
    });
    await client.stockMarketCollection.updateOne({ _id: old._id }, { $set: { replaced: true } });

    const container = new ContainerBuilder()
      .setAccentColor(0x3498db)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🆕 新股上市｜${pick.name}（\`${pick.symbol}\`）`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `接替下市的 ${old.name}，${pick.name} 正式掛牌，掛牌價 **${pick.initialPrice.toFixed(1)}**。\n用 \`/股市 買 ${pick.symbol}\` 開始交易。`,
        ),
      );
    await announce(client, container);
    console.log(`[STOCK-DELIST] 新股上市 ${pick.symbol} 補位 ${old.symbol}`.green);
  }
}

async function runDailyScan(client) {
  if (!isEnabled()) return { scanned: 0 };
  if (!client.stockMarketCollection) return { scanned: 0 };
  const guildIds = await client.stockMarketCollection.distinct("guildId");
  const nowMs = Date.now();
  for (const guildId of guildIds) {
    await advanceWarnings(client, guildId, nowMs).catch((e) =>
      console.log(`[STOCK-DELIST] advanceWarnings failed guild=${guildId}: ${e?.message || e}`.yellow),
    );
    await rollNewTrigger(client, guildId).catch((e) =>
      console.log(`[STOCK-DELIST] rollNewTrigger failed guild=${guildId}: ${e?.message || e}`.yellow),
    );
    await relist(client, guildId, nowMs).catch((e) =>
      console.log(`[STOCK-DELIST] relist failed guild=${guildId}: ${e?.message || e}`.yellow),
    );
  }
  return { scanned: guildIds.length };
}

// 交易限制：warning 鎖買進 / 放空，delisted（enabled:false）由既有檢查擋下
function isBuyRestricted(market) {
  return market?.listingStatus === "warning";
}

module.exports = {
  runDailyScan,
  enterWarning,
  settleAndDelist,
  isBuyRestricted,
  stockType,
};
