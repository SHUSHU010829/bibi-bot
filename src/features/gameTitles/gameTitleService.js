require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const { gameTitles, mining, commandChannels } = require("../../config");

// 遊戲區共用稱號系統。
// - 解鎖清單存 UserLevels.gameTitles（與 badges 平行）。
// - 展示中的稱號沿用 UserLevels.title（錢包卡 / 升等公告本來就讀這個欄位）。
// - 成就條件全部可由既有資料推導，於各遊戲動作後呼叫 check() 重算。
// - 週冠（mine_king）為 weekly 型，由 miningWeeklyRank cron 直接 grant / revoke，不進 check。

function cfg() {
  return gameTitles || {};
}
function defs() {
  return cfg().defs || {};
}
function def(id) {
  return defs()[id] || null;
}
function order() {
  const o = cfg().order;
  return Array.isArray(o) && o.length ? o : Object.keys(defs());
}
function label(id) {
  const d = def(id);
  if (!d) return id;
  return `${d.emoji || ""} ${d.name || id}`.trim();
}
function categoryLabel(cat) {
  return cfg().categoryLabels?.[cat] || cat;
}
function idsByCategory(cat) {
  return order().filter((id) => def(id)?.category === cat);
}

async function getDoc(client, userId, guildId) {
  if (!client.userLevelsCollection) return null;
  return client.userLevelsCollection.findOne({ userId, guildId }).catch(() => null);
}

async function getUnlocked(client, userId, guildId) {
  const doc = await getDoc(client, userId, guildId);
  return new Set(doc?.gameTitles || []);
}

// 稱號詮釋資料（與 gameTitles 字串清單平行存放，向後相容）：
//   gameTitleMeta: [{ titleId, grantedAt, expiresAt|null, source, status }]
// gameTitles 仍是權威解鎖清單（$addToSet/$pull），meta 僅補充時效 / 來源 / 紀錄。
async function getTitleMeta(client, userId, guildId) {
  const doc = await getDoc(client, userId, guildId);
  return Array.isArray(doc?.gameTitleMeta) ? doc.gameTitleMeta : [];
}

// 寫入 / 刷新某稱號的 meta（先移除同 titleId 舊紀錄再 push，確保唯一）。
async function writeTitleMeta(
  client,
  { userId, guildId, titleId, expiresAt = null, source = "system" }
) {
  if (!client.userLevelsCollection) return;
  await client.userLevelsCollection
    .updateOne({ userId, guildId }, { $pull: { gameTitleMeta: { titleId } } })
    .catch(() => {});
  await client.userLevelsCollection
    .updateOne(
      { userId, guildId },
      {
        $push: {
          gameTitleMeta: {
            titleId,
            grantedAt: Date.now(),
            expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
            source,
            status: "active",
          },
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: true }
    )
    .catch(() => {});
}

// 解鎖一個稱號（idempotent）。回傳 { newlyAdded }。
// expiresAt（ms 或 Date，null=永久）、source 會寫入 gameTitleMeta。
async function grant(
  client,
  { userId, guildId, member, titleId, announce = true, expiresAt = null, source = "system" }
) {
  if (!def(titleId) || !client.userLevelsCollection) return { newlyAdded: false };
  const res = await client.userLevelsCollection.updateOne(
    { userId, guildId },
    { $addToSet: { gameTitles: titleId }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  const newlyAdded = (res.modifiedCount || 0) > 0 || (res.upsertedCount || 0) > 0;
  // 重新發放（含 admin 設定期限）時也刷新 meta，確保 grantedAt / expiresAt 正確
  await writeTitleMeta(client, { userId, guildId, titleId, expiresAt, source });
  if (newlyAdded && announce) {
    await announceUnlock(client, { member, userId, titleId }).catch(() => {});
  }
  return { newlyAdded };
}

// 設為展示中的稱號（寫進 UserLevels.title，與徽章 / 自訂稱號共用同一個展示槽）。
async function setActive(client, { userId, guildId, titleId }) {
  if (!client.userLevelsCollection) return { ok: false, reason: "disabled" };
  if (titleId === "__clear__") {
    await client.userLevelsCollection.updateOne(
      { userId, guildId },
      { $set: { title: null, updatedAt: new Date() } },
      { upsert: true }
    );
    return { ok: true, cleared: true };
  }
  if (!def(titleId)) return { ok: false, reason: "no_title" };
  const unlocked = await getUnlocked(client, userId, guildId);
  if (!unlocked.has(titleId)) return { ok: false, reason: "locked" };
  await client.userLevelsCollection.updateOne(
    { userId, guildId },
    { $set: { title: label(titleId), updatedAt: new Date() } },
    { upsert: true }
  );
  return { ok: true };
}

// 收回一個稱號（週冠更替 / 過期 / admin 撤銷）。若正在展示則一併清掉展示。
// status：寫進 meta 的最終狀態（'revoked' | 'expired'），保留紀錄不刪除。
async function revoke(client, { userId, guildId, titleId, status = "revoked" }) {
  if (!def(titleId) || !client.userLevelsCollection) return;
  const doc = await getDoc(client, userId, guildId);
  const set = { updatedAt: new Date() };
  if (doc?.title === label(titleId)) set.title = null;
  await client.userLevelsCollection.updateOne(
    { userId, guildId },
    { $pull: { gameTitles: titleId }, $set: set }
  );
  // 標記 meta（若存在 active 紀錄），不刪除以保留歷史
  await client.userLevelsCollection
    .updateOne(
      { userId, guildId },
      {
        $set: {
          "gameTitleMeta.$[e].status": status,
          "gameTitleMeta.$[e].revokedAt": Date.now(),
        },
      },
      { arrayFilters: [{ "e.titleId": titleId, "e.status": "active" }] }
    )
    .catch(() => {});
}

// 掃出所有「已過期但仍 active」的稱號 meta（給 titleExpiryChecker cron 用）。
// 回傳 [{ userId, guildId, titleId }]。
async function findExpiredActive(client, now = Date.now()) {
  if (!client.userLevelsCollection) return [];
  const docs = await client.userLevelsCollection
    .find({
      gameTitleMeta: {
        $elemMatch: { status: "active", expiresAt: { $ne: null, $lt: now } },
      },
    })
    .project({ userId: 1, guildId: 1, gameTitleMeta: 1 })
    .toArray()
    .catch(() => []);

  const out = [];
  for (const d of docs) {
    for (const m of d.gameTitleMeta || []) {
      if (m.status === "active" && m.expiresAt != null && m.expiresAt < now) {
        out.push({ userId: d.userId, guildId: d.guildId, titleId: m.titleId });
      }
    }
  }
  return out;
}

// ── 成就統計擷取（單次 check 內以 cache 共用，未解鎖才查）─────────────
function makeCache(client, userId, guildId) {
  const c = {};
  return {
    async mining() {
      if (!c.mining)
        c.mining =
          (await client.miningProfilesCollection?.findOne({ userId, guildId }).catch(() => null)) ||
          {};
      return c.mining;
    },
    async coins() {
      if (c.coins === undefined) {
        const d = await client.userCoinsCollection?.findOne({ userId, guildId }).catch(() => null);
        c.coins = d || {};
      }
      return c.coins;
    },
    // 舊 AuctionListings 已被 MarketListings 取代，保留遷移寫入的歷史成交基數，
    // 避免拍賣商人頭銜進度因切換 collection 而歸零。
    async legacyAuctionBaseline() {
      if (c.legacyAuctionBaseline === undefined) {
        const d = await client.userLevelsCollection
          ?.findOne({ userId, guildId }, { projection: { legacy_auction_sold_count: 1 } })
          .catch(() => null);
        c.legacyAuctionBaseline = d?.legacy_auction_sold_count || 0;
      }
      return c.legacyAuctionBaseline;
    },
    count(coll, query) {
      return client[coll]?.countDocuments(query).catch(() => 0) ?? Promise.resolve(0);
    },
    async exists(coll, query) {
      const d = await client[coll]?.findOne(query).catch(() => null);
      return !!d;
    },
  };
}

// titleId → 判定是否達標。req 門檻取自 titles.json。
const RESOLVERS = {
  coal_collector: async (cache, ctx, req) => {
    const m = await cache.mining();
    const coins = (await cache.coins()).totalCoins || 0;
    return (m.mine_count_total || 0) >= req.mineCount && coins >= req.coins;
  },
  iron_smith: async (cache, ctx, req) => {
    const m = await cache.mining();
    return (m.craft_count_total || 0) >= req.craftCount && (m.lifetime_ore?.iron || 0) >= req.iron;
  },
  gem_hunter: async (cache, ctx, req) => {
    const m = await cache.mining();
    return (m.lifetime_ore?.gold || 0) >= req.gold && (m.lifetime_ore?.diamond || 0) >= req.diamond;
  },
  legend_miner: async (cache, ctx, req) => {
    const m = await cache.mining();
    return (
      (m.mine_count_total || 0) >= req.mineCount &&
      (m.lifetime_ore?.diamond || 0) >= req.diamond &&
      (m.weekly_champion_count || 0) >= req.weeklyChamp
    );
  },
  casino_regular: async (cache, ctx, req) =>
    (await cache.count("coinTransactionsCollection", {
      userId: ctx.userId,
      guildId: ctx.guildId,
      source: "bet",
    })) >= req.betCount,
  casino_bigwin: async (cache, ctx, req) =>
    cache.exists("coinTransactionsCollection", {
      userId: ctx.userId,
      guildId: ctx.guildId,
      source: "payout",
      amount: { $gte: req.payout },
    }),
  casino_jackpot: async (cache, ctx) =>
    cache.exists("coinTransactionsCollection", {
      userId: ctx.userId,
      guildId: ctx.guildId,
      source: "payout",
      "meta.matchType": "jackpot",
    }),
  stock_retail: async (cache, ctx, req) =>
    (await cache.count("stockTransactionsCollection", {
      userId: ctx.userId,
      guildId: ctx.guildId,
    })) >= req.txCount,
  stock_god: async (cache, ctx, req) => {
    const d = await cache.coins();
    const income = (d.coinsFrom_stock_sell || 0) + (d.coinsFrom_stock_dividend || 0);
    return income >= req.income;
  },
  lottery_fan: async (cache, ctx, req) =>
    (await cache.count("lotteryTicketsCollection", {
      userId: ctx.userId,
      guildId: ctx.guildId,
    })) >= req.ticketCount,
  lottery_jackpot: async (cache, ctx) =>
    cache.exists("lotteryTicketsCollection", {
      userId: ctx.userId,
      guildId: ctx.guildId,
      matched: { $gte: 6 },
    }),
  auction_merchant: async (cache, ctx, req) => {
    const current = await cache.count("marketListingsCollection", {
      listing_type: "auction",
      seller_id: ctx.userId,
      guild_id: ctx.guildId,
      status: "sold",
    });
    const baseline = await cache.legacyAuctionBaseline();
    return current + baseline >= req.soldCount;
  },
  // Phase H+ 地下城稱號：冰窟 / 廢墟 1F–5F 各通關 ≥ 1 次
  frozen_hero: async (cache, ctx) => {
    const m = await cache.mining();
    const clears = m?.floor_unlocks?.ice?.clears || {};
    return [1, 2, 3, 4, 5].every((f) => (clears[String(f)] || 0) >= 1);
  },
  ruins_scholar: async (cache, ctx) => {
    const m = await cache.mining();
    const clears = m?.floor_unlocks?.ruins?.clears || {};
    return [1, 2, 3, 4, 5].every((f) => (clears[String(f)] || 0) >= 1);
  },
  // 龍裔：屠龍累積（世界 BOSS + 地下城 mini-BOSS 共用 dragon_slayer_kills）達門檻
  dragon_heir: async (cache, ctx, req) => {
    const m = await cache.mining();
    return (m.dragon_slayer_kills || 0) >= req.bossKills;
  },
};

// 檢查並解鎖達標稱號。categories 限制範圍（預設全部）。weekly 型不在此處理。
async function check(client, { userId, guildId, member }, categories = null) {
  if (!client.userLevelsCollection) return [];
  try {
    const unlocked = await getUnlocked(client, userId, guildId);
    const pending = order().filter((id) => {
      const d = def(id);
      if (!d || d.weekly || !RESOLVERS[id]) return false;
      if (unlocked.has(id)) return false;
      if (categories && !categories.includes(d.category)) return false;
      return true;
    });
    if (!pending.length) return [];

    const cache = makeCache(client, userId, guildId);
    const ctx = { userId, guildId };
    const newly = [];
    for (const id of pending) {
      const ok = await RESOLVERS[id](cache, ctx, def(id).req || {}).catch(() => false);
      if (ok) {
        await grant(client, { userId, guildId, member, titleId: id, announce: true }).catch(() => {});
        newly.push(id);
      }
    }
    return newly;
  } catch (e) {
    console.log(`[GAMETITLE] check failed: ${e.message}`.yellow);
    return [];
  }
}

// 進度（給 /成就 用）：回傳每個稱號的 parts（current / target）與是否布林型。
async function progress(client, { userId, guildId }) {
  const cache = makeCache(client, userId, guildId);
  const ctx = { userId, guildId };
  const out = [];
  for (const id of order()) {
    const d = def(id);
    if (!d) continue;
    if (d.weekly) {
      out.push({ id, weekly: true, parts: [] });
      continue;
    }
    const req = d.req || {};
    const parts = [];
    const push = (lbl, cur, target) => parts.push({ label: lbl, cur, target });
    switch (id) {
      case "coal_collector": {
        const m = await cache.mining();
        push("累積挖礦", m.mine_count_total || 0, req.mineCount);
        push("持有金幣", (await cache.coins()).totalCoins || 0, req.coins);
        break;
      }
      case "iron_smith": {
        const m = await cache.mining();
        push("累積合成", m.craft_count_total || 0, req.craftCount);
        push("歷史鐵礦", m.lifetime_ore?.iron || 0, req.iron);
        break;
      }
      case "gem_hunter": {
        const m = await cache.mining();
        push("歷史黃金", m.lifetime_ore?.gold || 0, req.gold);
        push("歷史鑽石", m.lifetime_ore?.diamond || 0, req.diamond);
        break;
      }
      case "legend_miner": {
        const m = await cache.mining();
        push("累積挖礦", m.mine_count_total || 0, req.mineCount);
        push("歷史鑽石", m.lifetime_ore?.diamond || 0, req.diamond);
        push("週冠次數", m.weekly_champion_count || 0, req.weeklyChamp);
        break;
      }
      case "casino_regular":
        push(
          "累積下注",
          await cache.count("coinTransactionsCollection", { userId, guildId, source: "bet" }),
          req.betCount
        );
        break;
      case "casino_bigwin":
        push(
          "最高單局派彩 ≥ 門檻",
          (await cache.exists("coinTransactionsCollection", {
            userId,
            guildId,
            source: "payout",
            amount: { $gte: req.payout },
          }))
            ? 1
            : 0,
          1
        );
        break;
      case "casino_jackpot":
        push(
          "開出 Jackpot",
          (await cache.exists("coinTransactionsCollection", {
            userId,
            guildId,
            source: "payout",
            "meta.matchType": "jackpot",
          }))
            ? 1
            : 0,
          1
        );
        break;
      case "stock_retail":
        push(
          "交易筆數",
          await cache.count("stockTransactionsCollection", { userId, guildId }),
          req.txCount
        );
        break;
      case "stock_god": {
        const d2 = await cache.coins();
        push("賣股+股利收入", (d2.coinsFrom_stock_sell || 0) + (d2.coinsFrom_stock_dividend || 0), req.income);
        break;
      }
      case "lottery_fan":
        push(
          "購買張數",
          await cache.count("lotteryTicketsCollection", { userId, guildId }),
          req.ticketCount
        );
        break;
      case "lottery_jackpot":
        push(
          "中過頭獎",
          (await cache.exists("lotteryTicketsCollection", { userId, guildId, matched: { $gte: 6 } }))
            ? 1
            : 0,
          1
        );
        break;
      case "auction_merchant": {
        const current = await cache.count("marketListingsCollection", {
          listing_type: "auction",
          seller_id: userId,
          guild_id: guildId,
          status: "sold",
        });
        const baseline = await cache.legacyAuctionBaseline();
        push("成交件數", current + baseline, req.soldCount);
        break;
      }
      case "frozen_hero": {
        const m = await cache.mining();
        const clears = m?.floor_unlocks?.ice?.clears || {};
        const done = [1, 2, 3, 4, 5].filter((f) => (clears[String(f)] || 0) >= 1).length;
        push("冰窟通關樓層", done, 5);
        break;
      }
      case "ruins_scholar": {
        const m = await cache.mining();
        const clears = m?.floor_unlocks?.ruins?.clears || {};
        const done = [1, 2, 3, 4, 5].filter((f) => (clears[String(f)] || 0) >= 1).length;
        push("廢墟通關樓層", done, 5);
        break;
      }
    }
    out.push({ id, weekly: false, parts });
  }
  return out;
}

function announceChannelId() {
  return (
    cfg().announceChannelId ||
    mining?.announceChannelId ||
    commandChannels?.mining?.[0] ||
    ""
  );
}

async function announceUnlock(client, { member, userId, titleId }) {
  const d = def(titleId);
  if (!d) return;
  const channelId = announceChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const mention = member?.user ? `${member.user}` : `<@${userId}>`;
  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏅 解鎖新稱號！\n${mention} 解鎖了【${categoryLabel(d.category)}】稱號 **${label(titleId)}**！\n` +
          "用 `/稱號 設定` 把它掛上錢包卡展示吧。",
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${d.desc || ""}`),
    );
  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

module.exports = {
  defs,
  def,
  order,
  label,
  categoryLabel,
  idsByCategory,
  getDoc,
  getUnlocked,
  getTitleMeta,
  writeTitleMeta,
  findExpiredActive,
  grant,
  setActive,
  revoke,
  check,
  progress,
  announceUnlock,
  announceChannelId,
};
