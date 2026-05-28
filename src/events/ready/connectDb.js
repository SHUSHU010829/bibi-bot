require("colors");

const { MongoClient } = require("mongodb");

module.exports = async (client) => {
  // 檢查環境變數
  if (!process.env.MONGO_PASSWORD) {
    console.log(`[ERROR] MONGO_PASSWORD environment variable is not set!`.red);
    console.log(`[ERROR] Please create a .env file with MONGO_PASSWORD variable`.red);
    console.log(`[WARNING] Database features will be disabled until this is fixed`.yellow);
    return;
  }

  const uri = `mongodb+srv://SHUSHU:${process.env.MONGO_PASSWORD}@morningbot.ar55cbn.mongodb.net/?retryWrites=true&w=majority`;
  const mongoClient = new MongoClient(uri);

  try {
    console.log(`[DATA] Connecting to MongoDB...`.cyan);
    await mongoClient.connect();

    const dbName = "MorningBot";
    const database = mongoClient.db(dbName);
    const collection = database.collection("FoodList");
    const gaslightCollection = database.collection("GaslightPost");

    // Statbot collections
    const messageStatsCollection = database.collection("MessageStats");
    const voiceStatsCollection = database.collection("VoiceStats");
    const channelActivityCollection = database.collection("ChannelActivity");

    // Voting system collection
    const votingProposalsCollection = database.collection("VotingProposals");

    // Role panels collection (遊戲身份組面板設定)
    const rolePanelsCollection = database.collection("RolePanels");

    // Suggestion panels collection (建議系統面板設定 + 排程刪除)
    const suggestionPanelsCollection = database.collection("SuggestionPanels");

    // Steam 特價推播去重
    const steamDealsCollection = database.collection("SteamDealsPushed");

    // 喜加一 (限免) 推播去重
    const freeGamesCollection = database.collection("FreeGamesPushed");

    // 等級系統 collections
    const userLevelsCollection = database.collection("UserLevels");
    const levelTransactionsCollection = database.collection("LevelTransactions");
    const dailyCheckinCollection = database.collection("DailyCheckin");
    const levelRolesCollection = database.collection("LevelRoles");
    const voiceSessionsCollection = database.collection("VoiceSessions");

    // 金幣系統 collections
    const userCoinsCollection = database.collection("UserCoins");
    const coinTransactionsCollection = database.collection("CoinTransactions");

    // 21 點對局狀態（in-flight + 結算後保留一段時間）
    const blackjackGamesCollection = database.collection("BlackjackGames");

    // HI-LO 對局狀態
    const hiloGamesCollection = database.collection("HiloGames");

    // 尋寶（Keno）對局狀態
    const kenoGamesCollection = database.collection("KenoGames");

    // 射龍門對局狀態
    const dragonGateGamesCollection = database.collection("DragonGateGames");

    // 火箭（Crash）對局紀錄（每局獨立，純歷史用）
    const crashGamesCollection = database.collection("CrashGames");

    // 輪盤對局狀態
    const rouletteGamesCollection = database.collection("RouletteGames");

    // 德州撲克牌桌狀態（多人，channel-scoped）
    const pokerGamesCollection = database.collection("PokerGames");

    // 賽馬牌桌狀態（多人，channel-scoped 售票 → 開賽 → 結算）
    const horseRaceGamesCollection = database.collection("HorseRaceGames");

    // 賭場「再來一局」：每位玩家每款遊戲的上一注參數
    const casinoLastBetsCollection = database.collection("CasinoLastBets");

    // 商店系統 collections
    const userInventoryCollection = database.collection("UserInventory");
    const shopTransactionsCollection = database.collection("ShopTransactions");
    const shopRoleCacheCollection = database.collection("ShopRoleCache");

    // Twitch chat 同步去重
    const twitchScoreFlushesCollection = database.collection("TwitchScoreFlushes");

    // Twitch 開台通知狀態 (login → 上次通知過的 streamId)
    const twitchLiveStateCollection = database.collection("TwitchLiveState");

    // 樂透系統 collections
    const lotteryDrawsCollection = database.collection("LotteryDraws");
    const lotteryTicketsCollection = database.collection("LotteryTickets");
    const lotterySubscriptionsCollection = database.collection("LotterySubscriptions");
    const lotteryWheelsCollection = database.collection("LotteryWheels");

    // 拉霸 jackpot 累積彩池（每 guild 一筆）
    const jackpotPoolCollection = database.collection("JackpotPool");

    // 玩家轉帳每日額度（記每日轉出總額）
    const coinTransfersCollection = database.collection("CoinTransfers");

    // 定期存款
    const coinDepositsCollection = database.collection("CoinDeposits");

    // 救濟金領取紀錄（連續天數、最後領取日期）
    const welfareClaimsCollection = database.collection("WelfareClaims");

    // 任務進度（每日/每週任務的進度與領取狀態）
    const questProgressCollection = database.collection("QuestProgress");

    // 經濟健康快照（每日聚合，用於通膨追蹤）
    const economySnapshotsCollection = database.collection("EconomySnapshots");

    // 成員自辦活動 collections
    const hostedEventsCollection = database.collection("HostedEvents");

    // 有獎問答
    const quizGamesCollection = database.collection("QuizGames");

    // 推薦頻道紀錄（餐廳/酒吧/飲料/娛樂）
    const recommendationsCollection = database.collection("Recommendations");

    // 邀請追蹤 collections
    const inviteCacheCollection = database.collection("InviteCache");
    const inviteRecordsCollection = database.collection("InviteRecords");

    // 股市系統 collections
    const stockMarketCollection = database.collection("StockMarket");
    const stockPricesCollection = database.collection("StockPrices");
    const userPortfolioCollection = database.collection("UserPortfolio");
    const stockTransactionsCollection = database.collection("StockTransactions");
    const stockEventsCollection = database.collection("StockEvents");
    const stockEventDefsCollection = database.collection("StockEventDefs");

    // 挖礦系統 collections
    const miningProfilesCollection = database.collection("MiningProfiles");
    const mineLogsCollection = database.collection("MineLogs");

    // 打工系統 collection（記每位玩家的打工冷卻）
    const workProfilesCollection = database.collection("WorkProfiles");

    // 地下城決鬥對局狀態
    const duelGamesCollection = database.collection("DuelGames");

    // 拍賣行掛牌
    const auctionListingsCollection = database.collection("AuctionListings");

    // 打工 / 挖礦到點通知訂閱
    const cooldownRemindersCollection = database.collection("CooldownReminders");

    client.database = database;
    client.collection = collection;
    client.gaslightCollection = gaslightCollection;
    client.messageStatsCollection = messageStatsCollection;
    client.voiceStatsCollection = voiceStatsCollection;
    client.channelActivityCollection = channelActivityCollection;
    client.votingProposalsCollection = votingProposalsCollection;
    client.rolePanelsCollection = rolePanelsCollection;
    client.suggestionPanelsCollection = suggestionPanelsCollection;
    client.steamDealsCollection = steamDealsCollection;
    client.freeGamesCollection = freeGamesCollection;
    client.userLevelsCollection = userLevelsCollection;
    client.levelTransactionsCollection = levelTransactionsCollection;
    client.dailyCheckinCollection = dailyCheckinCollection;
    client.levelRolesCollection = levelRolesCollection;
    client.voiceSessionsCollection = voiceSessionsCollection;
    client.userCoinsCollection = userCoinsCollection;
    client.coinTransactionsCollection = coinTransactionsCollection;
    client.blackjackGamesCollection = blackjackGamesCollection;
    client.hiloGamesCollection = hiloGamesCollection;
    client.kenoGamesCollection = kenoGamesCollection;
    client.dragonGateGamesCollection = dragonGateGamesCollection;
    client.crashGamesCollection = crashGamesCollection;
    client.rouletteGamesCollection = rouletteGamesCollection;
    client.pokerGamesCollection = pokerGamesCollection;
    client.horseRaceGamesCollection = horseRaceGamesCollection;
    client.casinoLastBetsCollection = casinoLastBetsCollection;
    client.twitchScoreFlushesCollection = twitchScoreFlushesCollection;
    client.twitchLiveStateCollection = twitchLiveStateCollection;
    client.userInventoryCollection = userInventoryCollection;
    client.shopTransactionsCollection = shopTransactionsCollection;
    client.shopRoleCacheCollection = shopRoleCacheCollection;
    client.lotteryDrawsCollection = lotteryDrawsCollection;
    client.lotteryTicketsCollection = lotteryTicketsCollection;
    client.lotterySubscriptionsCollection = lotterySubscriptionsCollection;
    client.lotteryWheelsCollection = lotteryWheelsCollection;
    client.jackpotPoolCollection = jackpotPoolCollection;
    client.coinTransfersCollection = coinTransfersCollection;
    client.coinDepositsCollection = coinDepositsCollection;
    client.welfareClaimsCollection = welfareClaimsCollection;
    client.questProgressCollection = questProgressCollection;
    client.economySnapshotsCollection = economySnapshotsCollection;
    client.hostedEventsCollection = hostedEventsCollection;
    client.quizGamesCollection = quizGamesCollection;
    client.stockMarketCollection = stockMarketCollection;
    client.stockPricesCollection = stockPricesCollection;
    client.userPortfolioCollection = userPortfolioCollection;
    client.stockTransactionsCollection = stockTransactionsCollection;
    client.stockEventsCollection = stockEventsCollection;
    client.stockEventDefsCollection = stockEventDefsCollection;
    client.recommendationsCollection = recommendationsCollection;
    client.inviteCacheCollection = inviteCacheCollection;
    client.inviteRecordsCollection = inviteRecordsCollection;
    client.miningProfilesCollection = miningProfilesCollection;
    client.mineLogsCollection = mineLogsCollection;
    client.workProfilesCollection = workProfilesCollection;
    client.duelGamesCollection = duelGamesCollection;
    client.auctionListingsCollection = auctionListingsCollection;
    client.cooldownRemindersCollection = cooldownRemindersCollection;
    await economySnapshotsCollection
      .createIndex({ guildId: 1, date: 1 }, { unique: true })
      .catch((e) =>
        console.log(`[WARN] EconomySnapshots index 建立失敗：${e.message}`.yellow),
      );
    await cooldownRemindersCollection
      .createIndex({ userId: 1, guildId: 1, type: 1 }, { unique: true })
      .catch((e) =>
        console.log(`[WARN] CooldownReminders index 建立失敗：${e.message}`.yellow),
      );
    await cooldownRemindersCollection
      .createIndex({ enabled: 1, notified: 1, readyAt: 1 })
      .catch((e) =>
        console.log(`[WARN] CooldownReminders 掃描索引建立失敗：${e.message}`.yellow),
      );
    console.log(`[DATA] Successfully connected to MongoDB!`.cyan);

    // 自動修補沒有 category / drawCount 的舊資料（idempotent，沒事就不動）
    try {
      const missingCategory = await collection.updateMany(
        { $or: [{ category: { $exists: false } }, { category: null }] },
        { $set: { category: "lunch" } }
      );
      const missingDrawCount = await collection.updateMany(
        { drawCount: { $exists: false } },
        { $set: { drawCount: 0 } }
      );
      if (missingCategory.modifiedCount > 0 || missingDrawCount.modifiedCount > 0) {
        console.log(
          `[DATA] 自動修補舊資料：補 category ${missingCategory.modifiedCount} 筆（預設 lunch）、補 drawCount ${missingDrawCount.modifiedCount} 筆`.cyan
        );
      }
    } catch (migrateError) {
      console.log(
        `[WARNING] 修補舊資料失敗：${migrateError.message}`.yellow
      );
    }

    // 建立 FoodList 索引（防止同名同類別重複，加速排行榜排序）
    try {
      await collection.createIndex(
        { name: 1, category: 1, beverageStore: 1 },
        { unique: true, name: "uniq_food_identity" }
      );
      await collection.createIndex(
        { drawCount: -1 },
        { name: "drawCount_desc" }
      );
    } catch (indexError) {
      console.log(
        `[WARNING] Failed to create FoodList index (可能有重複資料需要先清理):\n${indexError.message}`.yellow
      );
    }

    // 等級系統索引
    try {
      await userLevelsCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_user_guild" }
      );
      await userLevelsCollection.createIndex(
        { guildId: 1, totalXp: -1 },
        { name: "guild_xp_desc" }
      );
      await userLevelsCollection.createIndex(
        { guildId: 1, level: -1, totalXp: -1 },
        { name: "guild_level_desc" }
      );

      await levelTransactionsCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "user_guild_time" }
      );
      await levelTransactionsCollection.createIndex(
        { guildId: 1, date: 1 },
        { name: "guild_date" }
      );
      await levelTransactionsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "ttl_90d" }
      );

      await dailyCheckinCollection.createIndex(
        { userId: 1, guildId: 1, date: 1 },
        { unique: true, name: "uniq_user_guild_date" }
      );
      await dailyCheckinCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "ttl_90d" }
      );

      await levelRolesCollection.createIndex(
        { guildId: 1, level: 1 },
        { unique: true, name: "uniq_guild_level" }
      );

      await voiceSessionsCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_voice_user_guild" }
      );

      await twitchScoreFlushesCollection.createIndex(
        { sessionId: 1 },
        { unique: true, name: "uniq_twitch_session" }
      );

      // 金幣系統索引
      await userCoinsCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_coin_user_guild" }
      );

      await coinTransactionsCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "coin_user_guild_time" }
      );
      await coinTransactionsCollection.createIndex(
        { userId: 1, guildId: 1, source: 1, date: 1 },
        { name: "coin_user_guild_source_date" }
      );
      await coinTransactionsCollection.createIndex(
        { guildId: 1, date: 1 },
        { name: "coin_guild_date" }
      );
      await coinTransactionsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "coin_ttl_90d" }
      );

      // 21 點對局索引：每位玩家同 guild 同時只能有一局 playing，靠 status 過濾不上 unique
      await blackjackGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_bj_gameId" }
      );
      await blackjackGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "bj_user_guild_status" }
      );
      // 用 cron 自己掃 abandoned 局退錢 → 結算後 30 天再清，避免 TTL 提前刪掉還沒退款的 doc
      await blackjackGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "bj_ttl_30d" }
      );

      // HI-LO 對局索引：邏輯與 21 點相同，每位玩家同 guild 同時只能有一局 playing
      await hiloGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_hl_gameId" }
      );
      await hiloGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "hl_user_guild_status" }
      );
      await hiloGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "hl_ttl_30d" }
      );

      // 尋寶（Keno）對局索引：每位玩家同 guild 同時只能有一局 selecting
      await kenoGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_keno_gameId" }
      );
      await kenoGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "keno_user_guild_status" }
      );
      await kenoGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "keno_ttl_30d" }
      );

      // 火箭對局索引：邏輯與 hilo 相同，同 guild 同人同時只能有一局 playing
      await crashGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_crash_gameId" }
      );
      await crashGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "crash_user_guild_status" }
      );
      await crashGamesCollection.createIndex(
        { status: 1, bustAt: 1 },
        { name: "crash_status_bust" }
      );
      await crashGamesCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "crash_user_guild_time" }
      );
      await crashGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "crash_ttl_30d" }
      );

      // 射龍門對局索引：每位玩家同 guild 同時只能有一局 playing
      await dragonGateGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_dg_gameId" }
      );
      await dragonGateGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "dg_user_guild_status" }
      );
      await dragonGateGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "dg_ttl_30d" }
      );

      // 輪盤對局索引：邏輯與 21 點相同，每位玩家同 guild 同時只能有一局 betting
      await rouletteGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_roulette_gameId" }
      );
      await rouletteGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "roulette_user_guild_status" }
      );
      await rouletteGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "roulette_ttl_30d" }
      );

      // 德州撲克牌桌索引：channel-scoped，同頻道同時只能有一桌等候/進行
      await pokerGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_poker_gameId" }
      );
      await pokerGamesCollection.createIndex(
        { channelId: 1, status: 1 },
        { name: "poker_channel_status" }
      );
      await pokerGamesCollection.createIndex(
        { "players.userId": 1, status: 1 },
        { name: "poker_player_status" }
      );
      await pokerGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "poker_ttl_30d" }
      );

      // 賽馬牌桌索引：channel-scoped 售票期 + cron 撈逾期局開賽
      await horseRaceGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_hr_gameId" }
      );
      await horseRaceGamesCollection.createIndex(
        { channelId: 1, status: 1 },
        { name: "hr_channel_status" }
      );
      await horseRaceGamesCollection.createIndex(
        { status: 1, expiresAt: 1 },
        { name: "hr_status_expiry" }
      );
      await horseRaceGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "hr_ttl_30d" }
      );

      // 賭場「再來一局」：每人每款遊戲一筆，舊紀錄 30 天後清掉
      await casinoLastBetsCollection.createIndex(
        { userId: 1, guildId: 1, game: 1 },
        { unique: true, name: "uniq_lastbet_user_guild_game" }
      );
      await casinoLastBetsCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "lastbet_ttl_30d" }
      );

      // 商店：背包索引（同人同 guild 同 itemId 可有多筆，因為到期時間/裝備狀態不同）
      await userInventoryCollection.createIndex(
        { userId: 1, guildId: 1 },
        { name: "inv_user_guild" }
      );
      await userInventoryCollection.createIndex(
        { userId: 1, guildId: 1, itemId: 1 },
        { name: "inv_user_guild_item" }
      );
      await userInventoryCollection.createIndex(
        { guildId: 1, expiresAt: 1 },
        { name: "inv_guild_expiry" }
      );

      // 商店：交易紀錄
      await shopTransactionsCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "shop_tx_user_guild_time" }
      );
      await shopTransactionsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 180 * 24 * 60 * 60, name: "shop_tx_ttl_180d" }
      );

      // 商店：身份組快取（每 guild 每色一筆，避免重複建立）
      await shopRoleCacheCollection.createIndex(
        { guildId: 1, hex: 1 },
        { unique: true, name: "uniq_role_cache_guild_hex" }
      );

      // 樂透系統索引(歷史是核心資產,不設 TTL)
      await lotteryDrawsCollection.createIndex(
        { drawId: 1 },
        { unique: true, name: "uniq_lottery_drawId" }
      );
      await lotteryDrawsCollection.createIndex(
        { lotteryType: 1, status: 1 },
        { name: "lottery_type_status" }
      );
      await lotteryDrawsCollection.createIndex(
        { "scheduledReminders.fireAt": 1, "scheduledReminders.fired": 1 },
        { name: "lottery_reminders" }
      );

      await lotteryTicketsCollection.createIndex(
        { drawId: 1, matched: -1 },
        { name: "lottery_tickets_draw_matched" }
      );
      await lotteryTicketsCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "lottery_tickets_user" }
      );
      await lotteryTicketsCollection.createIndex(
        { subscriptionId: 1 },
        { name: "lottery_tickets_subscription" }
      );
      await lotteryTicketsCollection.createIndex(
        { wheelingId: 1 },
        { name: "lottery_tickets_wheel" }
      );
      await lotteryTicketsCollection.createIndex(
        { ticketId: 1 },
        { unique: true, name: "uniq_lottery_ticketId" }
      );

      await lotterySubscriptionsCollection.createIndex(
        { status: 1, nextDrawId: 1 },
        { name: "lottery_subs_status_next" }
      );
      await lotterySubscriptionsCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "lottery_subs_user_status" }
      );
      await lotterySubscriptionsCollection.createIndex(
        { subscriptionId: 1 },
        { unique: true, name: "uniq_lottery_subscriptionId" }
      );

      await lotteryWheelsCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "lottery_wheels_user" }
      );
      await lotteryWheelsCollection.createIndex(
        { wheelingId: 1 },
        { unique: true, name: "uniq_lottery_wheelingId" }
      );

      // 救濟金領取紀錄
      await welfareClaimsCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_welfare_user_guild" }
      );

      // 任務進度：(user, guild, quest, period) 唯一
      await questProgressCollection.createIndex(
        { userId: 1, guildId: 1, questId: 1, period: 1 },
        { unique: true, name: "uniq_quest_user_guild_quest_period" }
      );
      await questProgressCollection.createIndex(
        { guildId: 1, period: 1, questId: 1 },
        { name: "quest_guild_period_quest" }
      );
      await questProgressCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "quest_ttl_90d" }
      );

      // 股市系統索引
      await stockMarketCollection.createIndex(
        { symbol: 1, guildId: 1 },
        { unique: true, name: "uniq_stock_symbol_guild" }
      );
      await stockPricesCollection.createIndex(
        { symbol: 1, guildId: 1, timestamp: -1 },
        { name: "stock_prices_symbol_guild_time" }
      );
      await stockPricesCollection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "stock_prices_ttl_30d" }
      );
      await userPortfolioCollection.createIndex(
        { userId: 1, guildId: 1, symbol: 1 },
        { unique: true, name: "uniq_portfolio_user_guild_symbol" }
      );
      await userPortfolioCollection.createIndex(
        { guildId: 1, symbol: 1 },
        { name: "portfolio_guild_symbol" }
      );
      await stockTransactionsCollection.createIndex(
        { userId: 1, guildId: 1, timestamp: -1 },
        { name: "stock_tx_user_guild_time" }
      );
      await stockTransactionsCollection.createIndex(
        { guildId: 1, symbol: 1, timestamp: -1 },
        { name: "stock_tx_guild_symbol_time" }
      );
      await stockTransactionsCollection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "stock_tx_ttl_90d" }
      );
      await stockEventsCollection.createIndex(
        { guildId: 1, timestamp: -1 },
        { name: "stock_events_guild_time" }
      );
      await stockEventsCollection.createIndex(
        { guildId: 1, eventId: 1, timestamp: -1 },
        { name: "stock_events_guild_eventId_time" }
      );
      await stockEventDefsCollection.createIndex(
        { guildId: 1, id: 1 },
        { unique: true, name: "stock_event_defs_guild_id" }
      );

      // 推薦頻道索引（type 過濾 + 全文搜尋）
      await recommendationsCollection.createIndex(
        { messageId: 1 },
        { unique: true, name: "uniq_rec_messageId" },
      );
      await recommendationsCollection.createIndex(
        { guildId: 1, type: 1, createdAt: -1 },
        { name: "rec_guild_type_time" },
      );
      await recommendationsCollection.createIndex(
        { guildId: 1, area: 1 },
        { name: "rec_guild_area" },
      );
      await recommendationsCollection.createIndex(
        { keywords: 1 },
        { name: "rec_keywords" },
      );

      // 成員自辦活動索引
      await hostedEventsCollection.createIndex(
        { eventId: 1 },
        { unique: true, name: "uniq_hosted_event_id" }
      );
      await hostedEventsCollection.createIndex(
        { guildId: 1, status: 1, createdAt: -1 },
        { name: "hosted_event_guild_status_time" }
      );
      await hostedEventsCollection.createIndex(
        { messageId: 1 },
        { sparse: true, name: "hosted_event_messageId" }
      );
      await hostedEventsCollection.createIndex(
        { hostId: 1, guildId: 1, status: 1 },
        { name: "hosted_event_host_status" }
      );

      // 邀請追蹤索引
      await inviteCacheCollection.createIndex(
        { guildId: 1, code: 1 },
        { unique: true, name: "uniq_invite_cache_guild_code" }
      );
      await inviteRecordsCollection.createIndex(
        { guildId: 1, inviteeId: 1 },
        { unique: true, name: "uniq_invite_records_guild_invitee" }
      );
      await inviteRecordsCollection.createIndex(
        { guildId: 1, inviterId: 1, status: 1 },
        { name: "invite_records_guild_inviter_status" }
      );

      // 有獎問答索引
      await quizGamesCollection.createIndex(
        { quizId: 1 },
        { unique: true, name: "uniq_quiz_id" }
      );
      await quizGamesCollection.createIndex(
        { status: 1, endsAt: 1 },
        { name: "quiz_status_endsAt" }
      );
      await quizGamesCollection.createIndex(
        { messageId: 1 },
        { sparse: true, name: "quiz_messageId" }
      );

      // 挖礦系統索引
      await miningProfilesCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_mining_user_guild" }
      );
      // 挖礦記錄：排行榜 / 成就 / 彩虹石計數用，TTL 90 天
      await mineLogsCollection.createIndex(
        { guild_id: 1, ts: -1 },
        { name: "mine_logs_guild_time" }
      );
      await mineLogsCollection.createIndex(
        { guild_id: 1, ore: 1, ts: -1 },
        { name: "mine_logs_guild_ore_time" }
      );
      await mineLogsCollection.createIndex(
        { ts: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "mine_logs_ttl_90d" }
      );

      // 打工系統索引
      await workProfilesCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_work_user_guild" }
      );

      // 決鬥對局索引：同 guild 同 duelId 唯一；逾時掃描靠 (status, expires_at)
      await duelGamesCollection.createIndex(
        { duel_id: 1 },
        { unique: true, name: "uniq_duel_id" }
      );
      await duelGamesCollection.createIndex(
        { guild_id: 1, challenger_id: 1, status: 1 },
        { name: "duel_guild_challenger_status" }
      );
      await duelGamesCollection.createIndex(
        { status: 1, expires_at: 1 },
        { name: "duel_status_expiry" }
      );
      await duelGamesCollection.createIndex(
        { updated_at: 1 },
        { expireAfterSeconds: 7 * 24 * 60 * 60, name: "duel_ttl_7d" }
      );

      // 拍賣行索引：(guild, listing_id) 唯一；結算掃描靠 (status, expires_at)
      await auctionListingsCollection.createIndex(
        { guild_id: 1, listing_id: 1 },
        { unique: true, name: "uniq_auction_guild_listing" }
      );
      await auctionListingsCollection.createIndex(
        { guild_id: 1, status: 1, expires_at: 1 },
        { name: "auction_guild_status_expiry" }
      );
      await auctionListingsCollection.createIndex(
        { guild_id: 1, seller_id: 1, status: 1 },
        { name: "auction_guild_seller_status" }
      );
      await auctionListingsCollection.createIndex(
        { settled_at: 1 },
        { expireAfterSeconds: 7 * 24 * 60 * 60, name: "auction_ttl_7d", sparse: true }
      );
    } catch (indexError) {
      console.log(
        `[WARNING] Failed to create LevelSystem indexes:\n${indexError.message}`.yellow
      );
    }

    // 一次性遷移：把舊版存在 MiningProfiles 的稱號解鎖清單搬到 UserLevels.gameTitles
    // （稱號系統已改為遊戲區共用，存於 UserLevels）。idempotent，沒資料就不動。
    try {
      const legacy = await miningProfilesCollection
        .find({ unlocked_titles: { $exists: true, $ne: [] } })
        .project({ userId: 1, guildId: 1, unlocked_titles: 1 })
        .toArray();
      let migrated = 0;
      for (const p of legacy) {
        const titles = (p.unlocked_titles || []).filter((t) => t && t !== "novice_miner");
        if (!titles.length) continue;
        await userLevelsCollection.updateOne(
          { userId: p.userId, guildId: p.guildId },
          { $addToSet: { gameTitles: { $each: titles } }, $set: { updatedAt: new Date() } },
          { upsert: true }
        );
        migrated += 1;
      }
      if (migrated > 0) {
        console.log(`[DATA] 遊戲稱號遷移：搬移 ${migrated} 位玩家的稱號到 UserLevels`.cyan);
      }
      // 清掉 MiningProfiles 上已搬走的稱號欄位（保留 weekly_champion_count / lifetime_ore）
      await miningProfilesCollection.updateMany(
        { $or: [{ unlocked_titles: { $exists: true } }, { active_title: { $exists: true } }] },
        { $unset: { unlocked_titles: "", active_title: "" } }
      );
    } catch (migrateError) {
      console.log(`[WARNING] 遊戲稱號遷移失敗：${migrateError.message}`.yellow);
    }

    // 確認有多少飲料店資料
    const beverageStoreCount = await collection.distinct("beverageStore", {
      category: "beverage",
    });
    console.log(`[DATA] Found ${beverageStoreCount.length} beverage stores in database`.cyan);
  } catch (error) {
    console.log(
      `[ERROR] Failed to connect to MongoDB:\n${error}`.red
    );
    console.log(
      `[WARNING] Database features will be disabled. Please check your MONGO_PASSWORD and network connection`.yellow
    );
  }
};
