# 公會倉庫系統設計文件

> 狀態：草案 v1
> 範圍：`/公會 倉庫`、`/公會 存礦`、`/公會 取礦` 三條新指令，並補上設定、紀錄、UI、反洗錢、平衡性等所有相關面向。

---

## 0. 設計目標

1. 給高產玩家一個「把過剩資源還給公會」的出口，強化向心力。
2. 給中後段成員一個「在解鎖或卡資源時，能從公會借力」的機會。
3. 在不削弱市集／拍賣行流動性、不破壞礦/農/魚產出曲線的前提下完成上面兩件事。
4. 完全杜絕「拉小號→領倉庫→退會→再入會」的洗倉庫鏈條。

非目標（第一版不做）：跨伺服器倉庫、料理成品 / Buff 物資儲存、倉庫升級樹、會員之間的點對點轉物。

---

## 1. 指令總覽

| 指令 | 對象 | Ephemeral | 用途 |
|---|---|---|---|
| `/公會 倉庫` | 全會員 | ✅ | 查詢倉庫存貨、自己今日已領紀錄、剩餘額度 |
| `/公會 存礦 [物品] [數量]` | 全會員 | ❌（公開） | 把背包 / 魚袋裡的資源捐入倉庫 |
| `/公會 取礦 [物品] [數量]` | 全會員 | ❌（公開） | 申請領取倉庫資源，支付手續費入公會金庫 |
| `/公會 倉庫設定` | 會長 / 副會長 | ✅ | 調整可調節參數（每日次數、單次上限、入會門檻等） |
| `/公會 倉庫紀錄` | 會長 / 副會長 | ✅ | 查近 30 天的存取紀錄（誰、何時、什麼、多少） |

所有指令沿用 `src/commands/guild_club/guild.js` 的 `allowedCategoryIds` 限制與「公會系統未啟用」防呆，不另作頻道判斷。

---

## 2. 支援物品清單與分級

倉庫第一版只支援下表 14 種「原料型」資源。料理、種子、合成材料、Buff 道具一律不可存。

> ⚠️ 名稱對齊：原提議中的「金礦」實際 config id 為 `gold`（顯示「黃金」）、「玫瑰」實際為 `black_rose`（顯示「黑玫瑰」）。設計文件統一使用 config 內的 id 與顯示名。

### 2.1 礦石（背包）

| id | 顯示 | 單價（config `price`） | 取礦單次上限 | 預設備庫格 |
|---|---|---|---|---|
| `stone` | 石頭 | 8 | 15 | 1000 |
| `coal` | 煤炭 | 20 | 15 | 600 |
| `iron` | 鐵礦 | 60 | 10 | 300 |
| `gold` | 黃金 | 200 | 5 | 100 |
| `diamond` | 鑽石 | 800 | 1 | 25 |

### 2.2 作物（背包，成熟後）

| id | 顯示 | 單價（payout 中位） | 取礦單次上限 | 預設備庫格 |
|---|---|---|---|---|
| `carrot` | 紅蘿蔔 | 65 | 15 | 300 |
| `corn` | 玉米 | 175 | 10 | 150 |
| `strawberry` | 草莓 | 450 | 5 | 80 |
| `black_rose` | 黑玫瑰 | 1350 | 1 | 25 |

### 2.3 魚類（魚袋）

| id | 顯示 | 單價（config `price`） | 取礦單次上限 | 預設備庫格 |
|---|---|---|---|---|
| `small_fish` | 小雜魚 | 5 | 15 | 1000 |
| `crucian` | 鯽魚 | 15 | 15 | 600 |
| `shark` | 鯊魚 | 60 | 10 | 300 |
| `octopus` | 章魚 | 150 | 5 | 100 |
| `lava_fish` | 熔岩魚 | 600 | 1 | 25 |

「取礦單次上限」對應原提議的數字，但**改為「每物品由 config 決定預設值，會長可在上下限內微調」**——見 §6 設定。

---

## 3. 存礦：規則

### 3.1 流程
1. 玩家於指令中選擇物品 id（autocomplete 限定 14 種）與數量（正整數）。
2. 驗證：玩家屬於該公會、背包/魚袋中持有數量 ≥ 申請數量。
3. 驗證：倉庫此物品數量 + 申請數量 ≤ 該物品倉庫容量上限。
4. 原子操作（MongoDB transaction，與既有 `donate` 風格一致）：
   - 從玩家對應欄位（`backpack.<id>` 或 `fish_bag.<id>`）扣除。
   - 寫入 `guild_club_warehouse`：`(guild_club_id, item_id)` 累加 `qty` 與 `available_at`。
   - 寫入 `guild_club_warehouse_log`：`action = "deposit"`。
   - 寫入 `guild_club_member_stats.warehouse_donated_value`：累積市價值（用於個人貢獻、不用於任務）。

### 3.2 不可收回
存入即放棄所有權，不提供撤銷。**理由**：避免「存→等隊友幾秒沒看到→自己領回」打亂節奏；同時讓存礦在語意上等同捐贈，與「金庫捐款」一致。

### 3.3 新存物品保護期（防掃倉）
每筆 deposit 寫入 `available_at = now + protectionMs`（預設 1 小時）。**保護期內全員都不可領（包含存入者本人）**。
- 倉庫顯示時會把「保護中」的數量單獨標示：`鐵礦 320（其中 15 保護中，<t:…:R> 解鎖）`。
- 計算「可被取礦的數量」時，永遠用 `qty - sum(protectedQty)`。

實作上不需逐筆追蹤每顆鐵礦，而是維護 per-item 的「未來解鎖批次表」`pending[]: [{qty, available_at}]`，每次取礦前先 `sweep()` 把已到期批次合併進 `available_qty`。

### 3.4 不計入任務進度
存礦**不會**累加任何個人或公會週任務的計數。理由：避免 A 存 → B 領 → B 存 → A 領的循環刷。但會在「個人公會貢獻值」（顯示在 `/公會 資訊`）加上市價×係數（預設 0.1，可調），讓存的人有面子。

---

## 4. 取礦：規則

### 4.1 領取資格（全部符合才能領）
| 條件 | 預設 | 可由會長調整 |
|---|---|---|
| 已加入此公會 ≥ N 小時 | 24h | ✅（上下限 6h ~ 168h） |
| 個人在此公會的「累積貢獻值」≥ V | 200 | ✅（0 ~ 5000） |
| 該公會未在解散 / 冷靜期 | — | ❌ |

「累積貢獻值」= 金庫捐款 + 倉庫存礦市價×係數 + 公會 boss 貢獻 + 任務貢獻（複用既有 `guildClubContribution` 欄位即可）。

新號／剛入會的人本來就無法立刻領，自然封死「進公會→領鑽石→退會」的洗倉庫鏈條。

### 4.2 每日次數與不可重複種類
- 每日（以伺服器時區的 00:00 為界）最多 **2 次**（可調 1~3 次）。
- 同一天內**同 item id 只能領一次**——即使第一次只領 1 顆鐵礦，第二次也不能再領鐵礦。
- 「同分類不可重複」（如取了鐵礦今天就不能取鑽石）**不採用**：玩家做料理常需要 `crucian + octopus` 兩種魚同時補。原提議若是後者，會大幅降低實用性。

### 4.3 單次數量上限
- 由 config 提供「該物品的上下限」（見 §2 的「取礦單次上限」即上限，下限統一為 1）。
- 會長可在 `/公會 倉庫設定` 把每物品的「上限」往**下**調（提高難度），不能往上調（避免破壞平衡）。

### 4.4 手續費（重點修正：放棄固定 20 元）
- 公式：`fee = max(20, ceil(unitPrice × qty × feeRate))`
- `feeRate` 預設 0.10（10%），會長可調 0.05 ~ 0.20。
- 範例：取 1 顆鑽石（單價 800）→ `max(20, 80) = 80 幣`；取 15 顆石頭（單價 8）→ `max(20, 12) = 20 幣`。
- 手續費**進公會金庫**（不是消失），讓費用在會員之間繼續循環、不破壞貨幣總量。

### 4.5 申請流程
1. autocomplete 物品 id + 數量。
2. 驗證資格、今日已領清單、單次上限、倉庫可被取量、申請者餘額 ≥ fee。
3. MongoDB transaction：
   - 從 `guild_club_warehouse.available_qty` 扣除。
   - 加入玩家對應欄位（`backpack` 或 `fish_bag`）。
   - 扣除玩家金幣 fee、加入 `guild_clubs.treasury_current`。
   - 寫入 `guild_club_warehouse_log`：`action = "withdraw"`。
   - 寫入 `guild_club_member_daily_withdraw`：`(userId, guild_club_id, day_key, item_id)`。
4. 公開訊息回覆（行動類，符合 CLAUDE.md UX #7）。

### 4.6 失敗情境（全部走 ContainerBuilder）
| reason | 標題 | body | 提示 |
|---|---|---|---|
| `not_in_club` | 🏰 你還沒加入公會 | — | /公會 申請 或等邀請 |
| `tenure_not_enough` | 🔒 入會時間不足 | 已加入 Xh，需 Yh | 再等 `<t:…:R>` |
| `contribution_not_enough` | 🔒 公會貢獻不足 | 目前 X，需 Y | 提示 /公會 捐款 或存礦 |
| `daily_limit_reached` | 🧊 今日次數用完 | 已取 N/N 次 | `<t:tomorrow:R>` 重置 |
| `item_already_taken_today` | 🧊 今天已領過這項 | — | 改領別項，明天再來 |
| `warehouse_empty` | 📦 倉庫暫時沒有 X | 可被取 0 / 總 Y（其中 Y 保護中） | 等保護期或催隊友存 |
| `qty_over_personal_limit` | ❌ 超過單次上限 | 上限 N | — |
| `qty_over_available` | ❌ 倉庫可取量不足 | 可取 X，申請 Y | — |
| `insufficient_funds_for_fee` | ❌ 手續費不足 | 需 X，有 Y | 去打工 |
| `club_in_disband_grace` | 🧊 公會冷靜期 | — | — |

---

## 5. UI 設計（嚴格遵守 CLAUDE.md UX 規則）

### 5.1 `/公會 倉庫`（ephemeral）
ContainerBuilder 結構（從上到下）：
1. **TextDisplay 標題**：`📦 ⟨公會名稱⟩ 倉庫`
2. **TextDisplay 摘要**：`Lv.X｜總價值 ≈ N 幣｜你今日已領：A・B（剩餘 1 次）`
3. **Separator**
4. **礦石區塊**（有量的逐項顯示）：
   - 每個物品一塊 TextDisplay：`<emoji> 鐵礦 320 / 容量 300（15 保護中，<t:…:R> 解鎖）`
   - 緊接一個 ActionRow：`[取 1] [取 5] [取 10] [取上限]`（上限按該 item 的個人上限 + 倉庫可取量取最小）
   - 每顆按鈕 customId：`guildwh_take_<userId>_<itemId>_<qty>`
5. **作物區塊**、**魚類區塊**：同上
6. **Separator**
7. **底部 TextDisplay**（UX #5）：`-# 尚無：黃金・鑽石・章魚・熔岩魚`
8. **底部 ActionRow**：`[存礦…] [捐款] [我的貢獻] [紀錄（會長/副會長）]`
   - 「存礦…」開 modal 讓玩家填 itemId + qty（autocomplete 在 slash command 較順，此按鈕為 fallback）。

### 5.2 存礦成功（公開）
- Container：`✅ ⟨玩家⟩ 向公會倉庫存入 <emoji> 鐵礦 ×30`
- 摘要行：`保護至 <t:…:R>｜公會貢獻 +X｜倉庫鐵礦 250/300`
- ActionRow：`[查看倉庫] [再存其他]`

### 5.3 取礦成功（公開）
- Container：`✅ ⟨玩家⟩ 從公會倉庫領取 <emoji> 鐵礦 ×5`
- 摘要：`手續費 -80 幣（入金庫）｜倉庫剩餘 245｜你今日 1/2`
- ActionRow：`[去挖礦回饋] [查看倉庫]`

### 5.4 取礦資格不足錯誤訊例（UX #6）
```
🔒 公會貢獻不足，暫不能取礦
解鎖條件：累積貢獻 ≥ 200
目前：125（差 75）
-# 可用 /公會 捐款 或 /公會 存礦 補貢獻。
```

---

## 6. 設定（config）

新增 `src/config/guild_warehouse.json`，從 `src/config/index.js` `...spread` 匯出。

```json
{
  "guildWarehouse": {
    "enabled": true,
    "protectionMs": 3600000,
    "depositContributionRate": 0.1,
    "withdraw": {
      "dailyMaxTimesDefault": 2,
      "dailyMaxTimesRange": [1, 3],
      "feeRateDefault": 0.10,
      "feeRateRange": [0.05, 0.20],
      "feeMinAbsolute": 20,
      "tenureHoursDefault": 24,
      "tenureHoursRange": [6, 168],
      "minContributionDefault": 200,
      "minContributionRange": [0, 5000]
    },
    "items": {
      "stone":       { "kind": "backpack", "perTakeMaxDefault": 15, "perTakeMaxRange": [1, 15], "capacityDefault": 1000, "unitPrice": 8 },
      "coal":        { "kind": "backpack", "perTakeMaxDefault": 15, "perTakeMaxRange": [1, 15], "capacityDefault": 600,  "unitPrice": 20 },
      "iron":        { "kind": "backpack", "perTakeMaxDefault": 10, "perTakeMaxRange": [1, 10], "capacityDefault": 300,  "unitPrice": 60 },
      "gold":        { "kind": "backpack", "perTakeMaxDefault": 5,  "perTakeMaxRange": [1, 5],  "capacityDefault": 100,  "unitPrice": 200 },
      "diamond":     { "kind": "backpack", "perTakeMaxDefault": 1,  "perTakeMaxRange": [1, 1],  "capacityDefault": 25,   "unitPrice": 800 },
      "carrot":      { "kind": "backpack", "perTakeMaxDefault": 15, "perTakeMaxRange": [1, 15], "capacityDefault": 300,  "unitPrice": 65 },
      "corn":        { "kind": "backpack", "perTakeMaxDefault": 10, "perTakeMaxRange": [1, 10], "capacityDefault": 150,  "unitPrice": 175 },
      "strawberry":  { "kind": "backpack", "perTakeMaxDefault": 5,  "perTakeMaxRange": [1, 5],  "capacityDefault": 80,   "unitPrice": 450 },
      "black_rose":  { "kind": "backpack", "perTakeMaxDefault": 1,  "perTakeMaxRange": [1, 1],  "capacityDefault": 25,   "unitPrice": 1350 },
      "small_fish":  { "kind": "fish_bag", "perTakeMaxDefault": 15, "perTakeMaxRange": [1, 15], "capacityDefault": 1000, "unitPrice": 5 },
      "crucian":     { "kind": "fish_bag", "perTakeMaxDefault": 15, "perTakeMaxRange": [1, 15], "capacityDefault": 600,  "unitPrice": 15 },
      "shark":       { "kind": "fish_bag", "perTakeMaxDefault": 10, "perTakeMaxRange": [1, 10], "capacityDefault": 300,  "unitPrice": 60 },
      "octopus":     { "kind": "fish_bag", "perTakeMaxDefault": 5,  "perTakeMaxRange": [1, 5],  "capacityDefault": 100,  "unitPrice": 150 },
      "lava_fish":   { "kind": "fish_bag", "perTakeMaxDefault": 1,  "perTakeMaxRange": [1, 1],  "capacityDefault": 25,   "unitPrice": 600 }
    },
    "capacityLevelMultiplier": {
      "1": 1.0, "2": 1.2, "3": 1.4, "4": 1.6, "5": 2.0,
      "6": 2.4, "7": 2.8, "8": 3.4, "9": 4.0, "10": 5.0
    }
  }
}
```

> **`unitPrice` 為什麼放在 config 而不是從 mining/farming/fishing 動態讀取？**
> 因為作物的 `payout` 是區間、未來可能加上市價浮動；倉庫的「貢獻折算」與「手續費」需要穩定的基準值。獨立一份避免下游波動破壞平衡。

「會長可調的設定」儲存在 `guild_clubs.warehouse_settings`（per-club override），讀取時用 `{...config.defaults, ...club.warehouse_settings}` 合併。

---

## 7. Database Schema

於 `src/events/ready/connectDb.js` 新增三個 collection：

### 7.1 `guild_club_warehouse`
```js
{
  guild_club_id: ObjectId,   // ref guild_clubs
  item_id: String,           // ex "iron"
  qty: Int,                  // 總量（含保護中）
  pending: [                 // 尚未過保護期的批次
    { qty: Int, available_at: Date }
  ],
  updated_at: Date
}
```
索引：`{ guild_club_id: 1, item_id: 1 }` unique。

### 7.2 `guild_club_warehouse_log`（純紀錄、TTL 90 天）
```js
{
  guild_club_id: ObjectId,
  user_id: String,
  action: "deposit" | "withdraw",
  item_id: String,
  qty: Int,
  fee: Int,                  // withdraw 才有
  market_value: Int,         // qty * unitPrice，存當下值
  created_at: Date
}
```
索引：`{ guild_club_id: 1, created_at: -1 }`、`{ user_id: 1, created_at: -1 }`、TTL on `created_at` 90 天。

### 7.3 `guild_club_member_daily_withdraw`
```js
{
  user_id: String,
  guild_id: String,          // discord server id
  guild_club_id: ObjectId,
  day_key: String,           // "2026-06-04"，用伺服器時區計算
  items_taken: [String],     // 今天領過的 item_id，用陣列以便檢查重複
  times_used: Int,
  updated_at: Date
}
```
索引：`{ user_id: 1, guild_id: 1, day_key: 1 }` unique；TTL on `updated_at` 7 天即可。

### 7.4 既有 collection 的微調
- `guild_club_members` 增 `warehouse_donated_value: Int`（與 `donated_amount` 平行），供 `/公會 資訊` 顯示。
- `guild_clubs` 增 `warehouse_settings: Object`（per-club override）。

---

## 8. 後端模組

```
src/features/guild_club/warehouse/
  warehouseService.js     // deposit / withdraw / getInventory / sweepProtection
  warehouseSettings.js    // 讀取 merge config + per-club override
  warehouseEligibility.js // tenure / contribution / daily-limit 檢查
  warehouseLog.js         // log 寫入 + 查詢
  warehouseView.js        // 所有 ContainerBuilder
```

### 8.1 `warehouseService.deposit({ client, userId, guildId, itemId, qty })`
回傳 `{ ok, club, item, newQty, protectionUntil }` 或 `{ ok: false, reason, ... }`。

### 8.2 `warehouseService.withdraw({ client, userId, guildId, itemId, qty })`
回傳 `{ ok, club, item, qty, fee, treasuryAfter, dailyRemaining }` 或 `{ ok: false, reason, ... }`。
內部順序：
1. `eligibility.check()` → 出資格相關 reason
2. `sweepProtection(itemId)` → 把已到期批次合併
3. 檢查 `available_qty` ≥ qty
4. 檢查 fee 餘額
5. transaction 寫入

### 8.3 並發保護
使用 MongoDB transaction + `findOneAndUpdate` with `qty: { $gte: requested }` 條件，避免兩個成員同時搶走最後一顆鑽石。失敗時回 `reason = "race_lost"`，前端訊息「剛剛被別人搶走了」。

---

## 9. 反洗錢 / 平衡性檢查表

| 攻擊面 | 對策 |
|---|---|
| 小號入會即領→退會 | §4.1 入會時間 + 累積貢獻雙條件 |
| A 存 B 領互刷任務 | §3.4 存礦不計任務進度 |
| 大公會囤積無限資源破壞市場 | §2 每物品容量上限 + §6 隨等級放大 |
| 剛存即被掃 | §3.3 保護期 1 小時 |
| 鑽石 20 元手續費太低 | §4.4 按市價 10% + 最低 20 |
| 同類資源全壟斷一天 | §4.2 同 item 一天一次 |
| 解散瞬間有人狂領 | §4.6 `club_in_disband_grace` 直接擋 |
| 餘額不足卻硬扣 fee | §4.5 transaction，扣不到就 rollback |
| 取礦次數 / 上限可被會長亂改破壞平衡 | §6 全部有 `_Range`，超出範圍直接拒 |

額外監督機制：
- 「倉庫紀錄」指令讓會長/副會長隨時查最近 30 天進出。
- 連續 7 天淨流出 > 淨流入時，`/公會 倉庫` 標頭加紅字提醒：`-# ⚠️ 本週倉庫資源外流量偏高，請會長留意。`（純警示，不阻擋）。

---

## 10. 與既有系統的接面

| 既有系統 | 變化 |
|---|---|
| `/公會 資訊` | 新增「倉庫摘要」一塊：總價值、最近一次活動時間 |
| `/公會 解散` | 解散結算前，倉庫**整批轉入金庫**（依當下 unitPrice 折現），與既有 `settleLockedTreasury` 同一個 transaction |
| `/公會 退會 / 踢人` | 不影響倉庫，已存入的資源永遠是公會的 |
| `/背包` `/魚袋` | 不必改顯示，倉庫是另一份獨立資料 |
| `guildClubContribution` | `warehouse_donated_value` 計入「個人總貢獻」排序與 `/公會 資訊` |
| `guildClubAnnouncer` | 大額存礦（單次市價 ≥ 10,000）廣播到公會頻道，與「升級」廣播風格一致 |

---

## 11. 落地里程碑

### M1 — MVP（建議 2 週內完成）
- §3 存礦、§4 取礦、§5.1~5.3 三個 UI、§7 三張 collection、§9 全部反洗錢檢查。
- `/公會 倉庫設定` 只暴露 `dailyMaxTimes`、`feeRate`、`tenureHours`、`minContribution` 四項（最常被微調的）。

### M2 — 監督與微調
- `/公會 倉庫紀錄`、§9 連續外流警示、§10 大額廣播。
- 開放「每物品 perTakeMax 微調」。

### M3 — 平衡性回顧
- 觀察 2 週數據（存取比、手續費總量、新會員領取分佈），決定是否：
  - 開放料理成品儲存
  - 加入「倉庫等級」獨立升級樹
  - 提供「指定捐贈給某項任務」用法

---

## 12. 待定 / 仍需與企劃確認的問題

1. **倉庫容量是否真的要隨公會等級放大？** §2 表格給的是 Lv.1 預設，§6 給了乘數。若不想要進度感，可拿掉乘數，所有公會用同一份容量。
2. **保護期 1 小時是否合適？** 太短防不了協作掃倉，太長存的人覺得卡。可先 1h 觀察。
3. **作物的成熟「未收割」狀態算不算庫存？** 第一版只支援「已收割進背包」的成品，未成熟的留在田裡不能直接存。
4. **公會等級不足時可不可以開倉庫？** 預設 Lv.1 就能用。若想當作 Lv.3 的解鎖獎勵也可，要的話寫進 `level.json`。
5. **手續費入金庫，會不會讓會長狂取自肥？** 會長同樣受日次數與不可重複限制，且金庫本就是會長管的——這條風險可忽略。

> 上述五點在進入實作前需要會長拍板。
