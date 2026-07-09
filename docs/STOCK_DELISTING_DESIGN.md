# 【股市新增企劃】—— 個股下市・整理期・強制結算

> 版本:v0.1（設計草案，尚未實作）
> 對照 bibi-bot 現行股市系統（`src/features/stock/*`、`src/config/stocks.json`）設計，盡量複用既有的 `enabled` 停牌判斷、`floor` 地板、`grantCoins` 金流、排程掃描，不另起爐灶。

> **背景**：目前每支股票都有 `floor`（約開盤價 20%）在所有價格路徑上用 `Math.max(floor, ...)` 夾住（`priceEngine.js` 的 `nextPrice` / `nextPriceAdvanced` / `applyEvent` / `priceImpact`），股價**永遠不會歸零**。本企劃討論「爛股被淘汰下市」這個機制要不要做、以及**怎麼做才不會變成隨機沒收玩家資產**。

---

## 一、提案概述與核心決策

### 要解決的體驗問題

有了 `floor` 保底，任何股票最慘也只跌到開盤價 1/5 就止跌、永遠不下市。好處是玩家不會血本無歸；壞處是**爛股沒有真正的下場**——長期陰跌的股票就一直躺在盤面上，缺乏「這支要完了、快跑」的張力。

### 核心決策:結算式下市，不是歸零式下市

真實市場的下市**不等於股票變 0**，而是「停止交易 + 按殘值結算給股東」。本企劃採同樣原則：

- ❌ **不採用**：股價跌到某點 → 直接把股票 `enabled: false`、持股人手上部位歸零、賣都賣不掉。
  - 這會讓玩家覺得「錢投進股市隨時被系統無預警沒收」，**砸掉整個股市系統的信任感**，違反現有 `floor` 提供的保護契約。
- ✅ **採用**：跌破門檻 → 進入**下市整理期（預警）**給逃命窗口 → 期滿仍不達標 → **按最後價格強制折現退幣**給股東 + 強制回補所有融券 → 停牌 → 隔期**重新上市（IPO）**補位。

> 一句話：保留「爛股會被淘汰」的刺激，但用「預警 → 逃命期 → 按殘值結算」取代「無預警歸零」。

### 設計原則（對齊 `CLAUDE.md`）

- **複用優先**：停牌走既有的 `enabled === false`（所有交易入口已擋）；退幣/回補走 `grantCoins`；下市掃描比照 `shortService.runMarginScan` / `triggerService.runScan` 的排程掃描模式。
- **config 驅動**：所有門檻、天數、結算比例放 `src/config/stocks.json` 的 `delisting` 區塊。
- **compute-on-read 相容**：下市狀態存在 market doc（`listingStatus` + `statusSince`），估值/排行榜讀取時即時判斷，不寫死玩家 profile。
- **絕不無預警沒收**：整理期一定有公告 + `/持股` 標記，整理期內**照常能賣**（只鎖買進與放空）。
- **coin 影響中性偏收縮**：強制退幣是系統付幣（source），但退的是玩家原本就持有的殘值、且下市後少了配息出口，整體不擴張通膨。

---

## 二、下市狀態機

在 market doc 上新增 `listingStatus` 欄位（現有 `enabled` 布林保留，作為「能不能交易」的最終開關，由狀態機驅動）。

```
                     跌破 dangerThreshold 連續 dangerDays 天
   normal ───────────────────────────────────────────────▶ warning
     ▲                                                         │
     │  警示期內任一天收在 recoverThreshold 之上               │ 整理期滿 delistGraceDays 天
     │  連續 recoverDays 天 → 撤銷警示                         │ 仍未回升
     └─────────────────────────────────────────────────────  ▼
                                                          delisted（enabled:false）
                                                               │ 冷卻 relistCooldownDays 天
                                                               ▼
                                                        （IPO 補位：見 §五）
```

| `listingStatus` | `enabled` | 可買 | 可賣 | 可放空 | 說明 |
|---|---|---|---|---|---|
| `normal` | true | ✅ | ✅ | ✅ | 一般狀態 |
| `warning`（整理期） | true | ❌ | ✅ | ❌ | 只准出場：鎖買進與放空，開放賣出/回補 |
| `delisted` | false | ❌ | ❌ | ❌ | 已下市，部位已在轉入當下強制結算完畢 |

> `warning` 期間鎖買進與放空的理由：不讓人「抄底一支正在下市的股票」或「壓一支反正要歸零的股票無風險套利」，整理期的唯一動作是**出清**。

---

## 三、觸發與結算參數（折衷基準，全部可調）

放 `src/config/stocks.json` → `stockSystem.delisting`：

```json
{
  "delisting": {
    "enabled": true,
    "scanCronSchedule": "5 21 * * *",
    "timezone": "Asia/Taipei",
    "dangerThresholdPct": 1.05,
    "dangerDays": 5,
    "recoverThresholdPct": 1.30,
    "recoverDays": 3,
    "delistGraceDays": 3,
    "settlementPriceBasis": "floor",
    "settlementFeeWaived": true,
    "relistCooldownDays": 7,
    "announce": true
  }
}
```

| 參數 | 基準 | 意義 |
|---|---|---|
| `dangerThresholdPct` | **1.05** | 「危險價」= `floor × 1.05`。收盤 ≤ 此價視為瀕臨地板。 |
| `dangerDays` | **5** | 連續 5 個交易日收在危險價以下 → 進入 `warning`。 |
| `recoverThresholdPct` | **1.30** | 「脫離價」= `floor × 1.30`。 |
| `recoverDays` | **3** | `warning` 中連續 3 天收在脫離價之上 → 撤回 `normal`（洗白）。 |
| `delistGraceDays` | **3** | 整理期長度。進 `warning` 後給 3 天逃命，期滿仍未 recover → `delisted`。 |
| `settlementPriceBasis` | **`floor`** | 強制結算單價基準：`floor`（保守，退地板價）或 `lastClose`（退最後收盤價，通常略高於 floor）。 |
| `settlementFeeWaived` | **true** | 強制結算免手續費/證交稅（非玩家主動賣出，不該被抽）。 |
| `relistCooldownDays` | **7** | 下市後多久可重新上市補位。 |

> 觸發用「連續 N 天收盤」而非「盤中觸價」，避免單筆放空砸到地板就誤觸下市。判定放在**每日收盤後**的掃描（`scanCronSchedule` 設在 21:05，收盤 21:00 之後）。

---

## 四、強制結算流程（進入 `delisted` 當下，一次做完）

掃描判定某股 `warning` 整理期滿仍未 recover，對該 guild、該 symbol：

1. **鎖交易**：market doc 設 `listingStatus: "delisted"`、`enabled: false`、`statusSince: now`。之後所有交易入口自動回 `no_symbol`（既有邏輯，不需改）。
2. **結算多頭持股**：查所有持有此 symbol 的部位（`stockPortfolioCollection`），每人：
   - 退幣 `payout = shares × settlementPrice`（`settlementPrice` 依 `settlementPriceBasis`，免稅免手續費）。
   - `grantCoins(client, { source: "stock_delist_settlement", amount: payout, meta: { symbol, shares, price } })`。
   - 刪除/清零該部位。
   - 私訊通知：「📉 XX（`SYMBOL`）已下市，你的 N 股按 每股 $P 強制結算，退回 $payout。」
3. **結算未平倉融券**：查所有此 symbol 的未回補融券（`stockShortsCollection`），每筆按 `settlementPrice` 強制回補結算：
   - 損益 = `(avgShort − settlementPrice) × shares`，退還保證金 ± 損益（比照 `shortService` 現有強制回補的金流，免手續費）。
   - 私訊通知回補結果。
4. **公告**（`announce`）：股市頻道紅色 Container「📉 XX（`SYMBOL`）已下市」+ 結算摘要（影響 N 名股東、M 筆融券）+「下市整理已完成，將於 `relistCooldownDays` 天後有新股上市」。
5. **清尾**：撤銷此 symbol 尚未觸發的觸價單（`triggerService`）、把它排出配息名單（`dividendService` 自然會因 `enabled:false` 略過，確認一次）。

> 全程**沒有任何玩家部位卡死或歸零**：多頭拿回殘值、空頭結清損益，帳面乾淨。

---

## 五、重新上市（IPO 補位）

pool 目前只有 9 支，下市一支就少一支，市場會越縮越小 → **必須補位**。

- 下市滿 `relistCooldownDays` 天後，由開盤排程檢查：若某 symbol 處於 `delisted` 且已過冷卻，**重新上市**。
- 兩種補位策略（config 選）：
  - **原地重生**：同 symbol 重新 `listingStatus: normal`、`enabled: true`，價格重設回 `initialPrice`（或 `initialPrice` 的某折數，象徵「重整後重新掛牌」）。實作最省，pool 不變。
  - **換新股**：從一組「候補新股清單」抽一支沒在盤上的新 symbol 上市（需要擴 pool）。較有新鮮感，但要多維護候補清單。
- **建議先做「原地重生」**：改動最小，直接把下市那支重設價格重新掛牌，並公告「XX 重整後重新上市，掛牌價 $X」。

---

## 六、UX / 顯示

- **`/股市` 列表**：`warning` 的股票標紅「⚠️ 下市整理中（剩 N 天，跌破 $X 將下市）」；`delisted` 不顯示或收到底部灰字。
- **`/持股`**：持有 `warning` 股票時，該列標紅並附 -# 提示「此股進入下市整理，剩 N 天，建議評估是否出場」+ 保留賣出按鈕。
- **進入 `warning` 當下公告**：股市頻道 Container「⚠️ XX（`SYMBOL`）跌破下市警戒，進入 N 天整理期。期間僅開放賣出，未能於 $脫離價 之上站穩將下市結算。」
- **錯誤訊息**：`warning` 期間嘗試買進/放空 → Container「🔒 XX 下市整理中，暫停買進與放空，僅開放出場」（比照 `CLAUDE.md` UX #2、#6 格式，寫明狀態+原因+剩餘天數）。

---

## 七、需要動到的檔案（實作時）

| 檔案 | 改動 |
|---|---|
| `src/config/stocks.json` | 新增 `stockSystem.delisting` 區塊 |
| `src/features/stock/delistService.js` | **新增**：狀態機推進 + 強制結算 + 每日掃描 |
| `src/features/stock/tradeService.js` | 買進檢查 `listingStatus === "warning"` → 擋；賣出照常 |
| `src/features/stock/shortService.js` | 開倉檢查 `warning` → 擋；`runMarginScan` 對 `delisted` 的殘留部位收斂 |
| `src/features/stock/seedService.js` | market doc 補 `listingStatus: "normal"`、`statusSince` 預設 |
| `src/events/ready/stockDelistScheduler.js` | **新增**：收盤後 cron 呼叫 `delistService` 掃描 |
| `src/events/ready/marketScheduler.js` | 開盤排程加「冷卻期滿 → 重新上市」檢查 |
| `src/commands/stock/stockMarket.js` / `src/features/profile/views/stockHoldings.js` | 顯示 `warning` / `delisted` 狀態 |
| `src/features/economy/grantCoins.js` | 補 source：`stock_delist_settlement`（flat，不套倍率） |
| `bibi-website` `src/lib/dashboard/botDefs.ts` | 若補位換新股，同步新 symbol 中文名 |

---

## 八、金流與通膨影響

- **強制退幣是 source（系統付幣）**，但退的是股東**原本帳面就持有**的殘值（≤ 地板價 × 股數），不是憑空新增財富；且下市後這支不再配息（少一個既有 source）。
- **融券結算 zero-sum**：空頭的獲利來自保證金機制內的價差，非系統增發。
- 整體對通膨**中性偏收縮**，方向與現有財富稅、盜賊系統一致，不會因為「下市」而放水金幣。

---

## 九、待確認決策（實作前拍板）

1. `settlementPriceBasis` 用 `floor`（保守）還是 `lastClose`（對股東稍友善）？— 建議 `floor`，維持「下市＝殘值」的體感。
2. 補位用「原地重生」還是「換新股」？— 建議先原地重生，改動最小。
3. 下市是否要**很罕見**（門檻拉嚴、幾乎不會觸發，純粹當威懾）還是**偶爾真的發生**（門檻適中，製造事件）？— 影響 `dangerDays` / `dangerThresholdPct` 的鬆緊。
4. 要不要限制「同一時間最多只有 1 支處於 warning/delisted」，避免多支同時下市把盤面掏空？
