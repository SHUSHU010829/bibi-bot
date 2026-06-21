# 公會新建築企劃：農膳坊 & 鐵匠鋪

> 對照現有 `src/config/guild_buildings.json`、`guild_forge.json`、`guild_club.json`、`farming.json`、`craft.json`、`dungeon.json`、`fishing.json` 的實際數值寫的版本。所有 buff 名稱、材料 key、解鎖門檻都對齊現行系統。

---

## 0. 現況基準（避免再寫飛）

### 公會等級門檻（`guild_club.json`）

| Lv | threshold | 上限人數 | 既有公會 buff |
|---|---|---|---|
| 1 | 0 | 10 | — |
| 2 | 10,000 | 12 | 挖礦額外產出 +1 |
| 3 | 50,000 | 15 | +打工 ×1.1 |
| 4 | 150,000 | 18 | +體力上限 +1、世界王攻擊 +5% |
| 5 | 500,000 | 20 | +挖礦幸運 +5%、世界王攻擊 +10%、世界王每場攻擊次數 +1 |

### 現有公會建築總消耗對照（鎖定升級規模上限）

| 建築 | maxLv | 建材累計 | 鋼錠累計 | 公會金幣累計 |
|---|---|---|---|---|
| 礦坑（mine） | 3 | 21 | 5 | 0 |
| 訓練場（training） | 3 | 15 | 24 | 0 |
| 倉庫擴建（warehouse） | 5 | 30 | 7 | 110,000 |
| 熔爐（forge） | 2 | — | — | 40,000 |
| 精煉站（refinery） | 3 | — | — | 300,000 |

**規模上限結論**：5 級建築的合理總消耗約莫是「建材 25~35、鋼錠 ≤ 35、公會金幣 ≤ 150,000」。本企劃以此為錨。

### 解鎖位置安排（避開現有 Lv.4 擁擠）

- 農膳坊 → `unlockClubLevel: 3`（生活線，早點啟動）
- 鐵匠鋪 → `unlockClubLevel: 4`（與熔爐同 Lv.4，但鐵匠鋪是「養成消耗端」、熔爐是「材料生產端」，玩法路徑不重疊）

### 既有作物資料（`farming.json`）

| 作物 | 成長時間 | 售價 payout | 種子需求 |
|---|---|---|---|
| 紅蘿蔔 carrot | 2h | 50~80 | 無 |
| 玉米 corn | 6h | 150~200 | 無 |
| 草莓 strawberry | 12h | 400~500 | 選用 |
| 黑玫瑰 black_rose | 24h | 1200~1500 + 5% 碎片 + 10% 稀有餌 | 必填 |

- `growthReductionCapPct: 0.6`（成長時間最多縮 60%，肥料疊加上限）
- `yieldBonusCapPct: 2.5`（產量倍率上限）

### 既有武器耐久（`dungeon.json`）

| 武器 | 基礎耐久 |
|---|---|
| 鐵劍 | 40 |
| 鋼劍 | 45 |
| 黃金劍 | 60 |
| 鑽石劍 | 80 |
| 傳說之劍 | **120**（前一份提案誤寫 80） |

### 武器修復公式（`mineService.getWeaponRepairCost`）

修復成本 = `{ stone: 20, coal: 10, iron: 5 }` + `recipe.materials` 每項 `÷2` 並向上取整（排除 coal 與 REPAIR_SKIP_MATERIALS）。例如傳說之劍 recipe `{ legendary_fragment: 18, diamond: 12, coal: 15 }` → 修復實際吃 `stone 20, coal 10, iron 5, legendary_fragment 9, diamond 6`。

---

## 1. 農膳坊（farm_kitchen）

### 1.1 定位

公會 Lv.3 解鎖的生活型建築。聚焦於「縮短農場循環時間」與「料理數量保險」，不直接提供戰力數值；經濟貢獻偏向後期玩家的「省時間 + 收成幣補貼」，避免高階作物倍增造成幣值崩盤。

### 1.2 升級表（cost 對齊現有規模，buffs 採覆蓋式總值）

```jsonc
"farm_kitchen": {
  "label": "農膳坊",
  "emoji": "🍳",
  "unlockClubLevel": 3,
  "maxLevel": 5,
  "levels": [
    {
      "level": 1,
      "cost": { "building_material": 2 },
      "buffs": [
        { "type": "farm_growth_reduction_pct", "value": 3 }
      ]
    },
    {
      "level": 2,
      "cost": { "building_material": 4, "steel_ingot": 2 },
      "buffs": [
        { "type": "farm_growth_reduction_pct", "value": 5 },
        { "type": "harvest_coin_pct", "value": 5 }
      ]
    },
    {
      "level": 3,
      "cost": { "building_material": 6, "steel_ingot": 5, "coins": 20000 },
      "buffs": [
        { "type": "farm_growth_reduction_pct", "value": 8 },
        { "type": "harvest_coin_pct", "value": 10 },
        { "type": "cooking_crit_pct", "value": 10 }
      ]
    },
    {
      "level": 4,
      "cost": { "building_material": 10, "steel_ingot": 10, "coins": 40000 },
      "buffs": [
        { "type": "farm_growth_reduction_pct", "value": 10 },
        { "type": "harvest_coin_pct", "value": 15 },
        { "type": "cooking_crit_pct", "value": 15 }
      ]
    },
    {
      "level": 5,
      "cost": { "building_material": 15, "steel_ingot": 15, "coins": 60000 },
      "buffs": [
        { "type": "farm_growth_reduction_pct", "value": 12 },
        { "type": "harvest_coin_pct", "value": 20 },
        { "type": "cooking_crit_pct", "value": 20 },
        { "type": "farm_low_tier_extra_count", "value": 1 }
      ]
    }
  ]
}
```

**滿級總消耗**：建材 37、鋼錠 32、公會金幣 120,000。鋼錠略高於現有最重的訓練場（24），合理性：農膳坊有 4 條 buff、是生活線終局。

### 1.3 四項加成設計與算式

#### A. 作物成熟時間 −12%（`farm_growth_reduction_pct`）

- 與肥料共用 `growthReductionCapPct: 0.6` 的同一條 cap，**不繞過**。
- 實作位置：`farmService.plantCrop` 計算 `ready_at` 時，把建築百分比換算為 ms 後納入 `growth_reduction_ms`。
- 算式：`buildingReductionMs = floor(crop.growMs × buildingPct / 100)`，與 fertilizer 共享 cap 後落到 `growth_reduction_ms`。
- 收益範例：
  - 紅蘿蔔 2h → 1h45m（省 15 分鐘）
  - 黑玫瑰 24h → 21h7m（省 2h53m）
- 為什麼從 −15% 砍到 −12%：黑玫瑰 +12% 已等於每天多 ≈1 次收成期窗，再加肥料可逼近 60% cap。−15% 在配合月光露水（−40%）+ 怪物黏液（−25%）後會把 cap 用滿，建築變成「肥料免費卡」。

#### B. 收成額外金幣 +20%（`harvest_coin_pct`）

- 套用在 `farmService.harvestCrop` 結算 `grantCoins` 之前的 `[lo, hi]` 上：`finalCoins = floor(randomInt(lo, hi) × (1 + pct/100))`。
- **不影響** 賣價市場（`cropMarket`）— 那個是把作物入袋後賣的價格，本 buff 是直接收成發的現金。
- 收益範例（取中位數）：
  - 紅蘿蔔 65 → 78（+13 幣）
  - 黑玫瑰 1350 → 1620（+270 幣）

#### C. 烹飪暴擊率 +20%（`cooking_crit_pct`）

- 觸發效果：**該次烹飪產出 2 份成品（buff 進 profile，uses_left ×2 或時效 ×2）**，而不是多一份食物或多領一次。
- 實作位置：`cookService` 套用 buff 到 `profile.active_food_buffs` 之前，骰一次 `Math.random() < pct/100`，命中就：
  - 對 `uses` 型 buff：`uses_left *= 2`
  - 對 `durationMs` 型 buff：`expires_at += durationMs`
  - 顯示在烹飪結果 Container 加一行「✨ 美味暴擊！效果加倍」
- 為什麼從 30% 砍到 20%：30% 暴擊 = 期望多 30% 食物 buff 上線時間，間接讓打工 +25~35%、地下城 ATK +20~35、全屬性 +15~20% 都多吃 30%；20% 已經很有感。

#### D. 滿級「低階作物 +1」（`farm_low_tier_extra_count`）

- **僅對紅蘿蔔 / 玉米** 觸發（在 `farmService.harvestCrop` 用 `LOW_TIER_CROPS = ["carrot", "corn"]` 過濾），高階作物（草莓、黑玫瑰）不受影響。
- 為什麼不適用所有作物：黑玫瑰收成 +1 = +1350 幣（+100%）會吃掉市場機制；紅蘿蔔 +1 = +65 幣，總帳期望小、但鼓勵玩家撐到滿級。
- 收益範例：
  - 紅蘿蔔每次收成 1 → 2，等於對 carrot 永久 +100%（價值低、循環快，玩家會養成多種紅蘿蔔的習慣）
  - 玉米同理

### 1.4 需新增 buff key（必補 `buffLabels.js`）

```js
farm_growth_reduction_pct: { label: "農作成長時間", unit: "-{v}%" },
harvest_coin_pct:          { label: "收成金幣", unit: "+{v}%" },
cooking_crit_pct:          { label: "烹飪美味暴擊", unit: "+{v}%" },
farm_low_tier_extra_count: { label: "低階作物額外產出", unit: "+{v} 個（限紅蘿蔔/玉米）" },
```

### 1.5 經濟驗算（單人 / 公會滿級）

假設一位玩家滿地 8 塊地、平均種紅蘿蔔輪轉：

- 沒農膳坊：8 塊 × 2h = 1 輪 16 蘿蔔、收 65 × 8 = 520 幣 / 2h ≈ 6240 幣 / 24h
- 滿級農膳坊：成長 −12% → 1h45m / 輪；收成 +20% 幣 + 1 個紅蘿蔔（額外 30 幣 / 個的賣價）
  - 每輪：8 × (65 × 1.20 + 30 紅蘿蔔賣值 ≈ 30) ≈ 8 × 108 = 864 幣
  - 24h ÷ 1.75h ≈ 13.7 輪 → 約 11840 幣 / 24h
  - **+90% 日收益**，主要來自輪轉次數而非單次倍增 → 玩家要實際操作（種植 + 收成）才能取得，不會躺賺

黑玫瑰只吃 −12% 成長 + 20% 幣（不吃 +1）：

- 沒建築：1 輪 24h 收 1350 幣
- 滿級建築：1 輪 21h7m 收 1620 幣 → 換算成 24h 比率 ≈ 1840 / 24h
- **+36%**，遠低於原提案的 +200%

---

## 2. 鐵匠鋪（blacksmith）

### 2.1 定位

公會 Lv.4 解鎖的養成輔助建築。**完全不碰戰力數值**（atk/def/critRate 都不動），只動「裝備能撐多久 + 修復負擔多重」。質變獎勵集中在 Lv.4、Lv.5。

### 2.2 升級表

```jsonc
"blacksmith": {
  "label": "鐵匠鋪",
  "emoji": "⚒️",
  "unlockClubLevel": 4,
  "maxLevel": 5,
  "levels": [
    {
      "level": 1,
      "cost": { "building_material": 2, "steel_ingot": 3 },
      "buffs": [
        { "type": "weapon_max_durability_pct", "value": 5 }
      ]
    },
    {
      "level": 2,
      "cost": { "building_material": 4, "steel_ingot": 6 },
      "buffs": [
        { "type": "weapon_max_durability_pct", "value": 10 }
      ]
    },
    {
      "level": 3,
      "cost": { "building_material": 6, "steel_ingot": 10, "coins": 15000 },
      "buffs": [
        { "type": "weapon_max_durability_pct", "value": 15 },
        { "type": "equipment_repair_discount_pct", "value": 10 }
      ]
    },
    {
      "level": 4,
      "cost": { "building_material": 10, "steel_ingot": 15, "coins": 30000 },
      "buffs": [
        { "type": "weapon_max_durability_pct", "value": 20 },
        { "type": "equipment_repair_discount_pct", "value": 25 }
      ]
    },
    {
      "level": 5,
      "cost": { "building_material": 15, "steel_ingot": 20, "coins": 50000 },
      "buffs": [
        { "type": "weapon_max_durability_pct", "value": 20 },
        { "type": "equipment_repair_discount_pct", "value": 40 },
        { "type": "combat_durability_save_pct", "value": 5 }
      ]
    }
  ]
}
```

**滿級總消耗**：建材 37、鋼錠 54、公會金幣 95,000。鋼錠累計比現有訓練場（24）高 +125%，但比前一份提案（134）少 60%。考量鐵匠鋪有「修復減免」這種長期經濟價值，54 是合理上限。

### 2.3 三項加成設計與算式

#### A. 武器耐久上限 **+20% 比例**（`weapon_max_durability_pct`）

**改用比例而非固定 +25**，避免「對低階武器 +63%、對最終武器 +21%」的不對等。

| 武器 | 基礎 | +5% | +10% | +15% | +20% |
|---|---|---|---|---|---|
| 鐵劍 | 40 | 42 | 44 | 46 | 48 |
| 鋼劍 | 45 | 47 | 50 | 52 | 54 |
| 黃金劍 | 60 | 63 | 66 | 69 | 72 |
| 鑽石劍 | 80 | 84 | 88 | 92 | 96 |
| **傳說之劍** | **120** | 126 | 132 | 138 | **144** |

- 範圍：**僅武器**（劍系）。盾耐久（已有 `shieldDurability.maxConsumePerBattle` 機制）、鎬子、釣竿不吃這條 buff，避免破壞磨石／修復工具的邊際效用。
- 實作位置：玩家裝備武器時計算 `weapon_max_durability`：
  - 現行：`weapon_max_durability = weaponDef.durability`
  - 新：`weapon_max_durability = floor(weaponDef.durability × (1 + buildingPct / 100))`
  - 需要在「換裝」與「公會建築升級事件」兩處重算 max（建築升級時把所有公會成員的當前裝備 max 同步刷新；當前 durability 不變、不送禮包）

#### B. 修復材料減免（`equipment_repair_discount_pct`）

- 套用範圍：**武器 + 鎬子 + 釣竿** 的材料修復。
- 套用方式：在 `mineService.getWeaponRepairCost` / `getRodRepairCost` / `getPickaxeRepairCost` 結果上，每項材料 `ceil(qty × (1 - pct/100))`，**最低保證 1**。
- 為什麼採梯形（10 / 25 / 40）而非提案的 −50% 突變：
  - 修復是日常剛需，0% → 50% 跳一級會讓 Lv3 → Lv4 過於甜美，Lv5 反而無感。
  - 階梯每級都有量變，玩家每升一級都「立即看到背包扣得少」。

範例（鐵劍每次修復成本）：

| 階段 | stone | coal | iron |
|---|---|---|---|
| 無建築 | 20 | 10 | 13 |
| Lv3 −10% | 18 | 9 | 12 |
| Lv4 −25% | 15 | 8 | 10 |
| Lv5 −40% | 12 | 6 | 8 |

範例（傳說之劍每次修復成本）：

| 階段 | stone | coal | iron | legendary_fragment | diamond |
|---|---|---|---|---|---|
| 無建築 | 20 | 10 | 5 | 9 | 6 |
| Lv5 −40% | 12 | 6 | 3 | 6 | 4 |

#### C. 戰鬥耐久節省 5%（`combat_durability_save_pct`）

- **僅在地下城／世界王戰鬥中** 對 **武器 + 盾** 扣耐久時觸發；鎬子挖礦、釣竿釣魚不觸發。
- 實作位置：`dungeon/battleEngine.js` 扣武器/盾耐久前骰 `Math.random() < 0.05`，命中跳過扣除。
- 為什麼從 10% 砍到 5%：
  - 5% 期望延壽 ≈ 5.3%（`1/(1-0.05) - 1`）— 玩家每 20 次戰鬥多撐 1 次。
  - 10% 對盾尤其影響大：盾每場最多扣 5 耐（mini-boss 8），10% 期望多撐 11.1% 場次 → 直接拉長 boss 戰續戰能力。5% 比較收斂。
- 為什麼排除鎬子／釣竿：那兩條已有完善的「磨石」「修復工具」二層修復系統（`craft.json` 的 `repairTools` / `whetstones`），10% 免扣會讓那些 endgame 的工具設計被架空。

### 2.4 需新增 buff key（必補 `buffLabels.js`）

```js
weapon_max_durability_pct:     { label: "武器耐久上限", unit: "+{v}%" },
equipment_repair_discount_pct: { label: "裝備修復材料", unit: "-{v}%（武器/鎬/釣竿）" },
combat_durability_save_pct:    { label: "戰鬥耐久節省", unit: "+{v}%（武器/盾）" },
```

### 2.5 經濟驗算

**傳說之劍滿級鐵匠鋪（Lv5）日常修復負擔**：

- 耐久 120 → 144（+20%）
- 戰鬥耐久節省 5% → 期望 ≈ 152 場次戰鬥才空耐
- 修復材料 −40% → 從 `stone 20, coal 10, iron 5, legendary_fragment 9, diamond 6` 變 `12, 6, 3, 6, 4`
- 每 152 場戰鬥修復一次，相較於原本每 120 場戰鬥修費約 60% 材料 → **整體傳說之劍維護成本降到原本的 47%**
- 這是「長期目標」，但仍不影響戰力本身

**鐵劍新手日常修復負擔**：

- 耐久 40 → 48（+20%）
- Lv5 修費 12/6/8（原 20/10/13）→ −40%
- 新手友善，但收益絕對值小（一次省 8 石 4 煤 5 鐵），不會破壞前期經濟

---

## 3. 共同實作要點

### 3.1 修改 `guild_buildings.json`

在 `kinds` 加 `farm_kitchen` 與 `blacksmith` 兩個 key（per-kind `unlockClubLevel` 取代 root level 的 `unlockClubLevel: 2`），需要把 root `unlockClubLevel` 廢棄、改成每個 kind 自己一個 `unlockClubLevel`。`buildingService` 一併改：

- `nextLevelRow` 前先檢查 `club.level >= kindDef(kind).unlockClubLevel ?? buildingCfg().unlockClubLevel`
- 顯示「未解鎖」用 CLAUDE.md UX #6 格式：`🔒 農膳坊 尚未解鎖！\n解鎖條件：公會 Lv.3\n目前：Lv.X`

### 3.2 `buildingsBuffs` 既有實作支援度

`buildingService.buildingsBuffs` 已是「取當前 row 累積值」的覆蓋式（注意註釋：「PDF 表上已給累積總值」），所以新建築的 `buffs` 陣列也用累積總值寫法即可，與礦坑 / 訓練場一致。

### 3.3 新增 buff 串接位置

| buff | 串接點 | 串接方式 |
|---|---|---|
| `farm_growth_reduction_pct` | `farmService.plantCrop` 計算 `ready_at` 處 | 把 `gc.buffsByType.farm_growth_reduction_pct / 100 × crop.growMs` 加進 `growth_reduction_ms`，與肥料共享 cap |
| `harvest_coin_pct` | `farmService.harvestCrop` 算 payout 處 | `randomInt(lo, hi) × (1 + pct/100)` |
| `cooking_crit_pct` | `cookService.applyFoodBuff` 套用前 | 骰 → 命中則 `uses_left *= 2` 或 `expires_at += durationMs` |
| `farm_low_tier_extra_count` | `farmService.harvestCrop` 收尾 | `LOW_TIER_CROPS.has(cropKey)` 才 +1 |
| `weapon_max_durability_pct` | 換裝（`mineService.equipWeapon`）+ 升級事件 | 重算 `weapon_max_durability`；當前 `weapon_durability` 不變 |
| `equipment_repair_discount_pct` | `getWeaponRepairCost / getRodRepairCost / getPickaxeRepairCost` 末端 | `Math.max(1, ceil(qty × (1 - pct/100)))` |
| `combat_durability_save_pct` | `dungeon/battleEngine` 扣武器/盾耐久前 | 骰 → 命中則跳過扣除 |

### 3.4 公會升級事件：刷新成員 `weapon_max_durability`

鐵匠鋪升級會改變所有成員的 `weapon_max_durability`。在 `buildingService.upgradeBuilding` 成功後對該 club 所有 member 跑：

```js
// pseudo
for member of clubMembers:
  if member.weapon !== "fist":
    member.weapon_max_durability = floor(weaponDef.durability × (1 + newPct/100))
    // weapon_durability 維持不動（不送、不扣）
```

要不要這樣寫看怎麼權衡。另一個選擇是 **lazy 計算**：把 `weapon_max_durability` 改成「動態查詢」而非存欄位，讀的時候現算 `weaponDef.durability × (1 + currentBuildingPct/100)`。Lazy 路線改的地方多（profile 顯示、修復檢查、扣耐邏輯都要改），但避開「公會解散後玩家裝備 max 跳回」的尷尬。

**推薦 lazy**，因為玩家換公會 / 公會降級的情境會很乾淨。

### 3.5 同步 `bibi-website/src/lib/dashboard/botDefs.ts`

公會建築顯示要在 dashboard 出現中文名稱（避免 `(farm_kitchen)` fallback）。一併補新建築 emoji 與 buff 名稱對照表。

### 3.6 `/加成` 指令（`src/commands/mining/buff.js`）顯示區塊

照 CLAUDE.md 架構規則：新增 buff 類型時同步更新顯示。把 7 條新 buff 加進 summary 區塊（按農場 / 烹飪 / 裝備 分組）。

---

## 4. 平衡性綜評

### 4.1 戰力通膨

- 農膳坊：0 戰力影響（所有 buff 走食物 buff 的二級管道，已有食物 buff 系統壓在 `getFoodAtkBonus` / `getFoodDefBonus` 等可控閘門）
- 鐵匠鋪：0 戰力影響（不動 atk/def/critRate）

### 4.2 經濟通膨

- 農膳坊 +20% 收成金幣 + 紅蘿蔔/玉米 +1 → 對低階作物 +30~50% 日收，**符合「鼓勵循環操作」設計**，不破壞單次倍率
- 鐵匠鋪 −40% 修復 + 20% 耐久 → 傳說之劍維護成本 47%、其他武器約 50~60%。減少消耗 ≠ 通膨，因為背包石/煤/鐵的下沉減少不會推高其他經濟參數

### 4.3 與磨石 / 修復工具的關係

- 鎬子吃 `equipment_repair_discount_pct` 但不吃 `combat_durability_save_pct` → 磨石仍是「快速恢復、保留 max」的工具，鐵匠鋪是「整體少花材料」的工具，雙線不衝突
- 釣竿同理

### 4.4 與肥料系統的關係

- 農膳坊 `farm_growth_reduction_pct` 與肥料共享 cap → 滿級 −12% 後玩家還能用月光露水（−40%）+ 怪物黏液（−25%）疊到 60% cap，肥料價值不死
- `yield_bonus_pct` 沒動 → 肥料的「+30% 章魚」「+20% 月光」仍是高階作物產量的唯一來源

---

## 5. 落地步驟（給工程的最小單位）

1. **新 buff 標籤**：`src/features/buff/buffLabels.js` 加 7 條新 key
2. **建築 config**：`src/config/guild_buildings.json` 加 `farm_kitchen` / `blacksmith` 兩個 kind；把 root `unlockClubLevel` 移到 per-kind
3. **解鎖判斷**：`buildingService` 升級檢查補 `unlockClubLevel`
4. **buff 串接**：
   - `farmService.plantCrop` 接 `farm_growth_reduction_pct`
   - `farmService.harvestCrop` 接 `harvest_coin_pct` + `farm_low_tier_extra_count`
   - `cookService` 接 `cooking_crit_pct`
   - `mineService.getXxxRepairCost` 接 `equipment_repair_discount_pct`
   - 武器 max durability 改 lazy（推薦）或在升級時批次刷新
   - `dungeon/battleEngine` 接 `combat_durability_save_pct`
5. **指令顯示**：`/加成` 加 7 條新 buff 區塊；`/公會建築` 顯示新兩個建築
6. **網站同步**：`bibi-website/src/lib/dashboard/botDefs.ts` 加中文名稱

預估工程量：兩個建築 + 7 條 buff 串接 ≈ 1.5~2 個工作天（含測試與 UI 調整）。
