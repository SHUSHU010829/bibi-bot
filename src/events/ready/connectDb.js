require("colors");

const { MongoClient } = require("mongodb");

module.exports = async (client) => {
  // Idempotent guard：ready 事件理論上只跑一次（handler 改用 once），
  // 但若未來新增其他觸發點仍可能被重入，這裡防止重複建立 MongoClient
  // 造成連線洩漏。
  if (client.database) return;

  if (!process.env.MONGO_URI) {
    console.log(`[ERROR] MONGO_URI environment variable is not set!`.red);
    console.log(`[ERROR] Please set MONGO_URI in your .env (see .env.example)`.red);
    console.log(`[WARNING] Database features will be disabled until this is fixed`.yellow);
    return;
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

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

    // 爬塔對局狀態
    const towerGamesCollection = database.collection("TowerGames");

    // 踩地雷對局狀態
    const minesGamesCollection = database.collection("MinesGames");

    // 刮刮樂對局狀態
    const scratchGamesCollection = database.collection("ScratchGames");

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

    // 單人德州撲克（Casino Hold'em）對局狀態
    const casinoHoldemGamesCollection = database.collection("CasinoHoldemGames");

    // 搶紅包（channel-scoped，限時搶 → 未搶完退款收尾）
    const redPacketGamesCollection = database.collection("RedPacketGames");

    // 俄羅斯輪盤牌桌（channel-scoped 等候 → 開轉結算）
    const russianRouletteGamesCollection = database.collection("RussianRouletteGames");

    // 賓果大廳：排程式群組賓果（場次 + 卡片）
    const bingoHallRoundsCollection = database.collection("BingoHallRounds");
    const bingoHallCardsCollection = database.collection("BingoHallCards");

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

    // 待收轉帳 / 贈送（收帳者可拒收，24 小時未答覆自動退回，收下才真正扣款/扣物）
    const pendingTransfersCollection = database.collection("PendingTransfers");

    // 定期存款
    const coinDepositsCollection = database.collection("CoinDeposits");

    // 銀行系統：信用分、黃金存摺、黃金定存、活期存款、貸款
    const creditProfilesCollection = database.collection("CreditProfiles");
    const goldHoldingsCollection = database.collection("GoldHoldings");
    const goldDepositsCollection = database.collection("GoldDeposits");
    const savingsAccountsCollection = database.collection("SavingsAccounts");
    const loansCollection = database.collection("Loans");
    const creditFlagsCollection = database.collection("CreditFlags");

    // 救濟金領取紀錄（連續天數、最後領取日期）
    const welfareClaimsCollection = database.collection("WelfareClaims");

    // 任務進度（每日/每週任務的進度與領取狀態）
    const questProgressCollection = database.collection("QuestProgress");

    // 任務通知偏好（每位玩家的「完成 DM 通知」開關）
    const questSettingsCollection = database.collection("QuestSettings");

    // 任務指派（每位玩家每期被隨機指派的任務清單 + 重抽/跳過額度）
    const questAssignmentsCollection = database.collection("QuestAssignments");

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
    const stockBroadcastCollection = database.collection("StockBroadcast");
    const stockShortsCollection = database.collection("StockShorts");
    const stockTreasuryCollection = database.collection("StockTreasury");
    const stockInsiderTipsCollection = database.collection("StockInsiderTips");

    // 挖礦系統 collections
    const miningProfilesCollection = database.collection("MiningProfiles");
    const mineLogsCollection = database.collection("MineLogs");

    // 釣魚系統 collections（Phase S4）
    const fishLogsCollection = database.collection("FishLogs");

    // 農場系統 collections（Phase D）
    const farmPlotsCollection = database.collection("FarmPlots");

    // BOSS 共鬥系統 collections（Phase C）
    const bossEventsCollection = database.collection("BossEvents");
    const bossDamageLogsCollection = database.collection("BossDamageLogs");

    // 公會系統 collections（Phase A）
    const guildsClubCollection = database.collection("GuildsClub");
    const guildClubMembersCollection = database.collection("GuildClubMembers");
    const guildClubLogsCollection = database.collection("GuildClubLogs");
    const guildClubInvitationsCollection = database.collection("GuildClubInvitations");
    const guildClubApplicationsCollection = database.collection("GuildClubApplications");
    const guildClubQuestClaimsCollection = database.collection("GuildClubQuestClaims");
    const guildClubContributionsCollection = database.collection("GuildClubContributions");
    const guildClubWarehouseCollection = database.collection("GuildClubWarehouse");
    const guildClubWarehouseLogsCollection = database.collection("GuildClubWarehouseLogs");
    const guildClubWarehouseDailyCollection = database.collection("GuildClubWarehouseDaily");

    // 世界事件 collections（全服共同目標）
    const worldEventsCollection = database.collection("WorldEvents");
    const worldEventContributionsCollection = database.collection("WorldEventContributions");
    const worldEventAnnouncementsCollection = database.collection("WorldEventAnnouncements");

    // 打工系統 collection（記每位玩家的打工冷卻）
    const workProfilesCollection = database.collection("WorkProfiles");

    // 地下城決鬥對局狀態
    const duelGamesCollection = database.collection("DuelGames");

    // 盜賊系統 collections（惡名/防身狀態、通緝榜、竊案紀錄）
    const theftProfilesCollection = database.collection("TheftProfiles");
    const wantedListCollection = database.collection("WantedList");
    const theftLogsCollection = database.collection("TheftLogs");

    // 地下城戰鬥紀錄（Phase H+ 多回合 HP 戰鬥日誌）：30 天 TTL
    const dungeonRunsCollection = database.collection("DungeonRuns");

    // 市集掛單（擺攤/換礦/徵求/競標）
    const marketListingsCollection = database.collection("MarketListings");

    // 交易所掛單（玩家對玩家物物交換）
    const barterListingsCollection = database.collection("BarterListings");

    // 市集 / 交易所退款信箱：背包滿時退回的礦石暫存在此
    const marketplaceMailboxCollection = database.collection("MarketplaceMailbox");

    // 市集成交樣本（算近期單價中位數，供反洗幣溢價偵測）
    const marketSalesCollection = database.collection("MarketSales");

    // 打工 / 挖礦到點通知訂閱
    const cooldownRemindersCollection = database.collection("CooldownReminders");

    // 通知總開關（master switch）：(userId, guildId) 唯一
    const notifySettingsCollection = database.collection("NotifySettings");

    // 礦石每日市價（Phase F）：一天一份 doc，date 為 YYYYMMDD
    const oreMarketPricesCollection = database.collection("OreMarketPrices");

    // 限時活動公告去重（Phase S5）：(eventId, phase, occurrence) 唯一，避免每分鐘掃描重發
    const eventAnnouncementsCollection = database.collection("EventAnnouncements");

    // 抖內系統 collections（與 bibi-website 共用，website 唯讀）
    const donationSessionsCollection = database.collection("DonationSessions");
    const donationRecordsCollection = database.collection("DonationRecords");
    const unmatchedDonationsCollection = database.collection("UnmatchedDonations");

    // Dashboard 稽核日誌：所有 admin API 寫入操作都會留一筆
    const dashboardAuditLogCollection = database.collection("DashboardAuditLog");

    // Cron 任務執行紀錄（withCronLog 寫入）
    const cronJobLogCollection = database.collection("CronJobLog");

    // 使用者個人偏好（公開資料 opt-in 等）
    const userSettingsCollection = database.collection("UserSettings");

    // 指令使用量統計（每 10 分鐘批次 flush，純粹用來看哪些指令冷門可合併）
    const commandStatsCollection = database.collection("CommandStats");

    // 玩家問卷調查回應（每位玩家每 guild 一筆）
    const surveyResponsesCollection = database.collection("SurveyResponses");

    // 遊戲房討論串（/開房）：threadId 唯一，open 狀態載入記憶體快取
    const gameRoomsCollection = database.collection("GameRooms");

    // 通用流水號計數器（_id 例：gameRoom:<guildId>）
    const countersCollection = database.collection("Counters");

    // 周表 RSS 已貼文記錄（避免同一篇貼文重複貼到同一個 thread）
    const rssWeeklyPostsCollection = database.collection("RssWeeklyPosts");

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
    client.towerGamesCollection = towerGamesCollection;
    client.minesGamesCollection = minesGamesCollection;
    client.scratchGamesCollection = scratchGamesCollection;
    client.kenoGamesCollection = kenoGamesCollection;
    client.dragonGateGamesCollection = dragonGateGamesCollection;
    client.crashGamesCollection = crashGamesCollection;
    client.rouletteGamesCollection = rouletteGamesCollection;
    client.pokerGamesCollection = pokerGamesCollection;
    client.horseRaceGamesCollection = horseRaceGamesCollection;
    client.casinoHoldemGamesCollection = casinoHoldemGamesCollection;
    client.redPacketGamesCollection = redPacketGamesCollection;
    client.russianRouletteGamesCollection = russianRouletteGamesCollection;
    client.bingoHallRoundsCollection = bingoHallRoundsCollection;
    client.bingoHallCardsCollection = bingoHallCardsCollection;
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
    client.pendingTransfersCollection = pendingTransfersCollection;
    client.coinDepositsCollection = coinDepositsCollection;
    client.creditProfilesCollection = creditProfilesCollection;
    client.goldHoldingsCollection = goldHoldingsCollection;
    client.goldDepositsCollection = goldDepositsCollection;
    client.savingsAccountsCollection = savingsAccountsCollection;
    client.loansCollection = loansCollection;
    client.creditFlagsCollection = creditFlagsCollection;
    client.welfareClaimsCollection = welfareClaimsCollection;
    client.questProgressCollection = questProgressCollection;
    client.questSettingsCollection = questSettingsCollection;
    client.questAssignmentsCollection = questAssignmentsCollection;
    client.economySnapshotsCollection = economySnapshotsCollection;
    client.hostedEventsCollection = hostedEventsCollection;
    client.quizGamesCollection = quizGamesCollection;
    client.stockMarketCollection = stockMarketCollection;
    client.stockPricesCollection = stockPricesCollection;
    client.userPortfolioCollection = userPortfolioCollection;
    client.stockTransactionsCollection = stockTransactionsCollection;
    client.stockEventsCollection = stockEventsCollection;
    client.stockEventDefsCollection = stockEventDefsCollection;
    client.stockBroadcastCollection = stockBroadcastCollection;
    client.stockShortsCollection = stockShortsCollection;
    client.stockTreasuryCollection = stockTreasuryCollection;
    client.stockInsiderTipsCollection = stockInsiderTipsCollection;
    client.recommendationsCollection = recommendationsCollection;
    client.inviteCacheCollection = inviteCacheCollection;
    client.inviteRecordsCollection = inviteRecordsCollection;
    client.miningProfilesCollection = miningProfilesCollection;
    client.mineLogsCollection = mineLogsCollection;
    client.fishLogsCollection = fishLogsCollection;
    client.farmPlotsCollection = farmPlotsCollection;
    client.bossEventsCollection = bossEventsCollection;
    client.bossDamageLogsCollection = bossDamageLogsCollection;
    client.guildsClubCollection = guildsClubCollection;
    client.guildClubMembersCollection = guildClubMembersCollection;
    client.guildClubLogsCollection = guildClubLogsCollection;
    client.guildClubInvitationsCollection = guildClubInvitationsCollection;
    client.guildClubApplicationsCollection = guildClubApplicationsCollection;
    client.guildClubQuestClaimsCollection = guildClubQuestClaimsCollection;
    client.guildClubContributionsCollection = guildClubContributionsCollection;
    client.guildClubWarehouseCollection = guildClubWarehouseCollection;
    client.guildClubWarehouseLogsCollection = guildClubWarehouseLogsCollection;
    client.guildClubWarehouseDailyCollection = guildClubWarehouseDailyCollection;
    client.worldEventsCollection = worldEventsCollection;
    client.worldEventContributionsCollection = worldEventContributionsCollection;
    client.worldEventAnnouncementsCollection = worldEventAnnouncementsCollection;
    client.workProfilesCollection = workProfilesCollection;
    client.duelGamesCollection = duelGamesCollection;
    client.theftProfilesCollection = theftProfilesCollection;
    client.wantedListCollection = wantedListCollection;
    client.theftLogsCollection = theftLogsCollection;
    client.dungeonRunsCollection = dungeonRunsCollection;
    client.marketListingsCollection = marketListingsCollection;
    client.barterListingsCollection = barterListingsCollection;
    client.marketplaceMailboxCollection = marketplaceMailboxCollection;
    client.marketSalesCollection = marketSalesCollection;
    client.cooldownRemindersCollection = cooldownRemindersCollection;
    client.notifySettingsCollection = notifySettingsCollection;
    client.oreMarketPricesCollection = oreMarketPricesCollection;
    client.eventAnnouncementsCollection = eventAnnouncementsCollection;
    client.donationSessionsCollection = donationSessionsCollection;
    client.donationRecordsCollection = donationRecordsCollection;
    client.unmatchedDonationsCollection = unmatchedDonationsCollection;
    client.dashboardAuditLogCollection = dashboardAuditLogCollection;
    client.cronJobLogCollection = cronJobLogCollection;
    client.userSettingsCollection = userSettingsCollection;
    client.commandStatsCollection = commandStatsCollection;
    client.surveyResponsesCollection = surveyResponsesCollection;
    client.gameRoomsCollection = gameRoomsCollection;
    client.countersCollection = countersCollection;
    client.rssWeeklyPostsCollection = rssWeeklyPostsCollection;

    // 抖內系統索引
    // - code unique：用於 webhook 對應 session
    // - status + createdAt：給 reconcile cron 掃過期 pending
    // - createdAt TTL 24 小時：sessionTtlMinutes 是 30 分業務語意，
    //   存 24 小時是保留一段時間讓對帳查得到，避免 mongo TTL 把剛 grant
    //   完還沒寫 record 的 doc 掃掉
    await donationSessionsCollection
      .createIndex({ code: 1 }, { unique: true, name: "uniq_donation_session_code" })
      .catch((e) =>
        console.log(`[WARN] DonationSessions code 索引建立失敗：${e.message}`.yellow),
      );
    // sessionId index：website /api/donation/status/[id] 用這個查
    await donationSessionsCollection
      .createIndex({ sessionId: 1 }, { unique: true, name: "uniq_donation_session_id" })
      .catch((e) =>
        console.log(`[WARN] DonationSessions sessionId 索引建立失敗：${e.message}`.yellow),
      );
    // donation_records.sessionId 同樣讓 website 反查 perks
    await donationRecordsCollection
      .createIndex({ sessionId: 1 }, { name: "donation_record_sessionId", sparse: true })
      .catch((e) =>
        console.log(`[WARN] DonationRecords sessionId 索引建立失敗：${e.message}`.yellow),
      );
    await donationSessionsCollection
      .createIndex({ status: 1, createdAt: 1 }, { name: "donation_session_status_time" })
      .catch((e) =>
        console.log(`[WARN] DonationSessions status 索引建立失敗：${e.message}`.yellow),
      );
    await donationSessionsCollection
      .createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 24 * 60 * 60, name: "donation_session_ttl_24h" },
      )
      .catch((e) =>
        console.log(`[WARN] DonationSessions TTL 索引建立失敗：${e.message}`.yellow),
      );

    // donation_records：tradeNo unique 為冪等鍵；歷史永久保留不設 TTL
    await donationRecordsCollection
      .createIndex({ tradeNo: 1 }, { unique: true, name: "uniq_donation_record_trade" })
      .catch((e) =>
        console.log(`[WARN] DonationRecords tradeNo 索引建立失敗：${e.message}`.yellow),
      );
    await donationRecordsCollection
      .createIndex(
        { userId: 1, guildId: 1, grantedAt: -1 },
        { name: "donation_record_user_guild_time" },
      )
      .catch((e) =>
        console.log(`[WARN] DonationRecords 玩家索引建立失敗：${e.message}`.yellow),
      );
    await donationRecordsCollection
      .createIndex(
        { guildId: 1, grantedAt: -1 },
        { name: "donation_record_guild_time" },
      )
      .catch((e) =>
        console.log(`[WARN] DonationRecords guild 索引建立失敗：${e.message}`.yellow),
      );

    // unmatched_donations：code 找不到 session 時的備援。tradeNo 仍然 unique
    // 防止 webhook 重送重複寫入。resolved=false 是待處理。
    await unmatchedDonationsCollection
      .createIndex(
        { tradeNo: 1 },
        { unique: true, name: "uniq_unmatched_trade" },
      )
      .catch((e) =>
        console.log(`[WARN] UnmatchedDonations tradeNo 索引建立失敗：${e.message}`.yellow),
      );
    await unmatchedDonationsCollection
      .createIndex(
        { resolved: 1, createdAt: -1 },
        { name: "unmatched_resolved_time" },
      )
      .catch((e) =>
        console.log(`[WARN] UnmatchedDonations resolved 索引建立失敗：${e.message}`.yellow),
      );

    // Dashboard 稽核日誌索引：依時間倒序查、依 admin / action 篩、90 天 TTL 自動清
    await dashboardAuditLogCollection
      .createIndex({ ts: -1 }, { name: "audit_ts_desc" })
      .catch((e) =>
        console.log(`[WARN] DashboardAuditLog ts 索引建立失敗：${e.message}`.yellow),
      );
    await dashboardAuditLogCollection
      .createIndex({ adminId: 1, ts: -1 }, { name: "audit_admin_time" })
      .catch((e) =>
        console.log(`[WARN] DashboardAuditLog admin 索引建立失敗：${e.message}`.yellow),
      );
    await dashboardAuditLogCollection
      .createIndex({ action: 1, ts: -1 }, { name: "audit_action_time" })
      .catch((e) =>
        console.log(`[WARN] DashboardAuditLog action 索引建立失敗：${e.message}`.yellow),
      );
    await dashboardAuditLogCollection
      .createIndex(
        { ts: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "audit_ttl_90d" },
      )
      .catch((e) =>
        console.log(`[WARN] DashboardAuditLog TTL 索引建立失敗：${e.message}`.yellow),
      );

    // Cron 任務紀錄索引：依任務名 + 時間倒序查、30 天 TTL 自動清
    await cronJobLogCollection
      .createIndex({ name: 1, startedAt: -1 }, { name: "cron_log_name_time" })
      .catch((e) =>
        console.log(`[WARN] CronJobLog name 索引建立失敗：${e.message}`.yellow),
      );
    await cronJobLogCollection
      .createIndex({ startedAt: -1 }, { name: "cron_log_time_desc" })
      .catch((e) =>
        console.log(`[WARN] CronJobLog ts 索引建立失敗：${e.message}`.yellow),
      );
    await cronJobLogCollection
      .createIndex(
        { startedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "cron_log_ttl_30d" },
      )
      .catch((e) =>
        console.log(`[WARN] CronJobLog TTL 索引建立失敗：${e.message}`.yellow),
      );

    // UserSettings：(userId, guildId) 唯一
    await userSettingsCollection
      .createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_user_settings" },
      )
      .catch((e) =>
        console.log(`[WARN] UserSettings 唯一索引建立失敗：${e.message}`.yellow),
      );

    // CommandStats：name 唯一（一個指令一筆）；排行查詢靠 count 索引
    await commandStatsCollection
      .createIndex({ name: 1 }, { unique: true, name: "uniq_command_stats_name" })
      .catch((e) =>
        console.log(`[WARN] CommandStats name 索引建立失敗：${e.message}`.yellow),
      );
    await commandStatsCollection
      .createIndex({ count: -1 }, { name: "command_stats_count_desc" })
      .catch((e) =>
        console.log(`[WARN] CommandStats count 索引建立失敗：${e.message}`.yellow),
      );

    // SurveyResponses：(userId, guildId) 唯一；統計查詢靠 (guildId, completedAt)
    await surveyResponsesCollection
      .createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_survey_user_guild" },
      )
      .catch((e) =>
        console.log(`[WARN] SurveyResponses 唯一索引建立失敗：${e.message}`.yellow),
      );
    await surveyResponsesCollection
      .createIndex(
        { guildId: 1, completedAt: -1 },
        { name: "survey_guild_completed" },
      )
      .catch((e) =>
        console.log(`[WARN] SurveyResponses 統計索引建立失敗：${e.message}`.yellow),
      );

    await economySnapshotsCollection
      .createIndex({ guildId: 1, date: 1 }, { unique: true })
      .catch((e) =>
        console.log(`[WARN] EconomySnapshots index 建立失敗：${e.message}`.yellow),
      );

    // 銀行系統索引
    await coinDepositsCollection
      .createIndex({ userId: 1, guildId: 1, status: 1 }, { name: "coin_deposit_user_status" })
      .catch((e) => console.log(`[WARN] CoinDeposits index 建立失敗：${e.message}`.yellow));
    await coinDepositsCollection
      .createIndex({ depositId: 1 }, { unique: true, name: "uniq_coin_deposit_id" })
      .catch((e) => console.log(`[WARN] CoinDeposits depositId index 建立失敗：${e.message}`.yellow));
    await creditProfilesCollection
      .createIndex({ userId: 1, guildId: 1 }, { unique: true, name: "uniq_credit_user_guild" })
      .catch((e) => console.log(`[WARN] CreditProfiles index 建立失敗：${e.message}`.yellow));
    await goldHoldingsCollection
      .createIndex({ userId: 1, guildId: 1 }, { unique: true, name: "uniq_gold_holding_user_guild" })
      .catch((e) => console.log(`[WARN] GoldHoldings index 建立失敗：${e.message}`.yellow));
    await goldDepositsCollection
      .createIndex({ depositId: 1 }, { unique: true, name: "uniq_gold_deposit_id" })
      .catch((e) => console.log(`[WARN] GoldDeposits index 建立失敗：${e.message}`.yellow));
    await goldDepositsCollection
      .createIndex({ userId: 1, guildId: 1, status: 1 }, { name: "gold_deposit_user_status" })
      .catch((e) => console.log(`[WARN] GoldDeposits user index 建立失敗：${e.message}`.yellow));
    await savingsAccountsCollection
      .createIndex({ userId: 1, guildId: 1 }, { unique: true, name: "uniq_savings_user_guild" })
      .catch((e) => console.log(`[WARN] SavingsAccounts index 建立失敗：${e.message}`.yellow));
    await loansCollection
      .createIndex({ loanId: 1 }, { unique: true, name: "uniq_loan_id" })
      .catch((e) => console.log(`[WARN] Loans index 建立失敗：${e.message}`.yellow));
    await loansCollection
      .createIndex({ userId: 1, guildId: 1, status: 1 }, { name: "loan_user_status" })
      .catch((e) => console.log(`[WARN] Loans user index 建立失敗：${e.message}`.yellow));
    await loansCollection
      .createIndex({ status: 1, dueAt: 1 }, { name: "loan_status_due" })
      .catch((e) => console.log(`[WARN] Loans due index 建立失敗：${e.message}`.yellow));
    await creditFlagsCollection
      .createIndex({ flagId: 1 }, { unique: true, name: "uniq_credit_flag_id" })
      .catch((e) => console.log(`[WARN] CreditFlags index 建立失敗：${e.message}`.yellow));
    await creditFlagsCollection
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, name: "credit_flag_ttl_90d" })
      .catch((e) => console.log(`[WARN] CreditFlags TTL 索引建立失敗：${e.message}`.yellow));
    // 礦石市價：date unique 作冪等鍵（freeze 當日只寫一次），走勢查詢靠 date 排序
    await oreMarketPricesCollection
      .createIndex({ date: 1 }, { unique: true, name: "uniq_ore_market_date" })
      .catch((e) =>
        console.log(`[WARN] OreMarketPrices index 建立失敗：${e.message}`.yellow),
      );
    // 限時活動公告去重：同活動同階段同實例只發一次；createdAt TTL 400 天清理
    await eventAnnouncementsCollection
      .createIndex(
        { eventId: 1, phase: 1, occurrence: 1 },
        { unique: true, name: "uniq_event_announce" },
      )
      .catch((e) =>
        console.log(`[WARN] EventAnnouncements index 建立失敗：${e.message}`.yellow),
      );

    // 周表 RSS 已貼文記錄：同 feed × 同貼文 × 同 thread 唯一（跨週貼兩個 thread 各記一筆）
    await rssWeeklyPostsCollection
      .createIndex(
        { feedId: 1, itemKey: 1, threadId: 1 },
        { unique: true, name: "uniq_weekly_post_thread" },
      )
      .catch((e) =>
        console.log(`[WARN] RssWeeklyPosts uniq index 建立失敗：${e.message}`.yellow),
      );
    await rssWeeklyPostsCollection
      .createIndex({ weekStart: 1 }, { name: "weekly_post_weekStart" })
      .catch((e) =>
        console.log(`[WARN] RssWeeklyPosts weekStart index 建立失敗：${e.message}`.yellow),
      );
    await eventAnnouncementsCollection
      .createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 400 * 24 * 60 * 60, name: "event_announce_ttl_400d" },
      )
      .catch((e) =>
        console.log(`[WARN] EventAnnouncements TTL 索引建立失敗：${e.message}`.yellow),
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
    await notifySettingsCollection
      .createIndex({ userId: 1, guildId: 1 }, { unique: true })
      .catch((e) =>
        console.log(`[WARN] NotifySettings index 建立失敗：${e.message}`.yellow),
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
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "level_tx_ttl_30d" }
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
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "coin_ttl_30d" }
      );

      // 待收轉帳 / 贈送索引
      await pendingTransfersCollection.createIndex(
        { offer_id: 1 },
        { unique: true, name: "uniq_pending_transfer_id" }
      );
      // 到期掃描：撈 pending 且已過期
      await pendingTransfersCollection.createIndex(
        { status: 1, expires_at: 1 },
        { name: "pending_transfer_status_expiry" }
      );
      // 每人待處理數量上限查詢（寄件方）
      await pendingTransfersCollection.createIndex(
        { guild_id: 1, sender_id: 1, status: 1 },
        { name: "pending_transfer_sender_status" }
      );
      // 收到 / 拒收後歷史保留 30 天再清（pending 一律 <24h，不會被提早清掉）
      await pendingTransfersCollection.createIndex(
        { created_at: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "pending_transfer_ttl_30d" }
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

      // 爬塔對局索引：每位玩家同 guild 同時只能有一局 playing
      await towerGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_tw_gameId" }
      );
      await towerGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "tw_user_guild_status" }
      );
      await towerGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "tw_ttl_30d" }
      );

      // 踩地雷對局索引：每位玩家同 guild 同時只能有一局 playing
      await minesGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_mn_gameId" }
      );
      await minesGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "mn_user_guild_status" }
      );
      await minesGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "mn_ttl_30d" }
      );

      // 刮刮樂對局索引：每位玩家同 guild 同時只能有一張 playing
      await scratchGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_sc_gameId" }
      );
      await scratchGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "sc_user_guild_status" }
      );
      await scratchGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "sc_ttl_30d" }
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

      // 單人德州撲克索引：每人同 guild 同時只能有一局 playing
      await casinoHoldemGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_ch_gameId" }
      );
      await casinoHoldemGamesCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        { name: "ch_user_guild_status" }
      );
      await casinoHoldemGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "ch_ttl_30d" }
      );

      // 搶紅包索引：channel-scoped + 到期掃描
      await redPacketGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_rp_gameId" }
      );
      await redPacketGamesCollection.createIndex(
        { status: 1, expiresAt: 1 },
        { name: "rp_status_expiry" }
      );
      await redPacketGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "rp_ttl_30d" }
      );

      // 俄羅斯輪盤索引：channel-scoped 等候 + 到期掃描
      await russianRouletteGamesCollection.createIndex(
        { gameId: 1 },
        { unique: true, name: "uniq_rr_gameId" }
      );
      await russianRouletteGamesCollection.createIndex(
        { channelId: 1, status: 1 },
        { name: "rr_channel_status" }
      );
      await russianRouletteGamesCollection.createIndex(
        { status: 1, expiresAt: 1 },
        { name: "rr_status_expiry" }
      );
      await russianRouletteGamesCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "rr_ttl_30d" }
      );

      // 賓果大廳場次索引：同時只能有一場 open（partial unique）+ 到期掃描
      await bingoHallRoundsCollection.createIndex(
        { roundId: 1 },
        { unique: true, name: "uniq_bh_roundId" }
      );
      await bingoHallRoundsCollection.createIndex(
        { status: 1 },
        {
          unique: true,
          partialFilterExpression: { status: "open" },
          name: "uniq_bh_single_open",
        }
      );
      await bingoHallRoundsCollection.createIndex(
        { status: 1, scheduledAt: 1 },
        { name: "bh_status_scheduled" }
      );
      await bingoHallRoundsCollection.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "bh_ttl_90d" }
      );

      // 賓果大廳卡片索引
      await bingoHallCardsCollection.createIndex(
        { cardId: 1 },
        { unique: true, name: "uniq_bhc_cardId" }
      );
      await bingoHallCardsCollection.createIndex(
        { roundId: 1, userId: 1 },
        { name: "bhc_round_user" }
      );
      await bingoHallCardsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "bhc_ttl_90d" }
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

      // 任務通知偏好：(user, guild) 唯一
      await questSettingsCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_quest_settings_user_guild" }
      );

      // 任務指派：(user, guild, tier, period) 唯一
      await questAssignmentsCollection.createIndex(
        { userId: 1, guildId: 1, tier: 1, period: 1 },
        { unique: true, name: "uniq_quest_assign_user_guild_tier_period" }
      );
      await questAssignmentsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 60 * 24 * 60 * 60, name: "quest_assign_ttl_60d_create" }
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
      await stockBroadcastCollection.createIndex(
        { guildId: 1 },
        { unique: true, name: "stock_broadcast_guild" }
      );
      await stockShortsCollection.createIndex(
        { userId: 1, guildId: 1, symbol: 1 },
        { unique: true, name: "uniq_shorts_user_guild_symbol" }
      );
      await stockShortsCollection.createIndex(
        { guildId: 1, symbol: 1 },
        { name: "shorts_guild_symbol" }
      );
      await stockTreasuryCollection.createIndex(
        { guildId: 1 },
        { unique: true, name: "uniq_treasury_guild" }
      );
      await stockInsiderTipsCollection.createIndex(
        { userId: 1, guildId: 1, createdAt: -1 },
        { name: "insider_user_guild_time" }
      );
      await stockInsiderTipsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "insider_ttl_30d" }
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

      // 釣魚系統索引（Phase S4）
      await fishLogsCollection.createIndex(
        { guild_id: 1, ts: -1 },
        { name: "fish_logs_guild_time" }
      ).catch((e) => console.log(`[WARN] FishLogs index: ${e.message}`.yellow));

      // 農場系統索引（Phase D）：每位玩家每地塊唯一；cron 用 status + 時間索引掃過期
      await farmPlotsCollection.createIndex(
        { userId: 1, guildId: 1, plotIndex: 1 },
        { unique: true, name: "uniq_farm_user_guild_plot" }
      ).catch((e) => console.log(`[WARN] FarmPlots uniq index: ${e.message}`.yellow));
      await farmPlotsCollection.createIndex(
        { status: 1, ready_at: 1 },
        { name: "farm_status_ready" }
      ).catch((e) => console.log(`[WARN] FarmPlots ready 索引: ${e.message}`.yellow));
      await farmPlotsCollection.createIndex(
        { status: 1, expires_at: 1 },
        { name: "farm_status_expiry" }
      ).catch((e) => console.log(`[WARN] FarmPlots expiry 索引: ${e.message}`.yellow));

      // BOSS 共鬥索引（Phase C）
      await bossEventsCollection.createIndex(
        { guild_id: 1, status: 1 },
        { name: "boss_guild_status" }
      ).catch((e) => console.log(`[WARN] BossEvents guild_status: ${e.message}`.yellow));
      await bossEventsCollection.createIndex(
        { status: 1, ends_at: 1 },
        { name: "boss_status_ends" }
      ).catch((e) => console.log(`[WARN] BossEvents status_ends: ${e.message}`.yellow));
      await bossDamageLogsCollection.createIndex(
        { boss_id: 1, user_id: 1 },
        { name: "boss_dmg_boss_user" }
      ).catch((e) => console.log(`[WARN] BossDamageLogs boss_user: ${e.message}`.yellow));
      await bossDamageLogsCollection.createIndex(
        { boss_id: 1, ts: -1 },
        { name: "boss_dmg_boss_ts" }
      ).catch((e) => console.log(`[WARN] BossDamageLogs boss_ts: ${e.message}`.yellow));
      await bossDamageLogsCollection.createIndex(
        { ts: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "boss_dmg_ttl_90d" }
      ).catch((e) => console.log(`[WARN] BossDamageLogs TTL: ${e.message}`.yellow));
      // 公會系統索引（Phase A）
      await guildsClubCollection.createIndex(
        { guild_club_id: 1 },
        { unique: true, name: "uniq_gc_id" }
      ).catch((e) => console.log(`[WARN] GuildsClub id: ${e.message}`.yellow));
      // 同伺服器、未解散公會的名稱不可重複；已解散的允許同名（歷史保留）
      await guildsClubCollection.createIndex(
        { guildId: 1, name: 1 },
        {
          unique: true,
          partialFilterExpression: { disbanded_at: null },
          name: "uniq_gc_guild_name_active",
        }
      ).catch((e) => console.log(`[WARN] GuildsClub name: ${e.message}`.yellow));
      await guildsClubCollection.createIndex(
        { guildId: 1, disbanded_at: 1, treasury: -1 },
        { name: "gc_guild_disbanded_treasury" }
      ).catch((e) => console.log(`[WARN] GuildsClub rank: ${e.message}`.yellow));

      // 成員：一個玩家在同伺服器最多屬於一個公會
      await guildClubMembersCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_gcm_user_guild" }
      ).catch((e) => console.log(`[WARN] GuildClubMembers uniq: ${e.message}`.yellow));
      await guildClubMembersCollection.createIndex(
        { guild_club_id: 1 },
        { name: "gcm_club" }
      ).catch((e) => console.log(`[WARN] GuildClubMembers club: ${e.message}`.yellow));

      // 金庫流水：90 天 TTL
      await guildClubLogsCollection.createIndex(
        { guild_club_id: 1, createdAt: -1 },
        { name: "gcl_club_time" }
      ).catch((e) => console.log(`[WARN] GuildClubLogs idx: ${e.message}`.yellow));
      // 防洗錢冷卻查詢：(user_id, source, createdAt -1) 取最後一筆 leave / kicked / disbanded
      await guildClubLogsCollection.createIndex(
        { user_id: 1, source: 1, createdAt: -1 },
        { name: "gcl_user_source_time", sparse: true }
      ).catch((e) => console.log(`[WARN] GuildClubLogs user_source idx: ${e.message}`.yellow));
      await guildClubLogsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "gcl_ttl_90d" }
      ).catch((e) => console.log(`[WARN] GuildClubLogs TTL: ${e.message}`.yellow));

      // 邀請：pending 查詢 + 過期自動清
      await guildClubInvitationsCollection.createIndex(
        { invitee_id: 1, guildId: 1, status: 1 },
        { name: "gci_invitee_status" }
      ).catch((e) => console.log(`[WARN] GuildClubInvitations idx: ${e.message}`.yellow));
      await guildClubInvitationsCollection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: "gci_ttl" }
      ).catch((e) => console.log(`[WARN] GuildClubInvitations TTL: ${e.message}`.yellow));

      // 申請：會長列出 pending + 防同玩家重複申請同公會
      await guildClubApplicationsCollection.createIndex(
        { guild_club_id: 1, status: 1, createdAt: -1 },
        { name: "gca_club_status" }
      ).catch((e) => console.log(`[WARN] GuildClubApplications idx: ${e.message}`.yellow));
      await guildClubApplicationsCollection.createIndex(
        { applicant_id: 1, guildId: 1, status: 1 },
        { name: "gca_applicant_status" }
      ).catch((e) => console.log(`[WARN] GuildClubApplications applicant: ${e.message}`.yellow));
      await guildClubApplicationsCollection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: "gca_ttl" }
      ).catch((e) => console.log(`[WARN] GuildClubApplications TTL: ${e.message}`.yellow));

      // 週任務領取：(公會、任務、週期) 唯一防重複領取
      await guildClubQuestClaimsCollection.createIndex(
        { guild_club_id: 1, questId: 1, period: 1 },
        { unique: true, name: "uniq_gcqc_club_quest_period" }
      ).catch((e) => console.log(`[WARN] GuildClubQuestClaims uniq: ${e.message}`.yellow));

      // BOSS 公會貢獻：(userId, guildId) 唯一，累計 + 週度
      await guildClubContributionsCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_gcc_user_guild" }
      ).catch((e) => console.log(`[WARN] GuildClubContributions uniq: ${e.message}`.yellow));
      await guildClubContributionsCollection.createIndex(
        { guild_club_id: 1, weekKey: 1, weeklyContribution: -1 },
        { name: "gcc_club_week_rank" }
      ).catch((e) => console.log(`[WARN] GuildClubContributions rank: ${e.message}`.yellow));
      await guildClubContributionsCollection.createIndex(
        { guild_club_id: 1, totalContribution: -1 },
        { name: "gcc_club_total_rank" }
      ).catch((e) => console.log(`[WARN] GuildClubContributions total: ${e.message}`.yellow));

      // 公會倉庫：(公會, 物品) 唯一
      await guildClubWarehouseCollection.createIndex(
        { guild_club_id: 1, item_id: 1 },
        { unique: true, name: "uniq_gcw_club_item" }
      ).catch((e) => console.log(`[WARN] GuildClubWarehouse uniq: ${e.message}`.yellow));

      // 倉庫流水：90 天 TTL；公會時間軸 + 24h 自存自領查詢用
      await guildClubWarehouseLogsCollection.createIndex(
        { guild_club_id: 1, created_at: -1 },
        { name: "gcwl_club_time" }
      ).catch((e) => console.log(`[WARN] GuildClubWarehouseLogs idx: ${e.message}`.yellow));
      await guildClubWarehouseLogsCollection.createIndex(
        { user_id: 1, item_id: 1, action: 1, created_at: -1 },
        { name: "gcwl_user_item_action" }
      ).catch((e) => console.log(`[WARN] GuildClubWarehouseLogs user_item idx: ${e.message}`.yellow));
      await guildClubWarehouseLogsCollection.createIndex(
        { created_at: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "gcwl_ttl_90d" }
      ).catch((e) => console.log(`[WARN] GuildClubWarehouseLogs TTL: ${e.message}`.yellow));

      // 每日領取額度：(userId, guildId, day_key) 唯一；7 天 TTL 自動清舊
      await guildClubWarehouseDailyCollection.createIndex(
        { user_id: 1, guildId: 1, day_key: 1 },
        { unique: true, name: "uniq_gcwd_user_guild_day" }
      ).catch((e) => console.log(`[WARN] GuildClubWarehouseDaily uniq: ${e.message}`.yellow));
      await guildClubWarehouseDailyCollection.createIndex(
        { updated_at: 1 },
        { expireAfterSeconds: 7 * 24 * 60 * 60, name: "gcwd_ttl_7d" }
      ).catch((e) => console.log(`[WARN] GuildClubWarehouseDaily TTL: ${e.message}`.yellow));

      // 世界事件索引
      await worldEventsCollection.createIndex(
        { event_db_id: 1 },
        { unique: true, name: "uniq_we_event_db_id" }
      ).catch((e) => console.log(`[WARN] WorldEvents id: ${e.message}`.yellow));
      await worldEventsCollection.createIndex(
        { state: 1, ends_at: 1 },
        { name: "we_state_ends_at" }
      ).catch((e) => console.log(`[WARN] WorldEvents state: ${e.message}`.yellow));
      await worldEventsCollection.createIndex(
        { event_id: 1, ended_at: -1 },
        { name: "we_event_ended_at" }
      ).catch((e) => console.log(`[WARN] WorldEvents cooldown: ${e.message}`.yellow));
      await worldEventContributionsCollection.createIndex(
        { event_db_id: 1, created_at: -1 },
        { name: "wec_event_time" }
      ).catch((e) => console.log(`[WARN] WorldEventContributions idx: ${e.message}`.yellow));
      await worldEventContributionsCollection.createIndex(
        { user_id: 1, created_at: -1 },
        { name: "wec_user_time" }
      ).catch((e) => console.log(`[WARN] WorldEventContributions user: ${e.message}`.yellow));
      await worldEventContributionsCollection.createIndex(
        { created_at: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "wec_ttl_90d" }
      ).catch((e) => console.log(`[WARN] WorldEventContributions TTL: ${e.message}`.yellow));
      await worldEventAnnouncementsCollection.createIndex(
        { event_db_id: 1, phase: 1 },
        { unique: true, name: "uniq_wea_event_phase" }
      ).catch((e) => console.log(`[WARN] WorldEventAnnouncements uniq: ${e.message}`.yellow));
      await worldEventAnnouncementsCollection.createIndex(
        { created_at: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "wea_ttl_30d" }
      ).catch((e) => console.log(`[WARN] WorldEventAnnouncements TTL: ${e.message}`.yellow));

      await fishLogsCollection.createIndex(
        { ts: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "fish_logs_ttl_90d" }
      ).catch((e) => console.log(`[WARN] FishLogs TTL index: ${e.message}`.yellow));
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

      // 盜賊系統索引
      // 惡名 / 防身狀態：(userId, guildId) 唯一
      await theftProfilesCollection.createIndex(
        { userId: 1, guildId: 1 },
        { unique: true, name: "uniq_theft_profile_user_guild" }
      ).catch((e) => console.log(`[WARN] TheftProfiles uniq: ${e.message}`.yellow));
      // 通緝榜：一人同時只有一筆 active 通緝（partial unique）；榜單排序 + cron 掃到期
      await wantedListCollection.createIndex(
        { userId: 1, guildId: 1, status: 1 },
        {
          unique: true,
          partialFilterExpression: { status: "wanted" },
          name: "uniq_wanted_active",
        }
      ).catch((e) => console.log(`[WARN] WantedList active uniq: ${e.message}`.yellow));
      await wantedListCollection.createIndex(
        { guildId: 1, status: 1, bounty: -1 },
        { name: "wanted_guild_status_bounty" }
      ).catch((e) => console.log(`[WARN] WantedList list idx: ${e.message}`.yellow));
      await wantedListCollection.createIndex(
        { status: 1, expires_at: 1 },
        { name: "wanted_status_expiry" }
      ).catch((e) => console.log(`[WARN] WantedList expiry idx: ${e.message}`.yellow));
      // 竊案 / 追捕紀錄：每日計數、同對象冷卻、報案查兇手；90 天 TTL
      await theftLogsCollection.createIndex(
        { guildId: 1, type: 1, actor_id: 1, ts: -1 },
        { name: "theft_logs_actor" }
      ).catch((e) => console.log(`[WARN] TheftLogs actor idx: ${e.message}`.yellow));
      await theftLogsCollection.createIndex(
        { guildId: 1, type: 1, target_id: 1, success: 1, ts: -1 },
        { name: "theft_logs_target" }
      ).catch((e) => console.log(`[WARN] TheftLogs target idx: ${e.message}`.yellow));
      await theftLogsCollection.createIndex(
        { ts: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "theft_logs_ttl_90d" }
      ).catch((e) => console.log(`[WARN] TheftLogs TTL: ${e.message}`.yellow));

      // 地下城戰鬥紀錄索引（Phase H+）：玩家近期戰鬥 / 主題統計 / TTL 30 天
      await dungeonRunsCollection.createIndex(
        { user_id: 1, ended_at: -1 },
        { name: "dungeon_runs_user_time" }
      ).catch((e) => console.log(`[WARN] DungeonRuns user_time: ${e.message}`.yellow));
      await dungeonRunsCollection.createIndex(
        { user_id: 1, theme: 1, floor: 1, ended_at: -1 },
        { name: "dungeon_runs_user_theme_floor" }
      ).catch((e) => console.log(`[WARN] DungeonRuns user_theme_floor: ${e.message}`.yellow));
      await dungeonRunsCollection.createIndex(
        { guild_id: 1, theme: 1, floor: 1, ended_at: -1 },
        { name: "dungeon_runs_guild_theme_floor" }
      ).catch((e) => console.log(`[WARN] DungeonRuns guild_theme_floor: ${e.message}`.yellow));
      await dungeonRunsCollection.createIndex(
        { run_id: 1 },
        { unique: true, name: "uniq_dungeon_run_id" }
      ).catch((e) => console.log(`[WARN] DungeonRuns run_id: ${e.message}`.yellow));
      // mini-BOSS 戰鬥用 is_milestone 標記，TTL 跳過（紀念意義 1 年由 cron 自行清）
      await dungeonRunsCollection.createIndex(
        { ended_at: 1 },
        {
          expireAfterSeconds: 30 * 24 * 60 * 60,
          name: "dungeon_runs_ttl_30d",
          partialFilterExpression: { is_milestone: { $ne: true } },
        }
      ).catch((e) => console.log(`[WARN] DungeonRuns TTL: ${e.message}`.yellow));

      // 市集索引：(guild, listing_id) 唯一；cron 用 (status, expires_at)；type 篩選
      await marketListingsCollection.createIndex(
        { guild_id: 1, listing_id: 1 },
        { unique: true, name: "uniq_market_guild_listing" }
      ).catch((e) => console.log(`[WARN] MarketListings uniq 索引：${e.message}`.yellow));
      await marketListingsCollection.createIndex(
        { guild_id: 1, status: 1, expires_at: 1 },
        { name: "market_guild_status_expiry" }
      ).catch((e) => console.log(`[WARN] MarketListings status 索引：${e.message}`.yellow));
      await marketListingsCollection.createIndex(
        { guild_id: 1, listing_type: 1, status: 1 },
        { name: "market_guild_type_status" }
      ).catch((e) => console.log(`[WARN] MarketListings type 索引：${e.message}`.yellow));
      await marketListingsCollection.createIndex(
        { guild_id: 1, seller_id: 1, status: 1 },
        { name: "market_guild_seller_status" }
      ).catch((e) => console.log(`[WARN] MarketListings seller 索引：${e.message}`.yellow));
      await marketListingsCollection.createIndex(
        { settled_at: 1 },
        { expireAfterSeconds: 7 * 24 * 60 * 60, name: "market_ttl_7d", sparse: true }
      ).catch((e) => console.log(`[WARN] MarketListings TTL 索引：${e.message}`.yellow));

      // 市集成交樣本索引：依物品查近期單價；90 天 TTL 自動清
      await marketSalesCollection.createIndex(
        { guildId: 1, item_type: 1, item_key: 1, settledAt: -1 },
        { name: "market_sales_item_time" }
      ).catch((e) => console.log(`[WARN] MarketSales item 索引：${e.message}`.yellow));
      await marketSalesCollection.createIndex(
        { settledAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "market_sales_ttl_90d" }
      ).catch((e) => console.log(`[WARN] MarketSales TTL 索引：${e.message}`.yellow));

      // 交易所掛單索引
      await barterListingsCollection.createIndex(
        { guild_id: 1, listing_id: 1 },
        { unique: true, name: "uniq_barter_guild_listing" }
      ).catch((e) => console.log(`[WARN] BarterListings uniq 索引：${e.message}`.yellow));
      await barterListingsCollection.createIndex(
        { guild_id: 1, status: 1, created_at: -1 },
        { name: "barter_guild_status_created" }
      ).catch((e) => console.log(`[WARN] BarterListings status 索引：${e.message}`.yellow));
      await barterListingsCollection.createIndex(
        { guild_id: 1, seller_id: 1, status: 1 },
        { name: "barter_guild_seller_status" }
      ).catch((e) => console.log(`[WARN] BarterListings seller 索引：${e.message}`.yellow));
      await barterListingsCollection.createIndex(
        { settled_at: 1 },
        { expireAfterSeconds: 7 * 24 * 60 * 60, name: "barter_ttl_7d", sparse: true }
      ).catch((e) => console.log(`[WARN] BarterListings TTL 索引：${e.message}`.yellow));

      // 退款信箱：mail_id 唯一；玩家查信靠 (user, guild) 索引；不設 TTL（玩家未領就一直留著）
      await marketplaceMailboxCollection.createIndex(
        { mail_id: 1 },
        { unique: true, name: "uniq_mailbox_id" }
      ).catch((e) => console.log(`[WARN] MarketplaceMailbox uniq 索引：${e.message}`.yellow));
      await marketplaceMailboxCollection.createIndex(
        { user_id: 1, guild_id: 1, created_at: 1 },
        { name: "mailbox_user_guild_time" }
      ).catch((e) => console.log(`[WARN] MarketplaceMailbox user 索引：${e.message}`.yellow));

      await gameRoomsCollection.createIndex(
        { threadId: 1 },
        { unique: true, name: "uniq_gameroom_thread" }
      ).catch((e) => console.log(`[WARN] GameRooms thread 索引：${e.message}`.yellow));
      await gameRoomsCollection.createIndex(
        { guildId: 1, ownerId: 1, status: 1 },
        { name: "gameroom_owner_status" }
      ).catch((e) => console.log(`[WARN] GameRooms owner 索引：${e.message}`.yellow));
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

    // 修補：舊版採集陷阱把 HP 打到 0 時錯把 hp_updated_at 設為 0，被 resolveHp 當成
    // 「滿血、計時停擺」而永不自然回復，玩家會卡在 0 HP。滿血玩家 hp_current 不可能為 0，
    // 故 hp_current:0 + hp_updated_at:0 必為卡住的受害者，重新啟動回復計時。idempotent。
    try {
      const stuck = await miningProfilesCollection.updateMany(
        { hp_current: 0, hp_updated_at: 0 },
        { $set: { hp_updated_at: Date.now(), updatedAt: new Date() } }
      );
      if (stuck.modifiedCount > 0) {
        console.log(`[DATA] HP 回復修補：重啟 ${stuck.modifiedCount} 位玩家的自然回復計時`.cyan);
      }
    } catch (migrateError) {
      console.log(`[WARNING] HP 回復修補失敗：${migrateError.message}`.yellow);
    }

    // 一次性遷移：把 UserLevels.cardAccent 對應的等級卡顏色補進 UserInventory，
    // 並標記為 equipped。/level cardtheme 已下線改由商店購買，此遷移確保舊用戶
    // 不會因為下線而失去手動設定過的顏色。idempotent。
    try {
      const accentDocs = await userLevelsCollection
        .find({ cardAccent: { $exists: true, $nin: [null, "", "default"] } })
        .project({ userId: 1, guildId: 1, cardAccent: 1 })
        .toArray();
      const accentNameMap = {
        pink: "粉紅",
        blue: "海藍",
        gold: "金箔",
        mint: "薄荷",
        mono: "墨黑",
      };
      let accentMigrated = 0;
      for (const u of accentDocs) {
        const key = u.cardAccent;
        if (!accentNameMap[key]) continue;
        const itemId = `accent_${key}`;
        const exists = await userInventoryCollection.findOne({
          userId: u.userId,
          guildId: u.guildId,
          itemId,
          type: "card_accent",
        });
        if (exists) {
          if (!exists.equipped) {
            await userInventoryCollection.updateOne(
              { _id: exists._id },
              { $set: { equipped: true, updatedAt: new Date() } }
            );
          }
          continue;
        }
        const now = new Date();
        await userInventoryCollection.insertOne({
          userId: u.userId,
          guildId: u.guildId,
          itemId,
          name: accentNameMap[key],
          type: "card_accent",
          payload: { themeKey: key },
          equipped: true,
          expiresAt: null,
          acquiredAt: now,
          updatedAt: now,
        });
        accentMigrated += 1;
      }
      if (accentMigrated > 0) {
        console.log(
          `[DATA] 等級卡顏色遷移：補發 ${accentMigrated} 位玩家的顏色到背包`
            .cyan
        );
      }
    } catch (migrateError) {
      console.log(
        `[WARNING] 等級卡顏色遷移失敗：${migrateError.message}`.yellow
      );
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
      `[WARNING] Database features will be disabled. Please check your MONGO_URI and network connection`.yellow
    );
  }
};
