# 逼逼機器人 — 挖礦生態系統開發規劃書（bibi-bot）

> 本文件原規劃 bibi-bot 端完整「挖礦生態系統」。**Phase 0–5（核心挖礦、打工、裝備合成、地下城、決鬥、贈送、拍賣）已開發完成並上線**，相關段落已移除（指令與機制見 `README.md` §12.5–12.6）。本文件僅保留尚未開發的「稱號 / 成長」「Twitch 訂閱者權益」與**抖內（贊助）的「發放端」**。
>
> **重要架構決策**：抖內的付款流程（Discord OAuth、建立 session、導向綠界 / 歐付寶、接收與驗證 webhook）整段搬到 **bibi-website** 執行；bibi-bot 只負責「Discord 端效果」——加身分組、發金幣、發消耗品、DM、公告，並透過一支內部 API 被 website 呼叫。詳見 [Phase 8](#phase-8--抖內發放端bibi-bot) 與 [API 介接契約](#api-介接契約)。
>
> 各階段皆為獨立可上線的完整功能，可依進度逐步推出。
>
> 最後更新：2026-05-27（移除已完成的 Phase 0–5）

---

## 目錄

1. [設計原則](#1-設計原則)
2. [與現有程式碼的對齊](#2-與現有程式碼的對齊)
3. [金幣數值總表](#3-金幣數值總表)
4. [Phase 6 — 成長 + 稱號系統](#phase-6--成長--稱號系統)
5. [Phase 7 — Twitch 訂閱者權益擴充](#phase-7--twitch-訂閱者權益擴充)
6. [Phase 8 — 抖內發放端（bibi-bot）](#phase-8--抖內發放端bibi-bot)
7. [API 介接契約](#api-介接契約)
8. [每日收入藍圖](#每日收入藍圖全系統上線後)
9. [風控與通膨防護](#風控與通膨防護)
10. [檔案索引](#檔案索引)
11. [開發時程總覽](#開發時程總覽)

> ✅ **Phase 0–5 已開發完成並上線**（核心挖礦、打工、裝備合成、地下城、決鬥、贈送、拍賣），相關段落已從本文件移除；指令與機制說明見 `README.md` §12.5–12.6。本文件僅保留尚未開發的 Phase 6–8。

---

## 1. 設計原則

| 原則 | 說明 |
|---|---|
| **任務是主力** | 所有新收入來源加總，不應超過任務全收（1,150 幣/天）的 80% |
| **階梯式吸引力** | 挖礦 >（趣味）打工 >（保底）補助 |
| **礦石有兩用途** | 直接賣錢 OR 存著合成裝備，讓玩家有策略選擇 |
| **每個 Phase 獨立可玩** | 上線任一 Phase 都是完整體驗 |
| **通膨出口隨收入擴充** | 每新增一個收入來源，同步新增一個消費出口 |
| **沿用既有經濟基礎建設** | 一律走 `grantCoins`，每個流向都進 `CoinTransactions`，方便日報分析 |

---

## 2. 與現有程式碼的對齊

> 撰寫與實作時務必對齊既有結構，不要另起爐灶。

### 2.1 發幣與帳本

- 發幣一律呼叫 `src/features/economy/grantCoins.js`：
  ```js
  // 簽名
  module.exports = async (client, opts) => { ... }
  // opts = { userId, guildId, amount, source, member, username, avatarHash, meta }
  ```
- 餘額存 `UserCoins`（`client.userCoinsCollection`），帳本存 `CoinTransactions`（`client.coinTransactionsCollection`，90 天 TTL），每個 source 另有 `coinsFrom_<source>` 計數。
- **新增來源**：挖礦賣礦 `mining_sell`、抖內 `donation`、（打工 `work` 已在白名單可直接用）。
  - `mining_sell`、`work`、`donation` 屬於「固定獎勵、不吃倍率」→ 加進 `grantCoins.js` 頂部的 `FLAT_REWARD_SOURCES` 陣列（與 `welfare`、`quest_daily` 同列），避免抖內金幣被 Twitch / Boost 倍率放大。
  - 商店消費沿用既有 `shop_buy`（已在 `SINK_SOURCES`）。

### 2.2 資料庫

- MongoDB 原生 driver（無 mongoose）。所有 collection 在 `src/events/ready/connectDb.js` 建立並掛到 `client.<name>Collection`。
- 新增 collection 三步驟：`database.collection("Name")` → `client.xxxCollection = col` → `await col.createIndex(...)`。

### 2.3 設定檔

- `src/config/*.json` 由 `src/config/index.js` 合併匯出。新增挖礦 / 抖內設定檔放此處。
- 主 guild、頻道、角色 ID 既有放在 `src/config/server.json`、Twitch tier 角色在 `src/config/level.json`。

### 2.4 HTTP 內部 API

- `src/httpServer/index.js`（Express 4）。既有內部 API 範本 = `POST /api/twitch-chat-score`（`src/httpServer/flushChatScore.js`），驗證方式：
  ```js
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!provided || provided !== process.env.DISCORD_BOT_SCORE_SECRET) return res.status(401)...
  ```
- 抖內發放 API（[Phase 8](#phase-8--抖內發放端bibi-bot)）**完全照這個模式**，改用新 secret `DONATION_GRANT_SECRET`。

### 2.5 Twitch 訂閱倍率（既有）

- 角色 ID 在 `src/config/level.json`：Tier1 `1181162291568332891`、Tier2 `...892`、Tier3 `...893`。
- 倍率邏輯 `src/features/economy/coinMultiplier.js`，stacking 採 `max`。挖礦 / 抖內的 Twitch 加成沿用同一組角色 ID。

---

## 3. 金幣數值總表

### 3.1 礦石收購價（賣給系統）

| 礦石 | 稀有度 | 掉落率 | 收購價 / 顆 | 掉落數量 |
|---|---|---|---|---|
| 🪨 石頭 | 普通 | 55% | 8 幣 | 1–3 顆 |
| 🪵 煤炭 | 普通 | 25% | 20 幣 | 1–2 顆 |
| 🔩 鐵礦 | 稀有 | 12% | 60 幣 | 1 顆 |
| 💎 水晶 | 稀有 | 6% | 200 幣 | 1 顆 |
| ✨ 彩虹石 | 傳說 | 2% | 800 幣 | 1 顆 |

> **一次挖礦期望值**：約 22–35 幣（視 buff 而定）

### 3.2 挖礦 CD 與鎬子

| 鎬子 | CD | luck 加成 | qty 加成 | 合成材料 | 耐久 |
|---|---|---|---|---|---|
| ⛏️ 木鎬（預設） | 2h | +0% | +0 | — | 永久 |
| 🔨 鐵鎬 | 1.5h | +5% | +0 | 鐵礦 ×15 | 50 次 |
| 💎 水晶鎬 | 1h | +12% | +1 | 水晶 ×5 + 鐵礦 ×20 | 50 次 |

### 3.3 打工

| 欄位 | 數值 |
|---|---|
| 每次收入 | 80–120 幣（平均 100） |
| CD | 4 小時 |
| 每日最多次數 | 6 次 |
| 每日最大貢獻 | 720 幣 |

### 3.4 挖礦商店道具（併入既有 `/商店`）

| 道具 | 效果 | 售價 | 類型 |
|---|---|---|---|
| 幸運藥水 | luck +8%，持續 3 次挖礦 | 300 幣 | 消耗品 |
| CD 縮短券 | 本次 CD -30 分鐘 | 150 幣 | 消耗品 |
| 背包擴充 | 背包上限 +5 格 | 2,000 幣 | 永久 |

### 3.5 補助指令（原救濟金）— 數值不變，僅改名

| 連領天數 | 金額 | 門檻 |
|---|---|---|
| 1 天 | 500 幣 | 總資產 ≤ 100 幣 |
| 2–3 天 | 600 幣 | 同上 |
| 4–7 天 | 700 幣 | 同上 |
| ≥ 8 天 | 800 幣 | 同上 |

### 3.6 稱號系統速覽

| 稱號 | 類型 | 解鎖條件 | 保留方式 |
|---|---|---|---|
| ⛏️ 新手礦工 | 預設 | 加入即有 | 永久 |
| 🪵 煤炭採集者 | 生產成就 | 累積挖礦 50 次 + 持有 500 幣 | 永久 |
| 🔨 鐵鍛師 | 合成成就 | 累積合成 10 件 + 歷史鐵礦 100 顆 | 永久 |
| 💎 寶石獵人 | 稀有成就 | 累積水晶 20 顆 + 彩虹石 ≥ 1 顆 | 永久 |
| 👑 礦坑之王 | 週排行榜 | 當週挖礦 #1（唯一） | 每週更替 |
| ✨ 傳說礦工 | 終極成就 | 累積挖礦 1000 次 + 彩虹石 ≥ 5 顆 + 週冠 ≥ 3 次 | 永久 |

---

## Phase 6 — 成長 + 稱號系統

> **目標**：長期目標感與炫耀資本。**預估**：3–4 天。

### 指令

| 指令 | 說明 |
|---|---|
| `/titles` | 已解鎖稱號 |
| `/title set [稱號]` | 切換展示稱號（同步 Discord 身分組） |
| `/achievements` | 成就進度 |
| `/profile [@玩家]` | 完整 Profile |
| `/leaderboard mining` | 當週挖礦排行榜 |

### 成就檢查（`src/features/mining/achievementChecker.js`，非同步）

```js
if (user.mine_count_total >= 50 && totalCoins >= 500) toGrant.push('coal_collector')
if (user.craft_count_total >= 10 && user.iron_total >= 100) toGrant.push('iron_smith')
// ... 解鎖即 grantTitle + announceTitle
```

### 身分組同步（`src/features/mining/titleManager.js`）

```js
// 解鎖：member.roles.add(TITLE_ROLE_MAP[titleId])
// 切換展示：先 remove 全部 title 角色，再 add 新選的
```

### 週排行榜 Cron（`src/events/ready/miningWeeklyRank.js`，每週一 00:01）

```
統計上週 mine_logs 依 qty 加總 → #1 給「礦坑之王」+ 身分組 → 移除上任王 → 公告 → 清理舊 logs（保留 90 天）
```

---

## Phase 7 — Twitch 訂閱者權益擴充

> **目標**：訂閱者在遊戲中有實質差異。**前置**：Phase 1（已完成）。**預估**：2–3 天。

### 既有訂閱倍率（不動，沿用 `level.json` 角色 ID）

| Tier | XP | 金幣（聊天/語音/簽到） |
|---|---|---|
| Tier 1 | ×1.5 | ×1.1 |
| Tier 2 | ×2.0 | ×1.3 |
| Tier 3 | ×3.0 | ×1.5 |

### 新增權益（延伸 `buffResolver.js`）

| 項目 | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| 挖礦 luck 加成 | +5% | +10% | +15% |
| 挖礦 CD 縮短 | −15m | −30m | −45m |
| 打工 CD 縮短 | −30m | −30m | −30m |
| 地下城體力上限 | 10 | +2（12） | +2（12） |
| 定存單上限 | 5 | +2（7） | +2（7） |
| 拍賣手續費 | 5% | 5% | → 2% |
| 樂透每期張數上限 | 10 | 10 | +5（15） |
| 自訂稱號免費 | ✗ | ✗ | ✓ 每月 1 次 |
| 訂閱限定卡面 | ✗ | ✓ | ✓ |
| 限定名字顏色（永久） | ✗ | ✗ | ✓ |

> luck 疊加後仍受 `luckCap = 25%` 全域限制。

### 設定檔 `src/config/twitch_perks.json`

```json
{
  "tier1": { "miningLuckBonus":0.05,"miningCdReductionMs":900000,"workCdReductionMs":1800000 },
  "tier2": { "miningLuckBonus":0.10,"miningCdReductionMs":1800000,"workCdReductionMs":1800000,"staminaBonus":2,"depositSlotBonus":2,"exclusiveThemeId":"theme_subscriber_t2" },
  "tier3": { "miningLuckBonus":0.15,"miningCdReductionMs":2700000,"workCdReductionMs":1800000,"staminaBonus":2,"depositSlotBonus":2,"auctionFeeRate":0.02,"lotteryTicketBonus":5,"monthlyFreeTitleEnabled":true,"exclusiveThemeId":"theme_subscriber_t3","exclusiveColorRoleId":"TIER3_COLOR_ROLE_ID" }
}
```

Tier 3 每月免費稱號 Cron：`src/events/ready/twitchMonthlyTitle.js`（每月 1 日，找 Tier3 成員 → 寫 `UserInventory` title_custom expires_at=30 天 → DM）。

---

## Phase 8 — 抖內發放端（bibi-bot）

> **目標**：只做「Discord 端效果」。付款 / OAuth / session / webhook 全在 **bibi-website**（見該 repo 的 `docs/DONATION_SYSTEM_PLAN.md`）。
> **前置**：Phase 1（已完成）。**預估**：2–3 天（不含 website）。

### 職責邊界

bibi-bot **只**做：建立 / 完成 session、收到發放呼叫 → 依方案加身分組、`grantCoins`、發消耗品、DM 收據、頻道公告、寫 `donation_records`（冪等）。**所有 DB 寫入都在 bot**。
bibi-bot **不**做：OAuth、接金流 webhook、驗章解密（這些在 website；website 對 DB 只有唯讀權）。

> **安全模型（安全強化版）**：website 對共用 MongoDB 只持有**唯讀**帳號，**所有寫入一律經由 bot 的兩支 API**；webhook 所需的金流 HashKey / HashIV 仍在 website。

### 8.1 內部 API（兩支，皆於 `src/httpServer/index.js` 註冊，Bearer 驗證仿 `flushChatScore.js`）

**(1) `POST /api/donation/session` — 建立 pending session（付款前由 website 呼叫）**

```js
// src/httpServer/donationSession.js
module.exports = (client) => async (req, res) => {
  // 1. Bearer 驗證：=== process.env.DONATION_GRANT_SECRET，否則 401
  // 2. body：{ userId, guildId, amountNtd, platform }
  // 3. sessionId = uuid(); merchantTradeNo = 'DON' + sessionId.replace(/-/g,'').slice(0,17)
  // 4. donation_sessions.insertOne({ session_id, merchant_trade_no, user_id, guild_id,
  //      amount_ntd, platform, status:'pending', created_at: Date.now() })
  // 5. return res.json({ ok:true, sessionId, merchantTradeNo })
}
```

**(2) `POST /api/donation/grant` — 發放（webhook 驗證成功後由 website 呼叫）**

```js
// src/httpServer/donationGrant.js
module.exports = (client) => async (req, res) => {
  // 1. Bearer 驗證，否則 401
  // 2. body：{ merchantTradeNo, tradeNo, amountNtd, platform }
  //    （userId / guildId 由 bot 從 session 還原，不由 webhook 帶入 → 防偽造身分）
  // 3. 冪等：donation_records.findOne({ trade_no: tradeNo })
  //    若存在 → return { ok:true, matched:true, alreadyGranted:true, perks }
  // 4. 找 session：donation_sessions.findOne({ merchant_trade_no, status:'pending' })
  //    找不到 → bot 自行寫 unmatched_donations → return { ok:true, matched:false }
  // 5. perks = await grantDonationPerks(client, { userId: session.user_id,
  //      guildId: session.guild_id, amountNtd, platform })
  // 6. 同一筆動作（MongoDB transaction）：
  //    a. donation_records.insertOne（trade_no unique）
  //    b. donation_sessions.updateOne({ merchant_trade_no }, { $set:{ status:'completed' } })
  // 7. return { ok:true, matched:true, alreadyGranted:false, perks }
  // 失敗：400 參數錯、503 client 未 ready / db 未掛
}
```

詳細請求 / 回應格式見 [API 介接契約](#api-介接契約)。

### 8.2 發放邏輯 `src/features/donation/grantDonationPerks.js`

```
依 amountNtd 對應 donation_tiers.json 方案：
  - grantCoins(client, { userId, guildId, amount: tier.coins, source: 'donation', member })
  - 加贊助者身分組（含天數；頂級為永久角色）
  - 發消耗品到 UserInventory（幸運藥水 / CD 縮短券）
  - 設定限時 buff（luck，記到既有 activeBuff 機制）
  - 限定卡面 / 顏色（Tier 對應）
  - DM 收據 + 指定頻道公告感謝
回傳 perks 快照物件：{ coins, roleId, items, luck, theme, title }
```

### 8.3 設定檔 `src/config/donation_tiers.json`

```json
[
  { "id":"coffee","minNtd":50,"maxNtd":149,"coins":500,"items":{"luck_potion":3},"roleDays":7 },
  { "id":"normal","minNtd":150,"maxNtd":499,"coins":2000,"items":{"cd_ticket":5},"roleDays":30,"luck":0.05,"luckDays":30 },
  { "id":"large","minNtd":500,"maxNtd":999,"coins":6000,"roleDays":90,"theme":"theme_donor","customTitleDays":30,"luck":0.08,"luckDays":90 },
  { "id":"top","minNtd":1000,"coins":15000,"roleDays":null,"theme":"theme_donor","customTitleDays":90,"luck":0.12,"luckPermanent":true,"canNominateTitle":true }
]
```

> `roleDays: null` = 永久頂級贊助者。「可提名限定稱號」由頻道主審核後手動授予。

### 8.4 新增 collection（`connectDb.js`）

```js
// donation_records — 成功贊助紀錄（永久），由本 API 寫入
{ user_id, guild_id, amount_ntd, tier_id, platform, trade_no /* unique index，防重複發放 */, granted_at, perks /* 快照 */ }
```

> **三個 collection 都由 bot 寫入**（安全強化版）：`donation_sessions` 由 `session` API 建立 pending、`grant` API 翻 `completed`；`donation_records` 由 `grant` API 寫；`unmatched_donations` 由 `grant` API 在找不到 session 時寫。website 對這些只有**唯讀**權（輪詢狀態 / 顯示紀錄）。完整 schema 見 [API 介接契約](#api-介接契約)。

### 8.5 Discord 指令

| 指令 | 說明 |
|---|---|
| `/贊助` | 回傳 `donate` 網址（bibi-website），引導前往 |
| `/贊助紀錄` | 讀 `donation_records` 顯示個人歷史與目前 buff |
| `/donation-admin grant @玩家 金額 平台` 🔒 | 管理員手動補發（對應 grant API 找不到 session 時寫入的 `unmatched_donations`） |

> 移除原短碼式 `/綁定贊助`，改由 website 的 Discord OAuth2 流程取代。

### 8.6 對帳 Cron（建議）`src/events/ready/donationReconcile.js`

```
定期掃描 donation_sessions 中 status='pending' 且逾時者；
必要時呼叫綠界/歐付寶查詢 API 確認是否已付款但漏接 webhook，
有付款未發放者 → 寫 unmatched_donations 供管理員 /donation-admin grant 補發。
```

### 8.7 `.env.example` 新增

```
DONATION_GRANT_SECRET=   # website 呼叫 /api/donation/grant 用的 Bearer
DONATION_ANNOUNCE_CHANNEL_ID=
DONOR_ROLE_ID=
DONOR_TOP_ROLE_ID=
```

---

## API 介接契約

> **本章節與 `bibi-website/docs/DONATION_SYSTEM_PLAN.md` 的「API 介接契約」逐字一致。任一邊修改都要同步。**

### 安全模型

website 對共用 MongoDB 只持有**唯讀**帳號；所有寫入一律經由 bot 的兩支 API。webhook 所需的金流 HashKey / HashIV 仍在 website（驗章 / 解密 / 表單簽章用）。兩支 API 皆用 `Authorization: Bearer <DONATION_GRANT_SECRET>`。

### 跨服務呼叫 1：建立 session（website → bot）

**`POST {BOT_API_BASE_URL}/api/donation/session`**

- Request body：

```json
{ "userId": "Discord 使用者 ID", "guildId": "主 guild ID", "amountNtd": 500, "platform": "ecpay" }
```

- Response 200：

```json
{ "ok": true, "sessionId": "uuid", "merchantTradeNo": "DON..." }
```

- 行為：bot 產生 `sessionId` 與 `merchantTradeNo`（`DON` + sessionId 去 `-` 前 17 碼），寫 `donation_sessions`（pending，TTL 30 分），回傳給 website 組金流表單。

### 跨服務呼叫 2：發放（website → bot）

**`POST {BOT_API_BASE_URL}/api/donation/grant`**

- Request body（`userId` / `guildId` 由 bot 從 session 還原，不由 webhook 帶入 → 防偽造身分）：

```json
{ "merchantTradeNo": "DON...", "tradeNo": "平台交易編號（冪等鍵）", "amountNtd": 500, "platform": "ecpay" }
```

- Response 200：

```json
{ "ok": true, "matched": true, "alreadyGranted": false,
  "perks": { "coins": 6000, "roleId": "...", "items": {"cd_ticket":0}, "luck": 0.08, "theme": "theme_donor", "title": "custom_30d" } }
```

- 行為：
  - 以 `tradeNo` 查 `donation_records` 做**冪等**——已存在則回 `alreadyGranted:true` 不重複發放。
  - 以 `merchantTradeNo` 找 pending `donation_sessions` 取 `userId` / `guildId`；**找不到 → bot 自行寫 `unmatched_donations`，回 `{ ok:true, matched:false }`**（website 不需也不能寫 DB）。
  - 找到 → 依 `amountNtd` 對 `donation_tiers.json` 判定方案發放，**在同一筆動作**寫 `donation_records` 並把 `donation_sessions.status` 翻為 `completed`。
- 錯誤碼：`401` Bearer 不符、`400` 參數錯誤、`503` bot 未就緒或 DB 未掛載（website 收到非 2xx 應記錄並重試）。

### 共用 MongoDB collection 擁有權

| collection | 寫入方 | 讀取方 | 備註 |
|---|---|---|---|
| `donation_sessions` | bot（session API 建立 pending、grant API 翻 completed） | bot / website（唯讀輪詢） | `{ session_id, merchant_trade_no(unique), user_id, guild_id, amount_ntd, platform, status('pending'\|'completed'\|'expired'), created_at }`，pending TTL 30 分 |
| `donation_records` | bot（grant API） | bot / website（唯讀） | `{ user_id, guild_id, amount_ntd, tier_id, platform, trade_no(unique), granted_at, perks }`，永久 |
| `unmatched_donations` | bot（grant API 找不到 session 時） | bot 管理指令 | `{ platform, data, ts, resolved }` |
| `UserCoins` / `CoinTransactions` | bot | bot / website（唯讀） | 既有經濟資料 |

### 抖內 buff 與 Twitch 訂閱疊加規則

- 挖礦 luck：抖內 + Twitch 相加後受 `luckCap = 25%` 全域限制。
- 身分組：贊助身分組與 Twitch 訂閱身分組可同時持有，效果獨立。
- 限定卡面：兩管道 id 不同，可各自解鎖。
- 永久頂級贊助者身分組不因 Twitch 訂閱取消而受影響。

---

## 每日收入藍圖（全系統上線後）

| 來源 | 一般玩家 | 勤勞玩家 | 備註 |
|---|---|---|---|
| 任務全收 | 0–1,150 | 1,150 | 主要來源 |
| 打工（P2） | 100–400 | 720 | 每 4h、最多 6 次 |
| 挖礦（P1） | 100–200 | 300–480 | 每 2h |
| 聊天 + 語音 | 50–150 | 200 | 既有 |
| 簽到 | 60–160 | 160 | 含連勝 |
| 地下城（P4） | 0–300 | 150–600 | 依體力裝備 |
| **補助** | **500–800** | **—** | **資產 ≤ 100 才能領，與其他互斥** |

> 一般玩家估 800–1,800 幣 / 天；勤勞玩家最多約 3,310 幣（不含補助）。

---

## 風控與通膨防護

| 機制 | 設定 | 說明 |
|---|---|---|
| 挖礦 CD | 2h（木鎬）→ 最短 1h（水晶鎬） | 限制日產量 |
| luck 上限 | 25%（`luckCap`） | 防 buff 疊加扭曲 |
| 彩虹石上限 | 每次掉 1 顆 | 防稀有石氾濫 |
| 拍賣手續費 | 5%（Tier3 2%） | 玩家交易回收通膨 |
| 贈送每日限制 | 3 次 / 人 | 防洗幣 |
| 補助門檻 | 總資產 ≤ 100 幣 | 不與其他收入疊加 |
| 鎬子耐久 | 50 次 → 退回木鎬 | 持續消費需求 |
| `mining_sell` / `donation` source | 獨立 source 標籤、不吃倍率 | 方便日報分析礦石 / 抖內貢獻 |
| 抖內冪等 | `donation_records.trade_no` unique | 防 webhook 重送重複發放 |
| 每日經濟報告 | 既有 `economyDailyReportScheduler` | 將 `mining_sell`、`donation` 納入 inflow 監控 |

---

## 檔案索引

> 僅列尚未開發的 Phase 6–8 檔案；已完成的挖礦 / 打工 / 合成 / 地下城 / 拍賣等檔案見 `README.md` §12.6 與 `src/features/mining`、`src/features/auction`。

| 檔案 | 內容 | Phase |
|---|---|---|
| `src/features/mining/achievementChecker.js` | 成就檢查 | 6 |
| `src/features/mining/titleManager.js` | 稱號 + 身分組同步 | 6 |
| `src/events/ready/miningWeeklyRank.js` | 週排行榜 cron | 6 |
| `src/config/twitch_perks.json` | Twitch 分 Tier 權益 | 7 |
| `src/features/mining/buffResolver.js` | 擴充 Twitch tier 挖礦 luck / CD 加成（既有檔案） | 7 |
| `src/events/ready/twitchMonthlyTitle.js` | Tier3 每月免費稱號 cron | 7 |
| `src/config/donation_tiers.json` | 抖內方案與回饋 | 8 |
| `src/features/donation/grantDonationPerks.js` | 抖內回饋發放 | 8 |
| `src/httpServer/donationSession.js` | `/api/donation/session` 建立 pending session | 8 |
| `src/httpServer/donationGrant.js` | `/api/donation/grant`（仿 flushChatScore） | 8 |
| `src/events/ready/donationReconcile.js` | 抖內對帳 cron | 8 |

---

## 開發時程總覽

> ✅ Phase 0–5 已開發完成並上線（不再列入待辦）。以下為剩餘工作。

| Phase | 內容 | 預估 | 前置 |
|---|---|---|---|
| 6 | 成長 + 稱號 | 3–4 天 | 1（已完成） |
| 7 | Twitch 訂閱擴充 | 2–3 天 | 1（已完成） |
| 8 | 抖內發放端 | 2–3 天 | 1（已完成）+ website 端 |
| **剩餘合計** | | **7–10 天** | |

> Phase 7 可與其他並行。Phase 8 的付款 / 前端在 bibi-website，需另計入該 repo 工時與商家帳號申請（3–7 工作天）。

_Last updated: 2026-05-27（抖內付款流程改由 bibi-website 執行，bot 僅保留發放端 API）_
