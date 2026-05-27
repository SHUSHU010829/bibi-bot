# 逼逼機器人 — 挖礦生態系統開發規劃書（bibi-bot）

> 本文件規劃 bibi-bot 端的「挖礦生態系統」「打工 / 補助」「裝備合成」「地下城」「拍賣行」「稱號」「Twitch 訂閱者權益」，以及**抖內（贊助）的「發放端」**。
>
> **重要架構決策**：抖內的付款流程（Discord OAuth、建立 session、導向綠界 / 歐付寶、接收與驗證 webhook）整段搬到 **bibi-website** 執行；bibi-bot 只負責「Discord 端效果」——加身分組、發金幣、發消耗品、DM、公告，並透過一支內部 API 被 website 呼叫。詳見 [Phase 8](#phase-8--抖內發放端bibi-bot) 與 [API 介接契約](#api-介接契約)。
>
> 各階段皆為獨立可上線的完整功能，可依進度逐步推出。
>
> 最後更新：2026-05-27

---

## 目錄

1. [設計原則](#1-設計原則)
2. [與現有程式碼的對齊](#2-與現有程式碼的對齊)
3. [金幣數值總表](#3-金幣數值總表)
4. [Phase 0 — 前置準備](#phase-0--前置準備)
5. [Phase 1 — 核心挖礦系統（MVP）](#phase-1--核心挖礦系統mvp)
6. [Phase 2 — 打工 + 補助指令調整](#phase-2--打工--補助指令調整)
7. [Phase 3 — 裝備合成系統](#phase-3--裝備合成系統)
8. [Phase 4 — 地下城 + 戰鬥](#phase-4--地下城--戰鬥)
9. [Phase 5 — 社交 + 拍賣行](#phase-5--社交--拍賣行)
10. [Phase 6 — 成長 + 稱號系統](#phase-6--成長--稱號系統)
11. [Phase 7 — Twitch 訂閱者權益擴充](#phase-7--twitch-訂閱者權益擴充)
12. [Phase 8 — 抖內發放端（bibi-bot）](#phase-8--抖內發放端bibi-bot)
13. [API 介接契約](#api-介接契約)
14. [每日收入藍圖](#每日收入藍圖全系統上線後)
15. [風控與通膨防護](#風控與通膨防護)
16. [檔案索引](#檔案索引)
17. [開發時程總覽](#開發時程總覽)

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

## Phase 0 — 前置準備

> **目標**：Schema 與共用工具到位。**預估**：1–2 天。

### 資料庫異動

延伸 `UserCoins`（或新建 `MiningProfiles`，建議延伸既有 user 文件以共用 `userId+guildId` 索引）：

```js
{
  mine_cooldown_at:    Number,  // timestamp ms，預設 0
  pickaxe:             String,  // 'wood' | 'iron' | 'crystal'，預設 'wood'
  pickaxe_durability:  Number,  // 預設 50（木鎬不消耗）
  luck_potion_uses:    Number,  // 預設 0
  mine_count_total:    Number,  // 預設 0
  backpack: { stone:Number, coal:Number, iron:Number, crystal:Number, rainbow:Number }
}
```

新增 collection（於 `connectDb.js` 建立並掛 `client.<name>Collection`）：

```js
// mine_logs — 挖礦記錄（成就 / 排行榜用），TTL 90 天（與 CoinTransactions 對齊）
{ user_id, guild_id, ore, qty, ts }
// titles — 稱號持有記錄（Phase 6 用，先建好）
{ user_id, guild_id, title_id, granted_at, expires_at /* null=永久 */ }
```

### 共用工具

- `src/features/mining/weightedRandom.js` — 加權隨機
- `src/features/mining/dropTable.js` — 礦石掉落表與 luck 調整
- `src/features/mining/buffResolver.js` — 整合鎬子 / 藥水 / 連簽 / Twitch tier 的 buff 計算

### 設定檔 `src/config/mining.json`

```json
{
  "cooldownMs": 7200000,
  "luckCap": 0.25,
  "ores": {
    "stone":   { "weight": 55, "price": 8,   "minQty": 1, "maxQty": 3 },
    "coal":    { "weight": 25, "price": 20,  "minQty": 1, "maxQty": 2 },
    "iron":    { "weight": 12, "price": 60,  "minQty": 1, "maxQty": 1 },
    "crystal": { "weight": 6,  "price": 200, "minQty": 1, "maxQty": 1 },
    "rainbow": { "weight": 2,  "price": 800, "minQty": 1, "maxQty": 1 }
  },
  "pickaxes": {
    "wood":    { "cdReductionMs": 0,       "luckBonus": 0,    "qtyBonus": 0, "durability": null },
    "iron":    { "cdReductionMs": 1800000, "luckBonus": 0.05, "qtyBonus": 0, "durability": 50  },
    "crystal": { "cdReductionMs": 3600000, "luckBonus": 0.12, "qtyBonus": 1, "durability": 50  }
  }
}
```

---

## Phase 1 — 核心挖礦系統（MVP）

> **目標**：最小可玩版本。**預估**：2–3 天。**新增收入**：勤勞玩家每天 +240–400 幣。

### 指令

| 指令 | 說明 |
|---|---|
| `/mine` | 主挖礦指令，含 CD 檢查、掉落、結果 Embed |
| `/backpack` | 查看背包礦石庫存 |
| `/sell [礦石] [數量]` | 賣給系統換幣，不填則賣全部 |

### 核心邏輯（`src/features/mining/mineCommand.js`）

```
1. CD 檢查 → 未到時間回傳剩餘分鐘
2. buffResolver → 算 luckBonus、qtyBonus、actualCD（含 Twitch tier）
3. dropTable.roll(luckBonus) → 決定礦石種類
4. randQty(ore, qtyBonus) → 決定數量
5. DB 更新：backpack[ore]+=qty、mine_cooldown_at=now+actualCD、mine_count_total+=1、mine_logs.insert
6. setImmediate → 非同步觸發成就檢查（Phase 6）
7. 回傳結果 Embed（彩虹石另發特殊 Embed + 頻道公告「全服第 N 位挖到彩虹石」）
```

### `/sell` 邏輯

```
price = Σ(ore_price × qty)
await grantCoins(client, { userId, guildId, amount: price, source: 'mining_sell', member })
扣背包 → 回傳賣出明細與餘額
```

### 消費出口（同步上線）

- 挖礦商店道具加入既有 `/商店`：幸運藥水 300 幣、CD 縮短券 150 幣。

---

## Phase 2 — 打工 + 補助指令調整

> **目標**：穩定收入管道 + 救濟金改名。**預估**：1 天。**新增收入**：打工每天最多 +720 幣。

### 打工（`/work`）

```
1. CD 檢查（4h，work_cooldown_at）
2. 隨機 job 文字（src/config/work_jobs.json）
3. 隨機金額 80–120
4. await grantCoins(client, { ..., amount, source: 'work', member })
5. 更新 work_cooldown_at
6. 回傳 Embed
```

`src/config/work_jobs.json` 範例：

```json
["幫人搬家，搬了三層樓的傢俱","在便利商店站了一班收銀台","幫鄰居遛了兩隻柴犬","在夜市擺了三小時臭豆腐攤","接了個前端外包，改了五個按鈕顏色"]
```

DB 新增 `work_cooldown_at: Number`（預設 0）。

### 補助指令（原救濟金）

- 指令名 `/救濟金` → `/補助`，邏輯 / 數值 / 門檻**完全不變**，只改名與 Embed 文字。舊指令加 deprecated 提示，保留 30 天後移除。

---

## Phase 3 — 裝備合成系統

> **目標**：礦石第二條出路，形成「囤積 vs 賣出」策略。**預估**：2–3 天。

### 指令

| 指令 | 說明 |
|---|---|
| `/craft [裝備]` | 合成裝備，自動消耗背包材料 |
| `/equipment` | 查看持有裝備與耐久 |

### 配方 `src/config/craft_recipes.json`

```json
[
  { "id":"pickaxe_iron","name":"鐵鎬","emoji":"🔨","materials":{"iron":15},"result":{"type":"pickaxe","id":"iron"} },
  { "id":"pickaxe_crystal","name":"水晶鎬","emoji":"💎","materials":{"crystal":5,"iron":20},"result":{"type":"pickaxe","id":"crystal"} }
]
```

### 邏輯與耐久

```
1. 確認材料足夠 → 扣礦石 → 更新 pickaxe + pickaxe_durability
2. 已持有同級未用完 → 提示確認
3. craft_count_total += 1（成就用）
每次成功挖礦 pickaxe_durability -= 1；歸 0 → 退回 'wood' 並 DM 提示。
```

DB 新增 `craft_count_total: Number`（預設 0）。

---

## Phase 4 — 地下城 + 戰鬥

> **目標**：裝備有處可用，高風險 / 報酬玩法。**預估**：4–6 天（最複雜）。

### 指令

| 指令 | 說明 |
|---|---|
| `/dungeon` | 進地下城，消耗體力戰鬥 |
| `/duel @玩家 [賭注]` | 1v1 決鬥 |

### 體力與戰鬥

- 體力上限 10，每小時回 1；進地下城耗 1，0 不可進。
- 簡化判定：`勝率 = clamp(playerAtk / monsterHp, 0.2, 0.9)`，`monsterHp` 隨機 50–200。
- 裝備 ATK 加成：木鎬 +0 / 鐵鎬 +15 / 水晶鎬 +35。
- 勝利掉落（比挖礦期望值高 30%）：

| 掉落物 | 機率 | 說明 |
|---|---|---|
| 稀有礦石碎片 | 40% | 可合成鐵礦 ×3 |
| 直接金幣 | 35% | 150–300 幣（`grantCoins` source `dungeon`） |
| 傳說素材碎片 | 15% | 未來裝備用（預留） |
| 什麼都沒有 | 10% | — |

> 直接金幣若要列入收入監控，可新增 `dungeon` source 並比照 `FLAT_REWARD_SOURCES`。

DB 新增 `stamina`、`stamina_updated_at`、`dungeon_count`。

---

## Phase 5 — 社交 + 拍賣行

> **目標**：貨幣在玩家間流動，稀有石二級市場。**預估**：3–4 天。

### 指令

| 指令 | 說明 |
|---|---|
| `/give @玩家 [礦石] [數量]` | 贈送礦石 |
| `/auction list` | 查看拍賣中物品 |
| `/auction sell [礦石] [數量] [起標價]` | 掛牌 |
| `/auction bid [拍賣ID] [出價]` | 出價 |

### 規則

- 掛牌 24h；到期無人出價自動退回（不收費）。
- 成交系統抽 **5% 手續費**（通膨回收）。每人同時最多掛 5 件。
- 最低起標 = 收購價 × 0.8。
- `/give` 無手續費、每日每人最多 3 次、不能送自己。
- 金幣流動走既有 peer transfer source（`transfer_in` / `transfer_out`）；拍賣出價走 `auction_bid`（已在 `SINK_SOURCES`）。

### DB 新增 `auction_listings`

```js
{ listing_id, seller_id, guild_id, ore, qty, start_price, current_bid, bidder_id, expires_at, status }
// status: 'active' | 'sold' | 'expired'，TTL 7 天（結束後保留供查詢）
```

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

> **目標**：訂閱者在遊戲中有實質差異。**前置**：Phase 1。**預估**：2–3 天。

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
> **前置**：Phase 1。**預估**：2–3 天（不含 website）。

### 職責邊界

bibi-bot **只**做：收到 website 的發放呼叫 → 依方案加身分組、`grantCoins`、發消耗品、DM 收據、頻道公告、寫 `donation_records`（冪等）。
bibi-bot **不**做：OAuth、建立 session、產 `MerchantTradeNo`、接金流 webhook、驗章解密。

### 8.1 內部 API：`POST /api/donation/grant`

於 `src/httpServer/index.js` 註冊，handler 仿 `flushChatScore.js`：

```js
// src/httpServer/donationGrant.js
module.exports = (client) => async (req, res) => {
  // 1. Bearer 驗證：req.authorization === process.env.DONATION_GRANT_SECRET，否則 401
  // 2. 解析 body：{ userId, guildId, amountNtd, tierId, platform, tradeNo, merchantTradeNo }
  // 3. 冪等：client.donationRecordsCollection.findOne({ trade_no: tradeNo })
  //    若存在 → return res.json({ ok:true, alreadyGranted:true, perks:exists.perks })
  // 4. const perks = await grantDonationPerks(client, { userId, guildId, amountNtd, tierId, platform })
  // 5. 同一筆動作寫兩處（金錢相關寫入由 bot 單一權威來源負責，避免與 website 競寫）：
  //    a. donation_records.insertOne（trade_no unique）
  //    b. donation_sessions.updateOne({ merchant_trade_no }, { $set:{ status:'completed' } })
  //    （MongoDB 可用 session/transaction 包起來，確保兩寫一致）
  // 6. return res.json({ ok:true, alreadyGranted:false, perks })
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

> `donation_sessions` 由 **website 建立**（pending），其 `status` 在發放完成時由 **bot 的 grant API 翻成 `completed`**（與 `donation_records` 同一筆動作寫入，見 8.1）。`unmatched_donations` 由 website 寫入。三者皆在同一個共用 MongoDB；完整 schema 見 [API 介接契約](#api-介接契約)。

### 8.5 Discord 指令

| 指令 | 說明 |
|---|---|
| `/贊助` | 回傳 `donate` 網址（bibi-website），引導前往 |
| `/贊助紀錄` | 讀 `donation_records` 顯示個人歷史與目前 buff |
| `/donation-admin grant @玩家 金額 平台` 🔒 | 管理員手動補發（對應 website 寫入的 `unmatched_donations`） |

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

### 跨服務呼叫：website → bot

**`POST {BOT_API_BASE_URL}/api/donation/grant`**

- Header：`Authorization: Bearer <DONATION_GRANT_SECRET>`、`Content-Type: application/json`
- Request body：

```json
{
  "userId": "Discord 使用者 ID",
  "guildId": "主 guild ID",
  "amountNtd": 500,
  "tierId": "large",
  "platform": "ecpay",
  "tradeNo": "平台交易編號（冪等鍵）",
  "merchantTradeNo": "DON+sessionId 前段"
}
```

- Response 200：

```json
{ "ok": true, "alreadyGranted": false,
  "perks": { "coins": 6000, "roleId": "...", "items": {"cd_ticket":0}, "luck": 0.08, "theme": "theme_donor", "title": "custom_30d" } }
```

- 行為：bot 以 `tradeNo` 查 `donation_records` 做**冪等**——已存在則回 `alreadyGranted:true` 且不重複發放；否則發放後**在同一筆動作**寫 `donation_records` 並把 `donation_sessions`（以 `merchantTradeNo` 對應）`status` 翻為 `completed`。
- 錯誤碼：`401` Bearer 不符、`400` 參數錯誤、`503` bot 未就緒或 DB 未掛載（website 收到非 2xx 應重試或寫 `unmatched_donations`）。

### 共用 MongoDB collection 擁有權

| collection | 寫入方 | 讀取方 | 備註 |
|---|---|---|---|
| `donation_sessions` | website（建立 pending）／ bot grant API（翻 completed） | website / bot 對帳 cron | `{ session_id, merchant_trade_no(unique), user_id, guild_id, amount_ntd, platform, status('pending'\|'completed'\|'expired'), created_at }`，pending TTL 30 分 |
| `donation_records` | bot（grant API） | bot / website | `{ user_id, guild_id, amount_ntd, tier_id, platform, trade_no(unique), granted_at, perks }`，永久 |
| `unmatched_donations` | website webhook | bot 管理指令 | `{ platform, data, ts, resolved }` |
| `UserCoins` / `CoinTransactions` | bot | bot / website（讀） | 既有經濟資料 |

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

| 檔案 | 內容 | Phase |
|---|---|---|
| `src/config/mining.json` | 挖礦設定 | 0 |
| `src/config/work_jobs.json` | 打工文字 | 2 |
| `src/config/craft_recipes.json` | 合成配方 | 3 |
| `src/config/twitch_perks.json` | Twitch 分 Tier 權益 | 7 |
| `src/config/donation_tiers.json` | 抖內方案與回饋 | 8 |
| `src/features/mining/weightedRandom.js` | 加權隨機 | 0 |
| `src/features/mining/dropTable.js` | 掉落表與 luck | 0 |
| `src/features/mining/buffResolver.js` | buff 整合（含 Twitch） | 0 → 7 |
| `src/features/mining/mineCommand.js` | `/mine` | 1 |
| `src/features/mining/sellCommand.js` | `/sell` | 1 |
| `src/features/mining/craftCommand.js` | `/craft` | 3 |
| `src/features/mining/achievementChecker.js` | 成就檢查 | 6 |
| `src/features/mining/titleManager.js` | 稱號 + 身分組同步 | 6 |
| `src/features/work/workCommand.js` | `/work` | 2 |
| `src/features/auction/auctionService.js` | 拍賣行 | 5 |
| `src/features/donation/grantDonationPerks.js` | 抖內回饋發放 | 8 |
| `src/httpServer/donationGrant.js` | `/api/donation/grant`（仿 flushChatScore） | 8 |
| `src/events/ready/miningWeeklyRank.js` | 週排行榜 cron | 6 |
| `src/events/ready/twitchMonthlyTitle.js` | Tier3 每月免費稱號 cron | 7 |
| `src/events/ready/donationReconcile.js` | 抖內對帳 cron | 8 |

---

## 開發時程總覽

| Phase | 內容 | 預估 | 前置 |
|---|---|---|---|
| 0 | 前置 / Schema | 1–2 天 | — |
| 1 | 核心挖礦 MVP | 2–3 天 | 0 |
| 2 | 打工 + 補助改名 | 1 天 | 0 |
| 3 | 裝備合成 | 2–3 天 | 1 |
| 4 | 地下城 + 戰鬥 | 4–6 天 | 3 |
| 5 | 社交 + 拍賣行 | 3–4 天 | 1 |
| 6 | 成長 + 稱號 | 3–4 天 | 1 |
| 7 | Twitch 訂閱擴充 | 2–3 天 | 1 |
| 8 | 抖內發放端 | 2–3 天 | 1 + website 端 |
| **合計** | | **20–29 天** | |

> Phase 2、7 可與其他並行。Phase 8 的付款 / 前端在 bibi-website，需另計入該 repo 工時與商家帳號申請（3–7 工作天）。

_Last updated: 2026-05-27（抖內付款流程改由 bibi-website 執行，bot 僅保留發放端 API）_
