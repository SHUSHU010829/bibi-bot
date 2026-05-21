# 逼逼機器人 (Discord Bot)

![Repobeats](https://repobeats.axiom.co/api/embed/07fb82330959889996315cafa478ae498f152b45.svg "Repobeats analytics image")

一隻為單一 Discord 社群量身打造的多功能機器人，整合社群治理（票務 / 投票 / 動態語音 / 身份組）、生活娛樂（早安卡、抽籤、食物/飲料管理、星座運勢）與外部資訊推播（Steam 特價、喜加一、加密貨幣、匯率、天氣）。

---

## 目錄

- [設計目的](#設計目的)
- [使用技術](#使用技術)
- [專案結構](#專案結構)
- [安裝與部署](#安裝與部署)
- [核心功能與操作流程](#核心功能與操作流程)
  - [動態語音頻道](#1-動態語音頻道)
  - [Ticket 與遊戲頻道投票](#2-ticket-與遊戲頻道投票)
  - [身份組自助領取](#3-身份組自助領取)
  - [建議 / 投票面板](#4-建議--投票面板)
  - [Steam 特價推播](#5-steam-特價推播)
  - [喜加一（限時免費）推播](#6-喜加一限時免費推播)
  - [每日早安卡 / 今日報告](#7-每日早安卡--今日報告)
  - [食物與飲料系統](#8-食物與飲料系統)
  - [加密貨幣 / 匯率 / 天氣](#9-加密貨幣--匯率--天氣)
  - [抽籤、統計與其他指令](#10-抽籤統計與其他指令)
  - [等級系統與每日簽到](#11-等級系統與每日簽到)
  - [金幣經濟、賭場與商店](#12-金幣經濟賭場與商店)
  - [Twitter / Threads 連結修正](#13-twitter--threads-連結修正)
- [維運腳本](#維運腳本)
- [外部 API](#外部-api)
- [維護建議](#維護建議)

---

## 設計目的

- **集中化社群治理**：以「申請 → 審核 → 投票 → 自動結算」流程規範遊戲頻道的開設與封存，避免管理員主觀決策。
- **降低管理員負擔**：動態語音頻道、Ticket、身份組、建議蒐集等流程全部交由 bot 自動化處理。
- **內容主動觸達**：將 Steam 特價、限時免費遊戲、每日早安、星座運勢等資訊在固定時間推播到指定頻道，提升社群活躍度。
- **單一伺服器最佳化**：所有設定集中在 `src/config.json`，搭配 `.env` 即可快速複製到其他伺服器使用。

---

## 使用技術

| 類別 | 技術 |
| --- | --- |
| 執行環境 | Node.js 22.x |
| Discord SDK | [discord.js](https://discord.js.org/) v14（Slash Command、Buttons、Modal、Embed） |
| 資料庫 | MongoDB Atlas（透過官方 `mongodb` driver） |
| 排程 | [`node-cron`](https://www.npmjs.com/package/node-cron) |
| 圖片產生 | `satori` + `satori-html` + `@resvg/resvg-js`（早安卡、運勢卡） |
| 時間處理 | `luxon`、`tyme4ts`（農民曆 / 節氣） |
| 中文轉換 | `opencc-js`（簡繁轉換） |
| HTTP | `axios` |
| 部署 | Dockerfile（`node:22-slim`） |
| 開發工具 | `nodemon`、`dotenv` |

機器人在 `src/index.js` 啟動，建立 Discord Client 後委派給 `src/handlers/eventHandler.js` 動態載入 `src/events/**` 中所有事件處理器與 `src/commands/**` 中的 Slash Command。

---

## 專案結構

```
src/
├── index.js                # 進入點
├── config.json             # 主要設定檔（頻道 ID、權重、推播排程…）
├── messageConfig.json      # 訊息文案
├── handlers/eventHandler.js
├── commands/               # Slash Commands（按功能分子目錄）
│   ├── ask/                # 詢問星座運勢、占卜
│   ├── casino/             # /二十一點、/hilo、/拉霸、/賽馬、/樂透買、/賭場排行、/我的賭場紀錄…
│   ├── currency/           # 加密貨幣、匯率
│   ├── draw/               # 抽籤、抽一個（樂透模擬）
│   ├── economy/            # /錢包、/轉帳、/存款、/骰寶、/give-coins
│   ├── food/               # 食物/飲料 CRUD、/吃什麼
│   ├── general/            # /help
│   ├── level/              # /每日簽到、/等級卡、/徽章圖鑑、/稱號…
│   ├── post/               # 整人小工具（瓦斯燈）
│   ├── roles/              # /setup-roles
│   ├── shop/               # /商店、/背包（credits 商店、buff、卡面）
│   ├── stats/              # /stats、/leaderboard
│   ├── ticket/             # /setup-ticket、/proposal、/close-ticket、/setup-suggestion
│   └── weather/            # /weather
├── events/
│   ├── ready/              # bot 啟動時要做的事（載入 DB、註冊指令、起 cron…）
│   ├── interactionCreate/  # 按鈕、Select Menu 互動
│   ├── messageCreate/      # 訊息統計、Twitter/Threads 連結修正
│   ├── voiceStateUpdate/   # 動態語音、語音時長統計
│   ├── guildMemberAdd/Remove
│   └── validations/        # Slash Command 前置驗證、Autocomplete
├── features/
│   ├── casino/             # blackjack / hilo / sicbo / slot / lottery 引擎
│   ├── economy/            # grantCoins、買賣紀錄、轉帳手續費、定期存款
│   ├── leveling/           # XP 計算、徽章、稱號、升等公告
│   ├── shop/               # 商品結算、buff 倍率、role 顏色發放
│   ├── steamDeals/         # 小黑盒 RSS → Steam API → Embed → 推播
│   ├── freeGames/          # 喜加一抓取與發送
│   ├── twitch/             # Twitch 開台通知
│   └── voting/             # 投票結算、Ticket 公投
├── utils/                  # 共用函式（卡片產生、農民曆、autocomplete…）
├── data/                   # 持久化 JSON（身份組、建議、票務面板）
├── constants/              # 食物分類等靜態常數
├── scripts/                # 一次性資料遷移腳本
└── tool/                   # 部署 / 刪除 Slash Command 用的維運腳本
```

---

## 安裝與部署

### 1. 取得程式碼與安裝套件

```bash
git clone https://github.com/shushu010829/discord_bot.git
cd discord_bot
npm install
```

### 2. 建立 `.env`

複製 `.env.example` 為 `.env` 並填入：

| 變數 | 說明 |
| --- | --- |
| `BOT_TOKEN` | Discord Developer Portal 取得的 Bot Token |
| `MONGO_PASSWORD` | MongoDB Atlas 密碼 |
| `DISCORD_DEALS_CHANNEL_ID` | Steam 特價推播頻道（留空則用 `config.json`） |
| `STEAM_DEALS_*` | 排程、暫停、Dry-run、首啟即跑 |
| `DISCORD_FREE_GAMES_CHANNEL_ID`、`FREE_GAMES_*` | 喜加一推播控制 |

### 3. 設定 `src/config.json`

至少填入以下欄位（其他依需要）：

- `serverId`、`developersId`
- `normalChannelId`、`createVoiceChannelId`、`memberCountChannelId`
- `ticket.categoryId`、`ticket.supportRoleId`
- `voting.votingChannelId`
- `roles[]`（提供身份組面板選項）

### 4. 部署 Slash Command

```bash
node src/tool/deploy-commands.js   # 註冊指令
node src/tool/get-commands.js      # 列出已註冊指令
node src/tool/delete-commands.js   # 清除指令
```

### 5. 啟動

```bash
# 開發模式（nodemon 熱重載）
npm run start:dev

# 直接啟動
node src/index.js
```

### 6. Docker 部署

```bash
docker build -t discord-bot .
docker run -d --env-file .env --name bibi-bot discord-bot
```

---

## 核心功能與操作流程

### 1. 動態語音頻道

**目的**：讓成員自由建立 / 銷毀臨時語音頻道，無需打擾管理員。

**操作流程**：

```
使用者加入「點選新增頻道」
   ↓ voiceStateUpdate 觸發
bot 自動建立同分類下的新頻道（預設名稱「記得改名喔！」）
   ↓
將使用者移動進新頻道，並授予建立者「管理頻道」權限
   ↓
所有成員離開 → bot 自動刪除頻道
```

**設定**：將語音頻道 ID 填入 `config.json` 的 `createVoiceChannelId` 即可。

> Bot 必須擁有 **管理頻道** 與 **移動成員** 權限。頻道狀態僅存在記憶體中，重啟會遺失。

---

### 2. Ticket 與遊戲頻道投票

**目的**：把「想開新遊戲頻道 / 想封存舊頻道」的決策權交給社群投票。

**完整流程**：

```
使用者點 Ticket 面板「創建票務」
   ↓ 自動建立 ticket-{username} 私人頻道
管理員在票務頻道輸入 /proposal start
   ↓ bot 在投票頻道發布投票訊息
成員按按鈕投票（可改票、有互斥邏輯）
   ↓ node-cron 每 5 分鐘檢查過期投票
自動結算 → 更新訊息 → 通知 Ticket
   未通過：5 分鐘後自動關閉 Ticket
```

**指令**：

| 指令 | 權限 | 說明 |
| --- | --- | --- |
| `/setup-ticket` | 管理員 | 在當前頻道部署 Ticket 面板 |
| `/proposal start game:<名稱> type:<create\|archive>` | `ManageChannels` | 在 Ticket 頻道發起投票 |
| `/close-ticket` | Ticket 開啟者 / 管理員 | 立即關閉 Ticket |

**新增頻道 (create) 投票機制**：

| 選項 | 權重 | 意義 |
| --- | --- | --- |
| 🔥 我會玩 | 3 | 擁有遊戲、會活躍使用 |
| 👍 純支持 | 1 | 支持但不一定會玩 |
| 😶 沒興趣 | 0 | 純表態 |

**通過條件（雙重鎖）**：總分 ≥ `passThresholds.totalScore`（預設 15）**且** 核心玩家 ≥ `passThresholds.minPlayers`（預設 3）。

**封存頻道 (archive) 投票**：

- ✋ 我還在玩 / 📦 同意封存
- 「我還在玩」< `archiveThresholds.minActivePlayers`（預設 2）即通過封存。

**MongoDB 資料結構**：

```javascript
{
  voteId, ticketChannelId, proposerId, gameName,
  proposalType,                       // create | archive
  status,                             // VOTING | PASSED | FAILED
  messageId, channelId, guildId,
  votes: { players: [], supporters: [], noInterest: [] },
  createdAt, expiresAt
}
```

---

### 3. 身份組自助領取

**目的**：讓成員自行勾選想接收通知的身份組，免人工指派。

**流程**：

1. 管理員在通知頻道執行 `/setup-roles`
2. bot 依 `config.json` 的 `roles[]` 產生 Select Menu 面板
3. 成員選擇後由 `events/interactionCreate/handleRoleSelect.js` 增/刪身份組
4. 面板狀態會持久化到 `src/data/role-panels.json`，重啟後仍可運作

---

### 4. 建議 / 投票面板

**指令**：`/setup-suggestion`

提供讓成員提案、其他人投票（贊成 / 反對）的輕量級面板，資料存於 `src/data/suggestion-panels.json`，並由 `suggestionScheduler.js` 進行定期維護。

---

### 5. Steam 特價推播

**目的**：自動把台灣區 Steam 史低 / 高折扣遊戲推送到指定頻道。

**處理鏈**（`src/features/steamDeals/`）：

```
小黑盒 RSS (xiaoheihe.js)
   ↓ 抓回特價清單
Steam Store API (steam.js)
   ↓ 補上台幣價格、是否史低
filter.js
   ↓ 過濾掉非台區、不符條件
dedupe.js
   ↓ 同一遊戲不重複推
embed.js → 發送 Embed
```

**控制變數**（`.env` 覆寫 `config.json`）：

- `STEAM_DEALS_ENABLED`：開關
- `STEAM_DEALS_CRON`：排程（預設每 2 小時）
- `STEAM_DEALS_DRY_RUN`：只 log 不發送
- `STEAM_DEALS_RUN_ON_START`：啟動立即跑一次（驗證用）
- `activeHours.startHour / endHour`：只在指定時段內推播

---

### 6. 喜加一（限時免費）推播

**目的**：彙整 Epic / Steam 的限時免費遊戲。

**設定**位於 `config.json` 的 `freeGames`，可單獨開關各平台、覆寫 GamerPower API base URL；同樣支援 Dry-run、首啟即跑。資料來源為 [GamerPower API](https://www.gamerpower.com/api-read)。

排程預設 `30 */6 * * *`（與 Steam 特價錯開），實作於 `src/features/freeGames/` 與 `events/ready/freeGamesScheduler.js`。

---

### 6.5 Twitch 開台通知

**目的**：當指定的 Twitch 主播開台時，自動在 Discord 頻道推播一張 Twitch 紫色 embed（顯示主播名 / 標題 / 遊戲 / 觀眾數 / 縮圖 + Watch Stream 按鈕）。

**設定**位於 `src/config/twitch.json`：
- `channelId`：要推到的 Discord 頻道 ID（預設 `1181142765002833980`）
- `streamers`：要追蹤的 Twitch login 陣列（預設 `["shushu010829"]`）
- `cronSchedule`：輪詢頻率（預設 `*/1 * * * *`，每分鐘檢查一次）
- `messageContent`：通知文案模板，可用 `{streamer}` 取代主播名
- `mentionRoleId` / `mentionEveryone`：要不要 ping 身份組或全體

**環境變數**（見 `.env.example`）：
- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`：必填，於 [Twitch Dev Console](https://dev.twitch.tv/console/apps) 註冊 App 取得
- `DISCORD_TWITCH_CHANNEL_ID`、`TWITCH_STREAMERS`、`TWITCH_LIVE_CRON`、`TWITCH_LIVE_ENABLED`、`TWITCH_LIVE_DRY_RUN`、`TWITCH_LIVE_RUN_ON_START`

**去重**：`TwitchLiveState` collection 以 login 為 key，記錄上一次已通知的 streamId，同一場直播只會通知一次；下播後再開新一場才會再推一次。沒有 MongoDB 時會 fallback 到 in-memory，bot 重啟後會重新通知（屬預期行為）。

實作位於 `src/features/twitch/`（`api.js` 走 Helix App Access Token、`embed.js` 組訊息、`dedupe.js` 處理重複、`index.js` 串成一個 job）與 `events/ready/twitchLiveScheduler.js`。

---

### 7. 每日早安卡 / 今日報告

- **早安卡**：`events/ready/sendMorningMessage.js` 依 `morningMessage.cronSchedule`（預設每天早上 8 點）發送，使用 `satori` 動態繪製含日期、星期、節氣、農民曆、詩詞、運勢的 PNG 卡片。
- **`/today-report`**：成員可隨時手動取得今日資訊（日期、運勢、節日）。
- **資料來源**：本地 `src/data/calender.json`（透過 `npm run update-calendar` 從 TaiwanCalendar 更新）、`utils/getLunarInfo.js`（農民曆）、`utils/getPoem.js`（詩詞）。

---

### 8. 食物與飲料系統

為了解決「今天吃什麼？」的萬年難題：

| 指令 | 用途 |
| --- | --- |
| `/increase-food` | 新增餐廳 / 食物 |
| `/batch-add-food` | 批次匯入 |
| `/delete-food` | 刪除 |
| `/food-list` | 查看目前清單 |
| `/food-ranking` | 依抽中次數排名 |
| `/draw-lot` | 抽今天吃什麼 |
| `/drink-lot` | 抽今天喝什麼 |
| `/beverage-stores`、`/import-beverage-menu` | 飲料店與菜單管理 |

資料存於 MongoDB；指令內含 Autocomplete（`utils/autocompleteFoodName.js`、`autocompleteBeverageStore.js`）。

---

### 9. 加密貨幣 / 匯率 / 天氣

- `/cryptocurrency`：透過 [cryptocompare](https://min-api.cryptocompare.com/documentation) 查即時幣價。
- `/exchange-rate`：查台幣對外幣匯率。
- `/weather city:<城市>`、`/weather all`：查台灣縣市天氣。

---

### 10. 抽籤、統計與其他指令

| 指令 | 說明 |
| --- | --- |
| `/choose-one` | 在多個選項中隨機抽一個 |
| `/straws` | 抽籤（吉凶） |
| `/ask` | 占卜 / 星座運勢 |
| `/stats`、`/leaderboard` | 訊息與語音時長統計（由 `messageStats.js`、`voiceStats.js` 累積） |
| `/gaslight`、`/increase-gaslight` | 整人小工具 |
| `/help` | 查看指令說明（自動掃 `commands/**`，可帶 `指令:<名稱>` 直接跳） |

---

### 11. 等級系統與每日簽到

**目的**：以 XP / 等級 / 連勝 / 徽章 / 稱號的長線回饋強化社群黏著度，讓「每天回來看一眼」變成習慣。

**XP 來源**：

| 來源 | 規則 | 設定區塊 |
| --- | --- | --- |
| 訊息 | 每則 15–25 XP，30 秒冷卻、最少 4 字 | `levelSystem.message` |
| 語音 | 每分鐘 10 XP，需頻道內 ≥ 2 人；自動忽略靜音 / 拒聽 / AFK | `levelSystem.voice` |
| 簽到 | `/每日簽到`，基礎 100 XP + 連勝加成 | `levelSystem.daily` |
| 反應 | 每被加 1 個反應 +2 XP，每人每日上限 50 XP | `levelSystem.reaction` |

#### 每日簽到流程

```
使用者執行 /每日簽到
   ↓ 檢查 dailyCheckinCollection 是否已有今天紀錄
若昨天有簽 → streak +1
若昨天沒簽但前天有，且持有保護卡 → 消耗 1 張保護卡，streak 不歸零
其餘情況 → streak 歸零從 1 起算
   ↓ 計算 XP：baseXp + min(streak, capDays) × bonusPerDay
   ↓ 連勝倍率：≥7 天 ×1.5、≥30 天 ×2.0
   ↓ 寫入 userLevelsCollection（streak、longestStreak、totalCheckins…）
   ↓ 透過 grantXp 統一發 XP（會觸發升等公告與徽章解鎖）
   ↓ 用 satori 產生 30 天月曆樣式的簽到卡並回覆
```

**重置時間**：以 `daily.resetTimezone`（預設 `Asia/Taipei`）的午夜為界，跨日才能再簽。

#### 補簽卡 🛡️

- 每連續簽到滿 `streakFreezeUnlockEvery`（預設 30）天 +1 張，庫存上限 `maxStreakFreezeStock`（預設 3）。
- 漏簽 1 天會自動消耗 1 張、連勝不歸零；漏 2 天以上仍會歸零。
- 用 `/補簽卡` 隨時查庫存與下一張的距離。

#### 徽章與稱號

- `src/features/leveling/badgeDefinitions.js` 定義了等級 / 連勝 / 訊息 / 語音 / 社交 / 特殊 6 大類徽章；連勝類包含 `streak_3 / 7 / 30 / 100`。
- `grantXp` 每次發 XP 後呼叫 `badgeChecker` 重新評估，新解鎖的徽章會在升等公告與簽到回覆中標示。
- `/稱號 設定` 可從已解鎖徽章或目前等級 tier 中挑一個顯示在等級卡（選擇 tier 等同於還原為預設）。

#### Twitch 訂閱加成

`levelSystem.twitchSubBonus` 讀取使用者當前的 Twitch Tier 身份組（在 `tiers[]` 對應 roleId），訊息 / 語音 / 簽到 XP 會套用對應倍率（預設 T1 ×1.5、T2 ×2.0、T3 ×3.0）。

#### 指令

| 指令 | 用途 |
| --- | --- |
| `/每日簽到` | 領今日 XP，產生簽到卡與月曆 |
| `/補簽卡` | 查補簽卡庫存、下次解鎖距離 |
| `/等級卡 [用戶] [私密]` | 看自己或他人的等級卡（XP、進度條、稱號） |
| `/等級排行榜` | 伺服器 Top 排行 |
| `/徽章圖鑑` | 全徽章解鎖進度 |
| `/稱號 設定` | 切換等級卡稱號（可選徽章或目前等級 tier） |
| `/徽章展示 設定 / 重置` | 自選等級卡下方展示的 5 個徽章與順序 |
| `/等級卡主題` | 切換等級卡顏色主題 |
| `/levelroles set / remove / list / apply` 🔒 | 管理員：設定等級對應身份組、批次同步 |

#### MongoDB 資料結構

```javascript
// userLevelsCollection
{
  userId, guildId,
  level, xp, totalXp,
  totalMessages, totalVoiceMinutes, totalReactionsReceived,
  streak, longestStreak, totalCheckins,
  streakFreezes,                     // 保護卡庫存
  lastDailyAt,                       // 最近簽到日期 (YYYY-MM-DD)
  badges: [badgeId...],
  title, cardTheme,
  xpFromDaily, xpFromMessage, xpFromVoice, xpFromReaction,
  createdAt, updatedAt
}

// dailyCheckinCollection（{userId, guildId, date} 唯一索引）
{
  userId, guildId, date,             // YYYY-MM-DD
  streak, usedFreeze,
  reward: { xp, bonus },
  createdAt
}
```

> 升等公告與卡片由 `events/ready/connectDb.js` 在連線時建立索引，並由 `features/leveling/levelUpAnnouncer.js` 推送到 `levelUpAnnouncement.channelId`。

---

### 12. 金幣經濟、賭場與商店

**目的**：把社群活躍度（聊天 / 語音 / 簽到）轉成可消費的 `credits`，再用賭場、商店、轉帳、定存把這些 credits 重新分配回社群，形成「賺 → 花 → 互動」的循環。

#### 12.1 credits 經濟基礎

- `features/economy/grantCoins.js` 是所有金幣異動的唯一入口：發言、語音、簽到、表情、賭場下注 / 派彩、商店、轉帳、定存全部走它。
- 每筆異動都寫一筆 `coinTransactions` 紀錄（含 `source`、`meta.game`、`date`），方便對帳與每日上限計算。
- 套用倍率時自動讀 Twitch Tier、Server Boost、商店金幣 buff（疊加策略可在 `coinSystem.bonusStackingMode` 切換 `multiply` / `max`）。
- 金錢相關指令：

| 指令 | 用途 |
| --- | --- |
| `/錢包` | 查當前 credits、生命總值、來源分布、生效中 buff |
| `/轉帳 對象 金額 [備註]` | 把金幣轉給其他玩家（會收手續費，每日有上限） |
| `/存款 開戶 金額 天數` | 開定期存款，到期領回本金 + 利息 |
| `/存款 查詢` | 查所有未到期 / 已到期的存單 |
| `/存款 提款 存單` | 領回到期存款（未到期會被扣違約金） |
| `/give-coins user amount [reason]` 🔒 | 管理員：發放或扣除 credits（會記在交易紀錄） |

#### 12.2 賭場遊戲

賭場類遊戲共用同一套節流 / 對帳機制：每款遊戲在 `casino/<game>` 區塊獨立設 `minBet`、`maxBet`，下注走 `source: "bet"`、派彩走 `source: "payout"`，所以 `/我的賭場紀錄` 與 `/賭場排行` 才能算 RTP。

| 指令 | 玩法 | 主要設定 |
| --- | --- | --- |
| `/拉霸 spin bet` | 五輪滾筒老虎機，含 jackpot 累積彩池（每筆下注 3% 注入彩池），中 jackpot 時 announce 到 `slot.jackpotPool.announceChannelId` | `casino.slot` |
| `/骰寶 bet kind 金額` | 三顆骰子，可同時押 3 注。支援 大 / 小 / 單骰 / 對子 / 圍骰（特定 ×180、任意 ×30）/ 總點數（4 或 17 ×60、5 或 16 ×30…） | `casino.sicbo` |
| `/二十一點 下注 [副數]` | 跟莊家比 21 點。莊家 ≥17 必停（含 soft 17）、Blackjack 賠 3:2、玩家過五關（5 張未爆）2:1、莊家過五關則莊家勝、可 Hit / Stand / Double。可選 1 / 4 / 6 / 8 副牌 | `casino.blackjack` |
| `/hilo 下注` | 猜下一張比底牌 HI / LO / SAME，倍率依剩餘牌堆即時計算（含 5% 房費）；連對倍率累積，至少贏 1 把後可隨時收手；達 `maxRounds` 強制結算 | `casino.hilo` |
| `/賽馬` | 在 `casino.horseRacing.announceChannelId` 播報頻道開盤一場 10 分鐘售票期賽馬（多人共局）：點按鈕跳 modal 押注、可同時押多匹，到時自動開賽逐幀文字動畫，0 人下注自動取消。賠率 ×3.0（30%）／×4.0（22%）／×5.5（17%）／×7.0（13%）／×9.0（10%）／×11.0（8%）約 10% 房費。開盤者可按「🚀 提早開賽」或「❌ 取消」 | `casino.horseRacing` |
| `/賭場排行 type [period]` | 賭場淨輸贏排行榜，預設本週周榜，可選今天 / 本週 / 本月 | — |
| `/我的賭場紀錄` | 自己的下注、派彩、RTP、各遊戲分項統計 | — |

> **共同行為**：每位玩家同 `guildId` 同時只能進行一局 `/二十一點` 或 `/hilo`，避免按鈕局多開互踩。中途離場（按鈕局 5 分鐘無互動）由每分鐘的 cleanup cron 自動處理：21 點直接退本金；HI-LO 沒贏過退本金、有贏過自動 cash out。`/賽馬` channel-scoped，同頻道一次只能有一場進行中；售票期到了由 `horseRaceScheduler` cron 撈出來自動開賽，0 人下注直接取消，比賽中段卡超過 `raceTtlSeconds` 視為中斷全額退款。

#### 12.3 樂透

獨立子系統，由 cron 定期開獎與寄發訂閱票，不算進其他賭場 RTP。

| 指令 | 用途 |
| --- | --- |
| `/樂透資訊` | 查當期獎池、開獎時間、剩餘時間 |
| `/樂透買 玩法 [張數] [號碼]` | 買單張或多張票，可自選號碼或隨機 |
| `/樂透包牌 玩法 號碼` | 選 7 個以上號碼自動展開所有 6 取 N 組合 |
| `/樂透訂閱 玩法 期數 每期張數 [號碼]` | 訂閱未來 N 期自動買同組號碼 |
| `/樂透訂閱列表` | 查 / 取消自己的訂閱 |
| `/樂透歷史 [筆數]` | 自己最近的中獎紀錄 |
| `/lotteryadmin …` 🔒 | 開發者：強制開獎、補建期、跑訂閱扣款、補發提醒 |

**獎池與排程**設定在 `casino.lottery`：
- 每個玩法在 `types.<玩法>` 用 `drawWeekdays`（1=Mon…7=Sun）+ `drawHour` 設開獎時段；訂閱在開獎前 30 分鐘扣款，`reminderCron` 每小時檢查期中提醒
- 預設 `6_49` 每週日 21:00、`3_20` 每週三 + 週日 21:00 開獎
- 支援多種玩法（預設 `6_49`、`3_20`），各自有獨立票價、系統種子金、wheeling 限制
- 跨過 `poolMilestones` 門檻時可選擇推播到 `poolMilestoneChannelId`

#### 12.4 商店與背包

| 指令 | 用途 |
| --- | --- |
| `/商店 瀏覽 [category]` | 列出商品（顏色身份組 / 加成藥水 / 卡面風格 / 自訂稱號…） |
| `/商店 購買 item` | 購買商品；身份組類會自動建立並指派 `🎨 xxx` 角色 |
| `/背包` | 查看擁有道具與生效中 buff（含到期時間） |
| `/背包 裝備 inventory_id` | 裝備卡面風格 / 顏色身份組 |
| `/背包 設定稱號 text` | 設定 24 字內自訂稱號（需先持有「自訂稱號」道具，30 天有效） |

**商品類型**（`src/config/shop.json`）：
- `role_color`：30 天顏色身份組（`#E74C3C` 紅色尊爵、`#FFD700` 極光金…）；需要 bot 有 ManageRoles 權限，會 cache 已建立的 role 在 `ShopRoleCache` 避免重複
- `xp_boost` / `coin_boost`：限時 XP / 金幣倍率藥水（1 小時 ×1.5 ~ 1 天 ×2.0）
- `wallet_theme`：永久解鎖錢包卡面（廟宇籤詩、故障藝術、蒸汽波、北歐極簡、皮革撲克、全息投影、街頭塗鴉…）
- `custom_title`：30 天自訂稱號，會顯示在錢包與升等公告

#### 12.5 MongoDB collections 速覽

| Collection | 內容 |
| --- | --- |
| `UserCoins` | 每位玩家在每個 guild 的當前 credits、來源累計、lifetime 統計 |
| `CoinTransactions` | 每筆金錢異動（90 天 TTL；對帳與每日上限都靠它） |
| `BlackjackGames` / `HiloGames` | in-flight + 已結算對局（30 天 TTL；由各自的 cleanup cron 退中途離場局） |
| `JackpotPool` | 每 guild 一筆累積彩池 |
| `LotteryDraws` / `LotteryTickets` / `LotterySubscriptions` / `LotteryWheels` | 樂透開獎期、票券、訂閱、包牌組 |
| `UserInventory` / `ShopTransactions` / `ShopRoleCache` | 商店背包、購買紀錄、顏色身份組快取 |
| `CoinTransfers` / `CoinDeposits` | 每日轉出額度、定期存款單 |

---

### 13. Twitter / Threads 連結修正

`events/messageCreate/threadsLinkHandler.js` 會自動偵測訊息中的 Twitter / Threads 連結，回覆可正確顯示嵌入內容的 fxtwitter / fixthreads 版本，方便手機瀏覽。

---

## 維運腳本

```bash
npm run update-calendar    # 從 TaiwanCalendar 抓最新行事曆
npm run verify-calendar    # 驗證行事曆 JSON 完整性
npm run convert-calendar   # 行事曆格式轉換

node src/tool/deploy-commands.js   # 註冊 / 更新 Slash Command
node src/tool/get-commands.js      # 列出已註冊指令
node src/tool/delete-commands.js   # 清空所有指令（謹慎使用）
```

---

## 外部 API

| 用途 | URL |
| --- | --- |
| 加密貨幣 | <https://min-api.cryptocompare.com/documentation> |
| 台灣行事曆 | <https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/2025.json> |
| Steam 特價來源 | 小黑盒 RSS（`https://discord-news.zeabur.app/xiaoheihe/...`） |
| Steam 商品資訊 | Steam Store API |
| Threads 連結修正 | <https://github.com/milanmdev/fixthreads> |

---

## 維護建議

1. **定期備份 MongoDB**：投票、食物、訊息統計等資料皆存於此。
2. **監控 cron**：投票結算、Steam 特價、喜加一、早安卡都仰賴 `node-cron`，bot 重啟後排程會重建。
3. **依社群規模調整門檻**：`voting.passThresholds`、`voting.weights`、`activeHours` 都可在不重啟程式的情況下用 PR / 重新部署修改。
4. **Slash Command 變更後執行 `deploy-commands`**：否則 Discord 端不會看到新指令。
5. **動態語音頻道資料僅在記憶體**：若有計畫長時間維運，可考慮持久化到 MongoDB 以便在重啟時恢復。
