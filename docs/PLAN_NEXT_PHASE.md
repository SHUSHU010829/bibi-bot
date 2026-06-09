# 逼逼機器人 — 新階段企劃書（問卷高期待三玩法）

> 紀錄日期：2026-06-09
> 背景：以問卷統計挑出期待值最高的三個玩法，從 `PLAN_BRAINSTORM.md`
> 中對應條目展開為完整 Phase 規劃。
> 涵蓋：**Phase H 寵物 / 夥伴養成**（對應 brainstorm A1）、
> **Phase I 文字冒險（森林 / 廢墟 / 深海）**（對應 brainstorm C1）、
> **Phase J 轉職 / 職業系統**（對應 brainstorm G2）。
> 銜接於 `PLAN_INTEGRATED.md` 之後，作為下一波主開發路線。

---

## 目錄

1. [文件目的與範圍](#1-文件目的與範圍)
2. [設計原則與共同地基](#2-設計原則與共同地基)
3. [Phase 排程與依賴關係](#3-phase-排程與依賴關係)
4. [Phase H — 寵物 / 夥伴養成](#phase-h--寵物--夥伴養成)
5. [Phase I — 文字冒險（森林 / 廢墟 / 深海）](#phase-i--文字冒險森林--廢墟--深海)
6. [Phase J — 轉職 / 職業系統](#phase-j--轉職--職業系統)
7. [跨 Phase 整合](#跨-phase-整合)
8. [開發時程總覽](#開發時程總覽)
9. [新增檔案索引](#新增檔案索引)
10. [通用驗收清單](#通用驗收清單)

---

## 1. 文件目的與範圍

### 1.1 與既有文件的關係

| 文件 | 範圍 | 狀態 |
|---|---|---|
| `PLAN_INTEGRATED.md` | Phase 8 / A–G / S3–S5 | 除 S3 外皆已完成 |
| `PLAN_OPTIMIZATION.md` | 既有功能優化（Opt-1～Opt-5） | 平行進行 |
| `PLAN_BRAINSTORM.md` | 30 個玩法候選 | 腦力激盪存檔 |
| **`PLAN_NEXT_PHASE.md`（本文件）** | **問卷三高期待玩法（H / I / J）** | **主開發路線** |

### 1.2 為什麼是這三個

| Phase | 對應條目 | 問卷期待值 | 核心價值 |
|---|---|---|---|
| **H 寵物 / 夥伴養成** | brainstorm A1 ⭐⭐⭐ | 高 | 每日回流、跨系統消耗出口、最強留存 |
| **I 文字冒險** | brainstorm C1 ⭐⭐⭐ | 高 | 補敘事性玩法缺口、單人 / 公會組隊皆可 |
| **J 轉職 / 職業系統** | brainstorm G2 ⭐⭐ | 高 | 玩家身份感、與 S3 技能樹差異化、季賽節奏 |

三者覆蓋 **養成 / 探險 / 身份** 三個玩家動機面向，彼此正交、且可串接：
- 寵物提供出戰 buff → 文字冒險可帶寵物 → 不同職業冒險路線不同。

---

## 2. 設計原則與共同地基

延續 `PLAN_INTEGRATED.md §2`，本文件另增以下重點：

| 原則 | 說明 |
|---|---|
| **生產 ↔ 消耗對稱** | 寵物餵食消化 fishing / farm 產出；冒險消耗體力與消耗品；轉職費用銷毀幣 |
| **eventBus 優先** | 三 Phase 之間的觸發改用 `src/features/eventBus`（見 brainstorm I3）統一訂閱 |
| **buff 統一彙整** | 所有加成走 `buffResolver`，新增 `pet`、`profession` 兩個來源 |
| **config 驅動** | 寵物品種、冒險事件樹、職業效果全部放 JSON |
| **owner 驗證** | 寵物 / 冒險 / 職業切換按鈕 customId 一律帶 ownerId |

### 2.1 前置地基（建議優先做）

> 本文件三個 Phase 上線前，**強烈建議** 先完成這兩項地基，否則維運會很痛苦：

| 地基 | 來源 | 為什麼這次必須做 |
|---|---|---|
| **eventBus**（brainstorm I3） | 新增 `src/features/eventBus/index.js` | 寵物親密度 / 冒險敘事節點 / 職業任務追蹤都會訂閱多個既有事件，沒這個會散落於每個 service |
| **經濟儀表板**（brainstorm I1） | 擴 `EconomySnapshots` + `/economy-admin dashboard` | 寵物與職業上線後新增大量 buff，沒儀表板無法判斷平衡 |

兩項合計 4–5 天，本文件時程已內含。

---

## 3. Phase 排程與依賴關係

```
                      ┌──────────────────────┐
                      │ eventBus（地基 2d）   │
                      └─────┬────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌─────────┐   ┌──────────┐  ┌──────────┐
        │ Phase H │   │ Phase J  │  │ Phase I  │
        │ 寵物    │   │ 轉職     │  │ 文字冒險 │
        └────┬────┘   └────┬─────┘  └────┬─────┘
             │             │             │
             └─────────────┴─────────────┘
                           │
                           ▼
                  ┌────────────────────┐
                  │ 經濟儀表板（平衡） │
                  └────────────────────┘
```

**建議順序**：`eventBus → Phase H 寵物 → Phase J 轉職 → Phase I 文字冒險 → 經濟儀表板覆盤`

理由：
- 寵物先做，因為它是 fishing / farm 產出的天然 sink，能立即消化 過剩產出
- 轉職放第二，給玩家身份感後再進冒險，職業會影響冒險選擇分支
- 文字冒險最後，因為它要吃前兩個 Phase 的 buff / 寵物出戰能力

---

## Phase H — 寵物 / 夥伴養成

> **前置需求**：Phase S4（釣魚）✅、Phase D（農場）✅、Opt-5（buffResolver）、eventBus 地基
> **預估時間**：6–8 天
> **定位**：最強留存系統，跨生產線消耗出口

### 核心機制

- 玩家從 **BOSS 戰結算 / 釣魚稀有抽 / 農場黑玫瑰收成** 機率掉「寵物蛋」
- 蛋有孵化倒數（4 / 12 / 24 小時依稀有度），孵化期可加速（餵食 / 加溫道具）
- 孵出寵物 → **三條軸**：等級（exp） / 親密度（互動） / 飢餓度（每 12h −10）
- 飢餓度 0 → 寵物罷工，不提供 buff
- 玩家可同時擁有多隻，但 **一次只能出戰一隻**

### 寵物品種（config 驅動，初版 10 隻）

| 品種 | 稀有度 | 出戰 buff | 取得來源 |
|---|---|---|---|
| 🐹 小礦鼠 | 普通 | 挖礦 qty +1 | 蛋（普通） |
| 🐟 小水靈 | 普通 | 釣魚 luck +5% | 蛋（普通） |
| 🌱 種苗精 | 普通 | 農場成熟時間 −10% | 蛋（普通） |
| 🐺 礦坑狼 | 稀有 | 挖礦 luck +5%、ATK +20 | 蛋（稀有） |
| 🦅 海鷹 | 稀有 | 釣魚 CD −15% | 蛋（稀有） |
| 🦄 守庫獸 | 稀有 | 賣礦 / 賣魚收入 +10% | 蛋（稀有） |
| 🐉 小火龍 | 傳說 | BOSS 傷害 +25% | 蛋（傳說 / BOSS 尾刀掉） |
| 🦊 商賈狐 | 傳說 | 拍賣手續費 −2%、打工收入 +20% | 蛋（傳說） |
| 🎄 雪精靈 | 限定 | 全屬性 +8% | 聖誕活動 / 抖內 |
| 🌟 抖內龍 | 限定 | 全屬性 +10% | 至尊抖內專屬 |

### 親密度系統

| 互動 | 親密度 +/- | 冷卻 |
|---|---|---|
| 餵食（魚 / 作物） | +5 ~ +15（依稀有度） | 每隻每日 5 次 |
| 撫摸 `/寵物 互動` | +2 | 每隻每日 3 次 |
| 出戰陪同（BOSS / 冒險） | +1 per 次 | — |
| 飢餓度歸 0 | −20（一次性） | — |

| 親密度等級 | 門檻 | 解鎖 |
|---|---|---|
| 生疏 | 0–99 | buff 效果 ×0.7 |
| 熟悉 | 100–299 | buff 效果 ×1.0 |
| 親密 | 300–699 | buff 效果 ×1.1 + 解鎖第二技能槽 |
| 摯友 | 700+ | buff 效果 ×1.25 + 出戰時 5% 機率觸發雙倍掉落 |

### 等級與進化

- 出戰時自動獲得 exp（挖礦 / 釣魚 / 農場 / BOSS / 冒險 都觸發）
- Lv.10、Lv.25 可進化（稀有度 +1 階、外觀變化、buff 數值 +20% / +40%）
- 進化需消耗「進化石」（BOSS 尾刀獎勵 / 抖內 / 限時活動掉）

### 消耗出口（必填段落）

| 入口 | 出口 |
|---|---|
| 蛋掉落 → 寵物 | 飢餓度需持續餵食（魚 / 作物消耗） |
| BOSS / 冒險 exp | 進化石需求（推動 BOSS 參與） |
| 多隻寵物 | 出戰切換 CD（避免無痛切換）+ 收養上限（初始 3 隻、可花幣擴充至 10 隻） |

### UX 設計重點

依 `CLAUDE.md` 七項檢查：

- **`/寵物 列表`**（查詢類 → ephemeral）：每隻寵物獨立 TextDisplay + 緊接 ActionRow（餵食 / 互動 / 出戰）
- **餵食成功**：成功訊息附「再餵一隻 / 查看魚袋」快捷按鈕
- **飢餓度警告**：飢餓 ≤ 20 時，下次 `/挖礦` 等行動完成訊息加 -# 提示「⚠️ 你的小火龍快餓了」
- **未孵化的蛋**：值為 0 的品種不顯示佔位，統一以 -# 顯示「尚未擁有：…」

### 指令

| 指令 | 說明 | 類別 |
|---|---|---|
| `/寵物 列表` | 查看擁有的寵物 / 蛋 | ephemeral |
| `/寵物 出戰 [pet_id]` | 切換出戰寵物 | ephemeral |
| `/寵物 餵食 [pet_id] [食材]` | 餵食 | 公開 |
| `/寵物 互動 [pet_id]` | 撫摸 / 玩耍 | 公開 |
| `/寵物 進化 [pet_id]` | 進化（需材料） | 公開 |
| `/寵物 圖鑑` | 已收集品種 + 解鎖獎勵 | ephemeral |
| `/寵物 改名 [pet_id] [名稱]` | 自訂名稱（30 字內） | ephemeral |
| `/寵物 放生 [pet_id]` | 放生（二次確認），返還少量幣 | ephemeral |

### DB 新增

```js
// user_pets
{
  pet_id:           String,    // uuid
  owner_id:         String,
  guild_id:         String,
  species:          String,    // 品種 id
  rarity:           String,    // 'common' | 'rare' | 'legendary' | 'limited'
  name:             String,    // 玩家自訂（預設＝品種名）
  level:            Number,
  exp:              Number,
  affection:        Number,    // 親密度
  hunger:           Number,    // 0 ~ 100
  last_fed_at:      Number,
  evolution_stage:  Number,    // 0 / 1 / 2
  active:           Boolean,   // 是否出戰中
  obtained_at:      Number,
  obtained_from:    String,    // 'boss' | 'fishing' | 'farm' | 'event' | 'donation'
}

// user_pet_eggs
{
  egg_id:       String,
  owner_id:     String,
  guild_id:     String,
  rarity:       String,
  hatches_at:   Number,
  obtained_at:  Number,
  obtained_from:String,
}
```

索引：
- `user_pets`：`{ owner_id: 1, guild_id: 1 }`、`{ owner_id: 1, active: 1 }`
- `user_pet_eggs`：`{ hatches_at: 1 }`（孵化排程掃描）

### Config 驅動（`src/config/pet.json`）

```json
{
  "species": [
    {
      "id": "mine_mouse", "name": "小礦鼠", "emoji": "🐹", "rarity": "common",
      "baseBuff": { "miningQty": 1 },
      "evolutionTo": "iron_mouse",
      "favoriteFood": ["small_fish", "carrot"]
    }
  ],
  "egg": {
    "hatchHours": { "common": 4, "rare": 12, "legendary": 24 },
    "speedupItem": "warming_stone",
    "speedupReductionPct": 0.5
  },
  "hunger": {
    "decayPerHour": 0.83,
    "thresholdWorking": 1,
    "warningAt": 20
  },
  "affection": {
    "tiers": [
      { "name": "生疏", "min": 0,   "buffMult": 0.7 },
      { "name": "熟悉", "min": 100, "buffMult": 1.0 },
      { "name": "親密", "min": 300, "buffMult": 1.1 },
      { "name": "摯友", "min": 700, "buffMult": 1.25 }
    ]
  },
  "dropSources": {
    "bossKill":     { "rate": 0.15, "rarityPool": { "common": 0.6, "rare": 0.35, "legendary": 0.05 } },
    "fishingRare":  { "rate": 0.02, "rarityPool": { "common": 0.7, "rare": 0.30 } },
    "farmBlackRose":{ "rate": 0.10, "rarityPool": { "common": 0.5, "rare": 0.5 } }
  }
}
```

### 與現有系統的接點

- **掉蛋 hook**：訂閱 `boss.killed` / `fish.done` / `harvest.done`（eventBus）→ 機率寫入 `user_pet_eggs`
- **餵食扣物**：扣 `UserInventory`（魚）/ `farm_inventory`（作物）
- **出戰 buff**：`buffResolver` 新增 `pet` 來源，讀 `user_pets.active=true`
- **孵化排程**：新增 `src/events/ready/petHatchChecker.js`（每分鐘）
- **飢餓排程**：併入既有 `farmDecayChecker.js`（節省 cron 數量），每小時 −0.83

### 新增檔案

| 檔案 | 內容 |
|---|---|
| `src/config/pet.json` | 品種、稀有度、buff 數值 |
| `src/features/pet/petService.js` | 蛋孵化、餵食、進化、出戰切換 |
| `src/features/pet/petResolver.js` | 出戰 buff 給 buffResolver 呼叫 |
| `src/events/ready/petHatchChecker.js` | 孵化排程 |
| `src/commands/pet/pet.js` | `/寵物` 指令群 |
| `src/events/interactionCreate/handlePetButton.js` | 按鈕處理（owner 驗證） |

---

## Phase I — 文字冒險（森林 / 廢墟 / 深海）

> **前置需求**：Phase 4（地下城）✅、Phase H 寵物（可選同時出戰）、eventBus 地基
> **預估時間**：7–9 天（框架 5d + 三場景各 1–2d）
> **定位**：補敘事性玩法缺口，單人 / 公會組隊皆可

### 核心機制

- text-based choice adventure，**事件樹用 JSON 定義**，未來加新場景只改設定檔
- 三場景：🌲 **暗影森林**（低階）、🏛️ **沉沒廢墟**（中階）、🌊 **深海裂谷**（高階）
- 每場 3–5 個 node（事件節點），玩家用按鈕選擇分支
- 消耗體力（5 / 8 / 12 點，與地下城共用體力池）
- 結果：幣 / 道具 / 寵物蛋 / 限定稀有素材 / 稱號候選
- **可帶出戰寵物**：寵物 buff 影響選項成功率
- **可公會組隊**（2–4 人）：分擔風險、提高高階場景生還率

### 場景定位

| 場景 | 解鎖 | 體力消耗 | 平均單場時長 | 預期報酬 |
|---|---|---|---|---|
| 🌲 暗影森林 | Lv.10 | 5 | 3–5 分鐘 | 200–500 幣 + 普通寵物蛋（5%） |
| 🏛️ 沉沒廢墟 | Lv.25 + 森林通關 3 次 | 8 | 5–8 分鐘 | 600–1,500 幣 + 限定「古文物」 |
| 🌊 深海裂谷 | Lv.45 + 廢墟通關 5 次 | 12 | 8–12 分鐘 | 2,000–5,000 幣 + 稀有寵物蛋（10%） |

### 事件節點機制

每個 node 是一個 JSON 物件：

```json
{
  "id": "forest_n1",
  "scene": "forest",
  "text": "你走到一條岔路，左邊傳來奇怪的低吼聲，右邊則是寧靜的溪流。",
  "image": null,
  "choices": [
    {
      "label": "🗡️ 朝低吼聲走過去",
      "checks": [{ "type": "atk", "min": 80 }],
      "petBonus": { "species": "mine_wolf", "successPct": 15 },
      "outcomes": {
        "success":  { "rate": 0.6, "next": "forest_n2_combat",  "reward": { "coin": 150 } },
        "fail":     { "rate": 0.4, "next": "forest_n2_retreat", "penalty": { "stamina": 2 } }
      }
    },
    {
      "label": "🐟 朝溪流走過去",
      "outcomes": {
        "success": { "rate": 1.0, "next": "forest_n2_fish", "reward": { "item": { "small_fish": 3 } } }
      }
    }
  ]
}
```

關鍵設計：
- `checks`：玩家屬性門檻（ATK / luck / level / 寵物出戰），低於門檻則 `success.rate` 降低
- `petBonus`：特定品種寵物出戰時，提高成功率 X%
- `outcomes.next`：可指向下一 node、結算 node、或迴圈 node（迷路機制）
- `outcomes.reward / penalty`：幣 / 物品 / 體力 / 寵物 exp

### 場景事件樹概覽

> 完整事件樹放 `src/config/adventure/<scene>.json`，每場景 15–25 個 node 組成樹狀分支。

**🌲 暗影森林**（3 主分支 × 平均 4 nodes）：
- 戰士路線：遭遇野獸 → BOSS 路線（小狼王）
- 探索路線：發現遺跡入口（為 廢墟解鎖鋪伏筆）
- 採集路線：撿藥草 / 釣魚 / 採蘑菇

**🏛️ 沉沒廢墟**（4 主分支 × 平均 4 nodes）：
- 機關解謎：成功 → 古文物；失敗 → 落石扣血
- 守衛戰鬥：機關獸戰，配合寵物效率倍增
- 古文物收集：考古路線（為 brainstorm C2 鋪路）
- 隱藏分支：找到「廢墟之心」→ 解鎖深海

**🌊 深海裂谷**（5 主分支 × 平均 5 nodes）：
- 深淵釣魚：稀有魚 +「深海珍珠」
- 海怪戰：擊敗 → 稀有寵物蛋（10%）
- 探險路線：傳說地圖碎片（連動既有藏寶圖系統）
- 失蹤者線：救援 NPC → 解鎖「深海守衛」永久稱號
- 死亡分支：滅頂 → 全部獎勵歸 0、體力扣光（高風險）

### 公會組隊規則

- 隊長發起：`/冒險 組隊 [場景]` → 公會頻道發出按鈕，會員按下加入
- 2–4 人，所有成員體力消耗 −20%
- 每個 node 選項由「當前回合玩家」決定，下個 node 換下一位（輪流主控）
- 報酬均分，但**寵物蛋給機率最高那位**（避免拆裂）

### 消耗出口（必填段落）

| 入口 | 出口 |
|---|---|
| 冒險產出（幣 / 文物 / 蛋） | 體力消耗（5–12 點 / 場）、失敗節點消耗藥水 / 道具 |
| 寵物 exp 加速 | 帶寵物提高成功率，但寵物會掉飢餓度 |
| 公會組隊 | 隊長付組隊費 100 幣 / 場（防濫開） |

### UX 設計重點

- **冒險中訊息**：每個 node 用 **ContainerBuilder** 呈現
  - Header：場景 emoji + 進度（Node 2 / 5）
  - Body：node text（敘事文字）
  - Separator
  - 寵物 / 同伴狀態小字 -#
  - ActionRow：選項按鈕（最多 4 個）
- **結算訊息**：成功訊息附「再玩一場 / 查看冒險紀錄 / 進入下個場景」按鈕
- **未解鎖場景**（UX 檢查 #6）：
  > `🔒 沉沒廢墟 尚未解鎖！\n解鎖條件：等級 25 + 暗影森林通關 3 次\n目前：Lv.18・通關 1 次`
- **按鈕 owner**：node 選項按鈕 customId `adv_<userId>_<runId>_<choiceIdx>`，owner 驗證必做（組隊模式下還需驗證「當前回合 ID」）

### 指令

| 指令 | 說明 |
|---|---|
| `/冒險` | 顯示三場景入口、解鎖狀態 |
| `/冒險 進入 [場景]` | 進入冒險（觸發 node 0） |
| `/冒險 組隊 [場景]` | 公會組隊（發起頻道訊息） |
| `/冒險 紀錄` | 查看歷史通關紀錄 |
| `/冒險 圖鑑` | 各場景結局收集進度 |
| `/adventure-admin reload` 🔒 | 重新載入事件樹 JSON（不重啟） |

### DB 新增

```js
// adventure_runs
{
  run_id:        String,
  user_id:       String,        // 單人 / 隊長
  guild_id:      String,
  scene:         String,        // 'forest' | 'ruins' | 'abyss'
  party:         [String],      // 組隊成員 user_ids（含隊長），單人＝[user_id]
  current_node:  String,
  visited_nodes: [String],
  pet_id:        String,        // 出戰寵物（隊長的）
  status:        String,        // 'active' | 'cleared' | 'failed' | 'expired'
  started_at:    Number,
  ended_at:      Number,
  ending_id:     String,        // 結局 id（用於圖鑑）
  rewards:       Object,        // 結算獎勵明細
}

// adventure_ending_unlocks
{
  user_id:    String,
  guild_id:   String,
  scene:      String,
  ending_id:  String,
  unlocked_at:Number,
}
```

索引：
- `adventure_runs`：`{ user_id: 1, status: 1 }`、TTL 30 天
- `adventure_ending_unlocks`：`{ user_id: 1, guild_id: 1, scene: 1, ending_id: 1 }` unique

### Config 結構

```
src/config/adventure/
  ├── forest.json    // 森林事件樹
  ├── ruins.json     // 廢墟事件樹
  ├── abyss.json     // 深海事件樹
  └── common.json    // 共用：解鎖條件、結局稱號清單
```

### 與現有系統的接點

- **體力消耗**：扣 `MiningProfiles.stamina`（與地下城 / BOSS 共用）
- **戰鬥節點**：複用 `bossEngine` 的 ATK 計算（傷害公式抽出共用）
- **寵物加成**：透過 `petResolver` 讀出戰寵物 species
- **掉落寵物蛋**：emit `pet.egg.gained` → `petService` 寫入 `user_pet_eggs`
- **公會頻道發訊**：複用既有公會頻道綁定

### 新增檔案

| 檔案 | 內容 |
|---|---|
| `src/config/adventure/*.json` | 三場景事件樹 + common |
| `src/features/adventure/adventureEngine.js` | run 狀態機、node 跳轉、屬性檢查 |
| `src/features/adventure/partyService.js` | 公會組隊輪流邏輯 |
| `src/commands/adventure/adventure.js` | `/冒險` 指令群 |
| `src/events/interactionCreate/handleAdventureButton.js` | 節點選擇按鈕 |

---

## Phase J — 轉職 / 職業系統

> **前置需求**：Phase 1–4 完成 ✅、Opt-5（buffResolver）、eventBus 地基
> **預估時間**：5–6 天
> **定位**：身份感系統，與 S3 技能樹差異化（職業＝身份 / 技能樹＝點數）

### 與技能樹的差異

| 維度 | S3 技能樹 | J 轉職系統 |
|---|---|---|
| 形式 | 解點數，三線可混點 | 選一個身份，獨佔效果 |
| 切換 | 重置（5,000 幣） | 轉職（每季 1 次免費、額外需消耗轉職石） |
| 效果 | 數值累加 | 數值 +專屬指令 +專屬視覺 |
| 玩家心智 | 「我有什麼能力」 | 「我是誰」 |

兩者**可疊加共存**：礦工職業 + 採掘線技能 = 雙重強化挖礦。

### 六職業（config 驅動，初版）

| 職業 | 主動指令 | 被動 buff | 適合玩家 |
|---|---|---|---|
| ⛏️ **礦工 Miner** | `/挖礦` CD 個人降低 10 分鐘 | 挖礦 qty +1、賣礦 +5% | 主力挖礦 |
| 🎣 **漁夫 Fisher** | `/釣魚` 一次釣兩條（消耗 2 次 CD） | 釣魚 luck +10%、烹飪 buff 時長 +30% | 主力釣魚 |
| 🌾 **農夫 Farmer** | `/施肥` 不消耗礦石（每日 3 次） | 農場成熟時間 −15%、收成 +10% | 主力農場 |
| ⚔️ **騎士 Knight** | `/挑釁`：強制鎖定一名玩家不能逃避決鬥（每週 1 次） | 地下城 / BOSS / 冒險 ATK +25、被反擊 −5% | PvP / BOSS |
| 💰 **商人 Merchant** | `/談判`：對特定 NPC 商店價格降 10%（每日 5 次） | 拍賣手續費 −2%、打工收入 +20% | 經濟 / 拍賣 |
| 📚 **學者 Scholar** | `/分析`：免費查任一礦石近 30 天行情走勢 | 任務獎勵 +15%、圖鑑解鎖時送額外幣 | 任務 / 收集 |

### 等級與精通

- 初次轉職免費，需 **Lv.20** + 完成「轉職試煉」（職業專屬短任務）
- 轉職後職業 exp 與玩家總等級分開計算（職業 Lv 0 → 50）
- 職業 Lv 每升 10 級解鎖：
  - Lv 10：buff 數值 +20%
  - Lv 20：解鎖第二主動指令
  - Lv 30：被動 buff +40%
  - Lv 50：解鎖**職業稱號**（永久）

### 轉職規則

| 情境 | 規則 |
|---|---|
| 初次轉職 | 免費 |
| 每季 1 次 | 免費（每季開始 1 / 4 / 7 / 10 月） |
| 額外轉職 | 消耗「轉職石」×1（活動 / BOSS / 抖內掉） |
| 強制轉回 | 不允許，但可以放棄職業（無職業狀態，無 buff） |

職業 exp 在轉職後**保留但凍結**，轉回時繼續累計。

### 季賽機制（職業榜）

每季結算每個職業的「該職業 Lv 50 並完成 N 個專屬任務」的玩家，發限定稱號：
- 季冠軍：「礦工之王」「漁夫之王」… × 6（季）
- 全職業精通：所有職業都達 Lv 30 → 永久稱號「百業通」

### 消耗出口（必填段落）

| 入口 | 出口 |
|---|---|
| 轉職 buff 強化原玩法產出 | 額外轉職需要轉職石、季賽限定稱號讓玩家有動機重置 |
| 主動指令（如 `/挑釁`） | 每日 / 每週限次，避免濫用 |

### UX 設計重點

- **`/職業 列表`**（查詢類 → ephemeral）：六個職業獨立 Section + 各自下方 ActionRow（轉職 / 查看試煉）
- **未滿足轉職條件**（UX 檢查 #6）：Container 紅色 accent，明列「需要 Lv.20、目前 Lv.17」
- **轉職成功**：成功訊息附「立刻試試新指令 / 查看職業效果」快捷按鈕
- **職業專屬指令**（如 `/挑釁`）若無職業 → Container 提示「此指令限騎士使用，目前無職業」+ 解決方向「使用 `/職業 列表` 選擇職業」

### 指令

| 指令 | 說明 | 類別 |
|---|---|---|
| `/職業 列表` | 查看 6 職業效果 / 我的職業 | ephemeral |
| `/職業 轉職 [職業]` | 執行轉職（含確認 modal） | 公開 |
| `/職業 試煉 [職業]` | 查看 / 接取試煉任務 | ephemeral |
| `/職業 季榜` | 各職業榜單 | ephemeral |
| 6 個職業專屬指令 | 礦工、漁夫… 各自的主動指令 | 公開 |

### DB 新增

```js
// user_professions
{
  user_id:           String,
  guild_id:          String,
  current:           String,    // 'miner' | 'fisher' | ... | null
  level:             Number,    // 當前職業 Lv
  exp:               Number,
  history:           [          // 轉職歷史（含凍結 exp）
    { profession: 'miner', level: 12, exp: 3400, switched_at: 1717891200000 }
  ],
  free_switch_used_at: Number,  // 本季是否用過免費轉職
  trial_completed:   { miner: true, fisher: false, ... },
  updated_at:        Number,
}
```

索引：`{ user_id: 1, guild_id: 1 }` unique。

### Config 驅動（`src/config/profession.json`）

```json
{
  "professions": [
    {
      "id": "miner",
      "name": "礦工",
      "emoji": "⛏️",
      "passive": { "miningQty": 1, "miningSellPct": 0.05 },
      "active": {
        "cmd": "礦工專注",
        "effect": "miningCdReduceMs",
        "value": 600000,
        "cooldown": "daily-3"
      },
      "trial": [
        { "type": "mine_count", "target": 30 },
        { "type": "sell_coin",  "target": 1000 }
      ],
      "expCurve": "polynomial",
      "unlockLevel": 20
    }
  ],
  "switchPolicy": {
    "freeFirstTime":  true,
    "freePerSeason":  1,
    "seasonStartMonths": [1, 4, 7, 10],
    "extraSwitchItem": "career_stone"
  }
}
```

### 與現有系統的接點

- **buff 整合**：`buffResolver` 新增 `profession` 來源
- **主動指令**：六個職業專屬指令掛在 `src/commands/profession/`，run() 開頭檢查 `user_professions.current`
- **季榜結算**：新增 `src/events/ready/professionSeasonChecker.js`（每日 00:05 檢查是否季首 / 季末）
- **exp 累計**：訂閱 `mine.done` / `fish.done` / `harvest.done` / `boss.attacked` 等 eventBus 事件

### 新增檔案

| 檔案 | 內容 |
|---|---|
| `src/config/profession.json` | 六職業定義 + 試煉 + 季賽 |
| `src/features/profession/professionService.js` | 轉職、試煉、exp 累計 |
| `src/features/profession/professionResolver.js` | 給 buffResolver 呼叫 |
| `src/commands/profession/profession.js` | `/職業` 指令群 |
| `src/commands/profession/active/*.js` | 6 個職業專屬主動指令 |
| `src/events/ready/professionSeasonChecker.js` | 季賽結算 cron |
| `src/events/interactionCreate/handleProfessionButton.js` | 轉職按鈕（含確認） |

---

## 跨 Phase 整合

### buffResolver 來源新增

完成本三 Phase 後，`buffResolver` 的來源層次：

```
final = base
      × pickaxe       (Phase 1)
      × foodBuff      (Phase S4)
      × guildBuff     (Phase A)
      × eventBuff     (Phase S5)
      × donationBuff  (Phase 8)
      × petBuff       (Phase H ★ new)
      × professionBuff(Phase J ★ new)
      × skillTree     (Phase S3)
```

`/加成` 指令需新增「寵物」與「職業」兩個顯示區塊。

### eventBus 事件清單

| 事件 | 發佈者 | 訂閱者 |
|---|---|---|
| `mine.done`     | mining service | pet exp、profession exp、季賽 |
| `fish.done`     | fishing service | pet exp、profession exp、egg drop |
| `harvest.done`  | farm service | pet exp、profession exp、egg drop |
| `boss.killed`   | boss engine | pet egg drop、profession exp |
| `adventure.cleared` | adventure engine | pet exp、profession exp、稱號候選 |
| `pet.hatched`   | pet service | 圖鑑（未來） |
| `profession.switched` | profession service | 公告（可選） |

### 消耗出口檢查總覽

| 新生產 | 消耗匹配 |
|---|---|
| 寵物蛋掉落 | 飢餓度餵食消化魚 / 作物 ✅ |
| 冒險產幣 / 道具 | 體力消耗、組隊費、失敗扣資源 ✅ |
| 轉職強化產出 | 季賽轉職石需求、主動指令日限 ✅ |

---

## 開發時程總覽

| 項目 | 時間 | 前置 | 備註 |
|---|---|---|---|
| 地基：eventBus | 2 d | — | 新玩法上線前必做 |
| Phase H 寵物 | 6–8 d | eventBus | 含孵化、餵食、進化、出戰、圖鑑 |
| Phase J 轉職 | 5–6 d | eventBus、Phase H（可選） | 六職業 + 試煉 + 季賽 |
| Phase I 文字冒險 | 7–9 d | eventBus、Phase H | 框架 5d + 三場景各 1–2d |
| 地基：經濟儀表板 | 2–3 d | — | 與 Phase 平行可做 |
| **合計** | **22–28 d** | | |

**建議啟動順序**：`eventBus → Phase H → Phase J → Phase I → 經濟儀表板`

里程碑：
- **M1**（+2d）：eventBus 上線、既有 service 開始 emit 事件
- **M2**（+8–10d）：Phase H 寵物上線，首批玩家開始養寵物
- **M3**（+13–16d）：Phase J 轉職上線，配合本季季首
- **M4**（+20–25d）：Phase I 文字冒險完整三場景上線
- **M5**（+22–28d）：經濟儀表板覆盤前 4 週數據

---

## 新增檔案索引

| 檔案 | 內容 | Phase |
|---|---|---|
| `src/features/eventBus/index.js` | 跨系統事件匯流排 | 地基 |
| `src/config/pet.json` | 寵物品種、稀有度、buff | H |
| `src/features/pet/petService.js` | 寵物核心邏輯 | H |
| `src/features/pet/petResolver.js` | 出戰寵物 buff 整合 | H |
| `src/events/ready/petHatchChecker.js` | 蛋孵化排程 | H |
| `src/commands/pet/pet.js` | `/寵物` 指令群 | H |
| `src/events/interactionCreate/handlePetButton.js` | 寵物按鈕處理 | H |
| `src/config/adventure/forest.json` | 暗影森林事件樹 | I |
| `src/config/adventure/ruins.json` | 沉沒廢墟事件樹 | I |
| `src/config/adventure/abyss.json` | 深海裂谷事件樹 | I |
| `src/config/adventure/common.json` | 共用：解鎖條件、結局稱號 | I |
| `src/features/adventure/adventureEngine.js` | 冒險狀態機 | I |
| `src/features/adventure/partyService.js` | 公會組隊邏輯 | I |
| `src/commands/adventure/adventure.js` | `/冒險` 指令群 | I |
| `src/events/interactionCreate/handleAdventureButton.js` | 節點選擇按鈕 | I |
| `src/config/profession.json` | 職業定義 + 試煉 + 季賽 | J |
| `src/features/profession/professionService.js` | 轉職核心 | J |
| `src/features/profession/professionResolver.js` | 職業 buff 整合 | J |
| `src/commands/profession/profession.js` | `/職業` 指令群 | J |
| `src/commands/profession/active/*.js` | 六職業專屬主動指令 | J |
| `src/events/ready/professionSeasonChecker.js` | 季賽結算 cron | J |
| `src/events/interactionCreate/handleProfessionButton.js` | 轉職按鈕 | J |

---

## 通用驗收清單

每個 Phase 上線前逐項勾選（延續 `PLAN_BRAINSTORM.md` 末段）：

- [ ] `node src/index.js` 啟動 bot 無錯誤
- [ ] 新指令出現在 slash command 面板
- [ ] UX 七項檢查（`CLAUDE.md`）全部通過：按鈕緊靠 / Container 錯誤訊息 / 成功快捷 / owner 驗證 / 零值處理 / 解鎖三項全寫 / ephemeral 一致性
- [ ] 新 collection 在 `connectDb.js` 註冊、unique / TTL 索引建好
- [ ] 新 buff 來源在 `/加成` 顯示
- [ ] config 駐留 `src/config/`，沒有寫死數值
- [ ] eventBus 事件 emit 與訂閱對齊
- [ ] 消耗出口段落填妥（無 sink 不上線）

---

_Last updated: 2026-06-09_
