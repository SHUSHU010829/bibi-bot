require("colors");
const { DateTime } = require("luxon");
const { coinSystem } = require("../../config");
const {
  getCoinTwitchSubBonus,
  getCoinServerBoostBonus,
} = require("./coinMultiplier");
const { getTodayCoinsBySources } = require("./dailyCoinCap");
const { getActiveBuffMultiplier } = require("../shop/activeBuff");
const { guildClub } = require("../../config");
const chatRewardBuffer = require("./chatRewardBuffer");
const bus = require("../eventBus");

async function getGuildWorkMultiplier(client, userId, guildId) {
  if (!guildClub?.enabled) return 1;
  if (!client.guildClubMembersCollection || !client.guildsClubCollection) return 1;
  const m = await client.guildClubMembersCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!m) return 1;
  const c = await client.guildsClubCollection
    .findOne({ guild_club_id: m.guild_club_id, disbanded_at: null })
    .catch(() => null);
  if (!c) return 1;
  const def = guildClub.levels.find((l) => l.level === c.level);
  const buff = (def?.buffs || []).find((b) => b.type === "work_income_multiplier");
  return buff?.value > 0 ? 1 + buff.value : 1;
}

const MSG_VOICE_SOURCES = ["message", "voice"];
const CHAT_SOURCES = ["message", "voice", "reaction"];
const CASINO_SOURCES = ["bet", "payout"];
const SINK_SOURCES = ["shop_buy", "auction_bid", "wealth_tax", "transfer_out", "transfer_fee", "deposit_lock", "deposit_penalty", "stock_buy", "stock_fee", "stock_tax", "stock_daytrade_tax", "stock_div_tax", "stock_insider_fee", "stock_short_margin", "event_host_lock", "invite_clawback", "duel_stake", "stone_appraisal", "market_buy", "market_escrow", "market_bid", "bulk_escrow", "bulk_sell_buy", "listing_fee", "renew_fee", "swap_fee", "farm_plant", "farm_expand", "barter_fee", "guild_create", "guild_donate", "guild_warehouse_fee", "guild_consign_buy", "quest_reroll", "quest_skip", "steal_loss", "bounty_escrow", "bounty_place_escrow", "bounty_fine", "bail", "detective_fee", "detective_crooked", "detective_arale", "detective_catch_lose", "detective_penalty", "detective_counterrob", "revenge_pay", "gold_buy", "savings_deposit", "loan_repay"];
const PEER_SOURCES = ["transfer_in", "transfer_out", "transfer_refund", "deposit_lock", "deposit_release", "event_prize", "event_refund", "auction_payout", "auction_refund", "duel_payout", "duel_refund", "market_payout", "market_refund", "bulk_payout", "bulk_refund", "bulk_sell_payout", "steal_gain", "bounty_payout", "bounty_refund", "bounty_fine_reward", "bounty_victim_compensation", "revenge_win"];
const FLAT_REWARD_SOURCES = ["welfare", "quest_daily", "quest_weekly", "quest_event", "stock_sell", "stock_dividend", "stock_short_settle", "stock_delist_settlement", "stock_raffle_prize", "stock_rebate", "invite_reward", "invite_welcome", "mining_sell", "work", "dungeon", "donation", "encounter", "farm_harvest", "farm_raid", "farm_sell", "boss_loot", "boss_killer", "boss_kill_bonus", "guild_create_refund", "guild_donate_refund", "guild_disband_payout", "deposit_interest", "survey", "fund_payout", "gold_sell", "savings_withdraw", "savings_interest", "loan_out", "detective_catch_win", "detective_reward"];
// source → 遊戲區稱號分類（金流出入口觸發解鎖檢查）
const GAME_TITLE_SOURCE_MAP = {
  bet: ["casino", "lottery"],
  payout: ["casino", "lottery"],
  stock_buy: ["stock"],
  stock_sell: ["stock"],
  stock_dividend: ["stock"],
  mining_sell: ["mining"],
  auction_payout: ["auction"],
  market_payout: ["auction"],
  bulk_payout: ["auction"],
  bulk_sell_payout: ["auction"],
};

module.exports = async (client, opts) => {
  if (!coinSystem?.enabled) return null;
  if (!client.userCoinsCollection) return null;
  if (!client.coinTransactionsCollection) return null;
  if (!opts?.source) return null;

  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();

  let amount = Math.floor(opts.amount || 0);
  if (amount === 0 && opts.source !== "admin") return null;

  // 聊天/語音/表情金幣走 buffer（每日上限 + threshold flush），減少每則訊息一筆 DB 寫入
  if (
    coinSystem?.chatBuffer?.enabled !== false &&
    CHAT_SOURCES.includes(opts.source) &&
    amount > 0
  ) {
    return chatRewardBuffer.addToBuffer(client, { ...opts, amount });
  }

  // 任何會扣款的非聊天 grant，先把該玩家的聊天 buffer flush，確保餘額包含已累積金額
  if (amount < 0 && opts.userId && opts.guildId) {
    await chatRewardBuffer
      .flushUserBuffer(client, opts.userId, opts.guildId, { reason: "pre_debit" })
      .catch(() => {});
  }
  if (
    amount < 0 &&
    opts.source !== "admin" &&
    !CASINO_SOURCES.includes(opts.source) &&
    !SINK_SOURCES.includes(opts.source)
  ) {
    return null;
  }

  // 倍率（admin / casino / sink / peer-transfer 都不套用）
  const skipMultipliers =
    opts.source === "admin" ||
    CASINO_SOURCES.includes(opts.source) ||
    SINK_SOURCES.includes(opts.source) ||
    PEER_SOURCES.includes(opts.source) ||
    FLAT_REWARD_SOURCES.includes(opts.source);
  const twitchInfo = skipMultipliers
    ? { multiplier: 1, name: null }
    : getCoinTwitchSubBonus(opts.member, opts.source);
  const boostInfo = skipMultipliers
    ? { multiplier: 1, name: null }
    : getCoinServerBoostBonus(opts.member, opts.source);
  const baseAmount = amount;
  const stackingMode = coinSystem?.bonusStackingMode === "max" ? "max" : "multiply";
  const baseMultiplier =
    stackingMode === "max"
      ? Math.max(twitchInfo.multiplier, boostInfo.multiplier)
      : twitchInfo.multiplier * boostInfo.multiplier;
  // 商店金幣加成 buff（只在正向獲得時生效，purchase/casino bet 不 buff）
  const buffMultiplier = skipMultipliers || amount <= 0 || opts.source === "shop_buy"
    ? 1
    : await getActiveBuffMultiplier(client, opts.userId, opts.guildId, "coin_boost").catch(() => 1);
  // 公會打工加成（只在 source === "work" 時生效，與其他倍率累乘）
  const guildWorkMultiplier =
    opts.source === "work" && amount > 0
      ? await getGuildWorkMultiplier(client, opts.userId, opts.guildId).catch(() => 1)
      : 1;
  // 世界事件金幣加成（依 source 對應的 *_price_pct / income_pct / coin_pct）
  const worldEventMult = skipMultipliers || amount <= 0
    ? 1
    : require("../world_event/worldEventBuffs").getCoinMultiplierForSource(opts.source);
  const totalMultiplier = baseMultiplier * buffMultiplier * guildWorkMultiplier * worldEventMult;
  if (totalMultiplier > 1 && amount > 0) {
    amount = Math.floor(amount * totalMultiplier);
  }

  // 每日上限：發言+語音合計
  if (MSG_VOICE_SOURCES.includes(opts.source)) {
    const cap = coinSystem.messageVoiceDailyCap ?? 30;
    const earnedToday = await getTodayCoinsBySources(
      client,
      opts.userId,
      opts.guildId,
      MSG_VOICE_SOURCES
    );
    if (earnedToday >= cap) return null;
    if (earnedToday + amount > cap) {
      amount = cap - earnedToday;
    }
  }

  // 表情每日上限（獨立額度）
  if (opts.source === "reaction") {
    const cap = coinSystem.reaction?.dailyCapPerUser ?? 10;
    const earnedToday = await getTodayCoinsBySources(
      client,
      opts.userId,
      opts.guildId,
      ["reaction"]
    );
    if (earnedToday >= cap) return null;
    if (earnedToday + amount > cap) {
      amount = cap - earnedToday;
    }
  }

  if (amount === 0) return null;

  // Transaction 紀錄
  client.coinTransactionsCollection
    .insertOne({
      userId: opts.userId,
      guildId: opts.guildId,
      amount,
      source: opts.source,
      meta: opts.meta || {},
      date: today,
      createdAt: new Date(),
    })
    .catch((e) =>
      console.log(`[ERROR] insert coin transaction: ${e}`.red)
    );

  const counterField = `coinsFrom_${opts.source}`;
  const inc = {
    totalCoins: amount,
    [counterField]: amount,
  };
  if (amount > 0) inc.lifetimeCoins = amount;
  if (amount < 0) inc.lifetimeSpent = -amount;

  const setOnInsert = {
    userId: opts.userId,
    guildId: opts.guildId,
    createdAt: new Date(),
  };

  const set = {
    updatedAt: new Date(),
  };
  if (opts.username !== undefined) set.username = opts.username;
  if (opts.avatarHash !== undefined) set.avatarHash = opts.avatarHash;

  const result = await client.userCoinsCollection.findOneAndUpdate(
    { userId: opts.userId, guildId: opts.guildId },
    { $inc: inc, $set: set, $setOnInsert: setOnInsert },
    { upsert: true, returnDocument: "after" }
  );

  const after = result.value || result;
  if (!after) return null;

  // 賭場單筆 bet/payout 不印 log（量太大）；用戶賺金幣也不印，只記錄扣款
  if (!CASINO_SOURCES.includes(opts.source) && amount < 0) {
    console.log(
      `[COIN] ${opts.username || opts.userId} ${amount} (from ${opts.source})`.yellow
    );
  }

  // 賭桌新手任務：source=bet 視為完成一局賭博
  if (opts.source === "bet") {
    try {
      const questService = require("../quests/questService");
      const notifyQuestClaim = require("../quests/notifyQuestClaim");
      const res = await questService
        .markCompleted(client, opts.userId, opts.guildId, "daily_gamble", {
          member: opts.member,
          username: opts.username,
        })
        .catch(() => null);
      if (res?.autoClaimed) {
        await notifyQuestClaim(
          client,
          { user: opts.member?.user, userId: opts.userId, guildId: opts.guildId },
          res.autoClaimed
        );
      }
    } catch (e) {
      // questService 還沒載入或還沒實作就靜默
    }
  }

  // 股市初探任務：source=stock_buy 視為完成一筆股票交易（買單在前，賣單只能在曾買過之後）
  if (opts.source === "stock_buy" || opts.source === "stock_sell") {
    try {
      const questService = require("../quests/questService");
      const notifyQuestClaim = require("../quests/notifyQuestClaim");
      const res = await questService
        .markCompleted(client, opts.userId, opts.guildId, "daily_stock", {
          member: opts.member,
          username: opts.username,
        })
        .catch(() => null);
      if (res?.autoClaimed) {
        await notifyQuestClaim(
          client,
          { user: opts.member?.user, userId: opts.userId, guildId: opts.guildId },
          res.autoClaimed
        );
      }
    } catch (e) {
      // questService 還沒載入或還沒實作就靜默
    }
  }

  // 遊戲區稱號：金流是各遊戲的共同出入口，依 source 對應分類後非阻塞檢查解鎖
  const titleCategories = GAME_TITLE_SOURCE_MAP[opts.source];
  if (titleCategories) {
    try {
      require("../gameTitles/gameTitleService")
        .check(
          client,
          { userId: opts.userId, guildId: opts.guildId, member: opts.member },
          titleCategories
        )
        .catch(() => {});
    } catch (_) {
      // gameTitleService 尚未載入就靜默
    }
  }

  bus.emit("coin.delta", {
    userId: opts.userId,
    guildId: opts.guildId,
    delta: amount,
    source: opts.source,
    meta: opts.meta || {},
  });

  return {
    granted: amount,
    baseAmount,
    multiplier: totalMultiplier,
    twitchSubName: twitchInfo.name,
    twitchSubMultiplier: twitchInfo.multiplier,
    boostBonusName: boostInfo.name,
    boostBonusMultiplier: boostInfo.multiplier,
    guildWorkMultiplier,
    doc: after,
  };
};
