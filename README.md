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
  - [金幣經濟、賭場、挖礦與商店](#12-金幣經濟賭場挖礦與商店)
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
│   ├── ask/                # /我想問
│   ├── casino/             # /二十一點、/hilo、/拉霸、/賽馬、/火箭、/射龍門、/尋寶、/輪盤、/德州撲克、/樂透買…
│   ├── currency/           # /加密貨幣、/即時匯率
│   ├── draw/               # /二選一、/抽籤
│   ├── economy/            # /轉帳、/存款、/骰寶、/領錢、/逼幣任務、/乞討、/give-coins、/circulation
│   ├── event/              # /活動（成員自辦獎金活動）
│   ├── food/               # /吃什麼、/food、/food-admin
│   ├── general/            # /help
│   ├── leaderboard/        # /排行榜（整合等級、訊息、語音、頻道、挖礦、賭場 7 種排行）
│   ├── level/              # /每日簽到、/補簽卡、/level-admin、開發者測試指令
│   ├── mining/             # /挖礦、/賣礦、/合成、/地下城、/決鬥、/裝備、/拍賣、/工作、/背包…
│   ├── post/               # /生成情勒文、/新增情勒文
│   ├── profile/            # /檔案（個人資料聚合）、/稱號（合併稱號＋展示徽章）
│   ├── quiz/               # /預測、/問答
│   ├── recommendation/     # /推薦、/recommendation-admin
│   ├── roles/              # /setup-roles
│   ├── shop/               # /商店、/背包
│   ├── stats/              # /stats
│   ├── stock/              # /股市（買/賣/走勢/配息/報價/持股/紀錄）、/stock-event
│   ├── ticket/             # /ticket（setup / close / proposal / suggestion-setup / vote）
│   └── weather/            # /天氣、/全台天氣
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
管理員在票務頻道輸入 /ticket proposal start
   ↓ bot 在投票頻道發布投票訊息
成員按按鈕投票（可改票、有互斥邏輯）
   ↓ node-cron 每 5 分鐘檢查過期投票
自動結算 → 更新訊息 → 通知 Ticket
   未通過：5 分鐘後自動關閉 Ticket
```

**指令**（全部收斂在 `/ticket` 之下）：

| 指令 | 權限 | 說明 |
| --- | --- | --- |
| `/ticket setup` | 管理員 | 在當前頻道部署 Ticket 面板（可自訂標題 / 描述 / 按鈕 / 類別 / 支援身份組） |
| `/ticket close` | Ticket 開啟者 / 管理員 | 立即關閉當前 Ticket |
| `/ticket suggestion-setup` | 管理員 | 部署建議系統面板 |
| `/ticket proposal start game:<名稱> type:<create\|archive>` | `ManageChannels` | 在 Ticket 頻道發起遊戲頻道投票 |
| `/ticket proposal end / cancel message_url:<連結>` | 管理員 | 提早結束 / 取消投票 |
| `/ticket vote create template:<模板> title:<標題>` | 管理員 | 從模板（遊戲頻道、活動、規則變更、一般提案）發起投票 |

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

**指令**：`/ticket suggestion-setup`

提供讓成員提案、其他人投票（贊成 / 反對）的輕量級面板，資料存於 `src/data/suggestion-panels.json`，並由 `suggestionScheduler.js` 進行定期維護。

---

### 5. Steam 特價推播

**目的**：自動把台灣區 Steam 史低 / 高折扣遊戲推送到指定頻道。

> 📍 **推播頻道**：特價喜加一 │ 💰（`1498530655745609819`，可用 `DISCORD_DEALS_CHANNEL_ID` 覆寫）。

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

> 📍 **推播頻道**：特價喜加一 │ 💰（`1498530655745609819`，可用 `DISCORD_FREE_GAMES_CHANNEL_ID` 覆寫）。

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

### 7. 每日早安卡

- **早安卡**：`events/ready/sendMorningMessage.js` 依 `morningMessage.cronSchedule`（預設每天早上 8 點）發送，使用 `satori` 動態繪製含日期、星期、節氣、農民曆、詩詞、運勢的 PNG 卡片。
- **資料來源**：本地 `src/data/calender.json`（透過 `npm run update-calendar` 從 TaiwanCalendar 更新）、`utils/getLunarInfo.js`（農民曆）、`utils/getPoem.js`（詩詞）。

---

### 8. 食物與飲料系統

為了解決「今天吃什麼？」的萬年難題：

> 📍 **可用頻道**：市民服務處 │ 🏢（`general` 桶）。標 🔒 的 `food-admin` 指令不受頻道限制。

| 指令 | 用途 |
| --- | --- |
| `/吃什麼 [類別] [飲料店]` | 隨機抽食物 / 飲料（不選類別則所有品項一起抽） |
| `/food list [類別]` | 查看食物清單 |
| `/food ranking [類別] [數量]` | 依抽中次數排行（預設前 10） |
| `/food stores` | 查看所有飲料店清單 |
| `/food-admin add` 🔒 | 新增單一食物（管理員） |
| `/food-admin batch` 🔒 | 一次新增多個食物（用逗號分隔） |
| `/food-admin import` 🔒 | 匯入整個飲料店菜單 |
| `/food-admin delete` 🔒 | 刪除食物項目 |

資料存於 MongoDB；指令內含 Autocomplete（`utils/autocompleteFoodName.js`、`autocompleteBeverageStore.js`）。

---

### 9. 加密貨幣 / 匯率 / 天氣

> 📍 **可用頻道**：市民服務處 │ 🏢（`general` 桶）。

- `/加密貨幣 貨幣代碼:<BTC|ETH|...>`：透過 [cryptocompare](https://min-api.cryptocompare.com/documentation) 查即時美金幣價。
- `/即時匯率 [欲兌貨幣]`：查貨幣兌新台幣匯率（資料來源 RTER.info），不填則顯示美元對台幣。
- `/天氣 縣市名稱:<城市>`：查單一縣市今日天氣。
- `/全台天氣`：查全台天氣總覽。

---

### 10. 抽籤、統計與其他指令

> 📍 **可用頻道**：市民服務處 │ 🏢（`general` 桶）。標 🔒 的管理員指令不受頻道限制。

| 指令 | 說明 |
| --- | --- |
| `/二選一` ~ 五選一 | 提供 2-5 個選項由機器人隨機選 |
| `/抽籤 [諮詢方向]` | 傳統籤詩風格抽籤（吉凶） |
| `/我想問 問題:<是非題>` | 問機器人是非題，回 Yes / No / Maybe |
| `/stats user / channel` | 訊息與語音時長統計（由 `messageStats.js`、`voiceStats.js` 累積） |
| `/排行榜 [類別] [時間]` | 統一排行榜：等級、訊息、語音、頻道熱度、挖礦、賭場贏家／輸家（下拉切類別、按鈕切時間） |
| `/推薦 查詢 [關鍵字] [類別] [地區]` | 瀏覽 / 搜尋伺服器推薦（餐廳、酒吧、飲料、娛樂） |
| `/推薦 編輯 訊息連結` | 修改推薦的分類欄位 |
| `/recommendation-admin delete / reanalyze` 🔒 | 管理員：刪除推薦、重跑 AI 分析 |
| `/活動 名稱 獎金 名次數 [描述]` | 自掏腰包當獎金的成員自辦活動 🎉 |
| `/預測 題目 獎金 選項a 選項b ...` | 發布有獎預測，事後由主辦人公布答案 🔮 |
| `/問答 題目 獎金 正確答案 選項a 選項b ...` | 發布有獎問答（平分 / 搶答模式）🎯 |
| `/生成情勒文`、`/新增情勒文` | 整人小工具：抽 / 新增情勒文 |
| `/help [指令]` | 查看指令說明（自動掃 `commands/**`，可帶指令名直接跳） |

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
- 用 `/補簽卡` 隨時查庫存與規則。

#### 徽章與稱號

- `src/features/leveling/badgeDefinitions.js` 定義了等級 / 連勝 / 訊息 / 語音 / 社交 / 特殊 6 大類徽章；連勝類包含 `streak_3 / 7 / 30 / 100`。
- `grantXp` 每次發 XP 後呼叫 `badgeChecker` 重新評估，新解鎖的徽章會在升等公告與簽到回覆中標示。
- `/稱號 設定` 可從已解鎖徽章、目前等級 tier 或遊戲稱號中挑一個顯示在等級卡（選擇 tier 等同於還原為預設）。

#### Twitch 訂閱加成

`levelSystem.twitchSubBonus` 讀取使用者當前的 Twitch Tier 身份組（在 `tiers[]` 對應 roleId），訊息 / 語音 / 簽到 XP 會套用對應倍率（預設 T1 ×1.5、T2 ×2.0、T3 ×3.0）。

#### 指令

> 📍 **可用頻道**：市民服務處 │ 🏢（`general` 桶）。標 🔒 / 🔧 的管理員 / 開發者指令不受頻道限制。

| 指令 | 用途 |
| --- | --- |
| `/每日簽到 [押倍]` | 領今日 XP，產生簽到卡與月曆；押倍會把當日金幣翻倍但隔天斷簽直接歸零（不能用補簽卡） |
| `/補簽卡` | 查補簽卡庫存與規則 |
| `/檔案` | 個人檔案聚合：等級卡 / 礦工 / 錢包 / 賭場紀錄 / 成就（按鈕切分頁，公開訊息，只看自己；可在 general / mining / stock 三個頻道使用） |
| `/稱號 設定` | 切換等級卡稱號（可選徽章、已解鎖遊戲稱號或目前等級 tier） |
| `/稱號 展示徽章 / 重置展示` | 自選等級卡下方展示的 5 個徽章與順序 |
| `/排行榜 [類別:等級] …` | 等級排行（屬於統一排行榜的等級類別） |
| `/level-admin give-xp role amount` 🔒 | 對整個身份組統一加 XP |
| `/level-admin roles set / remove / list / apply` 🔒 | 設定等級對應身份組、批次同步 |
| `/leveltest …` / `/dailytest …` 🔧 | 開發者測試工具（XP 給予、升等卡預覽、簽到卡預覽 / 重置） |

> 等級卡顏色已下線 `/level cardtheme`，改由商店「等級卡顏色」分類購買（500 金幣／永久）後到 `/背包` 裝備。舊用戶設定過的顏色會自動補進背包並標記為已裝備。

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

### 12. 金幣經濟、賭場、挖礦與商店

**目的**：把社群活躍度（聊天 / 語音 / 簽到）轉成可消費的 `credits`，再用賭場、商店、轉帳、定存把這些 credits 重新分配回社群，形成「賺 → 花 → 互動」的循環。

#### 12.1 credits 經濟基礎

- `features/economy/grantCoins.js` 是所有金幣異動的唯一入口：發言、語音、簽到、表情、賭場下注 / 派彩、商店、轉帳、定存全部走它。
- 每筆異動都寫一筆 `coinTransactions` 紀錄（含 `source`、`meta.game`、`date`），方便對帳與每日上限計算。
- 套用倍率時自動讀 Twitch Tier、Server Boost、商店金幣 buff（疊加策略可在 `coinSystem.bonusStackingMode` 切換 `multiply` / `max`）。
- 金錢相關指令：

> 📍 **可用頻道**：市民服務處 │ 🏢（`general` 桶）。標 🔒 的管理員指令不受頻道限制。

| 指令 | 用途 |
| --- | --- |
| `/檔案` → 錢包分頁 | 查當前 credits、生命總值、來源分布、生效中 buff（在 /檔案 上點「💰 錢包」按鈕） |
| `/轉帳 對象 金額 [備註]` | 把金幣轉給其他玩家（手續費：>1000 加 5%，否則 2%，每日有上限） |
| `/存款 開戶 金額 天數` | 開定期存款，到期領回本金 + 利息 |
| `/存款 查詢` | 查所有未到期 / 已到期的存單 |
| `/存款 提款 存單` | 領回到期存款（未到期會被扣違約金） |
| `/逼幣任務` | 查看每日／週常任務進度 📜 |
| `/領錢` | 補領未入帳的任務獎勵（任務完成時通常會自動入帳）🪙 |
| `/乞討` | 破產時領取救濟金，符合資格直接發放 🪙 |
| `/give-coins user amount [reason]` 🔒 | 管理員：發放或扣除 credits（會記在交易紀錄） |
| `/circulation` 🔒 | 管理員：查所有伺服器的金幣流通總量 |

#### 12.2 賭場遊戲

賭場類遊戲共用同一套節流 / 對帳機制：每款遊戲在 `casino/<game>` 區塊獨立設 `minBet`、`maxBet`，下注走 `source: "bet"`、派彩走 `source: "payout"`，所以 `/檔案` 的賭場紀錄分頁與 `/排行榜 類別:賭場贏家` 才能算 RTP。

> 📍 **可用頻道**：拉斯維加斯 │ 🃏、濱海灣金沙 │ 🃏（`casino` 桶）。標 🔒 / 🔧 的指令不受頻道限制。

| 指令 | 玩法 | 主要設定 |
| --- | --- | --- |
| `/拉霸 下注 [梭哈]` | 五輪滾筒老虎機，含 jackpot 累積彩池（每筆下注 3% 注入彩池），中 jackpot 時 announce 到 `slot.jackpotPool.announceChannelId` | `casino.slot` |
| `/骰寶 kind 金額` | 三顆骰子，可同時押 3 注。支援 大 / 小 / 單骰 / 對子 / 圍骰（特定 ×180、任意 ×30）/ 總點數（4 或 17 ×60、5 或 16 ×30…） | `casino.sicbo` |
| `/二十一點 下注 [梭哈]` | 跟莊家比 21 點。莊家 ≥17 必停（含 soft 17）、Blackjack 賠 3:2、玩家過五關（5 張未爆）2:1、莊家過五關則莊家勝、可 Hit / Stand / Double | `casino.blackjack` |
| `/hilo 下注 [梭哈]` | 猜下一張比底牌 HI / LO / SAME，倍率依剩餘牌堆即時計算（含 5% 房費）；連對倍率累積，至少贏 1 把後可隨時收手；達 `maxRounds` 強制結算 | `casino.hilo` |
| `/賽馬` | 開一場 10 分鐘售票期賽馬（多人共局）：點按鈕跳 modal 押注、可同時押多匹，到時自動開賽逐幀文字動畫，0 人下注自動取消。賠率 ×3.0（30%）／×4.0（22%）／×5.5（17%）／×7.0（13%）／×9.0（10%）／×11.0（8%）約 10% 房費 | `casino.horseRacing` |
| `/火箭 下注 [自動收手]` | 🚀 倍率不斷往上衝，按收手鎖定派彩；慢一步就爆炸 | `casino.crash` |
| `/射龍門` | 🐉 入場費 50。看完柱牌再決定要不要補注射第三張 | `casino.dragonGate` |
| `/尋寶 下注 [梭哈]` | 💎 從格子裡挑 5 格找寶藏，全中 400 倍 | `casino.keno` |
| `/輪盤 金額 [梭哈]` | 🎰 押紅黑、奇偶、大小、打、列 | `casino.roulette` |
| `/德州撲克 開桌 [max_players] [blind]` | 自動建立 thread，桌面在 thread 內進行 | `casino.poker` |
| `/排行榜 類別:賭場贏家 / 賭場輸家` | 賭場淨輸贏排行榜，預設本週周榜，可切今天 / 本週 / 本月 | — |
| `/檔案` → 賭場紀錄分頁 | 自己的下注、派彩、RTP、各遊戲分項統計 | — |
| `/casino-stats game period` 🔒 | 管理員：全伺服器賭場 RTP 統計 | — |
| `/slottest spin / preview` 🔧 | 開發者：拉霸抽獎 JSON / 圖卡預覽工具 | — |

> **共同行為**：每位玩家同 `guildId` 同時只能進行一局 `/二十一點` 或 `/hilo`，避免按鈕局多開互踩。中途離場（按鈕局 5 分鐘無互動）由每分鐘的 cleanup cron 自動處理：21 點直接退本金；HI-LO 沒贏過退本金、有贏過自動 cash out。`/賽馬` channel-scoped，同頻道一次只能有一場進行中；售票期到了由 `horseRaceScheduler` cron 撈出來自動開賽，0 人下注直接取消，比賽中段卡超過 `raceTtlSeconds` 視為中斷全額退款。

#### 12.3 樂透

獨立子系統，由 cron 定期開獎與寄發訂閱票，不算進其他賭場 RTP。

> 📍 **可用頻道**：拉斯維加斯 │ 🃏、濱海灣金沙 │ 🃏（樂透與賭場同屬 `casino` 桶）。標 🔒 的指令不受頻道限制。

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

#### 12.4 股市

虛擬股市，與賭場分開計算。有事件系統可在隨機時機觸發漲跌。

> 📍 **可用頻道**：逼逼金證卷 │ 🪙（`stock` 桶）。標 🔒 的指令不受頻道限制。

| 指令 | 用途 |
| --- | --- |
| `/股市 買 股票代號 數量` | 以市價買入指定股數 |
| `/股市 賣 股票代號 數量` | 以市價賣出，數量可填 `all` 全部賣出 |
| `/股市 走勢 股票代號 [期間]` | 查單檔股票走勢圖（預設 1 週） |
| `/股市 配息 [期間]` | 查自己過去領到的股息明細（預設 1 個月） |
| `/股市 報價` | 互動報價面板，下拉選股後用按鈕直接買 / 賣 / 看走勢 |
| `/股市 持股` | 查看當前持股、損益、總市值,每筆持股附「🔴 賣出」按鈕 |
| `/股市 紀錄 [期間] [股票代號]` | 查自己過去的買賣成交與已實現損益（預設 1 個月） |
| `/stock-event fire / fire-by-id / add / remove / list` 🔒 | 管理員：手動觸發事件、管理事件書 |

#### 12.5 商店與背包

> 📍 **可用頻道**：市民服務處 │ 🏢（`general` 桶）。`/商店` 為公開互動面板（已取消 ephemeral），購買結果仍以私人訊息回覆。

| 指令 | 用途 |
| --- | --- |
| `/商店` | 開啟公開商店面板：分類下拉切換、每件商品一顆購買鈕、分頁瀏覽（⏮️◀️🔄▶️⏭️）。點購買鈕即下單，結果以私人訊息回覆（含「立即裝備 / 設定稱號」後續鈕），不洗頻道 |
| `/背包` | 查看擁有道具與生效中 buff（含到期時間）；用選單直接裝備卡面 / 顏色身份組、設定 24 字內自訂稱號（需先持有「自訂稱號」道具，30 天有效） |

**商品類型**（`src/config/shop.json`）：
- `role_color`：30 天顏色身份組（`#E74C3C` 紅色尊爵、`#FFD700` 極光金…）；需要 bot 有 ManageRoles 權限，會 cache 已建立的 role 在 `ShopRoleCache` 避免重複
- `xp_boost` / `coin_boost`：限時 XP / 金幣倍率藥水（1 小時 ×1.5 ~ 1 天 ×2.0）
- `wallet_theme`：永久解鎖錢包卡面（廟宇籤詩、故障藝術、蒸汽波、北歐極簡、皮革撲克、全息投影、街頭塗鴉…）
- `custom_title`：30 天自訂稱號，會顯示在錢包與升等公告
- 挖礦道具（`mining_*`）：幸運藥水（挖礦 luck +8% ×3 次）、CD 縮短券（每張 -30 分冷卻，持有上限 30、每日最多買 30）、背包擴充（永久 +5 格）、**體力藥水（購買後立即恢復 5 點地下城體力、不超過上限；體力已滿時不可購買，每日最多買 2 瓶）**

#### 12.6 挖礦・打工・合成（mining）

**目的**：在賭場 / 股市之外，提供一條「時間驅動」的穩定產出路線——靠 `/挖礦`、`/打工` 累積礦石與金幣，再用 `/合成` 把礦石做成更好的鎬子，形成「挖 → 賣 / 合成 → 挖更快」的循環。設定分別在 `src/config/mining.json`、`work.json`、`craft.json`。

> 📍 **可用頻道**：財富牢改城 │ 💼（`mining` 桶）。挖礦 / 背包 / 賣礦 / 打工 / 合成 / 裝備 / 地下城 / 決鬥 / 贈送 / 拍賣全部收斂在這個頻道。

| 指令 | 用途 |
| --- | --- |
| `/挖礦` | 挖一次礦（冷卻 2 小時）。挖到鑽石會全服公告 ✨；**挖到石頭時結果訊息會出現「🔍 找鑑定師賭石」按鈕**（見下方賭石） |
| `/背包` | 查看礦石、容量、目前鎬子耐久、道具（幸運藥水 / CD 縮短券 / 傳說素材碎片）與下次可挖時間；冷卻中可在此使用 CD 縮短券；可裝備道具（顏色身份組 / 卡面 / 等級卡顏色 / 自訂稱號）整合成**單一下拉選單** 🎒 |
| `/賣礦 [礦石] [數量]` | 把指定礦石賣給系統換金幣；不指定數量則賣出該礦石全部，沒選礦石則什麼都不賣（避免手滑全數出清）🪙 |
| `/打工` | 打工賺穩定金幣（冷卻 4 小時，每日最多 6 次）💼 |
| `/合成 裝備 [確認]` | 用礦石合成更好的鎬子（採集）或武器（戰鬥）；要替換還有耐久的同級裝備需把 `確認` 設成 `true` 🔨 |
| `/裝備` | 查看目前鎬子 / 武器屬性與戰鬥力，以及鎬子・武器各配方的材料進度（✅ / ❌）🔧 |

**礦石**（`mining.ores`，挖到機率受 luck 影響，越稀有越吃 luck）：

| 礦石 | 稀有度 | 賣價 | 單次數量 |
| --- | --- | --- | --- |
| 石頭 | 普通 | 8 🪙 | 1–3 |
| 煤炭 | 普通 | 20 🪙 | 1–2 |
| 鐵礦 | 稀有 | 60 🪙 | 1 |
| 黃金 | 稀有 | 200 🪙 | 1 |
| 鑽石 | 傳說 | 800 🪙 | 1（挖到全服公告） |

**賭石（鑑定師）**（`mining.stoneAppraisal`，`stoneAppraisalService` / `handleStoneAppraisal`）：**只有「剛挖到石頭那一次」能賭**。挖到石頭時 `/挖礦` 結果會出現「🔍 找鑑定師賭石」按鈕，付費（預設每顆 `feePerStone = 150`）請鑑定師把該次石頭逐顆開出，依加權表（碎掉 60% / 煤炭 18% / 鐵礦 10% / 黃金 7% / 鑽石 2%）有機率變成別種礦——也可能全部碎掉，是高風險高報酬的金幣 sink。開出鑽石同樣全服公告。實作上以 `MiningProfiles.pending_appraisal{qty, ts}` 紀錄「最新一次挖到的石頭」，按鈕帶 `ts` 對鎖、原子清除確保**單次有效**且只認最新一次挖礦；超過 `windowMs`（預設 10 分）按鈕失效。鑑定費走 `grantCoins` 的 `source: "stone_appraisal"`（sink）。

**鎬子與合成**（`mining.pickaxes` / `craft.recipes`，每把鎬子提供 CD 縮短 / luck / 出礦量加成；非木鎬有耐久，耗盡自動退回木鎬）：

| 鎬子 | 合成材料 | CD 縮短 | luck | 出礦量 | 耐久 |
| --- | --- | --- | --- | --- | --- |
| 木鎬 | （初始） | — | — | — | 永久 |
| 鐵鎬 | 鐵礦 ×15 | −30 分 | +5% | — | 50 次 |
| 黃金鎬 | 黃金 ×5＋鐵礦 ×20 | −45 分 | +8% | — | 50 次 |
| 鑽石鎬 | 鑽石 ×5＋黃金 ×10 | −60 分 | +12% | +1 | 50 次 |

**武器與戰鬥**（`dungeon.weapons` / `craft.recipes` 中 `result.type = "weapon"`，戰鬥力由武器決定、與鎬子分離；赤手也能打但勝率極低；非赤手有耐久，打怪時消耗，耗盡退回赤手）：

| 武器 | 合成材料 | 戰鬥力（含基礎 20）| 暴擊 | 耐久 |
| --- | --- | --- | --- | --- |
| 赤手空拳 | （初始，**可打怪但勝率極低**，上限 10%）| 20 | — | 永久 |
| 鐵劍 | 鐵礦 ×20 | 45 | — | 60 次 |
| 鋼劍 | 鐵礦 ×30＋煤炭 ×20 | 70 | 3% | 60 次 |
| 黃金劍 | 黃金 ×8＋鐵礦 ×30 | 100 | 6% | 60 次 |
| 鑽石劍 | 鑽石 ×6＋黃金 ×15 | 140 | 10% | 50 次 |
| 傳說之劍 | 傳說素材碎片 ×15＋鑽石 ×10 | 200 | 20% | 80 次 |

- **背包**：基礎 100 格（`backpackBaseSlots`），裝滿就不能再挖，要先 `/賣礦`。
- **luck 加成**：鎬子 luck ＋幸運藥水（每次 +8%）＋ Twitch 加成的加總受 `luckCap = 25%` 上限；**抖內 luck 加成獨立於上限之外**，於封頂後額外疊加，斗內等級給多少實拿多少。
- **打工**：每次 80–120 🪙，每日次數用當日 `CoinTransactions(source=work)` 筆數判定，不需額外計數欄位。
- **金流串接**：`/賣礦` 走 `grantCoins` 的 `source: "mining_sell"`、`/打工` 走 `source: "work"`，皆納入經濟日報的 inflow 統計。

**地下城・決鬥・社交・拍賣（Phase 4–5）**：礦石與裝備的下游玩法——打造武器去地下城打怪、跟人決鬥賭金幣，或把礦石送人 / 上架拍賣。設定在 `src/config/dungeon.json`、`auction.json`。

| 指令 | 用途 |
| --- | --- |
| `/地下城` | 消耗 1 點體力進地下城戰鬥（體力上限 10、每小時回 1）；**赤手也能打但勝率極低（上限 10%），先 `/合成` 打把劍大幅提升戰鬥力**，高階武器有暴擊（保證獲勝＋金幣 ×1.5），勝利掉落礦石 / 金幣 / 幸運藥水 / CD 縮短券 / 傳說素材碎片，背包滿時礦石折金幣 ⚔️ |
| `/決鬥 @對象 賭注` | 1v1 金幣決鬥，雙方託管賭注、依武器戰鬥力判勝負、勝者通吃；對方按鈕接受 / 拒絕，逾時自動退款 🤺 |
| `/贈送 @對象 礦石 數量` | 把礦石送給其他玩家（每日 3 次、免手續費、不能送自己、檢查對方背包容量）🎁 |
| `/拍賣 清單 / 掛牌 / 出價` | 拍賣行：掛牌 24h、成交抽 5% 手續費、最低起標 = 收購價 80%、每人最多掛 5 件；被超越自動退款，到期無人出價退回礦石；掛牌可選填一口價（≥ 起標價），出價達標立即成交（封頂為一口價）🏷️ |

- **體力**：`/地下城` 每場耗 1 點、0 點不能進；惰性回復（每小時 +1，上限 10）。**戰鬥力 = 基礎 20 + 武器加成**（赤手 0 / 鐵劍 +25 / 鋼劍 +50 / 黃金劍 +80 / 鑽石劍 +120 / 傳說之劍 +180；鎬子不再影響戰鬥），怪物 HP 60–280。有武器時勝率 = `clamp(戰鬥力 / 怪物HP, 0.2, 0.9)`；**赤手空拳也能打，但不吃 0.2 保底、勝率上限僅 `fistWinRateMax = 0.1`（約 7–10%）**，暴擊則直接獲勝。武器每場耗 1 耐久，耗盡退回赤手。
- **突發事件**（`src/config/encounters.json`，`encounterService`）：`/挖礦`（12%）與 `/地下城`（15%）主行為後可能觸發隨機事件。挖礦：隱藏礦脈（掉落翻倍）/ 廢棄礦車（額外金幣）/ 時間裂隙（清冷卻）/ 流浪商人（送藥水）/ 礦坑崩塌（損失礦石）/ 怪物突襲（用武器自動結算）。地下城：藏寶箱・遺落補給・神秘藥水（回體力）・磨刀石（修武器耐久）・陷阱（扣體力）・精英怪（高風險高報酬，有機率掉傳說碎片）。金幣獎勵走 `grantCoins` 的 `source: "encounter"`。
- **決鬥金流**：賭注用 `duel_stake`（sink）託管，勝者派彩 `duel_payout`、退款 `duel_refund`，雙方總額守恆。
- **拍賣金流**：出價 `auction_bid`（sink）託管，被超越自動 `auction_refund`，成交賣家收 `auction_payout`（已扣 5% 手續費）。
- **cron**：`duelExpiryScheduler`（每分鐘掃逾時決鬥退款）、`auctionExpiryScheduler`（每 5 分鐘結算到期拍賣）。新增 source 已納入經濟日報 inflow / outflow。

**遊戲區共用稱號 / 成就（Phase 6）**：橫跨整個遊戲區（挖礦・賭場・股市・樂透・拍賣）的一套稱號系統——各遊戲達標自動解鎖稱號，**與等級卡稱號共用同一個展示槽**（寫進 `UserLevels.title`，錢包卡 / 升等公告直接顯示）。定義在 `src/config/titles.json`（門檻在各 `defs.*.req`，可隨時調）。

| 指令 | 用途 |
| --- | --- |
| `/檔案` → 成就分頁 | 查看等級徽章 + 遊戲稱號的完整圖鑑與進度（✅ 已解鎖 / 🔒 未解鎖）🏆 |
| `/稱號 設定` | 切換等級卡稱號（徽章 / 等級 tier / 遊戲稱號）|
| `/檔案` → 礦工檔案分頁 | 礦工生涯統計、歷史採集量、週冠次數、目前展示稱號 📜 |
| `/排行榜 類別:挖礦` | 本週挖礦數量排行榜（週一 00:01 重置並頒發礦坑之王）👑 |

> 已解鎖的遊戲稱號會出現在 `/稱號 設定` 的清單裡，跟徽章 / 等級 tier 在同一個下拉擇一展示（最後設定的生效）。

| 分類 | 稱號 | 解鎖條件 |
| --- | --- | --- |
| 挖礦 | 🪵 煤炭採集者 / 🔨 鐵鍛師 / 💎 寶石獵人 / ✨ 傳說礦工 | 挖礦 50 次+持有 500 / 合成 10 件+歷史鐵礦 100 / 歷史黃金 20+鑽石 1 / 挖礦 1000 次+鑽石 5+週冠 3 |
| 挖礦 | 👑 礦坑之王 | 當週挖礦數量第一（每週更替）|
| 賭場 | 🎰 賭場常客 / 💰 一夜致富 / 🃏 Jackpot 得主 | 下注 100 局 / 單局派彩 ≥ 10,000 / 開出一次拉霸 Jackpot |
| 股市 | 📈 股海散戶 / 💹 股神 | 完成 10 筆交易 / 賣股+股利收入 ≥ 50,000 |
| 樂透 | 🎟️ 樂透愛好者 / 🏆 頭獎得主 | 累積買 50 張 / 中過一次頭獎 |
| 拍賣 | 🏷️ 拍賣商人 | 成交 20 件 |

- **儲存**：解鎖清單存 `UserLevels.gameTitles`（與 `badges` 平行）、展示稱號沿用 `UserLevels.title`。挖礦的生涯統計（`lifetime_ore`、`mine_count_total`、`craft_count_total`、`weekly_champion_count`）仍在 `MiningProfiles`。
- **解鎖檢查**：成就條件全部可由既有資料推導，由 `gameTitleService.check()` 觸發——金流出入口 `grantCoins` 依 `source` 對應分類（bet/payout→賭場+樂透、stock_*→股市、auction_payout→拍賣、mining_sell→挖礦）非阻塞檢查，挖礦另在 `/挖礦`、`/合成` 後檢查。解鎖會在挖礦頻道公告。
- **cron**：`miningWeeklyRank`（每週一 00:01 結算上週挖礦榜首、頒礦坑之王 + 卸前任、累加週冠次數，可能連帶解鎖傳說礦工）。

**Twitch 訂閱者權益（Phase 7）**：訂閱者在挖礦生態享實質加成，依最高持有 tier 生效，設定在 `src/config/twitch_perks.json`（tier→角色沿用 `twitchSync.tierRoleIds`，與訂閱倍率同一組角色）。

| 權益 | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- |
| 挖礦 luck 加成 | +5% | +10% | +15% |
| 挖礦 CD 縮短 | −15 分 | −30 分 | −45 分 |
| 打工 CD 縮短 | −30 分 | −30 分 | −30 分 |
| 地下城體力上限 | 10 | 12 | 12 |
| 定存單上限 | 5 | 7 | 7 |
| 拍賣手續費 | 5% | 5% | 2% |
| 樂透每期張數上限 | 10 | 10 | 15 |

- 挖礦 luck 中鎬子 / 藥水 / Twitch 來源相加後受 `luckCap = 25%` 全域上限；抖內 luck 加成則獨立於上限外額外疊加（見 `buffResolver.js`）。拍賣手續費依「賣家」tier，於結算時判定。
- **尚未接（保留待做）**：訂閱限定卡面 `exclusiveThemeId` 與永久限定名字顏色 `exclusiveColorRoleId`——前者需在錢包卡渲染器實作 `theme_subscriber_t2/t3` 畫法、後者需先建顏色身分組並填入 ID。

> 🪙 **金幣顯示 emoji**：金額 / 餘額 / 獎勵的顯示集中在 `src/constants/coin.js`（`COIN_EMOJI` 動態金幣、`MONEY_EMOJI` 錢袋），用於訊息內容、Embed 描述 / 標題 / 欄位值；Embed footer、按鈕 setEmoji、斜線指令說明、canvas 圖片不適用，仍用一般 emoji。

#### 12.7 指令頻道限制（commandChannelGuard）

`utils/commandChannelGuard.js` 會依「指令所在資料夾」把指令分流到指定頻道桶，桶對應的頻道清單設定在 `src/config/server.json` 的 `commandChannels`。在錯誤頻道呼叫會被擋下並提示正確頻道。

| 指令桶 | 對應資料夾 | 允許頻道（名稱 / ID） |
| --- | --- | --- |
| `casino` | `commands/casino`（賭場遊戲**與樂透**） | 拉斯維加斯 │ 🃏（`1500783461831671858`）、濱海灣金沙 │ 🃏（`1504806019610574878`） |
| `stock` | `commands/stock` | 逼逼金證卷 │ 🪙（`1505808023933816893`） |
| `mining` | `commands/mining`（挖礦 / 打工 / 合成 / 地下城 / 決鬥 / 贈送 / 拍賣） | 財富牢改城 │ 💼（`1509074828206936126`） |
| `general` | 其餘所有資料夾 | 市民服務處 │ 🏢（`1192888968748994700`） |

**豁免（任何頻道都能用）**：標 🔒 的管理員指令、標 🔧 的開發者（`devOnly`）指令、以及只回私人訊息（`ephemeral`）的指令都不受頻道限制。若某個桶在 `commandChannels` 沒設定頻道（清單為空），該桶也視為不限制。

#### 12.8 自動播報 / 公告頻道

除了上面玩家輸入指令的頻道，bot 也會主動把內容推播到這些頻道（在各自 config 設定，與指令頻道限制無關）：

| 頻道（名稱 / ID） | 由哪些功能推播 |
| --- | --- |
| 特價喜加一 │ 💰（`1498530655745609819`） | Steam 特價（§5）、喜加一限免（§6）推播；對應 env `DISCORD_DEALS_CHANNEL_ID` / `DISCORD_FREE_GAMES_CHANNEL_ID` |
| 逼逼大灑幣 │ 🧧（`1506339475867832330`） | 主辦活動 / 賞金活動發布（`hostedEvents.publishChannelId`） |
| 華爾街日報 │ 📰（`1505072010949169312`） | 股市突發事件公告、股市報告 / 廣播（`stockSystem` 的 announce / report / broadcast） |
| 唐人街彩報 │ 🗞️（`1501770364982657084`） | 拉霸 jackpot 中獎、賽馬、樂透開獎與獎池里程碑等賭場類公告 |

#### 12.9 MongoDB collections 速覽

| Collection | 內容 |
| --- | --- |
| `UserCoins` | 每位玩家在每個 guild 的當前 credits、來源累計、lifetime 統計 |
| `CoinTransactions` | 每筆金錢異動（90 天 TTL；對帳與每日上限都靠它） |
| `BlackjackGames` / `HiloGames` | in-flight + 已結算對局（30 天 TTL；由各自的 cleanup cron 退中途離場局） |
| `JackpotPool` | 每 guild 一筆累積彩池 |
| `LotteryDraws` / `LotteryTickets` / `LotterySubscriptions` / `LotteryWheels` | 樂透開獎期、票券、訂閱、包牌組 |
| `UserInventory` / `ShopTransactions` / `ShopRoleCache` | 商店背包、購買紀錄、顏色身份組快取 |
| `CoinTransfers` / `CoinDeposits` | 每日轉出額度、定期存款單 |
| `MiningProfiles` / `MineLogs` | 每位玩家挖礦狀態（背包、鎬子、冷卻、體力、地下城 / 贈送計數）、挖礦紀錄（90 天 TTL，供排行 / 鑽石計數） |
| `WorkProfiles` | 每位玩家的打工冷卻狀態 |
| `DuelGames` | 地下城決鬥對局（pending / completed / declined / expired，7 天 TTL；逾時退款 cron） |
| `AuctionListings` | 拍賣行掛牌（active / sold / expired，7 天 TTL；結算 cron 撥款交貨 / 退回礦石） |

---

### 13. Twitter / Threads 連結修正

`events/messageCreate/threadsLinkHandler.js` 會自動偵測訊息中的 Twitter / Threads 連結，回覆可正確顯示嵌入內容的 fxtwitter / fixthreads 版本，方便手機瀏覽。

---

## 維運腳本

```bash
# 行事曆
npm run update-calendar           # 從 TaiwanCalendar 抓最新行事曆
npm run verify-calendar           # 驗證行事曆 JSON 完整性
npm run convert-calendar          # 行事曆格式轉換

# 資料修補
npm run clear-crash-stats         # 清空 /火箭 的賭場統計
npm run backfill-recommendations  # 回填推薦系統的歷史資料
npm run backfill-map-meta         # 回填地圖 / 地點 metadata
node scripts/migrateFoodData.js   # 一次性食物資料遷移（舊資料 → 新分類結構）

# Slash Command 部署
node src/tool/deploy-commands.js  # 註冊 / 更新 Slash Command
node src/tool/get-commands.js     # 列出已註冊指令
node src/tool/delete-commands.js  # 清空所有指令（謹慎使用）
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
