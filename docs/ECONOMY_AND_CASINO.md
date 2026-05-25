# 經濟系統 + 賭場遊戲完整規格書

> 本文件整理逼逼機器人「金幣經濟」與「賭場 / 商店 / 任務 / 救濟金 / 股市 / 邀請 / 活動」相關功能的所有規則、設定與數值。
>
> 所有數值來源：
> - `src/config/level.json`（`coinSystem`、`levelSystem`、`twitchSync`）
> - `src/config/casino.json`
> - `src/config/shop.json`
> - `src/config/quests.json`
> - `src/config/welfare.json`
> - `src/config/stocks.json` + `src/config/stockEvents.json`（股市）
> - `src/config/invite.json`（邀請獎勵）
> - `src/config/server.json` → `hostedEvents`（主辦活動）
> - 對應的 `src/features/**` 引擎程式
>
> 修改設定後不需重啟即可生效（除了 cron 排程）；指令名稱以中文 slash command 為準。

---

## 目錄

1. [核心概念](#1-核心概念)
2. [credits（金幣）獲取來源](#2-credits金幣獲取來源)
3. [倍率系統（Twitch / Boost / 商店 buff）](#3-倍率系統twitch--boost--商店-buff)
4. [每日上限與資格門檻](#4-每日上限與資格門檻)
5. [轉帳系統](#5-轉帳系統)
6. [定期存款](#6-定期存款)
7. [財富稅](#7-財富稅)
8. [救濟金](#8-救濟金)
9. [任務系統（每日 / 每週）](#9-任務系統每日--每週)
10. [邀請獎勵系統](#10-邀請獎勵系統)
11. [股市交易系統](#11-股市交易系統)
12. [主辦活動（賞金活動）](#12-主辦活動賞金活動)
13. [等級 / XP 系統](#13-等級--xp-系統)
14. [每日簽到與補簽卡](#14-每日簽到與補簽卡)
15. [徽章與稱號](#15-徽章與稱號)
16. [商店與背包](#16-商店與背包)
17. [賭場通則](#17-賭場通則)
18. [賭場 ─ 拉霸（吃角子老虎）](#18-賭場--拉霸吃角子老虎)
19. [賭場 ─ 骰寶 Sic Bo](#19-賭場--骰寶-sic-bo)
20. [賭場 ─ 二十一點 Blackjack](#20-賭場--二十一點-blackjack)
21. [賭場 ─ HI-LO](#21-賭場--hi-lo)
22. [賭場 ─ 輪盤 Roulette](#22-賭場--輪盤-roulette)
23. [賭場 ─ 德州撲克 Poker](#23-賭場--德州撲克-poker)
24. [賭場 ─ 尋寶 Keno](#24-賭場--尋寶-keno)
25. [賭場 ─ 火箭 Crash](#25-賭場--火箭-crash)
26. [賭場 ─ 射龍門 Dragon Gate](#26-賭場--射龍門-dragon-gate)
27. [賭場 ─ 賽馬 Horse Racing](#27-賭場--賽馬-horse-racing)
28. [賭場 ─ 樂透 Lottery](#28-賭場--樂透-lottery)
29. [防呆 / 防洗幣 / 風控](#29-防呆--防洗幣--風控)
30. [每日經濟報告](#30-每日經濟報告)
31. [MongoDB Collection 速覽](#31-mongodb-collection-速覽)

---

## 1. 核心概念

| 名稱 | 說明 |
| --- | --- |
| **credits（金幣）** | 經濟系統的單一貨幣，整數，最小單位 1 |
| **XP（經驗值）** | 累積後升等的指標，與 credits 是兩條獨立軌道但會交叉觸發（升等送 credits、商店買 XP buff） |
| **`grantCoins` 唯一入口** | 所有金幣異動（聊天、語音、簽到、賭場下注 / 派彩、商店、轉帳、定存、稅、救濟、任務、股市、邀請、活動、開台聊天）都必須走 `src/features/economy/grantCoins.js`，並在 `CoinTransactions` 寫一筆紀錄 |
| **source 標籤** | 每筆異動有 `source` 欄位，用於統計、上限計算、倍率判斷、RTP 對帳 |
| **時區** | 所有「每日 / 每週」相關重置一律以 `Asia/Taipei` 午夜為界 |

**source 一覽**

| source | 方向 | 說明 | 套倍率？ |
| --- | --- | --- | --- |
| `message` | 收 | 聊天訊息獎勵 | ✅ |
| `voice` | 收 | 語音時長獎勵 | ✅ |
| `daily` | 收 | 每日簽到（送 XP 也送金幣） | ✅ |
| `reaction` | 收 | 被加表情符號 | buff only |
| `levelup` | 收 | 升等獎金 | buff only |
| `twitch_chat` | 收 | Twitch 開台聊天獎勵（含名次加碼） | buff only |
| `welfare` | 收 | 救濟金 | ❌（flat） |
| `quest_daily` / `quest_weekly` / `quest_event` | 收 | 任務獎金 | ❌（flat） |
| `transfer_in` | 收 | 收到玩家轉帳 | ❌ |
| `transfer_out` | 出 | 轉出（含手續費，存負值） | ❌ |
| `bet` | 出 | 賭場下注（負值） | ❌ |
| `payout` | 收 | 賭場派彩 | ❌ |
| `shop_buy` | 出 | 商店購買（負值） | ❌（即使是 buff 倍率也不對 shop 生效） |
| `wealth_tax` | 出 | 每週財富稅（負值） | ❌ |
| `deposit_lock` | 出 | 定存鎖款（負值） | ❌ |
| `deposit_release` | 收 | 定存到期 / 提早領回 | ❌ |
| `stock_buy` | 出 | 股票買入本金（負值，sink） | ❌ |
| `stock_fee` | 出 | 股票買 / 賣手續費（負值，sink） | ❌ |
| `stock_sell` | 收 | 股票賣出成交額（flat） | ❌ |
| `stock_dividend` | 收 | 股票配息（flat） | ❌ |
| `event_host_lock` | 出 | 主辦活動鎖定獎金池（負值，sink） | ❌ |
| `event_prize` | 收 | 活動得獎派彩 | ❌ |
| `event_refund` | 收 | 活動取消 / 剩餘退回主辦人（已扣抽成） | ❌ |
| `invite_reward` | 收 | 邀請成功獎勵（給邀請人，flat） | ❌ |
| `invite_welcome` | 收 | 被邀請者歡迎金（flat） | ❌ |
| `invite_clawback` | 出 | 被邀請者早退時扣回邀請獎勵（負值，sink） | ❌ |
| `admin` | 雙向 | `/give-coins` 管理員手動發放 / 扣除 | ❌ |
| `auction_bid` | 出 | 拍賣下標（保留欄位） | ❌ |

> **「套倍率？」三態**：
> - **✅**：Twitch Sub / Server Boost / 商店 coin_boost buff 全部生效（僅 `message` / `voice` / `daily`，即 `appliesTo` 清單內者）。
> - **buff only**：Twitch / Boost 不套（不在 `appliesTo`），但屬「正向獲得」仍可吃商店 `coin_boost` buff。
> - **❌**：所有倍率一律不套（flat / sink / peer / casino / admin）。
>
> **負值規則**：除 `admin`、`bet/payout`、以及 sink 類（`shop_buy`、`auction_bid`、`wealth_tax`、`transfer_out`、`deposit_lock`、`stock_buy`、`stock_fee`、`event_host_lock`、`invite_clawback`）之外的 source，金額為負時會被 grantCoins 拒絕（防呆）。

---

## 2. credits（金幣）獲取來源

設定檔：`src/config/level.json` → `coinSystem`

### 2.1 訊息（`coinSystem.message`）

| 欄位 | 預設值 | 說明 |
| --- | --- | --- |
| `minCoins` | `0` | 每則訊息最少給的金幣 |
| `maxCoins` | `2` | 每則訊息最多給的金幣（隨機） |
| `cooldownSeconds` | `60` | 同一使用者冷卻秒數 |
| `minCharacters` | `4` | 最少字元數，太短不給（防灌單字水） |

### 2.2 語音（`coinSystem.voice`）

| 欄位 | 預設值 | 說明 |
| --- | --- | --- |
| `coinsPerTick` | `1` | 每個 tick 給的金幣 |
| `tickMinutes` | `2` | tick 長度（每 2 分鐘結算一次） |

> 與 XP 共用：頻道內必須 ≥ 2 人；自動忽略 mute / deaf / AFK。

### 2.3 每日簽到（`coinSystem.daily`）

| 欄位 | 預設值 |
| --- | --- |
| `baseCoins` | `60` |
| `streakBonusPerDay` | `10` |
| `streakBonusCapDays` | `10` |
| `streak7Multiplier` | `1.5` |
| `streak30Multiplier` | `2.0` |
| `resetTimezone` | `Asia/Taipei` |

簽到金幣公式：

```
streakBonus = min(streak, streakBonusCapDays) × streakBonusPerDay
amount      = baseCoins + streakBonus
若 streak ≥ 30 → amount × 2.0
否則 streak ≥ 7  → amount × 1.5
最後再套 Twitch / Boost / coin_boost buff（依 bonusStackingMode）
```

### 2.4 反應 XP（`coinSystem.reaction`）

| 欄位 | 預設 |
| --- | --- |
| `reactionsPerCoin` | `2`（每被加 2 個反應 = 1 金幣） |
| `dailyCapPerUser` | `10`（單日最多 10 金幣） |

### 2.5 升等獎金（`coinSystem.levelUp`）

| 欄位 | 預設 |
| --- | --- |
| `coinsPerLevel` | `3` |
| `softCapLevel` | `50` |
| `softCapDivisor` | `2` |

每次升等發 `coinsPerLevel × newLevel`；超過 `softCapLevel` 後除以 `softCapDivisor`。

**里程碑加碼**（額外發）：

| 等級 | 額外金幣 |
| --- | --- |
| 5 | 15 |
| 10 | 45 |
| 20 | 120 |
| 30 | 300 |
| 50 | 750 |
| 75 | 1,500 |
| 100 | 4,500 |

### 2.6 訊息 + 語音「每日合計上限」

`coinSystem.messageVoiceDailyCap = 200`

→ 一天透過聊天 + 語音最多賺 200 金幣，超過直接拒發；達上限前會自動截斷讓總額剛好等於 cap。

### 2.7 Twitch 開台聊天獎勵（`levelSystem.twitchSync`）

設定：`level.json` → `twitchSync`；實作 `src/httpServer/flushChatScore.js`（HTTP endpoint，需 `DISCORD_BOT_SCORE_SECRET`）。

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `guildId` | `1174352637295067157` |
| `perSessionXpCap` | 1,000 |
| `minMessageThreshold` | 5（單場 < 5 則不計） |
| `coinPayout.enabled` | true |
| `coinPayout.perMessage` | `{ min: 3, max: 7 }` |
| `coinPayout.perSessionCap` | 1,000 |
| `coinPayout.rankingBonuses` | `[2000, 1000, 1000, 1000, 500, 500, 500, 500, 500, 500]` |

**機制**

- 開台結束後，外部服務以 `sessionId` 回傳每位觀眾的聊天則數，機器人比對 Twitch 帳號 → Discord 成員。
- 每位 ≥ `minMessageThreshold`（5）則才結算。
- **XP**：每則 15–25 累加，封頂 `perSessionXpCap`（1,000）；source `twitch_chat`。
- **金幣**：每則 3–7 累加，封頂 `perSessionCap`（1,000）；再依本場聊天名次加碼 `rankingBonuses`（第 1 名 +2,000、第 2–4 名 +1,000、第 5–10 名 +500）；source `twitch_chat`。
- `sessionId` 冪等：同場重複回傳不重複發放。
- `twitch_chat` 不在倍率 `appliesTo` 內，故不套 Twitch / Boost 倍率，但屬正向獲得，可吃商店 `coin_boost` buff。

---

## 3. 倍率系統（Twitch / Boost / 商店 buff）

### 3.1 Twitch Sub Bonus

| Tier | RoleId | XP 倍率 | 金幣倍率 |
| --- | --- | --- | --- |
| Twitch Tier 1 | `1181162291568332891` | ×1.5 | ×1.1 |
| Twitch Tier 2 | `1181162291568332892` | ×2.0 | ×1.3 |
| Twitch Tier 3 | `1181162291568332893` | ×3.0 | ×1.5 |

`appliesTo`：`["message", "voice", "daily"]`（其他來源不套）。

### 3.2 Server Boost Bonus

| 欄位 | 值 |
| --- | --- |
| `roleId` | `1181220255733907599` |
| 名稱 | 伺服器加成 |
| XP 倍率 | ×2.0 |
| 金幣倍率 | ×1.3 |
| 一次性開 boost 獎勵 | +10,000 XP（`grantOnBoost`） |

### 3.3 商店 Buff

來自 `/商店 購買` 的 `xp_boost` / `coin_boost` 道具，到期前對「正向獲得」生效，**不對 `shop_buy` 自身倍率**。

### 3.4 倍率疊加策略

`coinSystem.bonusStackingMode = "max"`（金幣預設）

- `"max"`：取 Twitch、Boost 的較大倍率
- `"multiply"`：兩者相乘

最終公式（金幣）：

```
totalMultiplier = stack(twitchMul, boostMul) × shopBuffMul
amount          = floor(baseAmount × totalMultiplier)
```

> Twitch / Boost / shop buff 對於 `bet`、`payout`、`shop_buy`、`wealth_tax`、`transfer_*`、`deposit_*`、`stock_*`、`event_*`、`invite_*`、`welfare`、`quest_*`、`admin` 一律不套用。

---

## 4. 每日上限與資格門檻

### 4.1 入伺資格（`coinSystem.eligibility.minServerTenureDays = 7`）

加入伺服器 < 7 天的成員：
- 不能使用 `/錢包`、`/轉帳`、`/存款`、`/骰寶` 等金幣指令
- 不能收到別人的轉帳（防小帳洗幣）

### 4.2 帳號年齡

- `welfareSystem.minAccountAgeDays = 30`：Discord 帳號 < 30 天不得領取救濟金。
- `inviteSystem.minInviteeAccountAgeDays = 7`：被邀請者帳號 < 7 天，整筆邀請略過（不發獎、不發歡迎金、不留紀錄）。

### 4.3 各種 daily cap 整理

| 類別 | cap | 說明 |
| --- | --- | --- |
| 訊息 + 語音合計 | 200 / 天 | 主動賺金幣的上限 |
| 反應 | 10 / 天 | 與訊息語音獨立額度 |
| 轉帳轉出 | 20,000 / 天 | 防洗幣 |
| 管理員 `/give-coins` | 500,000 / 天 / 管理員 | 限制單一管理員濫權 |
| 邀請發獎 | 3 筆 / 天 / 邀請人 | `inviteSystem.dailyMaxInvites`，超過記錄但 0 獎勵 |
| 開台聊天 XP / 金幣 | 各 1,000 / 場 | `twitchSync.perSessionXpCap` / `coinPayout.perSessionCap` |
| 單股持有 | 500 股 | `stockSystem.maxSharesPerUser` |
| 同時定存單 | 5 筆 | `deposit.maxActivePerUser` |
| 撲克每日 buy-in | 50,000 | `poker.dailyBuyInLimit` |
| 樂透訂閱期數 | 12 期 | `lottery.subscription.maxDrawsPerSubscription` |
| 樂透訂閱每期張數 | 10 張 | `lottery.subscription.maxTicketsPerDraw` |

---

## 5. 轉帳系統

設定：`coinSystem.transfer`，指令 `/轉帳 對象 金額 [備註]`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minAmount` | 100 |
| `maxAmount` | 20,000 |
| `dailyCapPerSender` | 20,000 |
| `feeRate` | 2% |
| `feeRateHigh` | 5% |
| `highFeeThreshold` | 1,000（> 1,000 套 5%，否則 2%） |
| `cooldownSeconds` | 1,800（30 分鐘） |
| `suspiciousThreshold` | 5,000（雙向總額觸發告警） |

**手續費公式**

```
rate = amount > 1000 ? 5% : 2%
fee  = floor(amount × rate)
totalDeduct = amount + fee   // 從發送者扣
```

**檢查順序**

1. 系統 / 轉帳功能是否啟用
2. 入伺天數 ≥ 7（發送者）
3. 不能轉給 bot、自己
4. 金額 100–20,000
5. 餘額 ≥ totalDeduct
6. 距上次轉出 ≥ 30 分鐘
7. 今日累計轉出 + 本次 ≤ 20,000
8. 收款人入伺天數 ≥ 7
9. 扣款 → 入款（任一失敗自動回滾）
10. 非阻塞觸發雙向轉帳偵測

**雙向轉帳告警**（防互相洗）

- `suspiciousTransferDetector.js`，掃過去 24 小時 A↔B 雙向 `transfer_out`
- 雙向總額 ≥ 5,000 → 寫入 `coinSystem.adminGrant.auditLogChannelId` 或 `dailyEconomyReport.channelId`

---

## 6. 定期存款

設定：`coinSystem.deposit`，指令 `/存款 開戶 / 查詢 / 提款`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minAmount` | 100 |
| `maxAmount` | 100,000 |
| `maxActivePerUser` | 5 |
| `earlyWithdrawPenaltyRate` | 10% |

**存期與利率**（`terms`）

| 天數 | 利率（到期 +%） | 換算年化 |
| --- | --- | --- |
| 7 | 2% | ≈ 104.3% |
| 14 | 5% | ≈ 130.4% |
| 30 | 12% | ≈ 146.0% |

> 年化只是顯示提示，真正結算用「期間利率」一次性計算。

**到期領回**

```
payout = principal + floor(principal × rate)
```

**提早領回**（未到期）

```
penalty = floor(principal × 0.1)
payout  = max(0, principal − penalty)
利息歸零，違約金扣 10% 本金
```

**狀態**：`active` → `claimed`（到期領） / `early_claimed`（違約領）

---

## 7. 財富稅（累進制）

設定：`coinSystem.wealthTax`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `brackets` | 見下表 |
| `cronSchedule` | `0 4 * * 1`（每週一 04:00） |
| `timezone` | `Asia/Taipei` |
| `minDeduction` | 1 |
| `dmEnabled` | true（設為 false 可關閉私訊通知） |

**累進級距（邊際稅率，越富越狠，不留情）**

| 餘額區間 | 邊際稅率 |
| --- | --- |
| 0 ~ 50,000 | 0%（免稅額） |
| 50,000 ~ 100,000 | 2% |
| 100,000 ~ 300,000 | 5% |
| 300,000 ~ 1,000,000 | 10% |
| 1,000,000 ~ 5,000,000 | 20% |
| 5,000,000 ~ 20,000,000 | 35% |
| 20,000,000 ~ 100,000,000 | 50% |
| 100,000,000 以上 | 70% |

`brackets` 為陣列，每筆 `{ from, rate }` 表示「餘額超過 `from` 的部分」適用 `rate`，直到下一級的 `from`。最高一級沒有上限。

**公式**

```
對每個級距 i：
  lower = brackets[i].from
  upper = brackets[i+1]?.from ?? ∞
  if balance > lower:
    portion  = min(balance, upper) − lower
    tax     += portion × brackets[i].rate

tax = max(minDeduction, floor(tax))
tax = min(tax, totalCoins)              // 不能扣到負
```

**範例**

| 餘額 | 扣繳 | 有效稅率 |
| --- | --- | --- |
| 80,000 | 600 | 0.75% |
| 500,000 | 31,000 | 6.20% |
| 2,000,000 | 281,000 | 14.05% |
| 10,000,000 | 2,631,000 | 26.31% |
| 50,000,000 | 21,131,000 | 42.26% |
| 200,000,000 | 116,131,000 | 58.07% |

實作位於 `events/ready/wealthTaxScheduler.js`：
- 連續錯誤 3 次自動關閉
- 結算後在 `reportChannelId` 推 embed：級距表、總被扣戶數、總稅收、Top 5（含每人有效稅率）
- 結算後逐一私訊（DM）被課稅的用戶，內容含扣繳金額、稅前/稅後餘額、有效稅率與分級扣繳明細（可用 `dmEnabled: false` 關閉）
- 每筆扣稅以 `source: wealth_tax` 寫入 transactions，meta 含 `brackets`、`before`、`effectiveRate`、`slices`
- 用戶可用 `/我的稅務紀錄 [period]` 查詢歷史被課稅紀錄（累計金額、次數、平均有效稅率與逐筆明細），資料來源即上述 transactions

---

## 8. 救濟金

設定：`src/config/welfare.json`，指令 `/救濟金`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `balanceThreshold` | 100 |
| `minAccountAgeDays` | 30 |
| `resetTimezone` | `Asia/Taipei` |

**領取資格**

- Discord 帳號建立 ≥ 30 天
- 「總資產」（錢包餘額 + 所有 active 定存本金）≤ 100
- 當日尚未領取

**金額階梯（`tiers`）**

| 連續領取天數 (streak) | 金額 |
| --- | --- |
| 1 | 500 |
| 2–3 | 600 |
| 4–7 | 700 |
| ≥ 8 | 800 |

**判斷邏輯**

```
if 昨天有領 → streak += 1
else        → streak = 1
amount = 對應 tier 金額
```

**防 race**：使用 `findOneAndUpdate({ lastClaimDate: { $ne: today } })` 原子更新；首次領取時用 upsert + try/catch E11000。

---

## 9. 任務系統（每日 / 每週）

設定：`src/config/quests.json`，指令 `/每日任務`、`/領取任務獎勵`

### 9.1 每日任務

| ID | 名稱 | 條件 | 目標值 | 獎勵金幣 |
| --- | --- | --- | --- | --- |
| `daily_morning` | 早安打卡 | 07:00–10:00 在 `1174352640210124877` 頻道發言 | 1 | 150 |
| `daily_messages` | 文字活躍 | 當日訊息 ≥ 10 則 | 10 | 200 |
| `daily_voice_30` | 語音初段 | 當日語音 ≥ 30 分 | 30 | 150 |
| `daily_voice_60` | 語音進階 | 當日語音 ≥ 60 分 | 60 | 100 |
| `daily_gamble` | 賭桌新手 | 完成任意賭博一局（不論輸贏） | 1 | 300 |
| `daily_stock` | 股市初探 | 完成任意一筆股票交易（買或賣） | 1 | 250 |

> - 語音兩階段獨立計：待滿 30 分先拿 150，再到 60 分追加 100，語音任務合計 **250**。
> - `grantCoins` 在收到 `source = "bet"` 時自動標記 `daily_gamble` 完成；收到 `source = "stock_buy"` 或 `"stock_sell"` 時自動標記 `daily_stock` 完成。

**每日全收金額**

```
150（早安）+ 200（文字）+ 150（語音30）+ 100（語音60）+ 300（賭桌）+ 250（股市）
= 1,150 credits / 天
```

### 9.2 每週任務

| ID | 名稱 | 條件 | 目標值 | 獎勵金幣 |
| --- | --- | --- | --- | --- |
| `weekly_attendance` | 週週出席 | 本週簽到 ≥ 5 天 | 5 | 1,200 |
| `weekly_messages` | 活躍市民 | 本週發送訊息 ≥ 50 則 | 50 | 1,500 |
| `weekly_popular` | 人氣王 | 本週收到 ≥ 20 個表情符號反應 | 20 | 2,000 |

**每週全收金額**

```
1,200（出席）+ 1,500（訊息）+ 2,000（人氣）= 4,700 credits / 週
```

**理論週上限（每日全收 × 7 + 每週全收）**

```
1,150 × 7 + 4,700 = 12,750 credits / 週
```

### 9.3 領取機制與重置

- **自動入帳**：任務一達標即原子標記 `claimed` 並立刻發幣（`tryAutoClaim`），獎金 source = `quest_daily` / `quest_weekly`（`quest_event` 為活動類任務保留）。進度會 cap 在目標值，重複觸發不溢領。
- **補領退路**：自動入帳失敗時，玩家可用 `/領取任務獎勵`（`claimAll`）掃出 `ready`（已完成未領）的任務逐一補發。
- **查看進度**：`/每日任務` 顯示每項 `pending / in_progress / ready / claimed` 狀態與目標進度。
- **重置週期**：每日以 `Asia/Taipei` ISO 日期（`YYYY-MM-DD`）為界；每週以 ISO 週（`YYYY-Www`）為界。
- 任務獎金一律 **不套** Twitch / Boost / 商店 buff 倍率。

---

## 10. 邀請獎勵系統

設定：`src/config/invite.json`，指令 `/邀請`（查看個人邀請統計）。

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `enabled` | true | |
| `rewardAmount` | 3,000 | 基礎獎勵 |
| `rewardStep` | 1,000 | 每多 1 位「有效邀請」遞增 |
| `rewardMax` | 10,000 | 單筆獎勵封頂 |
| `dailyMaxInvites` | 3 | 每位邀請人每日最多發獎筆數 |
| `inviteeWelcomeBonus` | 500 | 被邀請者一次性歡迎金 |
| `clawbackDays` | 14 | 被邀請者多久內退出會被扣回獎勵 |
| `minInviteeAccountAgeDays` | 7 | 被邀請者帳號最低年齡 |
| `ignoreBots` | true | 忽略 bot 加入 |
| `dailyResetTimezone` | `Asia/Taipei` | |

**獎勵公式（階梯遞增）**

```
reward = min(rewardAmount + rewardStep × 目前有效邀請數, rewardMax)
       = min(3000 + 1000 × activeCount, 10000)
```

> `activeCount` 為發獎前該邀請人現有 `status = active` 的邀請數，越邀越多直到封頂 10,000。

**加入時流程（`guildMemberAdd`）**

1. 忽略 bot
2. 被邀請者帳號年齡 < 7 天 → 整筆略過
3. 比對使用的邀請碼（vanity / 找不到邀請人 → 略過）
4. 同一被邀請者已有紀錄 → 不重複發
5. 計算 reward（依邀請人目前 active 數）
6. 今日已發獎達 `dailyMaxInvites`（3）→ 本筆仍記錄但 reward = 0（`cappedByDaily`）
7. 發 `invite_reward` 給邀請人、`invite_welcome`（500）給被邀請者
8. 寫入 `InviteRecords`（status = `active`）

**Clawback（`guildMemberRemove`）**

- 被邀請者在 `clawbackDays`（14 天）內退出 → 從邀請人扣回當初獎勵（`invite_clawback` 負值），status → `clawed_back`
- 超過 14 天才退出 → 不扣回，status → `left`

**相關 source**：`invite_reward`、`invite_welcome`（flat 收入）、`invite_clawback`（sink 扣回）。

---

## 11. 股市交易系統

設定：`src/config/stocks.json` + `src/config/stockEvents.json`。
指令：`/買股`、`/賣股`、`/持股`、`/股歷`、`/配息紀錄`、`/stock-event`🔒。

### 11.1 市場通則（`stockSystem`）

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `timezone` | `Asia/Taipei` |
| `marketOpenHour` / `marketCloseHour` | 9 / 21（21:00 整收盤，僅開盤時間能下單） |
| `tickCronSchedule` / `tickIntervalMinutes` | `*/5 * * * *` / 5（每 5 分鐘更新一次價格） |
| `openCronSchedule` / `closeCronSchedule` | `0 9 * * *` / `0 21 * * *`（開 / 收盤公告） |
| `feeRate` / `minFee` | 1% / 5（買賣手續費 `max(5, floor(amount × 1%))`） |
| `maxSharesPerUser` | 500（單股持有上限） |
| `defaultMarketSentiment` | `sideways` |
| `announceChannelId` / `reportChannelId` / `broadcastChannelId` | `1505072010949169312` |

### 11.2 價格引擎（`priceEngine.js`）

每 5 分鐘（開盤期間）以隨機漫步更新：

```
nextPrice = lastPrice × (1 + drift + sigma × N(0,1))
nextPrice = max(floor, round(nextPrice, 0.1))    // 保底 floor、四捨五入到 0.1
```

- `sigma`：各股波動度（見股票池）
- `drift`：來自市場情緒
- `floor`：各股價格下限

**市場情緒（`marketDrift` / `sentimentRotation`）**

| 情緒 | drift |
| --- | --- |
| bull（多頭） | +0.001 |
| bear（空頭） | −0.001 |
| sideways（盤整） | 0 |

每日 09:00（`sentimentRotation.cronSchedule`）依權重 `bull:bear:sideways = 1:1:2` 隨機輪換並公告。

### 11.3 股票池（`stockSystem.pool`）

| 代號 | 名稱 | 初始價 | sigma | floor | 類型 | 年化股息 |
| --- | --- | --- | --- | --- | --- | --- |
| `TSPP` | 嗶積電 | 500 | 0.04 | 100 | tech | 2% |
| `UPPI` | 統嗶超商 | 300 | 0.015 | 60 | blue | 4% |
| `EGPP` | 嗶嗶海運 | 120 | 0.08 | 20 | meme | 0% |
| `CTPP` | 嗶嗶金控 | 800 | 0.025 | 160 | blue | 5% |
| `MTKP` | 嗶發科 | 200 | 0.055 | 40 | tech | 2.5% |

### 11.4 買 / 賣

**買入（`/買股 股票代號 數量`）**

```
totalCost = floor(currentPrice × shares)
fee       = max(5, floor(totalCost × 1%))
扣款：totalCost → source stock_buy（負）；fee → source stock_fee（負）
更新持倉 avgCost = 加權平均成本
```

- 餘額需 ≥ `totalCost + fee`
- 加上既有持股後不得超過 500 股

**賣出（`/賣股 股票代號 數量`，數量可填 `all`）**

```
proceeds   = floor(currentPrice × shares)
fee        = max(5, floor(proceeds × 1%))
入帳：proceeds → source stock_sell（正，顯示真實成交額）
扣費：fee      → source stock_fee（負）
損益 pnl = floor((currentPrice − avgCost) × shares)
```

> 賣出後 `avgCost` 不變（只減股數）。

### 11.5 配息（`stockSystem.dividend`）

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `cronSchedule` | `0 9 * * 1`（每週一 09:00） |
| `weeksPerYear` | 52 |
| `minPayoutPerHolder` | 1 |

每位股東每週配息：

```
payout = floor(shares × currentPrice × annualYield / 52)
若不足 1 → 補到 minPayoutPerHolder（1）
source = stock_dividend
```

派發後在 `reportChannelId` 公告，並逐一 DM 股東本週入帳明細。

### 11.6 突發事件（`stockEventConfig`）

| 欄位 | 預設 |
| --- | --- |
| `randomEventChance` | 0.12（每次 tick 觸發機率 12%） |
| `cooldownHours` | 2（同事件冷卻） |

- 事件 `effect` 為乘法漲跌（`applyEvent`：`price × (1 + effect)`，保底 floor）。
- `stock = "ALL"` 影響全市場；否則只影響指定代號。
- 內建 33 個靜態事件（`stockEvents.json`，例：蘇伊士運河擱淺 EGPP +20%、市場黑天鵝 ALL −7%、嗶發科 AI 晶片量產 MTKP +16% …）。
- 動態事件存於 `StockEventDefs`，同 `id` 以動態定義覆蓋靜態。
- 觸發後寫 `StockEvents` 並公告到 `announceChannelId`。

`/stock-event`🔒（開發者）子指令：`fire` / `fire-by-id` / `fire-now`（含臨時定義）/ `add` / `remove` / `list`，可強制觸發或管理動態事件。

### 11.7 指令一覽

| 指令 | 用途 |
| --- | --- |
| `/買股 股票代號 數量` | 市價買入 |
| `/賣股 股票代號 數量` | 市價賣出（數量可 `all`） |
| `/持股` | 個人持倉與損益 |
| `/股歷 [期間]` | 個人交易 / 配息紀錄 |
| `/配息紀錄 [期間]` | 配息歷史 |
| `/stock-event ...` 🔒 | 開發者：觸發 / 新增 / 移除突發事件 |

> `/買股`、`/賣股` 只在開盤時間（09:00–21:00）可用，且完成任一筆即標記 `daily_stock` 任務。

---

## 12. 主辦活動（賞金活動）

設定：`src/config/server.json` → `hostedEvents`，指令 `/活動`。
實作：`src/features/event/hostedEvent.js`。

| 欄位 | 預設 |
| --- | --- |
| `publishChannelId` | `1506339475867832330` |
| `maxRankCount` | 5 |
| `refundFeeRate` | 0.3（退款 / 剩餘退回時的防洗錢抽成） |

### 12.1 建立活動

`/活動` 選項：`名稱`、`獎金`（prizePool）、`名次數`（1–5）、`描述`、`最少人數`、`最多人數`。

驗證與流程：

1. 名次數 1 ~ 5；獎金池 ≥ 名次數（每名至少 1 credit）；最少人數 ≥ 1；最多人數 ≥ 最少人數
2. 主辦人餘額 ≥ 獎金池
3. 鎖定獎金池：`source = event_host_lock`（負值 sink）
4. 發佈到 `publishChannelId`，附「參與」「管理（限主辦人）」按鈕；建立失敗自動退款回滾

### 12.2 報名與管理

- 參與者點「參與」加入 / 退出（限報名階段、未截止、未額滿）。
- 主辦人管理面板：`結算名次` / `結束報名`⇄`重新開放報名` / `取消活動`。

### 12.3 結算與退款

**結算**

- 主辦人逐名次用 select 選出得獎者，再以 modal 填入各名次獎金（總和 ≤ 獎金池）。
- 得獎者領 `event_prize`。
- 剩餘（獎金池 − 已發出）退回主辦人，但先扣 30% 抽成：`event_refund` 為扣抽成後淨額。

**取消**

- 整筆獎金池退回主辦人，同樣扣 30% 抽成（`event_refund` 為淨額）。

**退款抽成公式（`refundFee.js`）**

```
fee = floor(amount × refundFeeRate)   // refundFeeRate = 0.3
net = amount − fee
```

> 30% 抽成是防洗錢設計：主辦人無法靠開假活動再全額退款來無損轉移 / 洗幣。

**狀態**：`RECRUITING` → `SETTLED`（已結算） / `CANCELLED`（已取消）。
**相關 source**：`event_host_lock`（鎖定）、`event_prize`（得獎派彩）、`event_refund`（退主辦人）。

---

## 13. 等級 / XP 系統

設定：`src/config/level.json` → `levelSystem`

### 13.1 XP 來源

| 來源 | 規則 |
| --- | --- |
| 訊息 | 15–25 XP / 則，30 秒 cooldown，最少 4 字 |
| 語音 | 10 XP / 分鐘，需 ≥ 2 人，自動忽略 mute / deaf / AFK |
| 簽到 | base 100 + 連勝加成（見下） |
| 反應 | 被加 1 個反應 +2 XP，每人每日上限 50 XP |
| 開台聊天 | 每則 15–25 XP，單場封頂 1,000（見 §2.7） |

### 13.2 簽到 XP 公式

```
streakBonus = min(streak, 30) × 10           // streakBonusCapDays = 30
xp          = 100 + streakBonus
若 streak ≥ 30 → xp × 2.0
否則 streak ≥ 7  → xp × 1.5
最後套 Twitch / Boost / xp_boost buff
```

### 13.3 升等公告

- `levelUpAnnouncement.enabled = true`
- 預設頻道 fallback `1192888968748994700`
- `milestones`：5 / 10 / 20 / 30 / 50 / 75 / 100（這幾級會用大張卡片）
- 升等同時觸發徽章重新評估、發 levelup 金幣

### 13.4 等級身份組

`levelRoles[]`（預設空），管理員可用 `/level-admin roles set` 動態新增；`/level-admin roles apply` 會批次同步全伺服器。

---

## 14. 每日簽到與補簽卡

指令 `/每日簽到`、`/補簽卡`

### 14.1 簽到流程

```
1. 檢查 dailyCheckinCollection 今天紀錄
2. 昨天有簽         → streak += 1
   昨天沒簽但前天有 + 有保護卡 → 消耗 1 張，streak 不歸零
   其餘                       → streak = 1
3. 計算 XP（見 §13.2）+ 金幣（見 §2.3）
4. 寫入 userLevelsCollection（streak / longestStreak / totalCheckins）
5. 透過 grantXp / grantCoins 統一發放
6. 用 satori 產生 30 天月曆樣式簽到卡
```

### 14.2 補簽卡（streak freeze）

| 欄位 | 預設 |
| --- | --- |
| `streakFreezeUnlockEvery` | 30 |
| `maxStreakFreezeStock` | 3 |

- 每連續簽到滿 30 天 +1 張
- 庫存上限 3
- 漏簽 1 天自動消耗 1 張，連勝不歸零
- 漏 2 天以上仍歸零

---

## 15. 徽章與稱號

定義：`src/features/leveling/badgeDefinitions.js`

### 15.1 徽章列表（共 17 枚）

| 類別 | id | 名稱 | 條件 |
| --- | --- | --- | --- |
| 等級 | `level_5` | ⭐ 新星 | Lv ≥ 5 |
| 等級 | `level_10` | 🥈 白銀勳章 | Lv ≥ 10 |
| 等級 | `level_25` | 🥇 黃金勳章 | Lv ≥ 25 |
| 等級 | `level_50` | 💎 白金勳章 | Lv ≥ 50 |
| 等級 | `level_100` | 👑 傳說王者 | Lv ≥ 100 |
| 連勝 | `streak_3` | 🌱 三日連登 | longestStreak ≥ 3 |
| 連勝 | `streak_7` | 🔥 週末戰士 | longestStreak ≥ 7 |
| 連勝 | `streak_30` | 🏅 全勤之月 | longestStreak ≥ 30 |
| 連勝 | `streak_100` | 💯 百日不墜 | longestStreak ≥ 100 |
| 訊息 | `msg_100` | 💬 話匣子 | totalMessages ≥ 100 |
| 訊息 | `msg_1000` | 📣 話癆 | ≥ 1,000 |
| 訊息 | `msg_10000` | 🎙️ 嘴砲大師 | ≥ 10,000 |
| 語音 | `voice_1h` | 🎤 初登麥 | totalVoiceMinutes ≥ 60 |
| 語音 | `voice_10h` | 🗣️ 麥霸 | ≥ 600 |
| 語音 | `voice_100h` | 👑 聲音之王 | ≥ 6,000 |
| 社交 | `react_10` | ❤️ 受歡迎 | totalReactionsReceived ≥ 10 |
| 社交 | `react_100` | 🌟 人氣王 | ≥ 100 |

### 15.2 稱號

- `/level title 設定`：可選任一已解鎖徽章名為稱號，或選目前等級 tier（還原預設）
- `/level displaybadges 設定 / 重置`：自選等級卡下方顯示 5 枚徽章與順序
- `/背包 設定稱號 text`：30 天自訂稱號（需先買 `title_custom` 道具）

---

## 16. 商店與背包

設定：`src/config/shop.json`，指令 `/商店 瀏覽 / 購買`、`/背包`

### 16.1 顏色身份組（`type: role_color`，30 天）

| ID | 名稱 | HEX | 售價 |
| --- | --- | --- | --- |
| `color_red` | 紅色尊爵 | `#E74C3C` | 1,500 |
| `color_orange` | 落日橘 | `#E67E22` | 1,500 |
| `color_gold` | 黃金 | `#F1C40F` | 2,000 |
| `color_green` | 翡翠綠 | `#2ECC71` | 1,500 |
| `color_teal` | 蒂芬妮綠 | `#1ABC9C` | 1,500 |
| `color_blue` | 海洋藍 | `#3498DB` | 1,500 |
| `color_purple` | 神秘紫 | `#9B59B6` | 1,500 |
| `color_pink` | 櫻花粉 | `#FF79C6` | 1,800 |
| `color_silver` | 月光銀 | `#BDC3C7` | 1,800 |
| `color_premium` | ✨ 極光金 | `#FFD700` | 5,000 |

> 已持有未過期同 ID 不能重複購買。Bot 需要 ManageRoles 權限；建立的 role 會 cache 在 `ShopRoleCache`。

### 16.2 加成藥水（`type: xp_boost` / `coin_boost`）

| ID | 名稱 | 倍率 | 時長 | 售價 |
| --- | --- | --- | --- | --- |
| `boost_xp_1h` | XP 1.5×（1h） | ×1.5 | 60 分 | 600 |
| `boost_xp_1d` | XP 1.5×（1d） | ×1.5 | 1,440 分 | 4,000 |
| `boost_xp_double` | XP 2×（1h） | ×2.0 | 60 分 | 1,500 |
| `boost_xp_double_1d` | XP 2×（1d） | ×2.0 | 1,440 分 | 12,000 |
| `boost_coin_1h` | 金幣 1.5×（1h） | ×1.5 | 60 分 | 800 |
| `boost_coin_1d` | 金幣 1.5×（1d） | ×1.5 | 1,440 分 | 5,000 |
| `boost_coin_double_1h` | 金幣 2×（1h） | ×2.0 | 60 分 | 2,500 |

### 16.3 卡面風格（`type: wallet_theme`，永久）

| ID | 名稱 | 售價 |
| --- | --- | --- |
| `theme_temple` | 廟宇籤詩 | 6,000 |
| `theme_nordic` | 北歐極簡 | 7,000 |
| `theme_glitch` | 故障藝術 | 9,000 |
| `theme_vaporwave` | 蒸汽波 | 9,000 |
| `theme_leather` | 皮革撲克 | 12,000 |
| `theme_hologram` | 全息投影 | 15,000 |
| `theme_graffiti` | 街頭塗鴉 | 18,000 |

> 永久解鎖，已擁有不能重買。

### 16.4 自訂稱號

| ID | 售價 | 時長 |
| --- | --- | --- |
| `title_custom` | 10,000 | 30 天 |

---

## 17. 賭場通則

- 設定根節點：`src/config/casino.json`
- 共用紀錄：每局下注都以 `source: "bet"`、派彩 `source: "payout"`，`meta.game` 標記遊戲種類
- 賭場遊戲清單：拉霸、骰寶、二十一點、HI-LO、輪盤、德州撲克、尋寶（Keno）、火箭（Crash）、射龍門、賽馬、樂透
- 每位玩家同 `guildId` 同時只能一局按鈕局（`/二十一點`、`/hilo`、`/射龍門` 等），避免按鈕互踩
- 中途離場（按鈕局逾時無互動）由 cleanup cron 處理：21 點直接退本金；HI-LO 沒贏退本金、有贏自動 cash out
- `BlackjackGames` / `HiloGames` 30 天 TTL；`CoinTransactions` 90 天 TTL
- 「賭桌新手」每日任務以 `bet` 為觸發
- `/賭場排行 type [period]`：可選 today / week / month
- `/我的賭場紀錄`：個人下注、派彩、RTP、各遊戲分項；`/casino-stats`🔒 為全域統計
- 賭場類來源 **不套** Twitch / Boost / 商店 buff 倍率
- 部分遊戲有開放時段：火箭（Crash）僅週六 21:00–24:00（見 §25）

---

## 18. 賭場 ─ 拉霸（吃角子老虎）

指令 `/拉霸 spin <bet>`，設定 `casino.slot`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBet` | 5 |
| `maxBet` | 500 |
| `dailyLossProtection` | 2,000（保留參數） |
| `jackpotPool.enabled` | true |
| `jackpotPool.contributionRate` | 3%（每筆下注 3% 注入彩池） |
| `jackpotPool.seedAmount` | 5,000（爆池後重置） |
| `jackpotPool.poolMilestones` | [10000, 25000, 50000, 100000] |
| `jackpotPool.announceChannelId` | `1501770364982657084` |

### 18.1 符號權重

| 符號 | id | weight |
| --- | --- | --- |
| 🍒 cherry | `cherry` | 35 |
| 🍋 lemon | `lemon` | 25 |
| 🍉 watermelon | `watermelon` | 18 |
| 🔔 bell | `bell` | 12 |
| ⭐ star | `star` | 7 |
| 7️⃣ seven (JACKPOT) | `seven` | 3 |

總權重 = 100；單格機率 = weight / 100。

### 18.2 三連線倍率（純獎金，不含本金）

| 三連線 | 倍率 | 機率（≈） |
| --- | --- | --- |
| 🍒🍒🍒 | ×2 | 0.35³ = 4.29% |
| 🍋🍋🍋 | ×5 | 1.56% |
| 🍉🍉🍉 | ×14 | 0.58% |
| 🔔🔔🔔 | ×28 | 0.17% |
| ⭐⭐⭐ | ×75 | 0.034% |
| 7️⃣7️⃣7️⃣ JACKPOT | ×450 + 整池 | 0.0027% |

### 18.3 兩連線（任兩格相同，第三格不同）

- 一般 ×0.5
- 兩個 🍒 額外加成：×0.5 + ×1.0 = ×1.5

### 18.4 Jackpot Pool 邏輯（`features/casino/slot/jackpotPool.js`）

```
每筆下注：pool += floor(bet × 0.03)
中 7️⃣7️⃣7️⃣：
  base payout = bet × 450
  jackpot 加碼 = max(0, pool − seedAmount)
  pool 重置為 5,000
  在 announceChannelId 推播
```

**目標 RTP**：≈ 82–86%（含通膨控制）

---

## 19. 賭場 ─ 骰寶 Sic Bo

指令 `/骰寶 bet kind 金額`，設定 `casino.sicbo`

| 欄位 | 預設 |
| --- | --- |
| `minBet` | 10 |
| `maxBet` | 1,000 |
| 同時押注數 | ≤ 3 注 |

### 19.1 押法與賠率

> 倍率為「純獎金」（不含本金），實際拿回 = 本金 × (1 + multiplier)。

| 押法 | 條件 | 賠率 |
| --- | --- | --- |
| 大 | 11–17，且非圍骰 | 1:1 |
| 小 | 4–10，且非圍骰 | 1:1 |
| 單骰 N | 三顆骰中出現 N 的次數 c | 1:c（c=1/2/3 → 1/2/3 倍） |
| 對子 N | 任 2 顆 = N | 10:1 |
| 圍骰 N | 三顆都 = N（特定圍骰） | 180:1 |
| 任意圍骰 | 任何三顆同 | 30:1 |
| 總點數 N | 與表對應 | 見下 |

### 19.2 總點數倍率

| 點數 | 倍率 |
| --- | --- |
| 4 / 17 | 60 |
| 5 / 16 | 30 |
| 6 / 15 | 17 |
| 7 / 14 | 12 |
| 8 / 13 | 8 |
| 9 / 10 / 11 / 12 | 6 |

> 3 / 18 與圍骰重複所以不開放。

### 19.3 重要規則

- 「大 / 小」遇到圍骰一律算輸
- 同一局可同時押多注，分別結算

---

## 20. 賭場 ─ 二十一點 Blackjack

指令 `/二十一點 下注 [副數]`，設定 `casino.blackjack`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBet` | 10 |
| `maxBet` | 1,000 |
| `gameTtlSeconds` | 300（按鈕局 5 分鐘逾時） |
| 副數選項 | 1 / 4 / 6 / 8 |

### 20.1 規則（簡化版）

- 1 副 52 張（依玩家選擇 1/4/6/8 副），每局重洗
- 玩家動作：**Hit / Stand / Double**（無 Split、無 Insurance、無 Surrender）
- 莊家：≥17 必停（含 soft 17 也停）
- A 自動軟硬切換（多 A 時取最高不爆值）
- 玩家湊到 21 自動 stand

### 20.2 賠率（payout 是「拿回的總額」，含本金）

| 結果 | payout |
| --- | --- |
| Blackjack（玩家天牌） | bet × 2.5（即 3:2） |
| 過五關 / 莊家爆 / 比點數贏 | bet × 2（1:1） |
| Double 後贏 | bet × 4（含 1:1 與雙倍本金） |
| 過五關（玩家持 5 張未爆） | totalStake × 2，賠率 1:1 |
| 平手（push） | 退本金 |
| 莊家 BJ / 玩家爆 / 莊家過五關 / 比點數輸 | 0 |

### 20.3 過五關（Five-Card Charlie）

- 玩家累積 5 張未爆 → 自動獲勝（賠率 1:1）
- 莊家累積 5 張未爆 → 莊家獲勝（玩家 BJ / 過五關優先結算）
- 設定常數：`FIVE_CARD_THRESHOLD = 5`、`FIVE_CARD_PAYOUT_MULTIPLIER = 2`

---

## 21. 賭場 ─ HI-LO

指令 `/hilo 下注`，設定 `casino.hilo`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBet` | 10 |
| `maxBet` | 1,000 |
| `gameTtlSeconds` | 300 |
| `houseEdge` | 5% |
| `maxRounds` | 10 |

### 21.1 規則

- 1 副 52 張，每局重洗
- 莊家先翻底牌 → 玩家猜下一張 **HI / LO / SAME**
- rank：A=1, 2..10, J=11, Q=12, K=13（花色不影響）
- 猜對：倍率累積，新底牌 = 剛翻牌
- 猜錯：累積全沒
- Cash Out：帶走 `bet × 累積倍率`（含本金）
- **至少猜對 1 把才能 Cash Out**（防無風險套利）
- 達 `maxRounds = 10` 強制結算為 cashout

### 21.2 倍率公式

```
fair = totalCardsLeft / matchingCardsLeft
mul  = floor(fair × (1 − 0.05) × 100) / 100
若 mul < 1.01 → 此選項不開放（return 0 → 視為猜錯）
累積倍率取整：round(acc × 100) / 100
最終 payout = floor(bet × accMultiplier + 1e−9)
```

> ε 修正：避免 100 × 2.01 因浮點變 200.999... 少派 1。

---

## 22. 賭場 ─ 輪盤 Roulette

指令 `/輪盤`，設定 `casino.roulette`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBetPerSlot` | 30 |
| `maxTotalBudget` | 2,000 |
| `bettingTimeoutSeconds` | 90 |
| `gameTtlSeconds` | 300 |

> 0–36 等機率（共 37 格），歐式單零盤。

### 22.1 押注與賠率（倍率 = 純獎金）

| 類型 | 賠率 | 涵蓋格數 |
| --- | --- | --- |
| 紅色 / 黑色 | 1:1 | 18 |
| 奇 / 偶 | 1:1 | 18 |
| 1–18 / 19–36 | 1:1 | 18 |
| 第 1 / 2 / 3 打（dozen） | 2:1 | 12 |
| 第 1 / 2 / 3 列（column） | 2:1 | 12 |
| 零街（0,1,2,3） | 8:1 | 4 |
| 角押（corner） | 8:1 | 4 |
| 雙街（line） | 5:1 | 6 |
| 街押（street） | 11:1 | 3 |
| 雙號（split） | 17:1 | 2 |
| 單號（straight） | 35:1 | 1 |

### 22.2 紅 / 黑號碼

- **紅**：1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36
- **黑**：2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35
- **綠**：0

### 22.3 內圍押法驗證

- **straight**：1 個號碼
- **split**：2 個相鄰號碼（同排左右、或上下差 3）
- **street**：起始號 ∈ {1, 4, 7, ..., 34}
- **corner**：左上角，且不能在第 3 列
- **line**：起始號 ∈ {1, 4, 7, ..., 31}

---

## 23. 賭場 ─ 德州撲克 Poker

指令 `/poker-open ...`，設定 `casino.poker`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBlind` | 10 |
| `maxBlind` | 500 |
| `minPlayers` | 2 |
| `maxPlayers` | 8 |
| `buyInMultiplier` | 50（buy-in = bigBlind × 50） |
| `joinTimeoutSeconds` | 300 |
| `actionTimeoutSeconds` | 60 |
| `gameTtlSeconds` | 900（15 分鐘） |
| `dailyBuyInLimit` | 50,000 |

### 23.1 規則重點

- 標準 No-Limit Texas Hold'em
- 兩人單挑：button = SB，另一位 = BB
- 多人：button 後一位 = SB，再下一位 = BB
- preflop：BB 後第一位先動；其他街從 button 後第一位開始
- 動作：`fold / check / call / raise / allin`（自動算 minRaise；不足額 all-in 不更新 minRaise）
- 邊池（side pots）依 totalBet 分層計算
- 平手按 button 後座位順序均分餘數
- 結束條件：
  - 只剩 1 人沒 fold → 立即結算
  - 到 river 後 showdown，evaluate 7 張
  - 達 actionTimeout 視為 fold

---

## 24. 賭場 ─ 尋寶 Keno

指令 `/尋寶 下注 <bet>`，設定 `casino.keno`，引擎 `features/casino/keno/engine.js`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBet` | 10 |
| `maxBet` | 50,000 |
| `gameTtlSeconds` | 300 |
| `paytable` | `[0, 0, 2, 5, 12, 100]` |

### 24.1 規則

- 20 格地圖（4×5），系統暗藏 5 格寶藏，玩家挑 5 格（可快選 / 清除）
- 選滿 5 格才能揭曉，依命中數派彩
- 按鈕互動局；house edge ≈ 1%

### 24.2 命中倍率（含本金）

| 命中數 | 倍率（含本金） |
| --- | --- |
| 0 | ×0 |
| 1 | ×0 |
| 2 | ×2 |
| 3 | ×5 |
| 4 | ×12 |
| 5 | ×100 |

```
payout = floor(bet × paytable[命中數])
```

---

## 25. 賭場 ─ 火箭 Crash

指令 `/火箭`（含 `下注` / `自動收手` 子指令），設定 `casino.crash`，引擎 `features/casino/crash/engine.js`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBet` | 10 |
| `maxBet` | 5,000 |
| `houseEdge` | 2% |
| `cooldownSeconds` | 300 |
| `openingWindow` | `Asia/Taipei`，週六（weekday 6）21:00–24:00 |

### 25.1 規則

- **只在週六 21:00–24:00 開放**，每次下注後冷卻 300 秒
- 下注後火箭升空，倍率隨時間指數上升直到 bust（爆炸）
- 玩家可隨時「收手」鎖定當前倍率派彩；爆炸前沒收手就歸零
- 可預設「自動收手」倍率（≥ 1.5），達標系統自動結算

### 25.2 Bust 抽法（provably-fair 風格）

```
r ~ Uniform(0, 1)
若 r < houseEdge → bust = 1.00x（發射瞬間就爆）
否則 bust = (1 − houseEdge) / (1 − r)，floor 至兩位小數
```

### 25.3 倍率成長與派彩

```
m(t) = exp(k × t_sec)          // 固定升空速度 k = 0.15/s
局長 = ln(bust) / k             // 安全上限 60 秒
payout = floor(bet × cashout倍率 + 1e−9)
```

> 所有局的爬升斜率相同，玩家無法從「火箭爬多快」反推這局 bust。

---

## 26. 賭場 ─ 射龍門 Dragon Gate

指令 `/射龍門`（`下注` / `梭哈`），設定 `casino.dragonGate`，引擎 `features/casino/dragonGate/engine.js`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `ante` | 50（入場費，開局即扣，房費不退） |
| `minBet` | 50 |
| `maxBet` | 1,000 |
| `gameTtlSeconds` | 300 |
| `houseEdge` | 5% |

### 26.1 規則

- 2 副 104 張，每局重洗
- 開局扣 `ante`（50）做房費，不論結果一律不退
- 莊家翻兩柱；若「對柱」或「連柱」（含 A–K 視為連柱）則重抽，直到取得「有效柱」（兩柱點數不同且不相鄰）
- 玩家抉擇：
  - **不補（fold）**：直接結束，僅損失 ante
  - **補（bet）/ 梭哈**：下注 X ∈ [50, 1000]（梭哈=全押），鎖倉 2X 後開第三張

### 26.2 第三張結算

| 第三張 | 結果 | 拿回 | 淨損益 |
| --- | --- | --- | --- |
| 落在兩柱中間 | between | `2X + floor(X × 倍率)` | 淨贏 X × 倍率 |
| 落在兩柱外面 | outside | `X` | 淨輸 X（外加 ante） |
| 碰柱（=任一柱） | hitGate | `0` | 淨輸 2X（外加 ante） |

### 26.3 倍率公式（依柱後剩餘牌堆）

```
m = (p_outside + 2 × p_hit − houseEdge) / p_between
floor 至兩位小數，最低 1.01
```

---

## 27. 賭場 ─ 賽馬 Horse Racing

指令 `/賽馬`，設定 `casino.horseRacing`，引擎 `features/casino/horseRacing/engine.js`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `minBet` | 10 |
| `maxBet` | 1,000 |
| `bettingWindowSeconds` | 600（開賽前 10 分鐘下注窗） |
| `raceTtlSeconds` | 1,800 |
| `announceChannelId` | `1501770364982657084` |

### 27.1 規則

- 6 匹馬各有獨立勝率與賠率（含本金）
- 玩家挑一匹下注，下注窗 10 分鐘
- 系統依各馬勝率「先決定贏家」，再倒推每幀位置動畫；中獎拿 `floor(bet × 賠率)`
- 多人可同場下注，結果公告到頻道；房費 ≈ 10%

### 27.2 馬匹與賠率（賠率含本金）

| 馬 | emoji | 勝率 | 賠率（含本金） |
| --- | --- | --- | --- |
| 閃電 | 🐎 | 30% | ×3.0 |
| 黑風 | 🐴 | 22% | ×4.0 |
| 金箭 | 🦄 | 17% | ×5.5 |
| 銀月 | 🦌 | 13% | ×7.0 |
| 紅炎 | 🐂 | 10% | ×9.0 |
| 夜影 | 🦓 | 8% | ×11.0 |

---

## 28. 賭場 ─ 樂透 Lottery

設定：`casino.lottery`，獨立子系統，**不算入賭場 RTP**。

### 28.1 通用排程與頻道

| 欄位 | 預設 |
| --- | --- |
| `announceChannelId` / `poolMilestoneChannelId` | `1501770364982657084` |
| `reminderCron` | `0 * * * *`（每小時檢查提醒） |
| `timezone` | `Asia/Taipei` |

各玩法在 `types.<玩法>` 自行設定開獎時段（`drawWeekdays`：1=Mon…7=Sun；`drawHour`：0–23）。訂閱扣款固定在該玩法每次開獎前 30 分鐘。

### 28.2 玩法

| 玩法 | range | pickCount | 票價 | 系統種子 | 開獎時段 |
| --- | --- | --- | --- | --- | --- |
| `6_49`（大樂透） | 1–49 | 6 | 50 | 5,000 | 每週日 21:00 |
| `3_20`（小樂透） | 1–20 | 3 | 10 | 500 | 每週三、週日 21:00 |

- `maxTicketsPerOrder`：兩種都 100
- `wheeling`：6/49 開放（最多 10 個 base 號碼）；3/20 不開放

### 28.3 派彩公式

#### 6/49

| 中幾號 | 獎項 | 配額 / 數量 |
| --- | --- | --- |
| 6 | 頭獎 | 70% pool |
| 5 | 二獎 | 15% pool |
| 4 | 三獎 | 10% pool |
| 3 | 四獎 | 固定 100 / 張 |
| 其他 | 滾入下期 | 5% + 餘數 |

> 頭獎 0 人中 → 整個 pool（含 2nd / 3rd 配額）全部滾下期；二獎沒人中時 15% 也滾。
> 同獎項多人時平分（floor），餘數一併滾下期。

#### 3/20

| 中幾號 | 獎項 | 配額 |
| --- | --- | --- |
| 3 | 頭獎 | 80% pool |
| 2 | 二獎 | 固定 50 / 張 |
| 其他 | 滾入下期 | 20% + 餘數 |

> 頭獎 0 人中 → 全部滾。二獎是系統固定支出，不從 pool 扣。

### 28.4 訂閱機制

| 欄位 | 預設 |
| --- | --- |
| `maxDrawsPerSubscription` | 12 |
| `maxTicketsPerDraw` | 10 |
| `consecutiveFailureThreshold` | 2（連 2 次扣款失敗自動暫停） |

訂閱可選自選號碼或隨機；扣款由 `subscriptionCron` 觸發。

### 28.5 池里程碑

| 玩法 | milestones |
| --- | --- |
| 6/49 | 10k / 20k / 30k / 50k / 75k / 100k / 150k / 200k |
| 3/20 | 1k / 2k / 5k / 10k |

跨過時推到 `poolMilestoneChannelId`。

### 28.6 期中提醒

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `countRange` | [1, 2]（每期 1–2 次） |
| `earliestAfterOpenHours` | 24 |
| `latestBeforeDrawHours` | 24 |
| `minIntervalHours` | 48 |
| `daytimeWindow` | 10:00–22:00 |

### 28.7 號碼處理

- 使用 `crypto.randomInt` 確保隨機性
- 包牌（wheeling）展開 C(n, pickCount) 全部組合
- 號碼分隔符接受：空白 / `,` / `，` / `、` / `.` / `。` / `/` / `\` / `-` / `+`

### 28.8 指令一覽

| 指令 | 用途 |
| --- | --- |
| `/樂透資訊` | 當期獎池、開獎時間、剩餘時間 |
| `/樂透買 玩法 [張數] [號碼]` | 單張或多張，可自選或隨機 |
| `/樂透包牌 玩法 號碼` | 7 個以上號碼自動展開 |
| `/樂透訂閱 玩法 期數 每期張數 [號碼]` | 訂閱 N 期 |
| `/樂透訂閱列表` | 查 / 取消訂閱 |
| `/樂透歷史 [筆數]` | 個人中獎紀錄 |
| `/lotteryadmin ...` 🔒 | 開發者：強制開獎、補建期、跑訂閱、補發提醒 |

---

## 29. 防呆 / 防洗幣 / 風控

| 機制 | 設定 / 行為 |
| --- | --- |
| 入伺 7 天門檻 | `coinSystem.eligibility.minServerTenureDays` |
| 帳號 30 天門檻（救濟金） | `welfareSystem.minAccountAgeDays` |
| 被邀請者帳號 7 天門檻 | `inviteSystem.minInviteeAccountAgeDays`（不足略過整筆邀請） |
| 訊息 / 語音每日上限 200 | `messageVoiceDailyCap` |
| 反應每日上限 10 金幣 | `coinSystem.reaction.dailyCapPerUser` |
| 開台聊天 XP / 金幣單場上限 | `twitchSync.perSessionXpCap` / `coinPayout.perSessionCap`（各 1,000，sessionId 冪等） |
| 轉帳冷卻 30 分鐘 | `transfer.cooldownSeconds` |
| 轉帳每日上限 20,000 | `transfer.dailyCapPerSender` |
| 雙向轉帳偵測（24h ≥ 5,000） | `suspiciousTransferDetector` |
| 管理員每日 500,000 上限 | `adminGrant.dailyCapPerAdmin` |
| 財富稅每週累進課稅（2%~70%） | `wealthTax.brackets`（免稅額 50k） |
| 股市手續費 / 持股上限 | `feeRate` 1%（買賣皆收）、`maxSharesPerUser` 500、僅開盤可下單 |
| 活動退款抽成 30% | `hostedEvents.refundFeeRate`（防靠假活動全額退款洗幣） |
| 邀請每日發獎上限 3 + 14 天 clawback | `dailyMaxInvites`、`clawbackDays`（早退扣回獎勵） |
| 賭場單局鎖定 | 同 `guildId` 同時只能一局按鈕局 |
| 賭場逾時退款 | 21 點退本金；HI-LO 沒贏退本金、有贏自動 cashout |
| 火箭限定時段 | 僅週六 21:00–24:00，下注冷卻 300s |
| 樂透訂閱失敗自動停 | 連 2 次扣款失敗 |
| 商店重複購買檢查 | 主題永久不可重買、role/title 未過期不可重買 |

---

## 30. 每日經濟報告

設定：`coinSystem.dailyEconomyReport`

| 欄位 | 預設 |
| --- | --- |
| `enabled` | true |
| `channelId` | `1501627333835096154` |
| `cronSchedule` | `0 8 * * *`（每天 08:00） |
| `lookbackDays` | 7 |
| `casinoLookbackDays` | 7 |
| `suspiciousLookbackHours` | 24 |

**outflow sources**（`economyDailyReportScheduler.js`）：`bet`、`deposit_lock`、`transfer_out`、`shop_buy`、`wealth_tax`、`stock_buy`、`stock_fee`

報告內容預期含：流入 / 流出總額、賭場 RTP、TopN 大戶、可疑雙向轉帳列表。

> 另有 `economySnapshotScheduler.js` 定期快照全服流通量；管理員可用 `/circulation`🔒 查全 guild 金幣流通量。

---

## 31. MongoDB Collection 速覽

| Collection | 內容 | TTL |
| --- | --- | --- |
| `UserCoins` | 每位玩家每個 guild 的 totalCoins、來源累計、lifetime | — |
| `CoinTransactions` | 每筆金錢異動，含 `source`、`meta`、`date` | 90 天 |
| `JackpotPool` | 每 guild 一筆拉霸彩池 | — |
| `BlackjackGames` | in-flight + 已結算 21 點對局 | 30 天 |
| `HiloGames` | in-flight + 已結算 HI-LO 對局 | 30 天 |
| `LotteryDraws` / `LotteryTickets` / `LotterySubscriptions` / `LotteryWheels` | 樂透期數、票券、訂閱、包牌 | — |
| `StockMarket` | 每 guild 每檔股票當前價格與設定 | — |
| `StockPrices` | 歷史報價（tick / event 寫入） | — |
| `StockTransactions` | 股票買 / 賣 / 配息紀錄 | — |
| `UserPortfolio` | 個人持倉（shares、avgCost） | — |
| `StockEvents` | 已觸發的突發事件紀錄 | — |
| `StockEventDefs` | 動態突發事件定義 | — |
| `HostedEvents` | 主辦活動（RECRUITING / SETTLED / CANCELLED） | — |
| `InviteRecords` | 邀請紀錄（active / left / clawed_back、rewardGranted） | — |
| `InviteCache` | 邀請碼使用次數快取（比對用） | — |
| `TwitchScoreFlushes` | 開台聊天結算冪等紀錄（sessionId） | — |
| `UserInventory` | 商店背包（卡面、顏色、藥水、稱號） | — |
| `ShopTransactions` | 商店購買紀錄 | — |
| `ShopRoleCache` | 動態建立的顏色身份組 cache | — |
| `CoinTransfers` | 轉帳每日額度 / 細項 | — |
| `CoinDeposits` | 定存單（active / claimed / early_claimed） | — |
| `WelfareClaims` | 救濟金紀錄（lastClaimDate、streak） | — |
| `UserLevels` | 等級、XP、簽到、徽章、稱號、卡面主題 | — |
| `DailyCheckin` | 每日簽到（{userId, guildId, date} unique） | — |
| `Quests` / `QuestProgress` | 任務進度 | 每日 / 每週滾動 |
| `TwitchLiveState` | Twitch 開台去重（與經濟系統無關，但同 DB） | — |

---

## 附錄 A：檔案索引

| 檔案 | 內容 |
| --- | --- |
| `src/config/level.json` | `coinSystem` / `levelSystem` / `twitchSync` |
| `src/config/casino.json` | 全部賭場 + 樂透 |
| `src/config/shop.json` | 商店道具 |
| `src/config/quests.json` | 每日 / 每週任務 |
| `src/config/welfare.json` | 救濟金 |
| `src/config/stocks.json` / `stockEvents.json` | 股市與突發事件 |
| `src/config/invite.json` | 邀請獎勵 |
| `src/config/server.json` → `hostedEvents` | 主辦活動 |
| `src/features/economy/grantCoins.js` | 金幣異動唯一入口 |
| `src/features/economy/coinMultiplier.js` | Twitch / Boost 倍率判斷 |
| `src/features/economy/dailyCoinCap.js` | 每日上限聚合 |
| `src/features/economy/eligibility.js` | 入伺 / 帳齡檢查 |
| `src/features/economy/refundFee.js` | 活動退款抽成 |
| `src/features/economy/suspiciousTransferDetector.js` | 雙向轉帳告警 |
| `src/httpServer/flushChatScore.js` | Twitch 開台聊天 XP / 金幣結算 |
| `src/features/casino/slot/{paytable,slotMachine,jackpotPool}.js` | 拉霸 |
| `src/features/casino/sicbo/{paytable,engine}.js` | 骰寶 |
| `src/features/casino/blackjack/{deck,hand,engine}.js` | 21 點 |
| `src/features/casino/hilo/engine.js` | HI-LO |
| `src/features/casino/roulette/{numbers,engine}.js` | 輪盤 |
| `src/features/casino/poker/{deck,hand,engine,service}.js` | 撲克 |
| `src/features/casino/keno/engine.js` | 尋寶 Keno |
| `src/features/casino/crash/{engine,tick}.js` | 火箭 Crash |
| `src/features/casino/dragonGate/engine.js` | 射龍門 |
| `src/features/casino/horseRacing/{engine,raceRunner}.js` | 賽馬 |
| `src/features/casino/lottery/{numbers,payout,wheeling,draw,subscriptions,...}.js` | 樂透 |
| `src/features/stock/{tradeService,portfolioService,priceEngine,eventEngine,dividendService}.js` | 股市 |
| `src/features/invite/{grantInviteReward,clawbackInviteReward,rewardFormula}.js` | 邀請獎勵 |
| `src/features/event/hostedEvent.js` | 主辦活動 |
| `src/features/shop/{catalog,buyItem,activeBuff,equipItem,roleColor}.js` | 商店 |
| `src/features/welfare/welfareService.js` | 救濟金 |
| `src/features/quests/{questDefinitions,questService}.js` | 任務 |
| `src/features/leveling/{grantXp,badgeDefinitions,badgeChecker,levelRoles,levelUpAnnouncer}.js` | 等級 |
| `src/events/ready/wealthTaxScheduler.js` | 財富稅 cron |
| `src/events/ready/economyDailyReportScheduler.js` | 每日經濟報告 cron |
