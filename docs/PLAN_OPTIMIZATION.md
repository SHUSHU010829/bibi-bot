# 逼逼機器人 — 既有功能優化計畫

> 本文件收錄 `PART2_EXPANSION_PLAN.md` 與 `PART3_SUPPLEMENT_PLAN.md` 中
> **已部分實作、需要擴充或補強**的項目，加上程式碼盤點時主動發現的優化機會。
>
> 與 `PLAN_INTEGRATED.md`（未實作功能）平行進行，不需互相等待。
>
> 最後更新：2026-05-28

---

## 目錄

1. [文件目的](#1-文件目的)
2. [Opt-1：決鬥系統公式與限制重做（Phase B）](#opt-1決鬥系統公式與限制重做phase-b)
3. [Opt-2：稱號進階管理（Phase E）](#opt-2稱號進階管理phase-e)
4. [Opt-3：挖礦專屬任務埋鉤子（Phase S1）](#opt-3挖礦專屬任務埋鉤子phase-s1)
5. [Opt-4：排行榜多維度擴充（Phase S2）](#opt-4排行榜多維度擴充phase-s2)
6. [Opt-5：統一 buffResolver（主動發現）](#opt-5統一-buffresolver主動發現)
7. [優化排程建議](#優化排程建議)
8. [新增 / 異動檔案索引](#新增--異動檔案索引)

---

## 1. 文件目的

`PART2_EXPANSION_PLAN.md` 與 `PART3_SUPPLEMENT_PLAN.md` 中部分 Phase 在
程式碼盤點時發現已經有底層實作，但**規格與規劃書不同**或**功能不完整**。
這些項目不適合作為「新功能 Phase」開發，而是針對既有系統的優化升級。

優化清單：

| Opt | 對應規劃書 Phase | 現況差距 | 預估時間 |
|---|---|---|---|
| Opt-1 | Phase B 決鬥 | 公式、上限、冷卻不同 | 1–2 天 |
| Opt-2 | Phase E 稱號管理 | 過期、admin、DM 缺失 | 1–2 天 |
| Opt-3 | Phase S1 挖礦任務 | 任務未定義、未埋鉤子 | 1–2 天 |
| Opt-4 | Phase S2 排行榜 | 缺 value/rainbow/titles/weekly | 1–2 天 |
| Opt-5 | （主動發現） | buff 邏輯散落、難擴充 | 2 天 |

**合計**：6–10 天。

---

## Opt-1：決鬥系統公式與限制重做（Phase B）

### 現況

| 來源 | 細節 |
|---|---|
| 路徑 | `src/features/mining/duelService.js`、`src/commands/mining/duel.js` |
| 勝負公式 | `winRate = atkC / (atkC + atkO)` 純機率，ATK 越高勝率越高 |
| 賭注範圍 | `minBet=10, maxBet=5000`（`src/config/duel.json`） |
| 每日場次 | **無限制** |
| 同對手冷卻 | **無**（只有 `acceptWindowMs=120000` 接受視窗） |
| 派彩 | 全拿（未抽水） |
| 紀錄查詢 | 未提供 `/決鬥紀錄` 指令 |

### 規劃書 Phase B 要求

| 項目 | 規格 |
|---|---|
| 勝負公式 | `score = baseAtk + pickaxeBonus + rand(0, 30)`，分數高者勝 |
| 賭注 | 100–5,000 |
| 每日場次 | 3 場 |
| 同對手冷卻 | 6 小時 |
| 派彩 | 賭注 × 1.9（系統抽 5%） |
| 紀錄 | `/決鬥紀錄` |

### 動作清單

1. **改寫 `duelService.js` 勝負函式**
   ```js
   function resolveDuel(challenger, opponent) {
     const cScore = challenger.baseAtk + challenger.pickaxeBonus + randInt(0, 30)
     const oScore = opponent.baseAtk   + opponent.pickaxeBonus   + randInt(0, 30)
     return cScore >= oScore ? challenger.id : opponent.id
   }
   ```
   - `baseAtk` / `pickaxeBonus` 從 `buffResolver.getEffectiveAtk()` 取得（依賴 Opt-5）

2. **派彩改抽 5%**
   ```js
   const payout = Math.floor(bet * 1.9)   // 對賭 2×，系統抽 5%
   ```

3. **前置檢查（在 `duel.js` 指令）**
   - 查詢 `DuelGames` 當日同 challenger 已完成場數 < 3
   - 查詢 `DuelGames` 6 小時內同 (challenger, opponent) 配對紀錄為 0

4. **調整 `src/config/duel.json`**
   ```json
   {
     "minBet": 100,
     "maxBet": 5000,
     "dailyLimit": 3,
     "samePairCooldownMs": 21600000,
     "systemRakePct": 0.05,
     "acceptWindowMs": 120000
   }
   ```

5. **新增 `/決鬥紀錄` 指令**
   - 路徑：`src/commands/mining/duelHistory.js`
   - 顯示個人最近 10 場勝負、累積戰績

### 改動檔案

- `src/features/mining/duelService.js`（公式 + 派彩）
- `src/commands/mining/duel.js`（前置檢查）
- `src/config/duel.json`（參數）
- 新增 `src/commands/mining/duelHistory.js`

---

## Opt-2：稱號進階管理（Phase E）

### 現況

| 來源 | 細節 |
|---|---|
| 資料結構 | `UserLevels.gameTitles: Set<titleId>`、展示用 `UserLevels.title: string` |
| 週冠換王 | ✅ `src/events/ready/miningWeeklyRank.js`（每週一 00:01）自動卸下舊王、頒新王、公告 |
| 過期機制 | ❌ 無 `expiresAt` 欄位 |
| 過期撤銷 cron | ❌ 不存在 |
| 多稱號展示 | ❌ `/profile` 只展示 `UserLevels.title` 單槽（與徽章共用） |
| 管理員工具 | ❌ 無 `/title-admin grant\|revoke\|list` |
| 換王通知 | ⚠️ 只發頻道公告，無 DM |

### 動作清單

1. **稱號資料結構升級**
   - `UserLevels.gameTitles` 由 `Set<titleId>` 升級為：
     ```js
     gameTitles: [
       { titleId: String, grantedAt: Number, expiresAt: Number|null, source: String }
     ]
     ```
   - `expiresAt = null` 表示永久（向後相容）
   - `source` 可為 `'weekly_king'`、`'donation_tier1'`、`'admin_grant'` 等

2. **新 cron：過期掃描**
   - 新增 `src/events/ready/titleExpiryChecker.js`
   - 每小時掃 `expiresAt != null && expiresAt < now && status='active'` 的稱號
   - 移除稱號 + 對應 Discord role（呼叫 `gameTitleService.revoke()`）
   - 寫入 `gameTitles[].status = 'expired'`（保留紀錄不刪除）

3. **多稱號收藏展示**
   - `/profile` Embed 新增「已解鎖稱號」欄位
   - 最多顯示 8 個 badge，按 `grantedAt` 倒序
   - 展示中稱號（`UserLevels.title`）特別高亮

4. **管理員工具**
   - 新增 `src/commands/title/titleAdmin.js`：
     - `/title-admin grant @玩家 [稱號ID] [天數]` — 手動授予（天數可留空 = 永久）
     - `/title-admin revoke @玩家 [稱號ID]` — 手動撤銷
     - `/title-admin list @玩家` — 列出所有稱號（含過期）
   - 僅 admin role 可用

5. **換王 DM 通知強化**
   - 修改 `miningWeeklyRank.js`：
     - 前任王收到「你的稱號『礦坑之王』已移交給 @新王」DM
     - 新王收到「恭喜你成為礦坑之王」DM
     - 頻道公告附 `@mention` 兩位

### 改動檔案

- `src/features/gameTitles/gameTitleService.js`（資料結構升級、撤銷函式抽出）
- `src/events/ready/miningWeeklyRank.js`（DM 通知）
- `src/commands/profile/*`（多稱號展示 Embed）
- 新增 `src/events/ready/titleExpiryChecker.js`
- 新增 `src/commands/title/titleAdmin.js`

### 與其他規劃的關聯

- `PLAN_INTEGRATED.md` **Phase 8 抖內**會產生有時效稱號（30 天身分組），本優化的過期機制是 Phase 8 的前置。

---

## Opt-3：挖礦專屬任務埋鉤子（Phase S1）

### 現況

| 來源 | 細節 |
|---|---|
| 任務框架 | ✅ `src/features/quests/questService.js` 完整（`incrementProgress`、`markCompleted`、`tryAutoClaim`） |
| 任務定義 | ⚠️ `src/config/quests.json` 只有早安、訊息、語音、賭博、股市相關，**沒有挖礦任務** |
| 觸發鉤子 | ❌ `mine.js`、`sell.js`、`work.js`、`craft.js` 均未呼叫 `questService` |
| 進度資料 | ✅ `QuestProgress` collection 完整 |

### 動作清單

1. **`src/config/quests.json` 新增任務**

   **Daily 新增 4 項：**

   | id | 名稱 | 條件 | 獎勵 |
   |---|---|---|---|
   | `daily_mine_3` | 礦工打卡 | `mine_count >= 3` | 150 幣 |
   | `daily_sell_ore` | 礦石出清 | `sell_ore_count >= 1` | 100 幣 |
   | `daily_rare_ore` | 幸運礦工 | `rare_ore_count >= 1`（iron/crystal/rainbow） | 200 幣 |
   | `daily_work` | 今日打工 | `work_count >= 1` | 100 幣 |

   **Weekly 新增 4 項：**

   | id | 名稱 | 條件 | 獎勵 |
   |---|---|---|---|
   | `weekly_mine_20` | 週末礦工 | `mine_count >= 20` | 1,000 幣 |
   | `weekly_rainbow` | 彩虹獵人 | `rainbow_count >= 1` | 2,500 幣 |
   | `weekly_craft` | 鍛造師週記 | `craft_count >= 3` | 1,200 幣 |
   | `weekly_sell_value` | 礦石大亨 | `meta.sellValue >= 1000` | 1,500 幣 |

2. **埋鉤子位置**

   | 指令 | 觸發點 | 呼叫 |
   |---|---|---|
   | `src/commands/mining/mine.js` | 成功掉落後 | `incrementProgress('daily_mine_3', 1)`、`incrementProgress('weekly_mine_20', 1)` |
   | 同上 | 掉落含 iron/crystal/rainbow | `incrementProgress('daily_rare_ore', 1)` |
   | 同上 | 掉落含 rainbow | `incrementProgress('weekly_rainbow', 1)` |
   | `src/commands/mining/sell.js` | 賣礦成功後 | `incrementProgress('daily_sell_ore', 1)`、`addMetaValue('weekly_sell_value', 'sellValue', soldCoins)` |
   | `src/commands/work.js`（或對應路徑） | 打工成功後 | `incrementProgress('daily_work', 1)` |
   | `src/commands/mining/craft.js` | 合成成功後 | `incrementProgress('weekly_craft', 1)` |

3. **`questService` 新增 `addMetaValue`**
   - 因為 `weekly_sell_value` 條件是「累計金額」而非「次數」
   - 新增 `addMetaValue(userId, guildId, questId, key, delta)`：累加 `QuestProgress.meta[key]`，並比對 condition.target 判定完成

### 改動檔案

- `src/config/quests.json`（新增 8 項任務）
- `src/features/quests/questService.js`（新增 `addMetaValue`，若 condition type 需擴充也在此）
- `src/commands/mining/mine.js`、`sell.js`、`craft.js`、`src/commands/work.js`（埋鉤子）

---

## Opt-4：排行榜多維度擴充（Phase S2）

### 現況

| 來源 | 細節 |
|---|---|
| 路徑 | `src/commands/leaderboard/leaderboard.js`、`src/features/leaderboard/categories.js` |
| 類別 | 等級、訊息、語音、頻道、挖礦（週）、賭場贏家、賭場輸家 |
| 挖礦排行 | ✅ 週榜（count）已有，呼叫 `rankService.currentWeekRanking()` |
| 缺 | value（總市值）、rainbow（彩虹石持有）、titles（稱號數）、weekly summary |

### 動作清單

1. **新增 `src/features/leaderboard/miningLeaderboard.js`**
   ```js
   export const miningLeaderboard = {
     byCount(guildId, period)    { /* 既有邏輯包裝 */ },
     byValue(guildId, period)    { /* MineLogs 加總，礦石以基礎價換算 */ },
     byRainbow(guildId)          { /* UserInventory.rainbow 排序 */ },
   }
   ```

2. **新增稱號排行**
   - 在 `categories.js` 增加 `titleCount` 類別
   - 從 `UserLevels.gameTitles.length`（升級後是 array length）排序 Top 10

3. **新增週 summary 複合 Embed**
   - 新增 `src/features/leaderboard/weeklySummary.js`
   - 組合挖礦 / 金幣 / 稱號各 Top 3
   - 設計成截圖友善（單一 Embed）

4. **`/leaderboard` 指令參數擴充**

   | 指令 | 說明 |
   |---|---|
   | `/leaderboard mining count [period]` | 既有 |
   | `/leaderboard mining value [period]` | 新增 |
   | `/leaderboard mining rainbow` | 新增（全時） |
   | `/leaderboard titles` | 新增 |
   | `/leaderboard weekly` | 新增（週 summary） |

5. **API（供 Dashboard 使用）**
   ```
   GET /api/v1/leaderboard/mining?type=count&period=week
   GET /api/v1/leaderboard/mining?type=value&period=month
   GET /api/v1/leaderboard/titles
   GET /api/v1/leaderboard/weekly-summary
   ```

### 改動檔案

- `src/features/leaderboard/categories.js`（新增類別註冊）
- 新增 `src/features/leaderboard/miningLeaderboard.js`
- 新增 `src/features/leaderboard/weeklySummary.js`
- `src/commands/leaderboard/leaderboard.js`（子指令參數）
- `src/services/httpServer/*`（API 路由，供 Dashboard）

---

## Opt-5：統一 buffResolver（主動發現）

### 現況

- `src/utils/twitchSubBonus.js`、`src/utils/serverBoostBonus.js` 等各自獨立
- `UserCoins.activeBuffs` 已存在，由 `src/events/ready/activeBuffsCleanupScheduler.js` 清理
- 食物 buff（Phase S4）、技能 buff（Phase S3）、公會 buff（Phase A）、活動 buff（Phase S5）若各自直接呼叫散落的 utility，將造成：
  - 上限疊加判斷錯誤（例如 luck 多處 +5% 加起來超過 luckCap）
  - 新加 buff 來源需修改所有使用點
  - 難以提供「我的 buff 總覽」指令

### 動作清單

1. **新增 `src/features/buff/buffResolver.js`**
   ```js
   const buffResolver = {
     async getEffectiveLuck(userId, guildId)              { /* twitch + sub + food + skill + guild + event；套 luckCap */ },
     async getEffectiveAtk(userId, guildId)               { /* base + pickaxe + food + skill + event */ },
     async getEffectiveIncomeMultiplier(userId, guildId, source) { /* source: 'mine' | 'work' | 'sell' | 'farm' */ },
     async getEffectiveCdMs(userId, guildId, source)      { /* CD 減免 */ },
     async summary(userId, guildId)                       { /* 給 /buff 指令用：列所有來源 */ },
   }
   ```

2. **重構既有呼叫點**
   - `mine.js` 計算 luck 改呼叫 `buffResolver.getEffectiveLuck()`
   - `work.js` 收入計算改呼叫 `buffResolver.getEffectiveIncomeMultiplier(userId, gId, 'work')`
   - `sell.js` 同上 source `'sell'`
   - `dungeon.js` ATK 改呼叫 `buffResolver.getEffectiveAtk()`
   - `duelService.js`（Opt-1）也改用 `buffResolver.getEffectiveAtk()`
   - `twitchSubBonus.js` 等改為 `buffResolver` 內部呼叫，不被外部直接使用

3. **未來擴充規則**
   - 任何新 Phase 想加新的 buff 來源（公會、技能、食物、活動），只需在 `buffResolver` 內加一個分支
   - 不可直接從外部讀 `UserCoins.activeBuffs`

### 為何放優化檔（不放 PLAN_INTEGRATED.md）

- 沒有新功能，純粹是把碎片化邏輯收斂
- 但這是 Phase A、D、S3、S4、S5 的共同前置基礎

### 啟動時機

**建議在啟動 Phase A 之前完成**。Phase F、S5 因為不大量依賴 buff，可以先做；
但 Phase S3（技能樹）強依賴此重構，沒做完之前不要啟動 S3。

### 改動檔案

- 新增 `src/features/buff/buffResolver.js`
- 重構 `src/commands/mining/mine.js`、`sell.js`、`craft.js`、`src/commands/work.js`、`src/commands/mining/dungeon.js`、`src/features/mining/duelService.js`
- 既有 `src/utils/twitchSubBonus.js`、`serverBoostBonus.js` 改為 `buffResolver` 內部模組

---

## 優化排程建議

不需等所有新 Phase 啟動，可在現有系統穩定運行時穿插執行：

| 週次 | 工作 | 時間 |
|---|---|---|
| 本週 | Opt-3（挖礦任務） | 1–2 天 |
| 本週 | Opt-4（排行榜） | 1–2 天 |
| 下週 | Opt-1（決鬥重做） | 1–2 天 |
| 下週 | Opt-2（稱號管理） | 1–2 天 |
| Phase A 啟動前 | Opt-5（buffResolver） | 2 天 |

**合計 6–10 天**，可與 `PLAN_INTEGRATED.md` 的 Phase 8 / G / F 並行進行。

---

## 新增 / 異動檔案索引

| 檔案 | 動作 | Opt |
|---|---|---|
| `src/features/mining/duelService.js` | 改寫公式 + 派彩 | Opt-1 |
| `src/commands/mining/duel.js` | 新增前置檢查 | Opt-1 |
| `src/config/duel.json` | 調整參數 | Opt-1 |
| `src/commands/mining/duelHistory.js` | **新增**`/決鬥紀錄` | Opt-1 |
| `src/features/gameTitles/gameTitleService.js` | 資料結構升級 | Opt-2 |
| `src/events/ready/titleExpiryChecker.js` | **新增**過期掃描 cron | Opt-2 |
| `src/events/ready/miningWeeklyRank.js` | 加 DM 通知 | Opt-2 |
| `src/commands/title/titleAdmin.js` | **新增** admin 工具 | Opt-2 |
| `src/commands/profile/*` | 多稱號展示 | Opt-2 |
| `src/config/quests.json` | 新增 8 項挖礦任務 | Opt-3 |
| `src/features/quests/questService.js` | 新增 `addMetaValue` | Opt-3 |
| `src/commands/mining/mine.js` | 埋鉤子 | Opt-3, Opt-5 |
| `src/commands/mining/sell.js` | 埋鉤子 | Opt-3, Opt-5 |
| `src/commands/mining/craft.js` | 埋鉤子 | Opt-3, Opt-5 |
| `src/commands/work.js` | 埋鉤子 | Opt-3, Opt-5 |
| `src/features/leaderboard/categories.js` | 註冊新類別 | Opt-4 |
| `src/features/leaderboard/miningLeaderboard.js` | **新增**多維度 | Opt-4 |
| `src/features/leaderboard/weeklySummary.js` | **新增**週 summary | Opt-4 |
| `src/commands/leaderboard/leaderboard.js` | 子指令參數 | Opt-4 |
| `src/features/buff/buffResolver.js` | **新增**統一 buff 解析 | Opt-5 |
| `src/utils/twitchSubBonus.js`、`serverBoostBonus.js` | 改為內部模組 | Opt-5 |
| `src/commands/mining/dungeon.js` | 改用 buffResolver | Opt-5 |

---

_Last updated: 2026-05-28_
