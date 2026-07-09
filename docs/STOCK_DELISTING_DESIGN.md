# 【股市新增企劃】—— 個股下市・整理期・強制結算

> 版本:v0.2（四大決策已拍板，見 §九；尚未實作）
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

**觸發改為事件驅動**（見 §二之一）：不靠「連續 N 天收在地板」（現引擎的均值回歸讓這條件幾乎不成立），而是由稀有的「基本面崩壞」利空事件把 `fairValue` 一併砍到地板附近，股票才會合理地待在地板 → 進整理期。

```
                     命中「基本面崩壞」事件（fairValue 崩到地板）
   normal ───────────────────────────────────────────────▶ warning
     ▲                                                         │
     │  整理期內若 fairValue 被利多修復、                       │ 整理期滿 delistGraceDays 天
     │  連續 recoverDays 天收在脫離價之上 → 撤銷警示            │ 仍未回升
     └─────────────────────────────────────────────────────  ▼
                                                          delisted（enabled:false）
                                                               │ 冷卻 relistCooldownDays 天
                                                               ▼
                                                        （換新股補位：見 §五）
```

| `listingStatus` | `enabled` | 可買 | 可賣 | 可放空 | 說明 |
|---|---|---|---|---|---|
| `normal` | true | ✅ | ✅ | ✅ | 一般狀態 |
| `warning`（整理期） | true | ❌ | ✅ | ❌ | 只准出場：鎖買進與放空，開放賣出/回補 |
| `delisted` | false | ❌ | ❌ | ❌ | 已下市，部位已在轉入當下強制結算完畢 |

> `warning` 期間鎖買進與放空的理由：不讓人「抄底一支正在下市的股票」或「壓一支反正要歸零的股票無風險套利」，整理期的唯一動作是**出清**。

### 二之一、為什麼一定要事件驅動（引擎現實）

追過價格引擎後確認，**純價格觸發在現引擎下幾乎不會發生**，原因是兩層向上的力：

- **均值回歸**（`priceEngine.js:65`）：`r += kappa × log(fairValue / lastPrice)`，`kappa = 0.02`。股價越接近地板（≈ `fairValue` 的 20%），`log(fair/price) ≈ log(5) ≈ 1.61`，換算成**每 tick +3.2% 的上拉**；盤中每分鐘一 tick、一天約 720 tick。越跌反彈越猛。
- **`fairValue` 幾乎不動**（`priceEngine.js:74` `nextFairValue`）：只靠情緒每天位移 `±fairValueDailyDrift`（0.002）。要讓 `fairValue` 從開盤價跌到地板需數百個交易日永久熊市 → 實務上不可能。
- **利空事件只砸 `currentPrice`、不動 `fairValue`**（`eventEngine.js:89` `applyEvent`）：所以任何利空只是暫時打下去，反彈立刻把它拉回 fairValue 附近。

**結論**：要讓股票能「合理地待在地板」，必須讓 `fairValue` 本身崩掉。因此下市由一個**專用的「基本面崩壞」事件**觸發，它同時：

1. 把 `fairValue` 砍到 `floor × crashFairMult`（例：`1.05`，逼近地板）。
2. 把 `currentPrice` 砸到接近地板（走既有 `applyEvent`，但幅度大）。
3. 把該股 `listingStatus` 設為 `warning`、`statusSince = now`、公告整理期開始。

之後均值回歸改成「拉向已崩掉的 fairValue」→ 股價自然黏在地板 → 整理期滿未被利多救回 → 下市。這也是唯一需要**碰到引擎**的地方：`applyEvent` 之外，多一條「事件可選擇性地改寫 `fairValue`」的路徑（新增欄位 `fairEffect`，預設不動 fairValue，只有基本面崩壞事件會帶）。

> **稀有度**：此事件放進 `stockEvents.json`，權重壓到極低（例：一般利空的 1/50），並限定只打高波動 meme 股（`嗶嗶海運` σ0.045、`長嗶航空` σ0.049）。目標頻率：一年數次、不是每週。

---

## 三、觸發與結算參數（折衷基準，全部可調）

放 `src/config/stocks.json` → `stockSystem.delisting`：

```json
{
  "delisting": {
    "enabled": true,
    "scanCronSchedule": "5 21 * * *",
    "timezone": "Asia/Taipei",
    "crashFairMult": 1.05,
    "recoverThresholdPct": 1.30,
    "recoverDays": 3,
    "delistGraceDays": 3,
    "settlementPriceBasis": "lastClose",
    "settlementFeeWaived": true,
    "relistCooldownDays": 7,
    "maxConcurrentDelisting": 0,
    "announce": true
  }
}
```

| 參數 | 基準 | 意義 |
|---|---|---|
| `crashFairMult` | **1.05** | 基本面崩壞事件把 `fairValue` 砍到 `floor × 1.05`（逼近地板，讓均值回歸改往地板拉）。 |
| `recoverThresholdPct` | **1.30** | 「脫離價」= `floor × 1.30`。整理期內若被利多把 `fairValue`／股價救起。 |
| `recoverDays` | **3** | `warning` 中連續 3 天收在脫離價之上 → 撤回 `normal`（洗白，罕見）。 |
| `delistGraceDays` | **3** | 整理期長度。進 `warning` 後給 3 天逃命，期滿仍未 recover → `delisted`。 |
| `settlementPriceBasis` | **`lastClose`** ✅ | 強制結算單價基準。**已拍板 lastClose**：退最後收盤價，對股東稍友善且最直覺；整理期鎖買進，無操縱風險。 |
| `settlementFeeWaived` | **true** | 強制結算免手續費/證交稅（非玩家主動賣出，不該被抽）。 |
| `relistCooldownDays` | **7** | 下市後多久換一支新股上市補位（見 §五）。 |
| `maxConcurrentDelisting` | **0（不限制）** ✅ | **已拍板不限制**：因採換新股補位，下市一支補一支，pool 不會縮水，故同時多支下市亦安全。`0` = 不設上限。 |

> 觸發改為**事件驅動**（§二之一），不再用「連續 N 天收盤」。整理期滿與 recover 判定仍放在**每日收盤後**的掃描（`scanCronSchedule` 設在 21:05，收盤 21:00 之後）。

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

## 五、換新股補位（已拍板）

pool 現役只有 9 支，下市一支就少一支 → 採**換新股**補位：下市時把該 symbol 從現役盤面退場，冷卻滿 `relistCooldownDays` 天後，由開盤排程從**候補新股清單**抽一支沒在盤上的新 symbol 掛牌上市。這樣現役檔數長期維持穩定，也讓盤面持續有新鮮感。

- **候補清單放 config**：`stockSystem.candidatePool`（結構同現有 `pool` 的個股欄位：`symbol / name / initialPrice / sigma / beta / floor / type / dividendYield`）。
- **抽選規則**：開盤排程檢查有無「空出的現役名額」（有 symbol 剛過冷卻退場、或現役檔數 < 目標 9 檔），若有則從 `candidatePool` 中「尚未上市過」的抽一支，seed 進 `stockMarketCollection`（比照 `seedService.backfillPoolStocks`），公告「🆕 新股上市：XX（`SYMBOL`）掛牌價 $X」。
- **候補耗盡的退路**：若 `candidatePool` 全抽完，退回**原地重生**——把最久之前下市那支重設價格重新掛牌（公告「重整後重新上市」）。避免盤面真的縮到 8 檔以下。
- **⚠️ 網站同步**：新 symbol 一旦可能被玩家看到，必須同步 `bibi-website` `src/lib/dashboard/botDefs.ts`（`STOCKS` 或對應名稱表），否則網站 dashboard 會 fallback 成 `(id)`（見兩 repo 的 CLAUDE.md 名稱規則）。候補清單裡的股票**一開始就先補進 botDefs.ts**，不要等上市才補。

### 候補新股清單（提案，命名待你定調）

延續現有「嗶」系雙關（嗶積電＝台積電、統嗶超商＝統一超商…），先擬幾檔候補，數值先給草案、上市價/波動可再調。**名字是你社群的風味，這份只是起頭，隨你改：**

| symbol | 提案名 | 影射 | initialPrice | sigma | beta | floor | type | 殖利率 |
|---|---|---|---|---|---|---|---|---|
| `NVPP` | 嗶偉達 | NVIDIA | 700 | 0.030 | 1.6 | 140 | tech | 0.01 |
| `TXPP` | 嗶斯拉 | Tesla | 420 | 0.040 | 2.0 | 84 | tech | 0 |
| `GLPP` | 嗶金糖 | 大立光 | 900 | 0.018 | 1.1 | 180 | tech | 0.05 |
| `PXPP` | 全嗶超商 | 全家 | 260 | 0.007 | 0.5 | 52 | blue | 0.06 |
| `BKPP` | 嗶山銀行 | 玉山金 | 150 | 0.008 | 0.6 | 30 | blue | 0.08 |
| `MMPP` | 嗶迷因 | 迷因/航運題材 | 80 | 0.050 | 2.5 | 16 | meme | 0 |

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
| `src/config/stocks.json` | 新增 `stockSystem.delisting` 區塊 + `stockSystem.candidatePool` 候補新股清單 |
| `src/config/stockEvents.json` | 新增稀有「基本面崩壞」事件（極低權重、限 meme 股、帶 `fairEffect`） |
| `src/features/stock/eventEngine.js` | 事件套用時多一條 `fairEffect` 路徑：可選擇性改寫 `fairValue`（預設不動，只有基本面崩壞帶）；命中時把該股設 `warning` |
| `src/features/stock/priceEngine.js` | `applyEvent` 增加可選 `fairEffect` 回傳，或新增 `applyFairCrash`（不動核心均值回歸公式，只多一條寫 fairValue 的入口） |
| `src/features/stock/delistService.js` | **新增**：整理期/ recover 判定、期滿強制結算（多頭 lastClose 退幣 + 融券強制回補）、狀態機推進 |
| `src/features/stock/tradeService.js` | 買進檢查 `listingStatus === "warning"` → 擋；賣出照常 |
| `src/features/stock/shortService.js` | 開倉檢查 `warning` → 擋；`runMarginScan` 對 `delisted` 的殘留部位收斂 |
| `src/features/stock/seedService.js` | market doc 補 `listingStatus: "normal"`、`statusSince` 預設；抽候補新股上市（換新股補位）|
| `src/events/ready/stockDelistScheduler.js` | **新增**：收盤後 cron 呼叫 `delistService` 掃描 |
| `src/events/ready/marketScheduler.js` | 開盤排程加「冷卻期滿／名額空出 → 抽候補新股上市」檢查 |
| `src/commands/stock/stockMarket.js` / `src/features/profile/views/stockHoldings.js` | 顯示 `warning` / `delisted` 狀態 |
| `src/features/economy/grantCoins.js` | 補 source：`stock_delist_settlement`（flat，不套倍率） |
| `bibi-website` `src/lib/dashboard/botDefs.ts` | **候補清單全部先補進名稱表**（不等上市），避免網站 fallback `(id)` |

---

## 八、金流與通膨影響

- **強制退幣是 source（系統付幣）**，但退的是股東**原本帳面就持有**的殘值（≤ 地板價 × 股數），不是憑空新增財富；且下市後這支不再配息（少一個既有 source）。
- **融券結算 zero-sum**：空頭的獲利來自保證金機制內的價差，非系統增發。
- 整體對通膨**中性偏收縮**，方向與現有財富稅、盜賊系統一致，不會因為「下市」而放水金幣。

---

## 九、決策拍板紀錄（2026-07-09）

| # | 決策 | 結論 |
|---|---|---|
| 1 | 觸發機制 | **事件驅動**——因現引擎的均值回歸讓純價格觸發幾乎不會發生（§二之一），改由稀有「基本面崩壞」事件砍 `fairValue` 觸發。 |
| 2 | 結算價基準 | **`lastClose`**（最後收盤價）——對股東稍友善、最直覺；整理期鎖買進無操縱風險。 |
| 3 | 下市後補位 | **換新股**——從 `candidatePool` 抽新 symbol 掛牌（§五）；候補耗盡才退回原地重生。 |
| 4 | 同時下市上限 | **不限制**（`maxConcurrentDelisting: 0`）——因換新股補位，pool 不縮水，多支同時下市亦安全。 |

### 實作前仍需你定調的內容

- **候補新股的名字/數值**（§五表）：目前是提案，命名是社群風味，請你過目調整後再落 config + botDefs.ts。
- **基本面崩壞事件的文案**：事件標題/描述（例：「XX 爆財報地雷，董事長落跑」）走你的口味。
