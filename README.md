# 逼逼機器人 (Discord Bot)

![Repobeats](https://repobeats.axiom.co/api/embed/07fb82330959889996315cafa478ae498f152b45.svg "Repobeats analytics image")

一隻為單一 Discord 社群量身打造的多功能機器人，整合社群治理（票務 / 投票 / 動態語音 / 身份組 / 遊戲房）、外部資訊推播（Steam 特價、喜加一、Twitch 開台、周表討論串、每日早安卡），以及一整套遊戲化經濟系統（金幣 / 等級 / 賭場 / 股市 / 挖礦 / 釣魚 / 農場 / 世界王 / 公會）。

> 📖 **完整功能介紹與操作說明請見文件網站：<https://docs.bibi.shushu.tw/docs>**

---

## 目錄

- [設計目的](#設計目的)
- [使用技術](#使用技術)
- [專案結構](#專案結構)
- [安裝與部署](#安裝與部署)
- [功能總覽](#功能總覽)
- [維運腳本](#維運腳本)
- [外部 API](#外部-api)
- [維護建議](#維護建議)

---

## 設計目的

- **集中化社群治理**：以「申請 → 審核 → 投票 → 自動結算」流程規範遊戲頻道的開設與封存，避免管理員主觀決策。
- **降低管理員負擔**：動態語音頻道、Ticket、身份組、建議蒐集、遊戲房開關等流程全部交由 bot 自動化處理。
- **內容主動觸達**：將 Steam 特價、限時免費遊戲、Twitch 開台、周表討論串、每日早安等資訊在固定時間推播到指定頻道，提升社群活躍度。
- **遊戲化黏著度**：用金幣經濟、等級簽到、賭場、股市、挖礦 / 釣魚 / 農場 / 世界王 / 公會等長線玩法，把社群活躍度轉成可消費的循環。
- **單一伺服器最佳化**：所有設定集中在 `src/config/`（透過 `src/config/index.js` 合併匯出），搭配 `.env` 即可快速複製到其他伺服器使用。

---

## 使用技術

| 類別 | 技術 |
| --- | --- |
| 執行環境 | Node.js 22.x |
| Discord SDK | [discord.js](https://discord.js.org/) v14（Slash Command、Buttons、Modal、Embed、Components v2） |
| 資料庫 | MongoDB Atlas（透過官方 `mongodb` driver） |
| 排程 | [`node-cron`](https://www.npmjs.com/package/node-cron) |
| 圖片產生 | `satori` + `satori-html` + `@resvg/resvg-js`（早安卡、運勢卡、簽到卡）、`canvas` + `gif-encoder-2`（動態圖卡 / GIF） |
| 時間處理 | `luxon`、`tyme4ts`（農民曆 / 節氣） |
| 中文轉換 | `opencc-js`（簡繁轉換） |
| HTTP / 抓取 | `axios`、`cheerio`（HTML 解析）、`p-limit`（併發控制） |
| Web 服務 | `express`（健康檢查 / 對外 HTTP 端點，`src/httpServer/`） |
| 記錄 | `pino` + `pino-pretty` |
| 部署 | Dockerfile（`node:22-slim`） |
| 開發工具 | `nodemon`、`dotenv` |

機器人在 `src/index.js` 啟動，建立 Discord Client 後委派給 `src/handlers/eventHandler.js` 動態載入 `src/events/**` 中所有事件處理器與 `src/commands/**` 中的 Slash Command。

---

## 專案結構

```
src/
├── index.js                # 進入點：建立 Discord Client → eventHandler 動態載入
├── handlers/eventHandler.js
├── config/                 # 拆檔後的設定（JSON / JS），由 index.js 合併匯出
│   ├── index.js            # 統一 config 入口（...spread 各區塊）
│   ├── server.js / .json   # 頻道 ID、指令頻道桶、推播頻道…
│   └── <功能>.json         # casino / mining / fishing / farming / boss / guild_* / stocks…
├── commands/               # Slash Commands（按功能分子目錄）
│   ├── ask/                # /我想問
│   ├── boss/               # /世界王（attack / spawn / cancel，管理員召喚＋全服共鬥）
│   ├── casino/             # /賭場（21點/猜大小/拉霸/賽馬/火箭/射龍門/尋寶/輪盤/德州撲克/骰寶）、/樂透
│   ├── draw/               # /二選一、/抽籤
│   ├── economy/            # /轉帳、/存款、/逼幣任務、/乞討、/福利、/以物易物、/信箱、/邀請、/問卷、/稅務紀錄、/逼幣紀錄、/give-coins、/economy-dashboard
│   ├── event/              # /活動（成員自辦獎金活動）、/event-admin
│   ├── farm/               # /農場、/施肥、/收成
│   ├── fishing/            # /釣魚、/料理、/魚袋
│   ├── food/               # /吃什麼、/菜單、/food-admin
│   ├── general/            # /help、/通知設定、/個人設定、開 / 關遊戲房
│   ├── guild_club/         # /公會（建立 / 加入 / 倉庫 / 建築 / 鐵匠鋪 / 宴會 / 聊天…）
│   ├── leaderboard/        # /排行榜（整合等級、訊息、語音、頻道、挖礦、賭場…多種排行）
│   ├── level/              # /每日簽到（簽到 / 補簽卡）、/level-admin
│   ├── mining/             # /挖礦、/賣出、/合成、/裝備、/地下城、/決鬥、/贈送、/市集、/礦石市場、/打工、/背包…
│   ├── post/               # /生成情勒文、/新增情勒文
│   ├── profile/            # /檔案（個人資料聚合）、/稱號、/卡號
│   ├── quiz/               # /預測、/問答
│   ├── recommendation/     # /推薦、/recommendation-admin
│   ├── roles/              # /setup-roles
│   ├── shop/               # /商店
│   ├── stats/              # /統計
│   ├── stock/              # /股市（買/賣/走勢/配息/報價/持股/紀錄）、/stock-event
│   ├── ticket/             # /ticket（suggestion-setup / proposal / vote）
│   ├── title/              # /title-admin
│   ├── weather/            # /天氣、/全台天氣
│   ├── world_event/        # /世界事件（全服隨機事件）
│   └── dev/                # /dev、/donation-admin（開發者工具）
├── events/                 # 事件處理器（每個事件一個資料夾）
│   ├── ready/              # bot 啟動時要做的事（連 DB、註冊指令、起 cron…）
│   ├── interactionCreate/  # 按鈕、Select Menu、Modal 互動
│   ├── messageCreate/      # 訊息統計、Threads / IG / X(Twitter) 連結修正
│   ├── messageReactionAdd/ # 反應 XP
│   ├── voiceStateUpdate/   # 動態語音、語音時長統計
│   ├── inviteCreate / inviteDelete       # 邀請追蹤
│   ├── guildCreate / guildMember*        # 進退群、歡迎、身份組同步
│   ├── thread*/           # thread 生命週期（德州撲克、公會聊天…）
│   └── validations/       # Slash Command 前置驗證、Autocomplete、頻道守門
├── features/              # 核心業務邏輯（指令層只呈現，不寫邏輯）
│   ├── economy/           # grantCoins（所有金幣異動唯一入口）、轉帳、定存、稅務…
│   ├── casino/            # blackjack / hilo / sicbo / slot / lottery 引擎
│   ├── leveling/          # XP 計算、徽章、稱號、升等公告
│   ├── mining/ dungeon/   # 挖礦、合成、賭石、地下城、決鬥、突發事件
│   ├── fishing/ farm/     # 釣魚 / 料理、農場種植
│   ├── boss/ world_event/ # 世界王共鬥、全服世界事件
│   ├── guild_club/        # 公會、倉庫、建築、鐵匠鋪、宴會、聊天 thread
│   ├── stock/ market/ marketplace/ barter/   # 股市、市集、拍賣、以物易物
│   ├── shop/ buff/        # 商品結算、buff 倍率（統一走 buffResolver）
│   ├── steamDeals/ freeGames/ twitch/ rssWeeklyThreads/   # 各推播 / 討論串管線
│   ├── quests/ welfare/ donation/ invite/ survey/         # 任務、福利、抖內、邀請、問卷
│   └── voting/ ticket/ gameRoom/ recommendation/ …
├── cron/                  # 排程任務
├── services/             # 跨功能共用服務
├── httpServer/           # express 健康檢查 / 對外端點
├── utils/                # 共用函式（卡片產生、農民曆、autocomplete…）
├── data/                 # 持久化 JSON（身份組、建議、票務面板）
├── constants/            # 食物分類、金幣 emoji 等靜態常數
├── scripts/              # 一次性資料遷移 / 維護腳本
└── tool/                 # 部署 / 列出 / 刪除 Slash Command 的維運腳本
```

---

## 安裝與部署

### 1. 取得程式碼與安裝套件

```bash
git clone https://github.com/SHUSHU010829/bibi-bot.git
cd bibi-bot
npm install
```

### 2. 建立 `.env`

複製 `.env.example` 為 `.env` 並填入：

| 變數 | 說明 |
| --- | --- |
| `BOT_TOKEN` | Discord Developer Portal 取得的 Bot Token |
| `MONGO_PASSWORD` | MongoDB Atlas 密碼 |
| `DISCORD_DEALS_CHANNEL_ID` | Steam 特價推播頻道（留空則用 `config/steamDeals.json`） |
| `STEAM_DEALS_*` | 排程、暫停、Dry-run、首啟即跑 |
| `DISCORD_FREE_GAMES_CHANNEL_ID`、`FREE_GAMES_*` | 喜加一推播控制 |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`、`TWITCH_*` | Twitch 開台通知（於 [Twitch Dev Console](https://dev.twitch.tv/console/apps) 取得） |

> 完整環境變數清單與說明見 `.env.example`。

### 3. 設定 `src/config/`

設定已拆成 `src/config/<功能>.json`（與 `server.js`），由 `src/config/index.js` 合併匯出；要改數值 / 文案 / 頻道請改對應區塊檔，merge conflict 才會局部化。至少填入以下欄位（其他依需要）：

- `server.json`：`serverId`、`developersId`、`createVoiceChannelId`、`memberCountChannelId`、各 `commandChannels` 指令頻道桶
- `ticket.categoryId`、`ticket.supportRoleId`（`server.json`）
- `voting.json`：`votingChannelId`、`passThresholds`、`weights`
- `roles[]`（`server.json`，提供身份組面板選項）
- 各推播頻道：`steamDeals.json` / `freeGames.json` / `twitch.json` 等

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

## 功能總覽

> 📖 **每個功能的詳細玩法、指令參數、UI 流程與數值表，請見文件網站：<https://docs.bibi.shushu.tw/docs>**
>
> 下方僅列出功能分類與對應指令 / 模組，方便快速定位程式碼；操作說明一律以文件網站為準。

### 社群治理

| 功能 | 指令 / 模組 | 說明 |
| --- | --- | --- |
| 動態語音頻道 | `voiceStateUpdate/` | 加入「點選新增頻道」自動開私人語音，全員離開自動刪除 |
| Ticket 與遊戲頻道投票 | `/ticket`、`features/voting`、`features/ticket` | 申請 → 票務頻道 → 公投 → cron 自動結算 |
| 身份組自助領取 | `/setup-roles`、`handleRoleSelect` | Select Menu 自助增刪通知身份組 |
| 建議 / 投票面板 | `/ticket suggestion-setup` | 成員提案、贊成 / 反對輕量投票 |
| 遊戲房開關 | `/開遊戲房`、`/關遊戲房`、`features/gameRoom` | 臨時遊戲房頻道管理 |
| 個人 / 通知設定 | `/個人設定`、`/通知設定` | 玩家自訂偏好與通知開關 |

### 資訊推播（cron 主動發送）

| 功能 | 模組 | 推播頻道 |
| --- | --- | --- |
| Steam 特價 | `features/steamDeals`（小黑盒 RSS → Steam API → Embed） | 特價喜加一 │ 💰 |
| 喜加一限免 | `features/freeGames`（GamerPower API） | 特價喜加一 │ 💰 |
| Twitch 開台通知 | `features/twitch`（Helix App Token + 去重） | `twitch.json` 指定頻道 |
| 周表討論串 | `features/rssWeeklyThreads`、`messageCreate/weeklyScheduleForward.js` | 每週預建 thread + 轉貼來源頻道的周表圖 |
| 每日早安卡 | `events/ready/sendMorningMessage.js`（satori 繪卡） | 含日期 / 節氣 / 農民曆 / 詩詞 / 運勢 |
| Threads 連結修正 | `messageCreate/threadsLinkHandler.js` | 抓貼文內容後回覆完整預覽卡；支援 `/share/` 短連結 |
| IG / X(Twitter) 連結修正 | `messageCreate/socialLinkHandler.js` | 回覆 oginstagram / fixupx / fxtwitter 版本 |

### 生活娛樂

| 功能 | 指令 |
| --- | --- |
| 食物 / 飲料 | `/吃什麼`、`/菜單`、`/food-admin` |
| 天氣 | `/天氣`、`/全台天氣` |
| 抽籤 / 隨機 | `/抽籤`、`/二選一`（～五選一）、`/我想問` |
| 推薦清單 | `/推薦`、`/recommendation-admin` |
| 整人小工具 | `/生成情勒文`、`/新增情勒文` |
| 統計 | `/統計 用戶 / 頻道` |

### 等級系統與簽到

`/每日簽到`（簽到 / 補簽卡 / 押倍）、`/檔案`、`/稱號`、`/排行榜`、`/level-admin`；XP 來源、徽章、稱號、Twitch 訂閱倍率統一走 `features/leveling`。

### 遊戲化經濟

| 子系統 | 指令 / 模組 | 重點 |
| --- | --- | --- |
| 金幣基礎 | `features/economy/grantCoins.js` | 所有金幣異動唯一入口，逐筆寫 `CoinTransactions` |
| 金錢工具 | `/轉帳`、`/存款`、`/逼幣任務`、`/乞討`、`/福利`、`/信箱`、`/邀請`、`/問卷`、`/稅務紀錄`、`/以物易物`、`/give-coins`、`/economy-dashboard` | 賺 → 花 → 互動循環 |
| 賭場 | `/賭場`（拉霸 / 骰寶 / 21點 / 猜大小 / 賽馬 / 火箭 / 射龍門 / 尋寶 / 輪盤 / 德州撲克）、`/樂透` | 共用下注 / 派彩 / RTP 對帳 |
| 股市 | `/股市`、`/stock-event` | 虛擬股市＋事件系統 |
| 商店與背包 | `/商店`、`/背包` | 顏色身份組 / 卡面 / buff 藥水 / 挖礦道具 |
| 挖礦生態 | `/挖礦`、`/賣出`、`/打工`、`/合成`、`/裝備`、`/地下城`、`/決鬥`、`/贈送`、`/市集`、`/礦石市場` | 挖 → 賣 / 合成 → 挖更快；含賭石、突發事件 |
| 釣魚與料理 | `/釣魚`、`/料理`、`/魚袋` | 釣魚換金幣、料理產 buff |
| 農場 | `/農場`、`/施肥`、`/收成` | 時間驅動種植產出 |
| 世界王 | `/世界王`（召喚 / 攻擊 / 取消） | 管理員召喚、全服共鬥 |
| 世界事件 | `/世界事件`、`features/world_event` | 全服隨機事件 |
| 公會 | `/公會`、`features/guild_club` | 公會、倉庫、建築、鐵匠鋪、宴會、聊天 thread |
| 遊戲區稱號 / 成就 | `/稱號`、`/檔案 → 成就`、`features/gameTitles` | 橫跨挖礦 / 賭場 / 股市 / 樂透 / 拍賣的稱號 |

### 指令頻道限制

`utils/commandChannelGuard.js` 依「指令所在資料夾」分流到 `config/server.json` 的 `commandChannels` 對應頻道桶（casino / stock / mining / citizen / general…），在錯誤頻道呼叫會被擋下並提示正確頻道；管理員（🔒）、開發者（🔧）、ephemeral 指令豁免。

### MongoDB collections

金幣 / 交易 / 賭場對局 / 樂透 / 商店 / 挖礦 / 拍賣 / 決鬥 / 等級 / 簽到等 collection 與索引（含 unique / TTL）統一在 `events/ready/connectDb.js` 宣告。各 collection 用途見文件網站。

---

## 維運腳本

```bash
# 行事曆
npm run update-calendar           # 從 TaiwanCalendar 抓最新行事曆
npm run verify-calendar           # 驗證行事曆 JSON 完整性
npm run convert-calendar          # 行事曆格式轉換

# 資料修補
npm run clear-crash-stats         # 清空 /賭場 火箭 的賭場統計
npm run backfill-recommendations  # 回填推薦系統的歷史資料
npm run backfill-map-meta         # 回填地圖 / 地點 metadata
npm run fix-donation-guild-space  # 修補抖內 / 公會空間資料
node src/scripts/migrateFoodData.js   # 一次性食物資料遷移（舊資料 → 新分類結構）

# Slash Command 部署
node src/tool/deploy-commands.js  # 註冊 / 更新 Slash Command
node src/tool/get-commands.js     # 列出已註冊指令
node src/tool/delete-commands.js  # 清空所有指令（謹慎使用）
```

---

## 外部 API

| 用途 | URL |
| --- | --- |
| 台灣行事曆 | <https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/2025.json> |
| Steam 特價來源 | 小黑盒 RSS（`https://discord-news.zeabur.app/xiaoheihe/...`） |
| Steam 商品資訊 | Steam Store API |
| 喜加一限免 | [GamerPower API](https://www.gamerpower.com/api-read) |
| Twitch 開台 | [Twitch Helix API](https://dev.twitch.tv/docs/api/)（App Access Token） |
| Threads 連結修正 | <https://github.com/milanmdev/fixthreads> |

---

## 維護建議

1. **定期備份 MongoDB**：投票、食物、訊息統計等資料皆存於此。
2. **監控 cron**：投票結算、Steam 特價、喜加一、早安卡都仰賴 `node-cron`，bot 重啟後排程會重建。
3. **依社群規模調整門檻**：`voting.passThresholds`、`voting.weights`、`activeHours` 都可在不重啟程式的情況下用 PR / 重新部署修改。
4. **Slash Command 變更後執行 `deploy-commands`**：否則 Discord 端不會看到新指令。
5. **動態語音頻道資料僅在記憶體**：若有計畫長時間維運，可考慮持久化到 MongoDB 以便在重啟時恢復。
6. **功能說明以文件網站為準**：玩法、數值、UI 流程的詳細內容統一維護在 <https://docs.bibi.shushu.tw/docs>，新增 / 調整功能後記得同步更新。
