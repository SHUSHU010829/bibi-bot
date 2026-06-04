# 公會倉庫系統設計文件

> 狀態：草案 v2（§12 五題已決議並折入正文）
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

> 各表「預設備庫格」為**乘數 1.0（Lv.2 解鎖當下）的基線值**。Lv.3~10 依 §6 `capacityLevelMultiplier` 放大；現有 Lv.3~4 公會剛打開倉庫就會看到 +30% / +60% 的容量加成。

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
2. **僅接受已進入 `backpack` / `fish_bag` 的成品**；田裡未收割的成熟作物、釣魚未上鉤的魚通通不算庫存，玩家需先 `/收割` 或正常結算後再存。
3. 驗證：玩家屬於該公會、背包/魚袋中持有數量 ≥ 申請數量。
4. 驗證：倉庫此物品數量 + 申請數量 ≤ 該物品倉庫容量上限。
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

實作上不需逐筆追蹤每顆鐵礦，而是維護 per-item 的「未來解鎖批次表」`pending[]: [{qty, available_at, depositor_id}]`，每次取礦前先 `sweep()` 把已到期批次合併進 `available_qty`。

### 3.4 同存入者 24h 自存自領鎖
即使保護期已過，**取礦者在過去 24 小時內存過該 item，就不能領這個 item**（純查 `guild_club_warehouse_log` 即可，不需額外欄位）。
- 目的：擋掉「存進去刷一筆貢獻 → 自己領回」的零成本攻擊。
- 不擋「我存了鐵、明天領別人存的鐵」的正常用法，因為次日 day_key 切換、自身 deposit 也滾出 24h 視窗。

### 3.5 不計入任務進度
存礦**不會**累加任何個人或公會週任務的計數。理由：避免 A 存 → B 領 → B 存 → A 領的循環刷。但會在「個人公會貢獻值」（顯示在 `/公會 資訊`）加上市價×係數（預設 0.1，可調），讓存的人有面子。

---

## 4. 取礦：規則

### 4.1 領取資格（全部符合才能領）
| 條件 | 預設 | 可由會長調整 |
|---|---|---|
| 公會等級 ≥ 2 | Lv.2 | ❌（系統解鎖門檻） |
| 已加入此公會 ≥ N 小時 | 24h | ✅（上下限 6h ~ 168h） |
| 個人在此公會的「累積貢獻值」≥ V | 200 | ✅（0 ~ 5000） |
| 該公會未在解散 / 冷靜期 | — | ❌ |

> 為何 Lv.2 解鎖：Lv.1 公會多半剛建會、貢獻系統還沒積累，整套防洗錢條件很難一次滿足，與其給玩家「看得到拿不到」的挫折，不如把倉庫綁在第一級升級的獎勵清單裡，讓 Lv.1 → Lv.2 的升級感更明確。對既有 Lv.3~4 的公會則完全無感。

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
| `club_level_locked` | 🔒 公會等級不足 | 倉庫於 Lv.2 解鎖，目前 Lv.X | 多捐款、做任務升級 |
| `tenure_not_enough` | 🔒 入會時間不足 | 已加入 Xh，需 Yh | 再等 `<t:…:R>` |
| `self_deposit_24h_lock` | 🧊 24h 內存過此項 | 你今天稍早存了 X 顆 Y | 換領別項或明天再來 |
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
    "unlockLevel": 2,
    "capacityLevelMultiplier": {
      "2": 1.0, "3": 1.3, "4": 1.6, "5": 1.9,
      "6": 2.2, "7": 2.5, "8": 2.7, "9": 2.85, "10": 3.0
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
- **會長行為透明化**：`/公會 倉庫紀錄` 頂部固定一行 `-# 近 30 天會長淨領取價值：N 幣（含手續費回流 M 幣）`。M 為會長付的手續費（最後又進金庫），讓會員一眼看清會長有沒有自肥。同條規則也適用副會長，但分開計算分開顯示。

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

## 12. 指令收斂規劃（順帶整治 `/公會` 介面）

加入倉庫的 5 條後，`/公會` 子指令將達 21 條（subcommand 上限 25，逼近天花板），autocomplete 選單也會長到不耐看。趁機把**「只有特定身份才會用、或執行前一定先看資訊」**的指令改為**按鈕**，放在 `/公會 資訊` 或對應指令的回覆裡。

### 12.1 改為按鈕（從 slash command 移除）

| 原指令 | 改為何處的按鈕 | 觸發者 | 備註 |
|---|---|---|---|
| `/公會 編輯簡介` | `/公會 資訊` 底部 `[編輯簡介]` | 會長 / 副會長 | 按下打開既有 modal，邏輯不變 |
| `/公會 指派副會長` | `/公會 資訊` 成員列表每位非副會長旁的 `[指派副]` | 會長 | 直接帶 `targetId`，無需手輸 user |
| `/公會 撤銷副會長` | `/公會 資訊` 成員列表每位副會長旁的 `[撤副]` | 會長 | 同上 |
| `/公會 踢人` | `/公會 資訊` 成員列表每位旁的 `[踢]` + 二次確認 | 會長 | 二次確認 container 顯示「踢出 @X？對方需冷卻 N 小時才能再入會」 |
| `/公會 轉讓` | `/公會 資訊` 成員列表每位非會長旁的 `[轉讓]` + 二次確認 | 會長 | 高風險動作，必走二次確認 modal |
| `/公會 申請列表` | `/公會 資訊` 標頭旁 `[待審 N]`（N>0 才出現） | 會長 | 沒待審就不顯示按鈕 |
| `/公會 領獎` | `/公會 任務` 底部 `[一鍵領取（+N 幣）]`（達標才出現） | 會長 | 與既有「達標才能領」邏輯天然合拍 |
| `/公會 倉庫設定` | `/公會 倉庫` 底部 `[倉庫設定]` | 會長 / 副會長 | 按下開 modal，輸入四個微調項 |
| `/公會 倉庫紀錄` | `/公會 倉庫` 底部 `[紀錄]` | 會長 / 副會長 | 開新 ephemeral container 顯示近 30 天 |

**收斂後 slash command 從 21 → 12 條**：建立、資訊、解散、邀請、申請、退會、捐款、任務、排行、倉庫、存礦、取礦。

### 12.2 為何這幾條適合按鈕化

- **要先看資訊才會用**：踢人、轉讓、指派副、撤副、領獎、倉庫設定——使用者本就會先 `/公會 資訊` 或 `/公會 任務` 看狀態，按鈕等於把「下一步」放在原地。
- **參數就在當前畫面**：成員 ID、申請者 ID、達標的任務 ID 都已在訊息裡，按鈕能自動帶入，省去 user option 的 autocomplete 漏選。
- **權限自帶過濾**：按鈕只渲染給有權限的人看，比 slash command 「執行後才報 not_leader」流暢。

### 12.3 為何這幾條保留 slash command

- **建立 / 解散 / 退會**：跟「資訊」沒有前置關係，玩家可能直接想做，留指令最快。
- **邀請**：要 user option，跨頻道時用 slash 比按鈕（找不到目標）順手。
- **申請**：要輸入公會名稱與理由，需要 modal/option 配合，留指令較合理。
- **捐款**：要輸入金額，純按鈕做不到「自訂金額」（雖然可放 1k / 5k / 10k 快捷，但完整流程仍需指令）。
- **任務 / 排行 / 倉庫 / 存礦 / 取礦**：高頻查詢與行動入口，留 slash 便於肌肉記憶。

### 12.4 既有 button handler 的影響

- 既有 `src/events/interactionCreate/handleGuildClubButton.js`（或對應檔）已處理邀請接受、申請審核、解散確認等流程；本次新增的按鈕沿用同一檔 + 同一 prefix 規範（`guild_<action>_<ownerId>_<payload>`），不額外開新檔，除非邏輯量超過 200 行才拆。
- customId 仍嚴格遵守 CLAUDE.md 架構規則 #4：含 ownerId、處理器先驗 `interaction.user.id === ownerId`，驗證失敗顯「這不是你的 XXX！」ephemeral。
- 成員列表按鈕是「每位成員一行」，會長身分本身就是 owner——customId 為 `guild_kick_<leaderId>_<targetId>`，handler 驗 `leaderId === interaction.user.id` 即可（與既有 `guildClubMembership.kick` 對齊）。

### 12.5 不在本次收斂的提案（避免變動範圍過大）

- **建立 / 申請 / 邀請** 改 modal-only：可行但會破壞使用者已養成的習慣，且這幾條目前運作良好，留待未來大改版再說。
- **`/公會 資訊` 分頁化**：成員多時按鈕會塞滿 5×5 上限。第一版用「最近活躍 10 人 + 全部成員另開 ephemeral」處理；若仍不足，M3 再做分頁。

### 12.6 落地順序

把這節納入 §11 的時程：
- **M1** 隨倉庫一起做的按鈕化：倉庫設定、倉庫紀錄。
- **M2** 跟著「監督與微調」一起做：編輯簡介、申請列表、領獎 → 按鈕。
- **M3** 高風險動作按鈕化：踢人、轉讓、指派副、撤副——這四條改完後 slash command 才正式降到 12 條。分階段做避免一次改太多造成 UX 連鎖回報。
