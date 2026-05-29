# 逼逼機器人 — 完整開發企劃書（未實作功能整合版）

> 本文件整合 `PART2_EXPANSION_PLAN.md`（Phase A–G）與 `PART3_SUPPLEMENT_PLAN.md`（Phase S1–S5），
> 並依據 `bibi-bot` 程式碼盤點結果，**僅保留尚未實作的 Phase**。
> 已部分實作、僅需擴充或補強的 Phase（B / E / S1 / S2）已移至 `PLAN_OPTIMIZATION.md`。
>
> 最後更新：2026-05-28

---

## 目錄

1. [文件目的與範圍](#1-文件目的與範圍)
2. [設計原則](#2-設計原則)
3. [前置依賴關係](#3-前置依賴關係)
4. [Phase 8 — 抖內發放系統](#phase-8--抖內發放系統)
5. [Phase A — 公會系統](#phase-a--公會系統)
6. [Phase C — 頻道共鬥 BOSS](#phase-c--頻道共鬥-boss)
7. [Phase D — 農場 / 種植系統](#phase-d--農場--種植系統)
8. [Phase F — 每日市價波動系統](#phase-f--每日市價波動系統)
9. [Phase G — Dashboard 贊助管理後台](#phase-g--dashboard-贊助管理後台)
10. [Phase S3 — 技能樹系統](#phase-s3--技能樹系統)
11. [Phase S4 — 釣魚系統](#phase-s4--釣魚系統)
12. [Phase S5 — 限時活動 / 節日系統](#phase-s5--限時活動--節日系統)
13. [頻道命名規劃](#頻道命名規劃)
14. [開發時程總覽](#開發時程總覽)
15. [新增檔案索引](#新增檔案索引)

---

## 1. 文件目的與範圍

### 1.1 與既有規劃書的關係

| 文件 | 範圍 | 狀態 |
|---|---|---|
| `MINING_SYSTEM_PLAN.md` | Phase 0–8 | Phase 1–7 完成、Phase 8 待開發 |
| `DASHBOARD_PLAN.md` | W0–W6+ | W0 重構中 |
| `PART2_EXPANSION_PLAN.md` | Phase A–G（原文） | 部分被本文件取代 |
| `PART3_SUPPLEMENT_PLAN.md` | Phase S1–S5（原文） | 部分被本文件取代 |
| **`PLAN_INTEGRATED.md`（本文件）** | **未實作的 Phase 整合版** | 主要開發路線 |
| `PLAN_OPTIMIZATION.md` | 已實作功能的優化計畫 | 平行進行 |

### 1.2 既有系統盤點摘要

| 規劃書 Phase | 主題 | 現況 | 歸屬 |
|---|---|---|---|
| Phase 1–7 | 挖礦/打工/合成/地下城/拍賣/稱號/Twitch | ✅ 已上線 | — |
| Phase 8 | 抖內發放 | ❌ 未實作 | 本文件 |
| Phase A | 公會系統 | ❌ 未實作 | 本文件 |
| Phase B | PVP 決鬥 | ⚠️ 已實作（公式不同、缺限制） | `PLAN_OPTIMIZATION.md` |
| Phase C | 頻道共鬥 BOSS | ❌ 未實作 | 本文件 |
| Phase D | 農場/種植 | ❌ 未實作 | 本文件 |
| Phase E | 稱號進階管理 | ⚠️ 週冠換王已有，其餘待補 | `PLAN_OPTIMIZATION.md` |
| Phase F | 每日市價波動 | ✅ 已實作 | 本文件 |
| Phase G | Dashboard 贊助後台 | ❌ 未實作 | 本文件 |
| Phase S1 | 挖礦專屬任務 | ⚠️ 框架完整、任務未定義 | `PLAN_OPTIMIZATION.md` |
| Phase S2 | 排行榜多維度 | ⚠️ 週榜已有、其餘待補 | `PLAN_OPTIMIZATION.md` |
| Phase S3 | 技能樹 | ❌ 未實作 | 本文件 |
| Phase S4 | 釣魚系統 | ❌ 未實作 | 本文件 |
| Phase S5 | 限時活動框架 | ✅ 已實作 | 本文件 |

---

## 2. 設計原則

| 原則 | 說明 |
|---|---|
| **前置依賴明確** | 每個 Phase 都標註所需的既有系統 / 其他 Phase |
| **社群為核心** | 公會 (A)、BOSS (C)、活動 (S5) 優先創造玩家互動 |
| **通膨同步控制** | 每新增一個收入來源，必須同步設計對應的消費出口 |
| **buff 統一彙整** | 所有屬性加成透過 `buffResolver`（見 `PLAN_OPTIMIZATION.md` Opt-5） |
| **設定檔驅動** | 平衡參數放 JSON，不寫死在程式 |
| **命名風格一致** | 頻道名稱維持「地名 / 場所感、五個字」風格 |

---

## 3. 前置依賴關係

```
                     bibi-website
                     ┌──────────┐
                     │ Stripe / │
                     │ 綠界 IPN │
                     └────┬─────┘
                          ▼
                  ┌────────────────┐
                  │ Phase 8 抖內   │ ←─ welfare.json 模式
                  └─┬──────────┬───┘
                    │          │
                    ▼          ▼
        ┌──────────────┐  ┌─────────────────┐
        │ Phase G      │  │ 稱號過期機制     │
        │ Dashboard    │  │ (見 Opt-2)      │
        │ 贊助後台     │  └─────────────────┘
        └──────────────┘

  既有 Phase 1–4
        │
        ▼
  ┌─────────────────────────────────────────────────┐
  │  Opt-5: buffResolver（先做）                    │
  └────┬────────┬────────┬────────┬────────┬───────┘
       ▼        ▼        ▼        ▼        ▼
   Phase A   Phase D  Phase S3  Phase S4  Phase S5
   公會     農場     技能樹    釣魚      限時活動

  既有 Phase 4
        │
        ▼
   Phase C
   BOSS

  既有 Phase 1
        │
        ▼
   Phase F 市價波動
```

**啟動順序建議**：`Phase 8 → G → F → S5 → S4 → D → C → S3 → A`

---

## Phase 8 — 抖內發放系統

> **前置需求**：`bibi-website` Stripe / 綠界 webhook 接收端完成
> **預估時間**：4–5 天
> **定位**：營收主要入口，影響後續 Phase G 的 Dashboard 內容

### 核心機制

- `bibi-website` 收到金流 webhook 後，向 bot 的 httpServer 發送發放請求
- Bot 根據贊助方案發放：金幣、有時效身分組、有時效稱號、永久收藏品
- 找不到對應玩家的紀錄存進 `UnmatchedDonations` 待管理員手動處理
- 所有發放紀錄寫進 `DonationRecords` 供 Phase G 查詢

### 贊助方案範例（最終以 website 配置為準）

| 方案 | 金額 | 發放內容 | 時效 |
|---|---|---|---|
| 小贊助 | 100 NTD | 1,000 幣 | — |
| 中贊助 | 300 NTD | 3,500 幣 + 稱號「逼逼小金主」 | 30 天 |
| 大贊助 | 1,000 NTD | 12,000 幣 + 身分組「贊助者」+ luck +5% buff | 30 天 |
| 至尊贊助 | 3,000 NTD | 40,000 幣 + 永久稱號「逼逼大金主」 | 永久 |

### 指令

| 指令 | 說明 |
|---|---|
| `/贊助` | 顯示贊助連結與方案 |
| `/我的贊助` | 查看個人贊助紀錄、目前有效 buff |
| `/donation-admin redeliver [tx_id]` 🔒 | 管理員手動補發 |
| `/donation-admin unmatched` 🔒 | 查看未對應的贊助紀錄 |

### DB 新增

```js
// donation_records
{
  tx_id:         String,   // 金流交易編號（unique）
  user_id:       String,
  guild_id:      String,
  amount:        Number,   // NTD
  plan_id:       String,
  delivered:     Boolean,
  delivered_at:  Number,
  source:        String,   // 'stripe' | 'ecpay'
  raw_payload:   Object,
}

// unmatched_donations
{
  tx_id:         String,
  amount:        Number,
  raw_payload:   Object,
  status:        String,   // 'pending' | 'resolved' | 'refunded'
  received_at:   Number,
  resolved_by:   String,
  resolved_at:   Number,
}
```

### API（bot httpServer 提供給 website 呼叫）

```
POST /api/v1/donation/webhook
  Body: { tx_id, user_id?, amount, plan_id, source, raw }
  - 若 user_id 缺失 → 寫入 unmatched_donations
  - 若 plan_id 已發放（tx_id 重複）→ idempotent return
  - 否則執行發放

GET  /api/v1/donation/my?user_id=...   個人贊助紀錄
```

### 與現有系統的接點

- **發放幣**：呼叫 `userCoinsCollection` 既有的入帳函式（與 `/領錢`、`/任務` 同模式）
- **身分組權益**：複用 `welfare.json` 的 `tierRoleId` 概念，新增 `donation` tier
- **稱號**：使用 `PLAN_OPTIMIZATION.md` Opt-2 升級後的 `expiresAt` 欄位
- **Buff**：寫入 `UserCoins.activeBuffs`，由 `buffResolver` 自動讀取

---

## Phase A — 公會系統

> **前置需求**：Phase 5（拍賣行）完成 ✅、`PLAN_OPTIMIZATION.md` Opt-5（buffResolver）完成
> **預估時間**：5–7 天
> **定位**：長期留存機制，讓玩家有歸屬感與集體目標

### 核心機制

- 玩家可建立或加入公會，每個公會最多 20 人
- 公會有獨立金庫，成員可自願捐款
- 公會升級解鎖共享 buff，讓所有成員受益
- 每週公會任務：累積挖礦次數、地下城通關數等，完成後集體領獎

### 公會等級與共享 buff

| 等級 | 升級條件（金庫累積） | 共享 buff |
|---|---|---|
| Lv 1（初創） | 0 幣 | 無 |
| Lv 2 | 10,000 幣 | 全員挖礦 qty +1 |
| Lv 3 | 50,000 幣 | 全員打工收入 +10% |
| Lv 4 | 150,000 幣 | 全員地下城體力上限 +1 |
| Lv 5 | 500,000 幣 | 全員挖礦 luck +5%（受 luckCap 限制） |

### 公會任務（每週重置）

| 任務 | 條件 | 獎勵（發給公會金庫） |
|---|---|---|
| 礦業大隊 | 全員本週挖礦合計 ≥ 100 次 | 5,000 幣 |
| 地下探索隊 | 全員本週地下城合計 ≥ 30 次 | 8,000 幣 |
| 賭場聯盟 | 全員本週賭場合計 ≥ 50 局 | 6,000 幣 |

### 指令

| 指令 | 說明 |
|---|---|
| `/公會 建立 [名稱]` | 建立公會，花費 5,000 幣（防濫建） |
| `/公會 加入 [名稱]` | 申請加入，需會長批准 |
| `/公會 資訊` | 查看公會等級、金庫、成員、buff |
| `/公會 捐款 [金額]` | 捐款進公會金庫 |
| `/公會 任務` | 查看本週公會任務進度 |
| `/公會 排行` | 全服公會金庫排行 |

### DB 新增

```js
// guilds_club
{
  guild_club_id: String,
  name:          String,
  leader_id:     String,
  members:       [String],
  treasury:      Number,
  level:         Number,
  created_at:    Number,
}

// guild_club_logs
{
  guild_club_id: String,
  user_id:       String,
  amount:        Number,
  source:        String,   // 'donate' | 'quest_reward' | 'upgrade'
  ts:            Number,
}
```

### 與現有系統的接點

- **公會挖礦次數累計**：讀 `MineLogs` 加總（不重複寫表）
- **金庫流水**：寫進 `CoinTransactions`，source 標 `guild_club`
- **共享 buff**：透過 `buffResolver` 在 luck/ATK/CD 等計算時讀取公會等級
- **任務進度**：複用 `questService` 的進度追蹤介面，新增 `guild` period

---

## Phase C — 頻道共鬥 BOSS

> **前置需求**：Phase 4（地下城）完成 ✅
> **預估時間**：3–4 天
> **定位**：最強的社群活動機制，適合配合實況場合觸發

### 核心機制

- BOSS 定時或由管理員手動在指定頻道刷新
- 全伺服器玩家在限定時間內攻擊 BOSS
- BOSS 有血量，玩家各自造成傷害
- 時間結束時依傷害比例分配獎勵
- BOSS 被擊殺有額外全員獎勵

### BOSS 規格

| 屬性 | 設定 |
|---|---|
| 血量 | 線上人數 × 500（動態） |
| 出現時間 | 每場 30 分鐘 |
| 自動刷新 | 每週六 21:00（配合實況） |
| 手動觸發 | `/boss-admin spawn` 🔒 |

### 傷害計算

```
damage = baseAtk(pickaxe) + rand(10, 50) + luckBonus × 20
// 攻擊消耗 1 點體力（與地下城共用體力池）
// 每位玩家每場 BOSS 最多攻擊 5 次
```

### 獎勵分配

```
totalPool   = BOSS_HP × 0.5
playerShare = floor(myDamage / totalDamage × totalPool)

// 額外：傷害 Top 3 各得稀有素材一份
// 額外：BOSS 被擊殺，全員額外 +100 幣
```

### 指令

| 指令 | 說明 |
|---|---|
| `/攻擊` | 攻擊當前 BOSS |
| `/boss 資訊` | 查看 BOSS 血量、剩餘時間、我的傷害排名 |
| `/boss-admin spawn [名稱] [血量]` 🔒 | 手動召喚 BOSS |

### DB 新增

```js
// boss_events
{
  boss_id:    String,
  guild_id:   String,
  name:       String,
  max_hp:     Number,
  current_hp: Number,
  status:     String,   // 'active' | 'defeated' | 'expired'
  started_at: Number,
  ends_at:    Number,
}

// boss_damage_logs
{
  boss_id: String,
  user_id: String,
  damage:  Number,
  ts:      Number,
}
```

### 與現有系統的接點

- **體力消耗**：直接扣 `MiningProfiles.stamina`（與地下城共用）
- **ATK 計算**：透過 `buffResolver.getEffectiveAtk()`
- **公告頻道**：對應頻道命名 `怪物出沒中`
- **自動排程**：新增 `src/events/ready/bossScheduler.js`

---

## Phase D — 農場 / 種植系統

> **前置需求**：Phase 1（挖礦）✅、Phase 3（合成）✅、Opt-5（buffResolver）
> **預估時間**：3–4 天
> **定位**：被動收入，與挖礦形成「主動 vs 被動」的節奏對比

### 核心機制

- 玩家種下作物，等待數小時後收成
- 挖礦產出的特定礦石可作為「肥料」加速成長
- 農場有地塊上限，需花幣擴充
- 作物成熟後不收成會「爛掉」（強制玩家回來），防止掛機囤積

### 作物種類

| 作物 | 種植成本 | 成熟時間 | 收成 | 爛掉時間 |
|---|---|---|---|---|
| 🥕 紅蘿蔔 | 20 幣 | 2h | 50–80 幣 | 成熟後 4h |
| 🌽 玉米 | 60 幣 | 6h | 150–200 幣 | 成熟後 6h |
| 🍓 草莓 | 150 幣 | 12h | 400–500 幣 | 成熟後 8h |
| 🌹 黑玫瑰 | 500 幣 | 24h | 1,200–1,500 幣 | 成熟後 12h |

### 礦石肥料效果

| 礦石 | 效果 |
|---|---|
| 🪨 石頭 ×3 | 成熟時間 −10% |
| 🔩 鐵礦 ×1 | 成熟時間 −25% |
| 💎 水晶 ×1 | 成熟時間 −40% + 收成上限 +20% |

### 地塊系統

| 地塊數 | 解鎖條件 |
|---|---|
| 2 格（初始） | 免費 |
| 4 格 | 3,000 幣 |
| 6 格 | 10,000 幣 |
| 8 格（上限） | 30,000 幣 |

### 指令

| 指令 | 說明 |
|---|---|
| `/農場` | 查看農場狀態 |
| `/種植 [作物] [地塊]` | 種下作物 |
| `/收成 [地塊]` | 收成 |
| `/施肥 [礦石] [數量] [地塊]` | 加速成長 |
| `/農場擴建` | 購買新地塊 |

### DB 新增

```js
// farm_plots
{
  user_id:       String,
  guild_id:      String,
  plot_index:    Number,
  crop:          String,
  planted_at:    Number,
  ready_at:      Number,
  expires_at:    Number,
  fertilized_by: String,
  status:        String,   // 'growing' | 'ready' | 'rotted'
}
```

### 與現有系統的接點

- **肥料消耗**：扣 `UserInventory` 礦石數量
- **作物產出收入**：透過 `buffResolver.getEffectiveIncomeMultiplier('farm')`
- **爛掉檢查**：新增 `src/events/ready/farmDecayChecker.js`（每小時）

---

## Phase F — 每日市價波動系統

> ✅ **已實作（2026-05-29）**
> - 引擎：`src/features/market/orePriceEngine.js`（seeded random、freeze 當日價、走勢查詢、過期清理）
> - 指令：`/行情`（無參數＝今日全礦石；指定礦石＝近 7 天走勢 + sparkline）→ `src/commands/mining/oreMarket.js`
> - 每日 cron：`src/events/ready/oreMarketScheduler.js`（00:00 freeze + 公告 + 清理）
> - DB：`OreMarketPrices`（date unique，保留 90 天），於 `connectDb.js` 註冊
> - 接點：`/賣礦` 改為先查當日行情、fallback 基礎價；設定放 `mining.json` 的 `oreMarket`
> - 實作差異：實際礦石為 stone/coal/iron/gold/diamond（非企劃示意的 crystal/rainbow）；
>   公告頻道由 `mining.oreMarket.announceChannelId` 設定（未設則略過公告）。
>
> **前置需求**：Phase 1（挖礦 + 賣礦）✅
> **預估時間**：1–2 天
> **定位**：讓囤積礦石有策略意義

### 核心機制

- 每天 00:00 用 seeded random 重新計算各礦石的當日收購價
- 價格在基礎價 ±30% 範圍內浮動
- 在指定頻道每日公告當日行情
- 玩家可用 `/行情` 查看當日礦石價格

### 波動公式

```js
const seed   = parseInt(todayDateString.replace(/-/g, ''))
const rng    = seededRandom(seed)
const factor = 0.7 + rng() * 0.6   // 0.70 ~ 1.30

dailyPrice[ore] = Math.round(basePrice[ore] * factor)
```

### 每日行情公告 Embed 範例

```
📊 今日礦石行情 — 2026-05-27
🪨 石頭   8 → 10 幣  ▲ +25%
🪵 煤炭  20 → 16 幣  ▼ −20%
🔩 鐵礦  60 → 72 幣  ▲ +20%
💎 水晶 200 → 190 幣 ▼ −5%
✨ 彩虹石 800 → 960 幣 ▲ +20%
明日行情將於 00:00 更新
```

### 指令

| 指令 | 說明 |
|---|---|
| `/行情` | 查看今日礦石收購價 |
| `/行情 [礦石]` | 查看特定礦石近 7 天價格走勢 |

### DB 新增

```js
// ore_market_prices
{
  date:   String,   // 'YYYYMMDD'
  prices: { stone, coal, iron, crystal, rainbow }
}
// 保留 90 天供走勢查詢
```

### 與現有系統的接點

- **`/sell` 單價**：原本讀 `mining.json` 基礎價，改為先查 `OreMarketPrices`，沒有則 fallback
- **每日 cron**：新增 `src/events/ready/marketAnnouncer.js`（每日 00:00）
- **公告頻道**：對應頻道命名 `逼逼交易所`

---

## Phase G — Dashboard 贊助管理後台

> **前置需求**：Phase 8 完成、`DASHBOARD_PLAN.md` W4 完成
> **預估時間**：2–3 天
> **定位**：讓管理員不需要下指令就能處理贊助異常、查紀錄

### 功能清單

**贊助紀錄頁（`/admin/donation`）**
- 列出所有贊助紀錄，可依日期、平台、金額篩選
- 顯示：玩家名稱、金額、方案、發放狀態、交易編號
- 可手動補發（對應 `unmatched_donations` collection）
- 匯出 CSV

**Unmatched 處理頁（`/admin/donation/unmatched`）**
- 列出所有「Webhook 來了但找不到 session」的紀錄
- 管理員可搜尋玩家名稱後手動綁定並補發
- 標記已處理 / 已退款

**贊助者清單（`/admin/donation/patrons`）**
- 顯示所有曾贊助過的玩家、累積金額、目前有效的 buff 和身分組
- 頂級贊助者（永久身分組）特別標注

### API（bot httpServer）

```
GET  /api/v1/admin/donation/records
GET  /api/v1/admin/donation/unmatched
POST /api/v1/admin/donation/unmatched/:id/resolve
GET  /api/v1/admin/donation/patrons
GET  /api/v1/admin/donation/stats
```

### 與現有系統的接點

- **API 位置**：bot 的 `src/services/httpServer/` 加路由
- **前端位置**：`bibi-website` 的 `dashboard/app/admin/donation/*`
- **權限**：複用 W0 OAuth admin 判定

---

## Phase S3 — 技能樹系統

> **前置需求**：Phase 1–4 全部完成 ✅、Opt-5（buffResolver）
> **預估時間**：4–6 天
> **定位**：讓花幣有長期方向感，不同玩家有不同的發展路線

### 設計概念

技能樹分三條專業線，玩家可自由分配技能點：

| 專業線 | 風格 | 強化項目 |
|---|---|---|
| ⛏️ 採掘線 | 礦工型 | 挖礦效率、掉落率、礦石市值 |
| ⚔️ 戰鬥線 | 戰士型 | 地下城傷害、體力上限、BOSS 獎勵 |
| 💰 商業線 | 商人型 | 賣礦加成、拍賣手續費減免、打工收入 |

### 技能點取得

- 每次升等獲得 1 點（與現有 `UserLevels` 掛鉤）
- 永久保留，可重置（5,000 幣）
- 最高等級 100，理論上限 100 點

### 採掘線（共 5 個）

| 技能 | 點數 | 效果 | 前置 |
|---|---|---|---|
| 礦石感知 | 1 | luck +3% | — |
| 快速開採 | 2 | CD −10 分鐘 | 礦石感知 |
| 採掘專精 | 3 | 石頭/煤炭掉落數 +1 | 快速開採 |
| 稀礦直覺 | 4 | 鐵礦以上機率 +5% | 採掘專精 |
| 彩虹共鳴 | 5 | 彩虹石機率 ×1.5 | 稀礦直覺 |

### 戰鬥線（共 5 個）

| 技能 | 點數 | 效果 | 前置 |
|---|---|---|---|
| 鬥志覺醒 | 1 | 地下城基礎 ATK +10 | — |
| 體能強化 | 2 | 體力上限 +2 | 鬥志覺醒 |
| 致命一擊 | 3 | 10% 機率雙倍傷害 | 體能強化 |
| BOSS 剋星 | 4 | BOSS 傷害 +20% | 致命一擊 |
| 不死鬥魂 | 5 | 地下城失敗不消耗體力 | BOSS 剋星 |

### 商業線（共 5 個）

| 技能 | 點數 | 效果 | 前置 |
|---|---|---|---|
| 市場嗅覺 | 1 | 賣礦收入 +5% | — |
| 談判技巧 | 2 | 打工收入 +15% | 市場嗅覺 |
| 拍賣達人 | 3 | 拍賣手續費 −1% | 談判技巧 |
| 大宗貿易 | 4 | 賣礦收入 +10%（累計 +15%） | 拍賣達人 |
| 壟斷市場 | 5 | 每日第一次賣礦 ×2 | 大宗貿易 |

### 指令

| 指令 | 說明 |
|---|---|
| `/技能樹` | 查看三線技能圖與點數 |
| `/技能 點 [技能名]` | 解鎖技能 |
| `/技能 重置` | 重置（5,000 幣） |
| `/技能 資訊 [技能名]` | 查看技能細節 |

### DB 新增

```js
// user_skills
{
  user_id:      String,
  guild_id:     String,
  skill_points: Number,
  unlocked:     [String],
  reset_count:  Number,
  updated_at:   Number,
}
```

### 設定檔（`src/config/skill_tree.json`）

```json
{
  "mining": [
    { "id": "ore_sense",     "cost": 1, "requires": null,             "effect": { "luck": 0.03 } },
    { "id": "fast_mine",     "cost": 2, "requires": "ore_sense",      "effect": { "cdReductionMs": 600000 } },
    { "id": "mine_mastery",  "cost": 3, "requires": "fast_mine",      "effect": { "commonQtyBonus": 1 } },
    { "id": "rare_instinct", "cost": 4, "requires": "mine_mastery",   "effect": { "rareLuck": 0.05 } },
    { "id": "rainbow_bond",  "cost": 5, "requires": "rare_instinct",  "effect": { "rainbowMultiplier": 1.5 } }
  ],
  "combat": [ ... ],
  "trade":  [ ... ]
}
```

### 與現有系統的接點

- **技能效果整合**：新增 `src/features/skill/skillResolver.js`，被 `buffResolver` 呼叫
- **升等發點**：在 `UserLevels` 升等事件 hook 增加 `skill_points`
- **重置費用**：扣 `UserCoins`

---

## Phase S4 — 釣魚系統

> **前置需求**：Phase 1（挖礦架構）✅、Opt-5（buffResolver）
> **預估時間**：2–3 天
> **定位**：第二條生產線

### 設計概念

- 釣魚與挖礦平行，CD 2.5 小時
- 魚類可直接賣錢，也可合成 buff 食物
- 不需要「釣竿升級」，但釣魚地點影響魚種

### 釣魚地點

| 地點 | 解鎖 | 特色 |
|---|---|---|
| 🏞️ 溪流 | 預設 | 常見魚為主 |
| 🌊 海邊 | Lv 15 | 稀有海魚機率較高 |
| 🔥 熔岩湖 | Lv 40 | 限定傳說魚 |

### 魚類掉落表

| 魚 | 稀有度 | 溪流 | 海邊 | 熔岩 | 收購價 |
|---|---|---|---|---|---|
| 🐟 小雜魚 | 普通 | 50% | 30% | 10% | 5 幣 |
| 🎣 鯽魚 | 普通 | 30% | 25% | 15% | 15 幣 |
| 🦈 鯊魚 | 稀有 | 12% | 25% | 20% | 60 幣 |
| 🐙 章魚 | 稀有 | 6% | 15% | 20% | 150 幣 |
| 🐉 熔岩魚 | 傳說 | 2% | 5% | 35% | 600 幣 |

### 食物合成（`/cook`）

| 食物 | 材料 | 效果 | 持續時間 |
|---|---|---|---|
| 🍱 魚排便當 | 鯽魚 ×3 | 打工收入 +20% | 2 小時 |
| 🍜 鯊魚麵 | 鯊魚 ×2 + 小雜魚 ×5 | 地下城 ATK +20 | 3 小時 |
| 🍱 章魚飯 | 章魚 ×1 | 挖礦 luck +10% | 2 次挖礦 |
| 🔥 熔岩鍋 | 熔岩魚 ×1 + 鯊魚 ×1 | 全屬性 +10% | 1 小時 |

### 指令

| 指令 | 說明 |
|---|---|
| `/fish [地點]` | 釣魚（預設溪流） |
| `/fish-bag` | 查看魚類背包 |
| `/cook [食物]` | 合成食物 |
| `/sell-fish [魚] [數量]` | 賣魚 |
| `/buff` | 查看所有有效 buff |

### DB 異動

```js
// 加在現有 user 文件
{
  fish_cooldown_at: Number,
  fish_bag: { small_fish, crucian, shark, octopus, lava_fish },
  active_food_buffs: [ { type, value, expires_at } ]
}
```

### 與現有系統的接點

- **抽獎邏輯**：複用 `grantMiningDrop` 的 weighted random
- **食物 buff**：寫入 `UserCoins.activeBuffs`，由 `buffResolver` 讀取
- **`/buff` 指令**：呼叫 `buffResolver.summary()` 列出所有來源

---

## Phase S5 — 限時活動 / 節日系統

> ✅ **已實作（2026-05-29）**
> - 設定：`src/config/events.json`（`eventSystem`：enabled / timezone / announceChannelId /
>   scanCronSchedule / announceEndGraceMinutes / events[]），合併進 `config/index.js`。
> - 框架核心：`src/features/event/eventEngine.js`（生效視窗判定、限定礦石注入、挖礦
>   luck/qty 加成彙整、限定任務注入、force-start/force-end 進程內覆寫、狀態標籤）。
> - 排程：`src/events/ready/eventScheduler.js`（每分鐘掃描，活動開始/結束各發一次公告，
>   靠 `EventAnnouncements` 的 (eventId, phase, occurrence) unique 去重 + 結束寬限窗）。
> - DB：`EventAnnouncements`（unique 去重 + createdAt TTL 400 天），於 `connectDb.js` 註冊。
> - 接點：
>   - 掉落注入 → `dropTable.js` 改讀 `eventEngine.getEffectiveOreDefs()`；
>   - buff 注入 → `mining/buffResolver.js` 疊加活動 luck/qty（獨立於 luckCap，與抖內同）；
>   - 任務注入 → `questDefinitions`/`questService` 支援 `evt-<id>` 週期，`/逼幣任務` 顯示
>     「限時活動任務」區塊，`/挖礦` 動態併入 `mine_count` 型活動任務 hook；
>   - 顯示 → `/挖礦`、`/賣礦`（限定礦石可正常賣出、活動結束後仍可賣）、`/加成` 列出生效活動。
> - 管理指令：`/活動管理`（列表 / 預覽 / 強制開始 / 強制結束 / 清除強制，皆 ADMIN）。
> - 實作差異：活動定義改為單一 `events.json` 陣列（非企劃示意的每活動一檔），與既有
>   `questSystem`/`stockSystem` 設定風格一致；force-start/force-end 為進程內覆寫（重啟失效）。
>
> **前置需求**：Phase 1–3 ✅、Opt-5（buffResolver）
> **預估時間**：3–4 天（框架）；每次活動內容 0.5–1 天
> **定位**：製造稀缺感與話題

### 設計概念

限時活動是**框架系統**，開發一次後每次新活動只需填設定檔。

活動類型：
- **限定礦石**：特定期間新增一種限定礦石進掉落表
- **限定裝備**：特定期間限定合成配方
- **加倍週末**：全員 luck / qty 加成
- **活動任務**：期間限定的 `quest_event` 任務

### 活動範例

| 活動 | 觸發 | 內容 |
|---|---|---|
| 🎄 聖誕挖礦節 | 12/24–26 | 限定礦石「❄️ 雪晶石」加入掉落（5%），500 幣 |
| 🎆 新年大爆發 | 1/1 | 全員挖礦 luck +10%（24h） |
| 🐉 農曆新年 | 農曆初一 | 限定任務：挖礦 10 次得「紅包幣 × 1,000」 |
| 🎃 萬聖節 | 10/31 | 「🕷️ 詛咒石」加入，高風險高報酬 |
| 📺 實況週年 | 自訂 | 全員 +200 幣 + 限定稱號「週年見證者」 |

### 活動設定檔（`src/config/events/christmas_2026.json`）

```json
{
  "id":      "christmas_2026",
  "name":    "🎄 聖誕挖礦節",
  "startAt": "2026-12-24T00:00:00+08:00",
  "endAt":   "2026-12-27T00:00:00+08:00",
  "effects": {
    "extraOre": {
      "id": "snow_crystal", "emoji": "❄️", "name": "雪晶石",
      "weight": 5, "price": 500, "qty": 1
    }
  },
  "quests": [
    {
      "id":   "event_xmas_mine",
      "name": "聖誕礦工",
      "condition": { "type": "mine_count", "target": 10 },
      "reward": 500
    }
  ],
  "announceChannelId": "CHANNEL_ID",
  "announcementText": "🎄 聖誕挖礦節開始！雪晶石已出現..."
}
```

### 框架核心邏輯（`src/features/event/eventEngine.js`）

```js
const activeEvents = await getActiveEvents()
for (const event of activeEvents) {
  if (event.effects.extraOre) dropTable.injectOre(event.effects.extraOre)
  if (event.effects.luckBonus) buffResolver.injectEventLuck(event.effects.luckBonus)
}
```

### 管理員指令

| 指令 | 說明 |
|---|---|
| `/event-admin list` 🔒 | 查看所有活動 |
| `/event-admin preview [活動ID]` 🔒 | 預覽活動效果 |
| `/event-admin force-start [活動ID]` 🔒 | 強制開始（測試用） |
| `/event-admin force-end [活動ID]` 🔒 | 強制結束 |

### 與現有系統的接點

- **挖礦掉落注入**：在 `/mine` 計算掉落表前呼叫 `eventEngine.applyDropOverrides()`
- **buff 注入**：透過 `buffResolver` 讀活動效果
- **任務注入**：`questService` 載入時合併 `event.quests`
- **排程**：新增 `src/features/event/eventScheduler.js`（每分鐘掃設定檔）

---

## 頻道命名規劃

> 風格原則：地名 / 場所感、五個字、有故事感

### 新增頻道

| 功能 | 頻道名 | 包含指令 |
|---|---|---|
| 挖礦 + 打工 + 鍛造 | **財富牢改城** | `/mine` `/work` `/craft` |
| 地下城 + 決鬥 + BOSS | **暗黑競技場** | `/dungeon` `/duel` `/攻擊` |
| 農場 + 釣魚 | **田園採集所** | `/farm` `/fish` |
| 拍賣行 + 贈送 | **上海拍賣行** | `/auction` `/give` |
| 公會 | **江湖幫派堂** | `/公會` |
| 行情公告 | **逼逼交易所** | 每日行情自動公告 |
| BOSS 出現公告 | **怪物出沒中** | BOSS 刷新公告 |
| 稱號 / 成就公告 | **名人堂走廊** | 成就解鎖自動公告 |
| 贊助引導 | **皇家贊助廳** | `/贊助` 連結引導 |
| 週排行榜公告 | **逼逼排行榜** | 每週一自動公告 |
| 限時活動公告 | **逼逼特報站** | 活動開始 / 結束公告 |

### Category 結構建議

```
📁 財富牢改城（生產）
  # 財富牢改城
  📢 逼逼交易所

📁 競技場
  # 暗黑競技場
  📢 怪物出沒中

📁 採集
  # 田園採集所

📁 市場
  # 上海拍賣行

📁 公會
  # 江湖幫派堂

📁 公告區（唯讀）
  📢 名人堂走廊
  📢 逼逼排行榜
  📢 逼逼特報站
  📢 皇家贊助廳
```

---

## 開發時程總覽

| Phase | 內容 | 時間 | 前置 | 狀態 |
|---|---|---|---|---|
| Phase 8 | 抖內發放 | 4–5 天 | website webhook | ✅ 已完成 |
| Phase G | Dashboard 贊助後台 | 2–3 天 | Phase 8 + Dashboard W4 | ⏳ bibi-website |
| Phase F | 每日市價波動 | 1–2 天 | Phase 1 | ✅ 已完成（2026-05-29） |
| Phase S5 | 限時活動框架 | 3–4 天 | Phase 1–3、Opt-5 | ✅ 已完成（2026-05-29） |
| Phase S4 | 釣魚系統 | 2–3 天 | Phase 1、Opt-5 | ⬜ 待開發 |
| Phase D | 農場 / 種植 | 3–4 天 | Phase 1, 3、Opt-5 | ⬜ 待開發 |
| Phase C | 頻道共鬥 BOSS | 3–4 天 | Phase 4 | ⬜ 待開發 |
| Phase S3 | 技能樹 | 4–6 天 | Phase 1–4、Opt-5 | ⬜ 待開發 |
| Phase A | 公會系統 | 5–7 天 | Phase 5、Opt-5 | ⬜ 待開發 |
| **合計** | | **27–38 天** | | |

**建議啟動順序**：`Phase 8 → G → F → S5 → S4 → D → C → S3 → A`

理由：
- Phase 8 / G 直接影響營收
- Phase F / S5 開發成本最低、增加日常活躍
- Phase S4 / D 是新生產線，需平衡測試
- Phase C / A 影響社群結構，放後段
- Phase S3 技能樹複雜度最高，最後

---

## 新增檔案索引

| 檔案 | 內容 | Phase |
|---|---|---|
| `src/features/donation/donationService.js` | 抖內發放核心邏輯 | 8 |
| `src/features/donation/webhookHandler.js` | 接收 website webhook | 8 |
| `src/services/httpServer/donationRoutes.js` | 贊助相關 API 路由 | 8, G |
| `src/commands/donation/donate.js` | `/贊助`、`/我的贊助` | 8 |
| `src/commands/donation/donationAdmin.js` | `/donation-admin` | 8 |
| `src/features/guild_club/guildClubService.js` | 公會核心邏輯 | A |
| `src/features/guild_club/guildClubQuest.js` | 公會每週任務 | A |
| `src/commands/guild_club/guild.js` | `/公會` 指令群 | A |
| `src/features/boss/bossEngine.js` | BOSS 血量 / 攻擊 / 獎勵 | C |
| `src/events/ready/bossScheduler.js` | BOSS 定時刷新 | C |
| `src/commands/boss/attack.js` | `/攻擊` `/boss 資訊` | C |
| `src/commands/boss/bossAdmin.js` | `/boss-admin` | C |
| `src/features/farm/farmService.js` | 農場種植 / 收成 / 施肥 | D |
| `src/events/ready/farmDecayChecker.js` | 爛掉檢查 cron | D |
| `src/commands/farm/farm.js` | 農場指令群 | D |
| `src/features/market/orePriceEngine.js` | 礦石每日市價計算 | F |
| `src/events/ready/marketAnnouncer.js` | 每日行情公告 cron | F |
| `src/commands/market/marketPrice.js` | `/行情` 指令 | F |
| `src/config/skill_tree.json` | 技能樹定義 | S3 |
| `src/features/skill/skillService.js` | 技能點管理 | S3 |
| `src/features/skill/skillResolver.js` | 技能效果整合進 buffResolver | S3 |
| `src/commands/skill/skill.js` | `/技能樹` `/技能` 指令 | S3 |
| `src/config/fishing.json` | 釣魚設定 | S4 |
| `src/features/fishing/fishService.js` | 釣魚核心 | S4 |
| `src/features/fishing/cookService.js` | 食物合成 | S4 |
| `src/commands/fishing/fish.js` | `/fish` 等指令 | S4 |
| `src/commands/fishing/buff.js` | `/buff` 統一查詢 | S4 |
| `src/config/events.json` | 活動定義（eventSystem.events 陣列） | S5 |
| `src/features/event/eventEngine.js` | 活動框架核心 | S5 |
| `src/events/ready/eventScheduler.js` | 活動開始/結束公告 cron | S5 |
| `src/commands/event/eventAdmin.js` | `/活動管理` | S5 |

---

_Last updated: 2026-05-28_
