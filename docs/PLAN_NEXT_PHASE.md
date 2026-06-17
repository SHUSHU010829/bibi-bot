# 逼逼機器人 — 新階段企劃書（問卷高期待玩法）

> 紀錄日期：2026-06-09（2026-06-16 增補 Phase K / L、移除 Phase I 文字冒險）
> 背景：以問卷統計挑出期待值最高的玩法，從 `PLAN_BRAINSTORM.md`
> 中對應條目展開為完整 Phase 規劃。
> 涵蓋：
> - **Phase H 寵物 / 夥伴養成**（brainstorm A1）
> - **Phase J 轉職 / 職業系統**（brainstorm G2）
> - **Phase K 神祕黑市**（brainstorm B3）— 增補
> - **Phase L 流浪商人**（新提案）— 增補
>
> **本次延後**：Phase I 文字冒險（brainstorm C1 ⭐⭐⭐）已從本計畫移除，
> 留待下一波再開。
>
> 銜接於 `PLAN_INTEGRATED.md` 之後，作為下一波主開發路線。

---

## 目錄

1. [文件目的與範圍](#1-文件目的與範圍)
2. [設計原則與共同地基](#2-設計原則與共同地基)
3. [Phase 排程與依賴關係](#3-phase-排程與依賴關係)
4. [Phase H+ — 地下城副本進階](#phase-h--地下城副本進階)
5. [Phase H — 寵物 / 夥伴養成](#phase-h--寵物--夥伴養成)
6. [Phase J — 轉職 / 職業系統](#phase-j--轉職--職業系統)
7. [Phase K — 神祕黑市](#phase-k--神祕黑市)
8. [Phase L — 流浪商人](#phase-l--流浪商人)
9. [跨 Phase 整合](#跨-phase-整合)
10. [開發時程總覽](#開發時程總覽)
11. [新增檔案索引](#新增檔案索引)
12. [通用驗收清單](#通用驗收清單)

---

## 1. 文件目的與範圍

### 1.1 與既有文件的關係

| 文件 | 範圍 | 狀態 |
|---|---|---|
| `PLAN_INTEGRATED.md` | Phase 8 / A–G / S3–S5 | 除 S3 外皆已完成 |
| `PLAN_OPTIMIZATION.md` | 既有功能優化（Opt-1～Opt-5） | 平行進行 |
| `PLAN_BRAINSTORM.md` | 30 個玩法候選 | 腦力激盪存檔 |
| **`PLAN_NEXT_PHASE.md`（本文件）** | **問卷高期待玩法（H / J / K / L）** | **主開發路線** |

### 1.2 為什麼是這四個

| Phase | 對應條目 | 問卷期待值 | 核心價值 |
|---|---|---|---|
| **H 寵物 / 夥伴養成** | brainstorm A1 ⭐⭐⭐ | 高 | 每日回流、跨系統消耗出口、最強留存 |
| **J 轉職 / 職業系統** | brainstorm G2 ⭐⭐ | 高 | 玩家身份感、與 S3 技能樹差異化、季賽節奏 |
| **K 神祕黑市** | brainstorm B3 ⭐⭐ | 高 | 稀有道具流通出口、驚喜感、賭性玩家 |
| **L 流浪商人** | 新提案 | 中—高 | 隨機限量限時商店、補日常驚喜、低風險友善版 |

前兩者覆蓋 **養成 / 身份** 兩個玩家動機面向，後兩者作為 **限時商店雙生 Phase**
（K 高風險 / 高稀有，L 低風險 / 高便利）共用商店引擎：
- 寵物提供出戰 buff，不同職業可搭配對應品種的 buff 偏好
- 黑市 / 流浪商人是新生產（罕見道具入口）與消耗（金幣 sink）的雙向出口。

> Phase I 文字冒險延後說明：原本作為冒險道具來源（古文物 / 深海珍珠 / 守衛核心 等）
> 已從本次商品池移除；黑市與流浪商人的 barter 收料改以**既有資源**（魚 / 礦 / 作物 / 黑玫瑰副產）為主。

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
                             ▼
                     ┌─────────────────┐
                     │ Phase H+ 地下城  │
                     │ HP 系統 + 樓層   │
                     └────────┬────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          ┌─────────┐                 ┌──────────┐
          │ Phase H │                 │ Phase J  │
          │ 寵物 v1 │                 │ 轉職     │
          └────┬────┘                 └────┬─────┘
               │                           │
               └─────────────┬─────────────┘
                             │
                             ▼
                      ┌──────────────┐
                      │ shopEngine   │（K / L 共用）
                      └──┬────────┬──┘
                         ▼        ▼
                    ┌────────┐ ┌──────────┐
                    │Phase K │ │ Phase L  │
                    │神祕黑市│ │ 流浪商人 │
                    └────┬───┘ └────┬─────┘
                         └────┬─────┘
                              ▼
                    ┌────────────────────┐
                    │ 經濟儀表板（平衡） │
                    └────────────────────┘
```

**建議順序**：`eventBus → Phase H+ → Phase H → Phase J → Phase K → Phase L → 經濟儀表板覆盤`

理由：
- **Phase H+ 地下城進階** 先做：提供 HP 系統、寵物協戰 hook 給 Phase H 用，又獨立完整
- 寵物 (H) 跟進：吃 H+ 的協戰介面，同時是 fishing / farm 產出的天然 sink
- 轉職 (J)：給玩家身份感，職業 buff 與寵物 / 副本搭配
- 黑市 (K)：排在 H / J 之後，商品池連動寵物蛋 / 進化材 / 轉職石
- 流浪商人 (L)：緊接 K，**直接復用** K 的 `shopEngine`，開發成本減半

---

## Phase H+ — 地下城副本進階

> **前置需求**：eventBus 地基、既有 Phase 4 地下城 ✅
> **預估時間**：5–7 天
> **定位**：副本系統 2.0 — 從單回合骰子升級為多回合 HP 戰鬥；作為 Phase H 寵物部分 buff（救命阿伯失敗保體力、黑曜霸主戰後 HP +50%、寵物協戰）的依賴
>
> **開發順序**：本 Phase **先於 Phase H 寵物**，因為部分寵物 buff 直接讀取本 Phase 新增的欄位與 hook。

### 核心改造

| 維度 | 既有（Phase 4） | 進階版（Phase H+） |
|---|---|---|
| 戰鬥判定 | binary 勝率（`ATK ÷ 怪物HP`）骰一次 | 多回合 HP 對打、後端模擬整場 |
| 玩家屬性 | 武器 ATK + 暴擊 | + **HP**（自然回復）+ **DEF**（武器副屬性 + buff）|
| 怪物 | 7 種固定，HP 60–280 隨機 | 7 種按樓層分配 + **ATK 屬性** + **技能**（中毒 / 暈眩等）|
| 樓層 / 副本 | 無 | **1F–5F 樓層** + **3 種副本主題**（礦坑 / 廢墟 / 冰窟）|
| 結果呈現 | 單行勝負 | **戰鬥日誌**（多回合演進，一次回傳）|

關鍵設計：**戰鬥多回合，互動仍單次**。後端跑完整場戰鬥，前端用 ContainerBuilder 呈現戰鬥日誌 + 結算 — 不變 Discord 互動次數。

### 戰鬥引擎（HP 對打）

```
每回合流程（後端模擬）：
1. 玩家攻擊 → damage = playerAtk × (1 + critBonus) − monsterDef
2. 怪物 HP −= damage
3. 怪物 HP ≤ 0 → break（勝利）
4. 怪物攻擊 → damage = monsterAtk × statusEffectMult − playerDef
5. 玩家 HP −= damage
6. 玩家 HP ≤ 0 → break（失敗）
7. 結算狀態效果 tick（中毒扣血、護甲倒數）
8. 寵物協戰判定（依寵物類型機率觸發）
9. 下一回合

最多 20 回合上限 → 平局視同失敗（避免無限循環）
```

戰鬥日誌（玩家看到的訊息）：

```
🗡️ 第 1 回合：你揮砍洞窟蝙蝠 → 28 傷害（暴擊！）
🦇 蝙蝠尖叫反咬 → 12 傷害（你 HP 88/100）
🐶 救命阿伯吠叫 → 回復 5 HP（你 HP 93/100）

🗡️ 第 2 回合：你揮砍 → 25 傷害
🐍 蝙蝠注入毒液 → 你陷入中毒（2 回合）

🗡️ 第 3 回合：你揮砍 → 27 傷害（致命一擊！）

✅ 勝利！剩餘 HP：80/100、體力 −1
🎁 戰利品：💎 鑽石 ×1、🪙 +450 幣
```

### 玩家屬性新增

| 屬性 | 來源 | 範圍 |
|---|---|---|
| **hp_max** | 100（基準）+ Lv ×2 + 食物 buff + 公會 buff + 寵物 buff | 100–250 |
| **hp_current** | 動態（自然回復 / 道具 / 寵物 / 戰鬥扣）| 0 – hp_max |
| **def** | 武器副屬性 + 食物 buff + 寵物 buff | 0–50 |
| **critRate** | 武器（既有）+ 寵物 buff | 0–20% |

### 樓層系統（1F–5F 初版，可擴 10F）

| 樓層 | 解鎖條件 | 體力 | 武器耐久 | 怪物 HP / ATK | 預期回合 | 推薦裝備 | 獎勵倍率 |
|---|---|---|---|---|---|---|---|
| 🏚️ 1F 廢棄礦坑 | 預設 | 1 | −1 | 100–200 / 8–12 | 3–5 | 拳頭 / 鐵劍 | ×1.0 |
| ⛏️ 2F 礦工迷宮 | Lv.10 + 通關 1F ×3 | 1 | −1 | 250–400 / 12–18 | 4–6 | 鐵劍 / 鋼劍 | ×1.3 |
| 🏛️ 3F 古遺跡 | Lv.20 + 通關 2F ×5 | 2 | −2 | 500–800 / 18–25 | 6–8 | 鋼劍 / 黃金劍 | ×1.7 |
| 🔥 4F 熔岩深淵 | Lv.35 + 通關 3F ×8 | 2 | −2 | 1,000–1,500 / 25–35 | 8–10 | 黃金劍 / 鑽石劍 | ×2.2 |
| 🌌 5F 虛空之門 | Lv.50 + 通關 4F ×10 | **3** | **−3** | 1,800–2,500 / 25–35 | 10–15 | 鑽石劍 / 傳說劍 | ×3.0 |
| 👹 5F mini-BOSS | 解鎖 5F 後 | 3（不疊加）| **−4** | 3,000–4,500（兩階段）/ 30–45 | 15–20 | 鑽石劍 / 傳說劍 | ×4.0 |

> 5F mini-BOSS = 房間版的固定 BOSS，獎勵含寵物蛋 / 傳說碎片 / **屠龍累積 +1**（連動 Phase H 黑曜霸主解鎖）。
> 怪物 HP 範圍經過調整，確保中階玩家進場有 3–5 回合的戰術空間，高階玩家也能在 5F 打到 10 回合以上。

### 武器耐久消耗對照（依實際 `dungeon.json` 數值）

| 武器 | ATK | 耐久 | 純跑 1F 場次 | 純跑 5F 場次 | 連續 mini-BOSS |
|---|---|---|---|---|---|
| 鐵劍 | 25 | 40 | 40 | 13 | 10 |
| 鋼劍 | 50 | 45 | 45 | 15 | 11 |
| 黃金劍 | 80 | 60 | 60 | 20 | 15 |
| 鑽石劍 | 120 | 80 | 80 | 26 | 20 |
| 傳說劍 | 180 | **120** ⚠️ | 120 | 40 | 30 |

> ⚠️ **建議調整**：既有 `dungeon.json` 中 **傳說劍與鑽石劍耐久相同（80）** — 配合新系統，建議將傳說劍耐久從 80 提升至 **120**，讓「鑽石 → 傳說」升級有耐久誘因（搭配 ATK +60、暴擊 +10%，符合終局武器定位）。

### 副本主題（樓層的橫向擴展，每個 3 樓共用）

| 主題 | 解鎖條件 | 偏好職業（連動 Phase J）| 限定掉落 |
|---|---|---|---|
| ⛏️ 礦坑（預設）| 從一開始 | 礦工 / 戰士 | 礦石、鎬子碎片、賭石 |
| 🏛️ 廢墟 | Lv.25 + 礦坑 3F 通關 ×10 | 騎士 / 學者 | 古錢幣、殘破護符、知識卷軸 |
| ❄️ 冰窟 | Lv.40 + 廢墟 3F 通關 ×10 | 漁夫 / 商人 | 冰晶魚、雪晶石、冷凍藥水 |

> 三個主題共用 5F 樓層架構（每主題各有 5 樓），玩家可平行解鎖、依職業 / buff 選擇主場。
> 未來 Phase I 文字冒險可重用「主題 / 樓層」框架。

### 戰鬥狀態效果

**怪物施加（玩家受影響）**

| 效果 | 來源怪物 | 影響 |
|---|---|---|
| 🐍 中毒 | 蝙蝠 / 史萊姆 | 每回合扣 5% HP（最多 3 回合）|
| 💫 暈眩 | 暗影狼 | 跳過 1 回合（無法攻擊）|
| 🛡️ 護甲 | 守衛獸 | 自身減傷 50%（持續 2 回合，玩家視角是傷害降低）|
| 🔥 燃燒 | 火焰精靈 | 每回合扣 8 HP（最多 2 回合）|
| ⚡ 麻痺 | 雷晶怪 | 暴擊率 ×0.5（持續 3 回合）|

**玩家道具（戰鬥前自動施用）**

| 道具 | 效果 | 取得 |
|---|---|---|
| 🧪 解毒劑 | 戰鬥中免疫中毒 | 商城 300 幣 / 鍊金合成 |
| 🛡️ 護盾卷軸 | 第一次受擊減 50% | 商城 400 幣 |
| 💊 治療藥水（小 / 中 / 大）| 戰鬥中自動觸發回 20 / 50 / 100 HP | 商城 200 / 500 / 1,500 幣 |
| 🔥 燃燒抵抗劑 | 戰鬥中免疫燃燒 | 商城 350 幣 |

### 體力消耗規則

| 情況 | 體力 | 武器耐久 |
|---|---|---|
| 戰鬥勝利 / 失敗 / 逃離（1F–2F）| 1 | −1 |
| 戰鬥勝利 / 失敗 / 逃離（3F–4F）| 2 | −2 |
| 戰鬥勝利 / 失敗 / 逃離（5F 一般）| 3 | −3 |
| **5F mini-BOSS** | 3（不額外）| **−4**（額外懲罰）|
| **主動逃離（新增 `/地下城 逃離`）**| **退還 50%**（向下取整）| **耐久不退**（進場就磨損）|
| 系統錯誤 | 全退 | 全退（既有 rollback 保留）|

體力上限同步調整：
- 基準 **10 → 12**（補償高樓層耗量）
- 回復速度不變（每小時 +1）
- Twitch / 公會 buff 照舊累加

### 武器耐久規則（為什麼按樓層而非回合）

- ✅ **按樓層扣**：直觀、與體力規則對稱、好記
- ❌ **不按回合扣**：戰鬥多回合是「後端模擬」，玩家只點一次，按回合扣會讓玩家無感且容易誤解
- ⚔️ **暴擊不額外扣**（玩家獎勵）
- 💀 **失敗仍扣**（風險不變）
- 🛠️ **維修工具**回滿（既有機制保留）
- 💎 **武器耐久歸零**：仍可進場，但戰鬥力降為「拳頭」級（既有降級邏輯保留）
- 🐉 **mini-BOSS −4 耐久**：高難度高消耗，逼玩家在打 mini-BOSS 前先維修，建立「儀式感」
- ⚠️ **建議同步調整 `dungeon.json`**：傳說劍耐久從 80 → 120，讓鑽石→傳說有耐久升級誘因

### HP 回復機制

| 來源 | 速率 / 條件 |
|---|---|
| 🌿 自然回復 | 每 10 分鐘 +5 HP（離線也算）|
| 💊 HP 藥水（小）| +20 HP，商城 200 幣 |
| 💊 HP 藥水（中）| +50 HP，商城 500 幣 |
| 💊 HP 藥水（大）| 滿 HP，商城 1,500 幣 |
| 🍱 食物 buff：HP 增益料理 | 戰前自動補滿 + Max HP +20（時效）|
| 🐶 寵物 buff（救命阿伯）| 戰後 25% 機率多回 10 HP |
| 🐉 寵物 buff（黑曜霸主）| 戰後固定 HP +50% |

### 寵物協戰（連動 Phase H）

出戰寵物每回合有機率協助，依寵物 buff 類型分流：

| 寵物類型 | 協戰機率 | 效果 |
|---|---|---|
| 戰鬥型（斑斑騎士 / 赤焰龍王）| 20% | 追擊一次，半傷 |
| 治癒型（救命阿伯 / 棉花糖公主）| 20% | 回 5–10 HP |
| 採集型（黃金獵人 / 翠林大師）| 戰後 | 寶箱 / 戰利品機率 +5% |
| 商業型（金幣社長 / 黃金大帝）| 戰後 | 金幣獎勵額外 +10% |
| 一般 / 無對應類型 | — | 不協戰，但仍掉飢餓 −5 |

戰鬥結束後：
- 寵物獲得 exp（依樓層 1F=10 / 5F=50）
- 飢餓度 −5（協戰）/ −3（陪同未觸發）

### 樓層 BOSS（5F 限定）

每副本主題的 5F 房間有 mini-BOSS，固定機制：

| 副本 | mini-BOSS | 特殊機制 |
|---|---|---|
| ⛏️ 礦坑 | 礦坑暴君 | HP 500、第二階段（HP < 50%）攻擊翻倍 |
| 🏛️ 廢墟 | 永眠守衛 | 護甲 3 回合內無法被打破 |
| ❄️ 冰窟 | 冰晶女王 | 每回合 30% 機率麻痺玩家 |

擊敗 mini-BOSS：
- 必掉 1 個寵物蛋（稀有 ↑ 機率）
- 100% 傳說碎片 ×1
- 屠龍累積 +1（5 場後玩家可解鎖黑曜霸主候選）
- 月榜稱號候選「副本征服者」

### 消耗出口（必填段落）

| 入口 | 出口 |
|---|---|
| 更高樓層獎勵倍率 | 高樓層耗體力多、需要 HP 藥水才能連戰 |
| 寵物協戰加成 | 寵物飢餓度持續扣（推動餵食、消化魚 / 作物）|
| mini-BOSS 稀有掉落 | 高階武器 / HP 藥水 / 解毒劑等耗材 |
| 自然回復慢 | 推動 HP 藥水購買（金幣 sink）|

### UX 設計重點

依 `CLAUDE.md` 七項檢查：

- **`/地下城` 進場前**：用 ContainerBuilder 顯示當前 HP / 體力 / 推薦樓層 + 三個樓層按鈕（依解鎖狀態顯示）
- **未解鎖樓層**（UX 檢查 #6）：
  > `🔒 3F 古遺跡 尚未解鎖！\n解鎖條件：等級 20 + 通關 2F ×5 次\n目前：Lv.17・通關 2F ×3 次`
- **戰鬥日誌**：每回合一行 TextDisplay，限制最多 20 行避免 Container 過長；超過則摘要顯示
- **HP 低警告**：戰前若 HP < 30% → Container 紅 accent「⚠️ HP 偏低，建議先休息或喝藥水」+ 三個按鈕（喝藥水 / 強制進場 / 取消）
- **逃離按鈕**：戰鬥日誌呈現時，HP 仍 > 0 但已扣下回合，給玩家「立刻逃離（退 50% 體力）」按鈕
- **owner 驗證**：所有按鈕 customId `dgn_<userId>_<action>` 必驗
- **成功訊息快捷**：戰利品下方放「再戰一場 / 查看背包 / 找鑑定師（若挖到石頭）」

### 指令

| 指令 | 說明 | 類別 |
|---|---|---|
| `/地下城` | 入口（顯示 HP / 體力 / 樓層選單）| ephemeral |
| `/地下城 挑戰 [主題] [樓層]` | 直接進指定樓層 | 公開（戰鬥訊息）|
| `/地下城 逃離 [run_id]` | 戰鬥中逃離（退 50% 體力） | 公開 |
| `/地下城 紀錄` | 通關紀錄 + 樓層解鎖進度 | ephemeral |
| `/地下城 狀態` | 查 HP / 體力 / 加成 / Buff | ephemeral |
| `/dungeon-admin reset-floor [user] [theme] [floor]` 🔒 | 重置玩家解鎖（測試用）| — |

### DB 變動

**修改既有 `MiningProfiles`**（`miningProfile.js` 的 `normalize()` 自動補欄位，**無需 migration**）：

```js
{
  // 既有欄位保留 (stamina / weapon / dungeon_count ...)
  hp_max:            Number,    // 新增，預設 100
  hp_current:        Number,    // 新增，預設 100
  hp_updated_at:     Number,    // 新增，自然回復計算
  def:               Number,    // 新增，預設 0
  floor_unlocks: {              // 新增，樓層解鎖
    mine:   { max_floor: 1, clears: { 1: 0, 2: 0, ... } },
    ruins:  { max_floor: 0, clears: {} },
    ice:    { max_floor: 0, clears: {} }
  }
}
```

**新增 collection**：

```js
// dungeon_runs（戰鬥紀錄）
{
  run_id:       String,
  user_id:      String,
  guild_id:     String,
  theme:        String,    // 'mine' | 'ruins' | 'ice'
  floor:        Number,
  monster_id:   String,
  result:       String,    // 'win' | 'lose' | 'escape'
  battle_log:   [Object],  // 每回合日誌（用於圖鑑 / 回放）
  damage_dealt: Number,
  damage_taken: Number,
  stamina_cost: Number,
  pet_id:       String,    // 出戰寵物
  rewards:      Object,
  started_at:   Number,
  ended_at:     Number,
}
```

索引：
- `dungeon_runs`：`{ user_id: 1, ended_at: -1 }`、TTL 30 天

### Config 擴充（`src/config/dungeon.json`）

```json
{
  "stamina": { "max": 12, "rechargeMs": 3600000 },
  "hp": {
    "baseMax": 100,
    "levelBonus": 2,
    "naturalRegenPer10Min": 5,
    "escapeRefundPct": 0.5
  },
  "themes": [
    { "id": "mine", "name": "礦坑", "unlock": null },
    { "id": "ruins", "name": "廢墟", "unlock": { "level": 25, "prereqFloor": { "mine": 3 }, "prereqClears": 10 } },
    { "id": "ice", "name": "冰窟", "unlock": { "level": 40, "prereqFloor": { "ruins": 3 }, "prereqClears": 10 } }
  ],
  "floors": [
    {
      "floor": 1,
      "name": "廢棄礦坑",
      "unlockLevel": 1,
      "staminaCost": 1,
      "weaponDurabilityCost": 1,
      "monsterHpRange": [100, 200],
      "monsterAtkRange": [8, 12],
      "rewardMultiplier": 1.0
    },
    {
      "floor": 2,
      "name": "礦工迷宮",
      "unlockLevel": 10,
      "prereqClears": { "floor": 1, "count": 3 },
      "staminaCost": 1,
      "weaponDurabilityCost": 1,
      "monsterHpRange": [250, 400],
      "monsterAtkRange": [12, 18],
      "rewardMultiplier": 1.3
    },
    {
      "floor": 3,
      "name": "古遺跡",
      "unlockLevel": 20,
      "prereqClears": { "floor": 2, "count": 5 },
      "staminaCost": 2,
      "weaponDurabilityCost": 2,
      "monsterHpRange": [500, 800],
      "monsterAtkRange": [18, 25],
      "rewardMultiplier": 1.7
    },
    {
      "floor": 4,
      "name": "熔岩深淵",
      "unlockLevel": 35,
      "prereqClears": { "floor": 3, "count": 8 },
      "staminaCost": 2,
      "weaponDurabilityCost": 2,
      "monsterHpRange": [1000, 1500],
      "monsterAtkRange": [25, 35],
      "rewardMultiplier": 2.2
    },
    {
      "floor": 5,
      "name": "虛空之門",
      "unlockLevel": 50,
      "prereqClears": { "floor": 4, "count": 10 },
      "staminaCost": 3,
      "weaponDurabilityCost": 3,
      "monsterHpRange": [1800, 2500],
      "monsterAtkRange": [35, 50],
      "rewardMultiplier": 3.0,
      "miniBossOption": true
    }
  ],
  "miniBosses": {
    "mine_5f":  { "id": "tyrant",  "hp": 3500, "atk": 35, "weaponDurabilityCost": 4, "phase2HpRatio": 0.5, "phase2AtkMult": 2.0 },
    "ruins_5f": { "id": "sleeper", "hp": 4000, "atk": 30, "weaponDurabilityCost": 4, "armorTurns": 3 },
    "ice_5f":   { "id": "queen",   "hp": 4500, "atk": 28, "weaponDurabilityCost": 4, "paralyzeChance": 0.3 }
  },
  "statusEffects": {
    "poison":   { "tickPct": 0.05, "turns": 3 },
    "stun":     { "skipTurns": 1 },
    "armor":    { "damageReductionPct": 0.5, "turns": 2 },
    "burn":     { "tickFlat": 8, "turns": 2 },
    "paralyze": { "critMult": 0.5, "turns": 3 }
  }
}
```

### 與現有系統的接點

- **既有怪物**：保留 7 種，依 HP / ATK 重新分配到對應樓層（高 HP 改 4F-5F）
- **既有掉落表**：依樓層加權，獎勵倍率自動套用（不重寫 `rollLoot`）
- **既有食物 buff**：`dungeon_atk` / `all_boost` 仍有效；新增 `dungeon_def` / `dungeon_hp_max` 兩個 type
- **`MiningProfiles.normalize()`**：自動補 hp / def 欄位（無 migration）
- **eventBus**：保留 `dungeon.cleared`，新增：
  - `dungeon.floor_unlocked` { userId, theme, floor }
  - `dungeon.mini_boss_defeated` { userId, theme, killCount }
  - `dungeon.fled` { userId, theme, floor, stamina_refunded }
- **稱號**：「副本征服者」（月榜，5F 通關次數最多）
- **任務**：既有 `daily_dungeon_win` 加 `theme` 過濾選項（如「冰窟通關 3 次」）
- **Phase H 寵物 hook**：本 Phase 提供以下介面給寵物 buff 讀取：
  - `petResolver.isCounterImmune()` — 黑曜霸主：BOSS 反擊免疫
  - `petResolver.getFailStaminaSaveRate()` — 救命阿伯：失敗保體力機率
  - `petResolver.getPostBattleHpRegenPct()` — 黑曜霸主：戰後 HP +50%
  - `petResolver.getCombatPetType()` — 寵物協戰類型判定

### 新增 / 修改檔案

| 檔案 | 變動 |
|---|---|
| `src/config/dungeon.json` | **大改**：加 `themes[]` / `floors[]` / `miniBosses` / `statusEffects` / `hp` 區塊 |
| `src/features/dungeon/battleEngine.js` | **新增**：多回合戰鬥模擬器、狀態效果引擎、戰鬥日誌生成 |
| `src/features/dungeon/dungeonService.js` | 改：呼叫 battleEngine、整合寵物協戰、HP 扣加、逃離 |
| `src/features/dungeon/floorService.js` | **新增**：樓層解鎖檢查 |
| `src/features/dungeon/hpService.js` | **新增**：自然回復、藥水使用 |
| `src/features/mining/miningProfile.js` | 改：加 hp_max / hp_current / def / floor_unlocks 欄位 |
| `src/commands/dungeon/dungeon.js` | 改：加 主題 / 樓層 子指令、逃離 |
| `src/events/interactionCreate/handleDungeonButton.js` | **新增**：戰鬥中按鈕（逃離 / 喝藥水）|

### 預估時程：5–7 天

| 項目 | 時間 |
|---|---|
| HP 戰鬥引擎（含戰鬥日誌呈現）| 2d |
| 樓層 / 主題 config + 解鎖機制 | 1d |
| 狀態效果系統 | 1d |
| 寵物協戰介面（給 Phase H 用，本 Phase 先預留 hook）| 0.5d |
| HP 藥水 / 自然回復 / 逃離機制 | 0.5d |
| mini-BOSS 機制 | 0.5d |
| 測試 / 平衡微調 | 1d |

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

## Phase K — 神祕黑市

> **前置需求**：Phase 1（挖礦）✅、Phase 5（拍賣行）✅、Phase H 寵物 / Phase J 轉職（商品池連動）、eventBus 地基
> **預估時間**：3–4 天
> **定位**：稀有道具流通出口 + 高風險金幣 sink，製造驚喜感與賭性張力

### 核心機制

- 每日隨機 **1 小時** 在 `#神祕黑市` 頻道開張（seeded random，可預測但不公開）
- 商人 NPC（系統訊息）擺出 **3–5 件** 商品，每件**全服限量**（通常 1–3 份）
- 商品涵蓋：稀有素材、限定寵物蛋、轉職石、進化石、限定外觀道具
- 購買時 **10% 機率被查緝**：罰金（商品 ×3）+ 沒收 + 公告通緝公頻
- 商人離開後留下殘留地圖碎片（彩蛋）
- **查緝率**會根據玩家當日購買次數遞增（第 1 次 10% / 第 2 次 25% / 第 3 次 50%）

### 商品池設定

依稀有度分四檔（config 驅動），每次開張隨機抽：

| 稀有度 | 出現權重 | 售價區間 | 範例商品 |
|---|---|---|---|
| 罕見 | 50% | 500–2,000 幣 | 限定礦石、加溫石、料理稀有食材 |
| 珍貴 | 30% | 3,000–10,000 幣 | 轉職石、寵物蛋（稀有）、限定釣餌 |
| 傳奇 | 15% | 20,000–60,000 幣 | 進化石、寵物蛋（傳說）、限定稱號券 |
| 違禁 | 5% | 100,000–300,000 幣 | 永久 buff 卷軸、跳過試煉券、稀有外觀 |

> 「違禁」級商品 = 一定被查緝率 +5%（暗示其黑市性），但若**成功買到**獎勵巨大。

### 暗號交易（黑市版以物易物）

黑市除標價販售外，**每場固定有 1–2 件「暗號交易」**：
不收幣、只收「黑市指定的特殊組合」物品，但**依然有查緝風險**。

設計重點：
- 商品 `mode = 'barter'`，`cost.items` 寫死於 config（如「3 顆鯊魚 + 1 顆熔岩魚 + 5 顆鐵礦」）
- 查緝率與一般商品**相同**（仍可能被沒收且罰款 — 罰款為等值幣 ×3）
- 暗號商品**通常更稀有**，是違禁級道具的另一條取得管道
- 適合不想花大錢、但有大量囤物的玩家

範例：

| 暗號需求 | 換取物 | 查緝風險 |
|---|---|---|
| 鯊魚 ×10 + 熔岩魚 ×3 | 寵物蛋（傳說） | 普通查緝率 |
| 彩虹石 ×5 + 黑玫瑰 ×3 | 永久 luck +0.5% 卷軸 | 違禁級（+5%） |
| 古文物 ×1（冒險產出） | 跳過職業試煉券 | 違禁級 |

> 重要：以物易物**不**降低查緝率，玩家不能用「我沒花錢」當理由逃避風險。
> 被查緝時罰款依「等值金幣 ×3」計算（每樣 cost item 取系統收購價加總）。

### 查緝風險機制

```
baseRate     = 0.10
buyCountToday = 玩家當日已成功購買次數
escalationRate = 0.15 × buyCountToday
itemPenalty  = (商品.tier === '違禁') ? 0.05 : 0
finalRate    = min(baseRate + escalationRate + itemPenalty, 0.80)
```

被查緝後果：
- 購買失敗，幣 **被扣** 商品標價 ×3（最低 1,000 幣）
- 商品**未獲得**
- 玩家進入「通緝名單」24h（無法再買、且訊息公頻發 `🚨 XXX 被黑市查緝了！罰款 N 幣！`）
- 通緝期間其他玩家可 `/黑市 檢舉 [玩家]` 領小額賞金（500 幣 / 24h 內 1 次）

### 出現排程

```
// 每日 00:00 用 seeded random 排定當日黑市時段
seed       = parseInt(today)
openHour   = rng() * 22 + 1  // 1:00 ~ 23:00（避開深夜）
durationHr = 1

// 開張前 5 分鐘在「逼逼特報站」放出暗號（不直接說頻道）
"📜 某處傳來低聲叫賣的聲音... 5 分鐘後揭曉"
```

不公開時段是設計重點 — 製造「正好遇到」的驚喜感，避免變成例行公事。

### 消耗出口（必填段落）

| 入口 | 出口 |
|---|---|
| 黑市賣稀有道具（產出） | 高價金幣消耗（500–300,000 幣）；查緝罰金（金幣銷毀） |
| 限定寵物蛋 / 進化石 | 平衡 Phase H 寵物進化的供給節奏 |
| 違禁級永久 buff 卷軸 | 對應賽季 / 抖內 buff 的稀缺對沖 |
| 暗號交易產出 | **囤積資源的非幣 sink**（魚 / 礦 / 作物 / 古文物） |

### UX 設計重點

依 `CLAUDE.md` 七項檢查：

- **開張公告**：在 `#神祕黑市` 用 ContainerBuilder（accent 紫色），列出 3–5 件商品
  - 每件商品**獨立 Section**：商品圖 + 描述 + 剩餘庫存 + 「購買（N 幣，⚠️ 風險 X%）」按鈕
  - 按鈕**就在該商品下方**，禁止集中底部
- **購買確認 modal**：點按鈕 → 二次確認（顯示「目前查緝率 X%」+「罰金將為 N 幣」）
- **被查緝**：紅色 accent Container「🚨 你被警察抓了！」+ 罰金明細 + -# 解決提示「24h 後通緝解除」
- **賣完 / 結束**：商品 sold out → 訊息更新為刪除線；商人離場 → 全部按鈕 disabled、留「下次再會」
- **owner 驗證**：購買按鈕 customId `bm_buy_<userId>_<itemId>`，必驗

### 指令

| 指令 | 說明 | 類別 |
|---|---|---|
| `/黑市` | 查看當前黑市狀態（開張中？商品？）；未開張時顯示「下次預估時段」（粗略區間） | ephemeral |
| `/黑市 紀錄` | 個人購買 / 被查緝歷史 | ephemeral |
| `/黑市 通緝` | 當前通緝名單 | ephemeral |
| `/黑市 檢舉 [玩家]` | 檢舉通緝名單上的玩家，領賞金 | 公開 |
| `/blackmarket-admin force-open` 🔒 | 管理員強制開市（測試 / 活動） | — |
| `/blackmarket-admin set-pool` 🔒 | 重抽當日商品池 | — |

### DB 新增

```js
// black_market_sessions
{
  session_id:   String,
  guild_id:     String,
  date:         String,           // 'YYYYMMDD'
  opens_at:     Number,
  closes_at:    Number,
  items: [
    {
      item_id:    String,
      tier:       String,         // 'rare' | 'precious' | 'legendary' | 'contraband'
      price:      Number,
      stock_init: Number,
      stock_left: Number,
    }
  ],
  status:       String,           // 'scheduled' | 'open' | 'closed'
  announce_msg_id: String,
}

// black_market_transactions
{
  user_id:    String,
  guild_id:   String,
  session_id: String,
  item_id:    String,
  price_paid: Number,
  result:     String,             // 'success' | 'busted'
  penalty:    Number,             // 被查緝時的罰金
  ts:         Number,
}

// black_market_wanted
{
  user_id:     String,
  guild_id:    String,
  busted_at:   Number,
  expires_at:  Number,             // busted_at + 24h
  reported_by: [String],           // 已被檢舉過的玩家（防重複領賞）
}
```

索引：
- `black_market_sessions`：`{ guild_id: 1, date: 1 }` unique
- `black_market_transactions`：`{ user_id: 1, ts: -1 }`、TTL 90 天
- `black_market_wanted`：`{ expires_at: 1 }`（過期清理）

### Config 驅動（`src/config/black_market.json`）

```json
{
  "scheduling": {
    "minHour": 1,
    "maxHour": 23,
    "durationHr": 1,
    "preAnnounceMin": 5,
    "announceChannelId": "CHANNEL_ID_特報站",
    "marketChannelId": "CHANNEL_ID_黑市"
  },
  "itemsPerSession": { "min": 3, "max": 5 },
  "barterRatio": { "min": 1, "max": 2 },
  "tiers": {
    "rare":       { "weight": 50, "priceRange": [500, 2000] },
    "precious":   { "weight": 30, "priceRange": [3000, 10000] },
    "legendary":  { "weight": 15, "priceRange": [20000, 60000] },
    "contraband": { "weight": 5,  "priceRange": [100000, 300000], "bustPenalty": 0.05 }
  },
  "bustRate": {
    "base": 0.10,
    "escalation": 0.15,
    "cap": 0.80
  },
  "penaltyMultiplier": 3,
  "wantedDurationHr": 24,
  "reportBounty": 500,
  "itemPool": [
    { "id": "snow_crystal", "tier": "rare", "stock": [1, 3] },
    { "id": "pet_egg_rare", "tier": "precious", "stock": [1, 1] },
    { "id": "career_stone", "tier": "legendary", "stock": [1, 2] },
    { "id": "permanent_luck_scroll", "tier": "contraband", "stock": [1, 1] }
  ],
  "barterPool": [
    {
      "id": "shark_lava_to_egg",
      "give": { "type": "pet_egg", "rarity": "legendary" },
      "cost": { "items": [
        { "id": "shark", "qty": 10 },
        { "id": "lava_fish", "qty": 3 }
      ]},
      "tier": "legendary",
      "stock": [1, 1]
    },
    {
      "id": "rainbow_rose_to_scroll",
      "give": { "type": "item", "id": "permanent_luck_scroll" },
      "cost": { "items": [
        { "id": "rainbow_stone", "qty": 5 },
        { "id": "black_rose", "qty": 3 }
      ]},
      "tier": "contraband",
      "stock": [1, 1]
    }
  ]
}
```

### 與現有系統的接點

- **共用商店引擎**：與 Phase L 流浪商人共用 `src/features/shop/shopEngine.js`
  - 統一 `item.cost` 介面：`{ coin: N }` / `{ items: [...] }` / `{ coin: N, items: [...] }`
  - 統一交易事務：先檢查 → 全部扣 → 全部給 → 失敗 rollback
  - 兩個 Phase 共用 barter 邏輯，避免重複實作
- **公告頻道**：開張 / 結束公告至「逼逼特報站」+「逼逼黑市站」（新頻道）
- **金幣扣款**：透過 `userCoinsCollection`，source 標 `black_market_buy` / `black_market_penalty` / `black_market_barter`
- **物品消耗**：barter 模式呼叫 `inventoryService.consumeMany()`（含魚 / 礦 / 作物 / 古文物各自 collection 的彙整介面）
- **道具入庫**：寵物蛋寫 `user_pet_eggs`、其他寫 `UserInventory`
- **eventBus**：emit `blackmarket.busted`、`blackmarket.purchased`、`blackmarket.barter_traded`

### 新增檔案

| 檔案 | 內容 |
|---|---|
| `src/config/black_market.json` | 排程、商品池、查緝率 |
| `src/features/shop/shopEngine.js` | 限量 / 限時商店引擎（與 L 共用） |
| `src/features/blackmarket/blackMarketService.js` | 黑市專屬：查緝計算、通緝名單 |
| `src/events/ready/blackMarketScheduler.js` | 每日排程 + 開張公告 cron |
| `src/commands/blackmarket/blackMarket.js` | `/黑市` 指令群 |
| `src/commands/blackmarket/blackMarketAdmin.js` | `/blackmarket-admin` |
| `src/events/interactionCreate/handleBlackMarketButton.js` | 購買按鈕（含確認 modal） |

---

## Phase L — 流浪商人

> **前置需求**：Phase K 神祕黑市（共用商店引擎）、Phase 5（拍賣行）✅
> **預估時間**：2–3 天（共用 K 的引擎，主要新增資料與表現層）
> **定位**：低風險友善版的限時商店，補日常驚喜、給愛逛街的玩家

### 與黑市的差異

| 維度 | K 神祕黑市 | L 流浪商人 |
|---|---|---|
| 風險 | 有查緝（10–80%） | 無風險 |
| 商品調性 | 稀有 / 限定 / 違禁 | 折扣 / 便利 / 平價限定 |
| 出現頻率 | 每日 1 小時 | 隨機 1–3 天出現一次、停留 6 小時 |
| 商品數量 | 3–5 件 | 5–8 件 |
| 庫存 | 全服限量（搶） | 個人限量（每人各買各的） |
| 價格 | 標價販售 | 帶折扣（原價 70–85%） |
| 玩家心態 | 賭一把、搶限定 | 順便逛逛、撿便宜 |

> 兩者**不會同時開張**（黑市開時流浪商人讓位），避免分散注意力。

### 商人個性（NPC 設定）

流浪商人有 **3 種隨機個性**，每次出現抽一種，影響商品偏好：

| 個性 | 偏好商品 | 額外效果 |
|---|---|---|
| 🧙 古怪藥師 | 食譜材料、藥水、烹飪稀有食材 | 全商品再 −5% |
| 🛡️ 退役騎士 | 強化券、戰鬥道具、體力藥水 | 額外送 1 個小道具（首購） |
| 🌸 花匠少女 | 作物種子、肥料、農場道具 | 寵物餵食道具 +1（限定品） |

開張公告寫商人名字（如：「🧙 古怪藥師艾莉莎」），讓玩家有「下次又是誰？」的記憶點。

### 商品策略

- 每次帶 **5–8 件** 商品，其中：
  - **3 件主打**：日常消耗品（藥水、肥料、釣餌）打 7–85 折
  - **1 件限定**：每商人特定的稀有道具（每 5 次出現一輪）
  - **1–2 件常規**：基礎物資補貨
  - **1–2 件以物易物**：不收幣，只收特定物品交換（見下節）
- 個人限量：每件商品 **每位玩家限買 1–3 個**（避免囤積）
- 價格寫死於 config，不隨機 — 玩家可清楚比價

### 以物易物（barter）⭐

流浪商人的招牌玩法 — 「我這有 X，能換你的 Y 嗎？」
讓玩家有用囤積資源換稀有道具的出口，也順便消化過剩產出。

**設計重點**

- 商品 `cost` 不是幣，而是 **一組物品需求**（可同時要求多項）
- 不同商人個性偏好不同物品（藥師收魚、騎士收礦、花匠收作物）
- 玩家背包不足時按鈕 disabled、顯示缺項
- 兌換完成後雙方扣 / 加，走原子事務避免拆單

**範例 barter trade**

| 商人 | 出 | 收（barter） | 設計意圖 |
|---|---|---|---|
| 🧙 古怪藥師 | 限定料理「龍息湯」食譜 | 熔岩魚 ×2 + 黑玫瑰 ×1 | 消化高階釣魚 / 農場 |
| 🛡️ 退役騎士 | 進化石 ×1 | 彩虹石 ×3 + 鯊魚 ×5 | 礦業 → 寵物進化 |
| 🌸 花匠少女 | 寵物餵食特餐（飽足度 +50）×3 | 玉米 ×10 | 玉米 sink |
| 🧙 古怪藥師 | 永久 luck +1% 卷軸（單次性、稀有） | 鯊魚 ×10 + 章魚 ×5 + 鐵礦 ×20 | 跨生產線整合 sink |
| 🛡️ 退役騎士 | 騎士轉職石 | 戰鬥相關物品（之後定義） | 為轉職 Phase J 提供另一條取得管道 |
| 🌸 花匠少女 | 稀有寵物蛋（保底品種） | 紅蘿蔔 ×30 + 玉米 ×15 + 草莓 ×8 | 低門檻 / 高累積、適合農場玩家 |

**Config 寫法**（`cost` 支援 `coin` / `items` / 混合）：

```json
{
  "id": "evolution_stone_barter",
  "tier": "limited",
  "display": "進化石",
  "cost": {
    "items": [
      { "id": "rainbow_stone", "qty": 3 },
      { "id": "shark",         "qty": 5 }
    ]
  },
  "perUserLimit": 1
}
```

混合範例（既要幣也要物品）：

```json
{
  "id": "rare_recipe_combo",
  "cost": {
    "coin": 2000,
    "items": [ { "id": "lava_fish", "qty": 1 } ]
  }
}
```

> 純幣交易仍用 `{ "coin": N }`，barter 改成 `{ "items": [...] }`，shopEngine 自動辨識。

### 出現排程

```
// 每日 00:00 判斷今日是否出現
appearanceRate = 0.5   // 50% 機率出現
if (rng() < appearanceRate) {
  arriveHour = rng() * 16 + 6   // 6:00 ~ 22:00
  duration   = 6   // 停留 6 小時
  personality = pickRandom(personalities)
}

// 出現前 10 分鐘預告（特報站）
"🛒 一位流浪商人正往這走來... 10 分鐘後抵達"
```

> **與黑市互斥**：今日已排定黑市 → 流浪商人本日不出現。

### 消耗出口（必填段落）

| 入口 | 出口 |
|---|---|
| 折扣便利商品 | 拉動日常消耗品的金幣流動（小額頻繁 sink） |
| 限定道具 | 給高活躍玩家提供 「全收集」目標（圖鑑連動） |

### UX 設計重點

- **抵達公告**：在 `#流浪商人` 頻道用 ContainerBuilder（accent 綠色暖色），呈現商人形象 + 個性介紹 + 商品清單
- **每件商品 Section**：圖示 + 描述 + 折扣前後價（劃線價）+ 我的剩餘可購買數 + 「購買」按鈕（緊接下方）
- **barter 商品的特殊表現**：
  - 價格欄不寫幣數，改寫「🔄 以物易物」+ 所需物品 emoji 串（如 `🌶️ ×3・🐟 ×5`）
  - 按鈕文字：「以物換取」而非「購買」
  - 玩家**背包不足**時：按鈕 disabled，hover 顯示缺項；同時在 Section 內 -# 標「目前你有 🌶️ ×1 / 🐟 ×5（缺 🌶️ ×2）」
  - 按下後**二次確認 modal**：明列「將消耗 X / Y、獲得 Z」，避免誤點
- **離場提示**：剩餘 30 / 10 / 1 分鐘時自動更新公告
  - 30 分：「⏰ 商人即將離開（30 分鐘）」
  - 10 分：「⏰ 商人準備收拾行李了！」
  - 1 分：「⏰ 最後 1 分鐘！」
- **owner 驗證**：customId `wm_buy_<userId>_<itemId>` / `wm_barter_<userId>_<itemId>`
- **個人限量**：玩家已買達上限 → 按鈕變灰 + 提示「你今日已買過」

### 指令

| 指令 | 說明 | 類別 |
|---|---|---|
| `/流浪商人` | 查看當前商人狀態 / 下次預估出現時段 | ephemeral |
| `/流浪商人 紀錄` | 個人購買 / 兌換歷史（區分幣 / barter） | ephemeral |
| `/流浪商人 圖鑑` | 已遇過的商人個性收集 | ephemeral |
| `/流浪商人 兌換預覽 [商品]` | 列出 barter 需求 + 我的目前持有量 | ephemeral |
| `/wanderer-admin force-arrive [personality]` 🔒 | 管理員強制出現 | — |

### DB 新增

```js
// wandering_merchant_sessions
{
  session_id:   String,
  guild_id:     String,
  date:         String,
  personality:  String,         // 'alchemist' | 'knight' | 'gardener'
  arrives_at:   Number,
  leaves_at:    Number,
  items: [
    {
      item_id:        String,
      mode:           String,   // 'coin' | 'barter' | 'mixed'
      original_price: Number,   // mode=coin/mixed 才有
      discount_price: Number,   // 同上
      barter_cost: [            // mode=barter/mixed 才有
        { item_id: String, qty: Number }
      ],
      per_user_limit: Number,
    }
  ],
  status:       String,         // 'scheduled' | 'arrived' | 'left'
  announce_msg_id: String,
}

// wandering_merchant_purchases
{
  user_id:    String,
  guild_id:   String,
  session_id: String,
  item_id:    String,
  mode:       String,           // 'coin' | 'barter' | 'mixed'
  qty:        Number,
  price_paid: Number,           // 幣部分
  items_paid: [                 // 物品部分
    { item_id: String, qty: Number }
  ],
  ts:         Number,
}

// wandering_merchant_encounters
{
  user_id:     String,
  guild_id:    String,
  personality: String,
  first_met_at: Number,
}
```

索引：
- `wandering_merchant_sessions`：`{ guild_id: 1, date: 1 }`
- `wandering_merchant_purchases`：`{ user_id: 1, session_id: 1, item_id: 1 }`、TTL 90 天
- `wandering_merchant_encounters`：`{ user_id: 1, personality: 1 }` unique

### Config 驅動（`src/config/wandering_merchant.json`）

```json
{
  "scheduling": {
    "appearanceRate": 0.5,
    "minHour": 6,
    "maxHour": 22,
    "durationHr": 6,
    "preAnnounceMin": 10,
    "announceChannelId": "CHANNEL_ID_特報站",
    "shopChannelId": "CHANNEL_ID_流浪商人"
  },
  "personalities": [
    {
      "id": "alchemist",
      "name": "古怪藥師艾莉莎",
      "emoji": "🧙",
      "globalDiscountPct": 0.05,
      "itemTags": ["potion", "ingredient", "cook_rare"]
    },
    {
      "id": "knight",
      "name": "退役騎士哈洛德",
      "emoji": "🛡️",
      "firstBuyBonus": "small_item",
      "itemTags": ["buff_scroll", "stamina_potion"]
    },
    {
      "id": "gardener",
      "name": "花匠少女小百合",
      "emoji": "🌸",
      "bonusItem": "pet_treat",
      "itemTags": ["seed", "fertilizer", "farm_tool"]
    }
  ],
  "itemsPerSession": { "min": 5, "max": 8 },
  "barterRatio": { "min": 1, "max": 2 },
  "discountRange": [0.70, 0.85],
  "perUserLimit": { "min": 1, "max": 3 },
  "barterPool": {
    "alchemist": [
      {
        "id": "dragon_breath_recipe",
        "give": { "type": "recipe", "id": "dragon_breath" },
        "cost": { "items": [
          { "id": "lava_fish", "qty": 2 },
          { "id": "black_rose", "qty": 1 }
        ]},
        "perUserLimit": 1
      }
    ],
    "knight": [
      {
        "id": "evolution_stone_barter",
        "give": { "type": "item", "id": "evolution_stone", "qty": 1 },
        "cost": { "items": [
          { "id": "rainbow_stone", "qty": 3 },
          { "id": "shark", "qty": 5 }
        ]},
        "perUserLimit": 1
      }
    ],
    "gardener": [
      {
        "id": "pet_egg_barter",
        "give": { "type": "pet_egg", "rarity": "rare" },
        "cost": { "items": [
          { "id": "carrot",     "qty": 30 },
          { "id": "corn",       "qty": 15 },
          { "id": "strawberry", "qty": 8 }
        ]},
        "perUserLimit": 1
      }
    ]
  }
}
```

### 與現有系統的接點

- **共用商店引擎**：`src/features/shop/shopEngine.js`（Phase K 已建立）
  - `shopEngine.tryPurchase(userId, item)` 內部依 `item.cost` 結構分派：
    - `coin` → 走 `userCoinsCollection.debit()`
    - `items` → 走 `inventoryService.consumeMany()`（原子事務）
    - `mixed` → 兩者皆檢查後一起扣
  - 任一步失敗 → rollback、回傳 `{ ok: false, reason }` 給 UX 層
- **互斥檢查**：排程器先查當日是否有黑市，有則略過
- **金幣扣款**：source 標 `wandering_merchant_buy`
- **物品消耗**：複用 `UserInventory.removeItems()`、魚 / 作物分別走各自 collection
- **eventBus**：emit `wanderer.purchased`、`wanderer.barter_traded`、`wanderer.encountered`

### 新增檔案

| 檔案 | 內容 |
|---|---|
| `src/config/wandering_merchant.json` | 個性、商品、排程 |
| `src/features/wanderer/wandererService.js` | 商人邏輯（個性選擇、限量檢查） |
| `src/events/ready/wandererScheduler.js` | 排程 + 到達 / 離場公告 cron |
| `src/commands/wanderer/wanderer.js` | `/流浪商人` 指令群 |
| `src/events/interactionCreate/handleWandererButton.js` | 購買按鈕 |

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
| `pet.hatched`   | pet service | 圖鑑（未來） |
| `profession.switched` | profession service | 公告（可選） |
| `blackmarket.purchased` | black market service | 圖鑑、季賽、經濟儀表板 |
| `blackmarket.busted` | black market service | 公頻通緝公告、檢舉系統 |
| `wanderer.encountered` | wanderer service | 商人圖鑑、稱號候選（集滿三種商人） |
| `wanderer.purchased` | wanderer service | 經濟儀表板 |

### 消耗出口檢查總覽

| 新生產 | 消耗匹配 |
|---|---|
| 寵物蛋掉落 | 飢餓度餵食消化魚 / 作物 ✅ |
| 轉職強化產出 | 季賽轉職石需求、主動指令日限 ✅ |
| 黑市稀有道具入口 | 高價金幣消耗 + 查緝罰金（強力 sink） ✅ |
| 流浪商人折扣品 | 雖然便宜但個人限量；日常消耗品流動性 sink ✅ |
| **以物易物（K 暗號 / L barter）** | **非幣 sink：消化魚 / 礦 / 作物 / 黑玫瑰副產，不通膨 ✅** |

### shopEngine 共用合約（Phase K / L）

`src/features/shop/shopEngine.js` 對外提供統一購買 API：

```js
// 商品定義
type ShopItem = {
  id: string
  display: string
  cost:
    | { coin: number }
    | { items: Array<{ id: string, qty: number }> }
    | { coin: number, items: Array<{ id: string, qty: number }> }
  give: ItemGrant            // 寵物蛋 / 物品 / 卷軸 / 食譜...
  stock: number              // 全服或個人剩餘
  perUserLimit: number
}

// 購買 API（黑市 / 流浪商人都呼叫這個）
shopEngine.tryPurchase(userId, guildId, sessionId, item, opts?)
  → { ok: true, granted: ItemGrant }
  → { ok: false, reason: 'insufficient_coin' | 'insufficient_items' | 'out_of_stock' | 'over_limit' | 'busted' }
```

關鍵設計：
- **原子事務**：cost 與 give 同一個 MongoDB transaction，失敗 rollback
- **barter 缺料**：回 `insufficient_items` + 缺項清單，給 UX 層 disable 按鈕用
- **黑市專屬 hook**：`opts.bustCheck` 傳入 callback，shopEngine 在扣物前呼叫；callback 回 `true` 則扣 cost 但不 give（被查緝模式）
- **流浪商人專屬 hook**：`opts.firstBuyBonus`，首購送額外小物
- 兩 Phase 共用一套引擎、各自 service 只負責商品池排程與 UX

---

## 開發時程總覽

| 項目 | 時間 | 前置 | 備註 |
|---|---|---|---|
| 地基：eventBus | 2 d | — | 新玩法上線前必做 |
| **Phase H+ 地下城進階** | **5–7 d** | eventBus | HP 系統 / 樓層 / 副本主題 / 寵物協戰 hook（先於 Phase H）|
| Phase H 寵物 v1（12 隻貓狗）| 6–8 d | eventBus、Phase H+ | 含孵化、餵食、飾品、出戰、圖鑑 |
| Phase J 轉職 | 5–6 d | eventBus、Phase H（可選） | 六職業 + 試煉 + 季賽 |
| Phase K 神祕黑市 | 3–4 d | Phase H / J（道具池連動）、eventBus | 含 `shopEngine` 共用引擎 |
| Phase L 流浪商人 | 2–3 d | Phase K 的 `shopEngine` | 共用引擎、新增 3 種商人個性 |
| 地基：經濟儀表板 | 2–3 d | — | 與 Phase 平行可做 |
| **合計** | **25–33 d** | | |

**建議啟動順序**：`eventBus → Phase H+ → Phase H → Phase J → Phase K → Phase L → 經濟儀表板`

里程碑：
- **M1**（+2d）：eventBus 上線、既有 service 開始 emit 事件
- **M2**（+7–9d）：Phase H+ 地下城副本進階上線（HP 系統 + 樓層 + 主題）
- **M3**（+13–17d）：Phase H 寵物 v1 上線，首批玩家開始養寵物（含協戰）
- **M4**（+18–23d）：Phase J 轉職上線，配合本季季首
- **M5**（+21–27d）：Phase K 神祕黑市上線（含 `shopEngine`）
- **M6**（+23–30d）：Phase L 流浪商人上線（復用 `shopEngine`）
- **M7**（+25–33d）：經濟儀表板覆盤前 4 週數據

> **寵物 v2/v3** 延後：8 條龍系寵物中部分（赤焰龍王 / 黑曜霸主等）依賴本 Phase H+ 的屠龍累積與 HP 系統；
> 銀月騎士 / 青銅將軍依賴未來圖鑑系統（brainstorm A2）與拍賣曝光擴充，列入下一波。

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
| `src/config/profession.json` | 職業定義 + 試煉 + 季賽 | J |
| `src/features/profession/professionService.js` | 轉職核心 | J |
| `src/features/profession/professionResolver.js` | 職業 buff 整合 | J |
| `src/commands/profession/profession.js` | `/職業` 指令群 | J |
| `src/commands/profession/active/*.js` | 六職業專屬主動指令 | J |
| `src/events/ready/professionSeasonChecker.js` | 季賽結算 cron | J |
| `src/events/interactionCreate/handleProfessionButton.js` | 轉職按鈕 | J |
| `src/features/shop/shopEngine.js` | 限量 / 限時商店引擎（K / L 共用，支援 coin / barter / mixed） | K |
| `src/features/inventory/inventoryService.js` | 跨 collection 的物品消耗 / 入庫彙整介面（barter 用） | K |
| `src/config/black_market.json` | 黑市排程、商品池、查緝率、暗號交易池 | K |
| `src/features/blackmarket/blackMarketService.js` | 黑市邏輯（查緝、通緝） | K |
| `src/events/ready/blackMarketScheduler.js` | 黑市排程 cron | K |
| `src/commands/blackmarket/blackMarket.js` | `/黑市` 指令群 | K |
| `src/commands/blackmarket/blackMarketAdmin.js` | `/blackmarket-admin` | K |
| `src/events/interactionCreate/handleBlackMarketButton.js` | 黑市購買按鈕 + 確認 modal | K |
| `src/config/wandering_merchant.json` | 流浪商人個性、商品、排程 | L |
| `src/features/wanderer/wandererService.js` | 流浪商人邏輯 | L |
| `src/events/ready/wandererScheduler.js` | 流浪商人排程 cron | L |
| `src/commands/wanderer/wanderer.js` | `/流浪商人` 指令群 | L |
| `src/events/interactionCreate/handleWandererButton.js` | 流浪商人購買按鈕 | L |

---

## 頻道命名建議（K / L 新增）

延續 `PLAN_INTEGRATED.md` 五字場所感原則：

| 功能 | 頻道名 | 性質 |
|---|---|---|
| 神祕黑市 | **黑街交易所** | 開市公告 + 商品展示 |
| 流浪商人 | **流浪商人街** | 商人抵達公告 + 商品展示 |

兩個頻道都列在「公告區（唯讀）」Category 下，禁止玩家發言，只透過按鈕互動。

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

## 附錄 A：現有道具盤點（2026-06-16）

> 目的：給 Phase K / L 商店設計與新道具擴充的對齊基線。
> 上線前所有新道具需先檢查是否與現有重複，並對齊命名 / 價格區間。

### A.1 礦石（5 + 1 限定）

| ID | 名稱 | 取得 | 用途 | 基礎價 |
|---|---|---|---|---|
| `stone` | 🪨 石頭 | `/挖礦` 55% | 賣、賭石、肥料 | 8 |
| `coal` | 🪵 煤炭 | `/挖礦` 25% | 賣、合成、燃料 | 20 |
| `iron` | 🔩 鐵礦 | `/挖礦` 12% | 合成、賣 | 60 |
| `gold` | 🥇 黃金 | `/挖礦` 6% | 合成、賣 | 200 |
| `diamond` | 💎 鑽石 | `/挖礦` 1% | 合成、賣 | 800 |
| `snow_crystal` | ❄️ 雪晶石 | 聖誕活動限定 | 賣、節日合成 | 500 |
| `gambling_stone` | 🪨 賭石（劣質 / 優質） | 挖礦副產 | 給鑑定師開獎 | — |

### A.2 魚類（5 + 1 副產）

| ID | 名稱 | 取得 | 用途 | 基礎價 |
|---|---|---|---|---|
| `small_fish` | 🐟 小雜魚 | 溪流 60% | 烹飪、肥料、賣 | 5 |
| `crucian` | 🎣 鯽魚 | 各地點 | 烹飪、賣 | 15 |
| `shark` | 🦈 鯊魚 | 海邊 / 熔岩 | 合成釣竿、烹飪、賣 | 60 |
| `octopus` | 🐙 章魚 | 熔岩湖多 | 合成、烹飪、肥料 | 150 |
| `lava_fish` | 🐉 熔岩魚 | 熔岩湖 8% | 合成、限定料理 | 600 |
| `moon_dew` | 🌙 月光露水 | 熔岩湖 5% 副產 | 肥料、烹飪稀有食材 | — |

### A.3 作物（4 種）

| ID | 名稱 | 種植成本 | 收成 | 額外掉落 |
|---|---|---|---|---|
| `carrot` | 🥕 紅蘿蔔 | 20 幣 | 50–80 幣 | — |
| `corn` | 🌽 玉米 | 60 幣 | 150–200 幣 | — |
| `strawberry` | 🍓 草莓 | 150 幣 | 400–500 幣 | — |
| `black_rose` | 🌹 黑玫瑰 | 500 幣 | 1,200–1,500 幣 | 靈魂碎片 / 稀有釣餌 |

### A.4 工具（4 階各 4 件）

- **鎬子**：木 / 鐵 / 黃金 / 鑽石 — 挖礦屬性
- **釣竿**：竹 / 碳纖 / 黃金 / 秘銀 — 釣魚屬性
- **劍**：鐵 / 鋼 / 黃金 / 鑽石 / 傳說 — 地下城戰鬥
- **維修工具**：鐵 / 鋼 / 黃金 / 秘銀 / 鑽石 / 傳說 — 修復耐久

### A.5 特殊道具（既有）

| 名稱 | 取得 | 效果 |
|---|---|---|
| 撈網 | 合成 | 釣魚成功率 +10% |
| 高級陷阱 | 合成 | 農場防守 |
| 藏寶圖 | 合成 / 隨機掉 | 觸發藏寶系統 |
| 藏寶圖碎片 | 隨機遭遇 | 集滿合藏寶圖 |
| 賭石 | 挖礦副產 | 給 NPC 鑑定師開獎 |
| 靈魂碎片 | 黑玫瑰收成隨機 | 用途待擴充（未實作完） |

### A.6 消耗品 / 商城（既有 shop）

| 道具 | 售價 | 效果 |
|---|---|---|
| CD 縮短券 | 150 幣 | 縮短 CD 30 分鐘 |
| 背包擴充 | 2,000 幣 | +5 格 |
| 幸運藥水 | 300 幣 | 3 次挖礦 luck +8% |
| 體力藥水 | 600 幣 | +5 體力（日限 3） |
| 磨鎬石 | 250 幣 | 鎬耐久回滿（最大值 −10） |

### A.7 烹飪食物（16 種，由 `food.json` 定義）

涵蓋：打工收入 +20%、釣魚 luck +10%、挖礦 luck +10%、地下城 ATK +20、農場產量 +X%、全屬性 +10%。
時長 1–4 小時不等 / 或固定次數型。

### A.8 Buff 卷軸與藥水

- XP 藥水、金幣藥水、各級倍數 1.5× / 2×（時長 1h–1d）
- 來源：商城 / 抖內 / Twitch perks / 隨機遭遇

### A.9 外觀（17 種，純收藏 / 炫耀）

- **顏色身份組**（30 天時效）：紅 / 橘 / 金 / 綠 / 蒂芬妮綠 / 藍 / 紫 / 粉 / 銀 / 極光金
- **卡面風格**（永久）：廟宇籤詩 / 故障藝術 / 蒸汽波 / 北歐極簡 / 皮革撲克 / 全息投影 / 街頭塗鴉
- **等級卡強調色**（永久）：粉紅 / 海藍 / 金箔 / 薄荷 / 墨黑

### A.10 稱號（18 種，`titles.json`）

按 挖礦 / 賭場 / 股市 / 樂透 / 拍賣 / BOSS 戰 分類，含成就型（永久）與排名型（週月輪替）。

### A.11 既有 barter 系統

> ⚠️ **重要**：`src/config/barter.json` + `src/features/barter/` 已存在 — **玩家對玩家**的物品交換（手續費 1%，7 日有效）。
> Phase K / L 的 barter（玩家 ↔ NPC）**不衝突**，但要避免命名混淆：
> - 既有：`/barter`（P2P 互換）
> - 新增：黑市暗號交易、流浪商人 barter（NPC barter）
> - 建議：新系統用 `/黑市` / `/流浪商人` 為入口，不再開新的 top-level 指令

### A.12 抖內獎勵（已實作）

| 階級 | 金額 | 內容 |
|---|---|---|
| 小額 | 50–149 | 500 幣 + 幸運藥水 ×3 |
| 標準 | 150–499 | 2,000 幣 + CD 票 ×5 |
| 高級 | 500–999 | 6,000 幣 + 限定卡面 |
| 頂級 | 1,000+ | 15,000 幣 + VIP 永久身分組 + 自訂稱號 |

### A.13 公會倉庫（共享 15 種）

存放：礦石 / 作物 / 魚類，依品質有容量限制。**無獨有道具**，純倉庫機制。

### A.14 關鍵發現（給後續擴充用）

- ✅ 完整生產線：礦 / 魚 / 作物 / 烹飪 已成熟
- ✅ 完整 buff 卷軸：時長型加成已成熟
- ❌ **無寵物 / 蛋類**（Phase H 全新引入）
- ❌ **無轉職 / 職業相關道具**（Phase J 全新引入）
- ❌ **無冒險專屬道具**（Phase I 全新引入：古文物、地圖碎片進階款）
- ⚠️ 靈魂碎片用途未明（黑玫瑰副產）— 可作 Phase K / L barter 收料新出口
- ⚠️ 賭石（劣質）有可能囤積過量 — 可作流浪商人 barter 收料

---

## 附錄 B：新道具規劃（依 Phase 分類）

> 給 Phase H / I / J / K / L 上線時所需新增的道具目錄。
> 上線前需在對應 config 註冊，並對齊既有命名風格（snake_case ID、繁中名）。

### B.1 Phase H 寵物相關（共 14 種，預估）

| ID | 名稱 | 功用 | 取得 |
|---|---|---|---|
| `pet_egg_common` | 普通寵物蛋 | 孵化 4h → 普通寵物 | BOSS / 釣魚稀有 / 黑玫瑰 |
| `pet_egg_rare` | 稀有寵物蛋 | 孵化 12h → 稀有寵物 | BOSS / 黑市 / 流浪商人 barter |
| `pet_egg_legendary` | 傳說寵物蛋 | 孵化 24h → 傳說寵物 | BOSS 尾刀 / 黑市違禁 / 抖內 |
| `pet_egg_limited` | 限定寵物蛋 | 限定品種 | 季節活動 / 至尊抖內 |
| `warming_stone` | 🔥 加溫石 | 蛋孵化時間 −50% | 商城 600 幣 / 黑市 / 流浪商人 |
| `evolution_stone` | ✨ 進化石 | 寵物 Lv.10/25 進化材料 | BOSS 尾刀 / 黑市傳奇級 / 流浪商人 barter |
| `pet_treat_basic` | 🍪 基礎餵食餅乾 | 飽足度 +20 | 商城 100 幣 |
| `pet_treat_premium` | 🍰 高級餵食餐 | 飽足度 +50 | 流浪商人花匠款 |
| `pet_skin_*` | 🎨 寵物皮膚 | 純外觀 | 抖內 / 季節活動 |
| `pet_rename_card` | 📝 寵物改名卡 | 自訂名稱（30 字）| 商城 500 幣 |
| `pet_revive_potion` | 💧 寵物復甦藥 | 飢餓 0 罷工狀態回滿 | 商城 800 幣 / 流浪商人 |

### B.2 Phase I 冒險相關（本次延後）

> Phase I 文字冒險已從本次計畫移除。原規劃的森林 / 廢墟 / 深海 22 種道具
> （古文物、深海珍珠、守衛核心、海妖之淚 等）一併延後。
> 黑市 / 流浪商人的商品池**改以既有資源為主**（魚 / 礦 / 作物 / 黑玫瑰副產 等）。
> 若 Phase I 後續上線，再從 PR 歷史回復道具清單即可。

### B.3 Phase J 轉職相關（共 6 種，預估）

| ID | 名稱 | 功用 | 取得 |
|---|---|---|---|
| `career_stone` | 🗿 轉職石 | 季內額外轉職消耗 | 黑市傳奇級 / 流浪商人 barter |
| `trial_progress_voucher` | 📋 試煉減半券 | 職業試煉要求 ×0.5（取代「跳過試煉券」，平衡風險低） | 黑市 / 抖內 |
| `class_badge_miner` | ⛏️ 礦工徽章 | Lv.50 後永久佩戴（外觀）| 季賽冠軍 |
| `class_badge_*` | 其他 5 職業徽章 | 同上 | 季賽冠軍 |
| `season_pass_emblem` | 🏅 季首紀念章 | 季首登入禮 | 系統發放 |

> ⚠️ 原「跳過職業試煉券」改為「試煉減半券」，避免破壞遊戲設計（玩家失去職業引導體驗）。

### B.4 Phase K 黑市 / Phase L 流浪商人 通用（共 5 種，預估）

| ID | 名稱 | 功用 | 取得 |
|---|---|---|---|
| `luck_scroll_30d` | 🍀 luck +1% 卷軸（30 天） | 30 天 luck +1%（受 luckCap 限制）| 黑市違禁 / 抖內 |
| `luck_scroll_permanent` | 🍀 luck +0.5% 卷軸（永久，**個人累計上限 +3%**） | 永久 luck +0.5% | 黑市違禁 / 暗號交易 |
| `title_voucher_limited` | 🏷️ 限定稱號券 | 從限定池選一個（30 天）| 黑市傳奇 / 抖內 |
| `recipe_dragon_breath` | 📖 龍息湯食譜 | 解鎖限定料理（全屬性 +15% / 4h）| 流浪商人 barter（藥師款）|
| `rare_bait` | 🪱 限定釣餌 | 本次釣魚 luck +30% | 黑市 / 流浪商人 |

### B.5 平衡規則

針對新增 buff 類道具，加入：

1. **永久 luck 卷軸個人累計上限 +3%**（避免無限堆疊）
2. **永久型卷軸納入 `luckCap`**（賭場與挖礦皆受限）
3. **時效型卷軸（30 天）不疊加 luckCap**，但本身有時效衰減
4. **「跳過試煉券」不上線**，改為「試煉減半券」

---

## 附錄 C：材料 → 合成關聯圖

> 目的：確保每個道具有明確 **生產 → 消耗** 路徑，沒有孤兒材料；
> 同時補齊既有未明用途（如靈魂碎片、賭石劣質）。

### C.1 既有材料出口檢查（紅燈 = 需補出口）

| 材料 | 既有出口 | 狀態 | 補強方案 |
|---|---|---|---|
| 石頭 | 賭石、肥料、賣 | 🟢 OK | — |
| 煤炭 | 合成、賣 | 🟢 OK | — |
| 鐵礦 | 合成、賣 | 🟢 OK | — |
| 黃金 | 合成、賣 | 🟢 OK | 新合成：進化石 |
| 鑽石 | 合成、賣 | 🟢 OK | 新合成：進化石 |
| 小雜魚 | 烹飪、肥料 | 🟢 OK | 寵物餵食 |
| 鯊魚 | 合成釣竿、烹飪 | 🟢 OK | 黑市暗號 |
| 熔岩魚 | 限定料理 | 🟡 出口少 | 流浪商人 barter（食譜換）|
| 黑玫瑰 | 烹飪、副產靈魂碎片 | 🟢 OK | — |
| **靈魂碎片** | （無用途）| 🔴 孤兒 | **新合成：進化石、寵物玩具** |
| **賭石（劣質）** | 鑑定師開獎 | 🟡 易囤積 | **流浪商人收料（barter）** |

### C.2 新道具合成樹（建議納入 `craft.json`）

```
進化石（Phase H 核心消耗品）
├─ 黃金 ×3 + 鑽石 ×1 + 靈魂碎片 ×2          ← 給靈魂碎片出口
├─ 流浪商人騎士款 barter：彩虹石 ×3 + 鯊魚 ×5
└─ 黑市傳奇級購買：60,000 幣

寵物玩具（提升親密度互動上限）
├─ 黑玫瑰 ×2 + 靈魂碎片 ×3 + 鐵 ×5
└─ 商城 1,500 幣

戰鬥藥水（提升地下城 / BOSS ATK）
├─ 煤炭 ×3 + 鐵 ×2 + 鯊魚 ×1
└─ 鍊金 NPC 製作（未來）

龍息湯（限定料理，全屬性 +15% / 4h）
├─ 熔岩魚 ×2 + 黑玫瑰 ×1 + 黃金 ×3
└─ 需先學會食譜（流浪商人 barter）

> 註：原規劃中需要冒險產出（古文物 / 守衛核心 / 海妖之淚 等）的合成項目
> （完整護符 / 深海稱號券 / 傳說劍）一併延後至 Phase I 上線後再開。
```

### C.3 補出口的合成項目（解決孤兒問題）

| 道具 | 之前狀態 | 新出口 |
|---|---|---|
| 靈魂碎片 | 🔴 孤兒（黑玫瑰副產但無用）| 進化石、寵物玩具材料 |
| 賭石（劣質）| 🟡 易囤積 | 流浪商人收 20 個 + 鐵 ×30 → 隨機罕見道具 |
| 雪晶石（限定）| 🟡 限定礦只能賣 | 進化石替代材料（黃金 ×3 替換為雪晶石 ×1）|

### C.4 跨 Phase 材料流向

```
                  ┌────────────────────┐
                  │   生產線（既有）   │
                  └────────┬───────────┘
                           │
        ┌──────────┬───────┴────┬───────────┐
        ▼          ▼            ▼           ▼
    ⛏️ 礦石     🐟 魚類      🌾 作物     🌹 黑玫瑰
        │          │            │           │
        │          │            │           ▼
        │          │            │      💎 靈魂碎片（NEW 出口）
        │          │            │           │
        └──────┬───┴────┬───────┘           │
               │        │                   │
               ▼        ▼                   ▼
         🍱 烹飪    🦴 工具          ✨ 進化石（NEW）
            │         │                   │
            ▼         ▼                   ▼
       😋 buff     ⚒️ 修耐久          🐉 寵物進化
                                          │
                                          ▼
                                    🦄 強化 buff
```

> 設計原則：**每條既有產線都有「賣 / 合成 / barter」三條出口**，避免囤積。
> Phase I 冒險上線後再補「冒險產出 → 鍊金 / 稱號 / 限定食譜」這條支線。

---

## 附錄 D：黑市 / 流浪商人 具體商品池

### D.1 黑市 itemPool（每場從中隨機抽 3–5 件）

**罕見級（rare，權重 50）**

| 商品 | 售價 | 全服庫存 | 備註 |
|---|---|---|---|
| 雪晶石 ×3 | 1,200 | 2 | 聖誕限定 |
| 加溫石 ×2 | 800 | 3 | 寵物孵化加速 |
| 限定釣餌 ×5 | 1,500 | 3 | luck +30% / 釣 |
| 高級肥料 ×5 | 600 | 2 | 農場加速 |
| 戰鬥藥水 ×2 | 900 | 2 | 地下城 / BOSS ATK +20 |

**珍貴級（precious，權重 30）**

| 商品 | 售價 | 全服庫存 | 備註 |
|---|---|---|---|
| 稀有寵物蛋 ×1 | 8,000 | 1 | 12h 孵化 |
| 轉職石 ×1 | 6,000 | 2 | 額外轉職 |
| 30 天 luck +1% 卷軸 | 5,500 | 2 | 受 luckCap |
| 寵物皮膚（基礎款）| 4,000 | 1 | 純外觀 |
| 高級餵食餐 ×3 | 3,500 | 2 | 飽足 +50 ×3 |

**傳奇級（legendary，權重 15）**

| 商品 | 售價 | 全服庫存 | 備註 |
|---|---|---|---|
| 進化石 ×1 | 40,000 | 1 | 寵物進化 |
| 傳說寵物蛋 ×1 | 55,000 | 1 | 24h 孵化 |
| 限定稱號券 | 30,000 | 2 | 30 天時效 |
| 龍息湯食譜 | 35,000 | 1 | 解鎖限定料理 |
| 高階藏寶圖 | 25,000 | 1 | 觸發稀有寶藏 |

**違禁級（contraband，權重 5，查緝率 +5%）**

| 商品 | 售價 | 全服庫存 | 備註 |
|---|---|---|---|
| 永久 luck +0.5% 卷軸 | 200,000 | 1 | 個人累計上限 +3% |
| 試煉減半券 | 150,000 | 1 | 取代「跳過試煉券」 |
| 限定寵物蛋（季限） | 280,000 | 1 | 抖內以外的取得管道 |
| 稀有寵物皮膚 | 120,000 | 1 | 純外觀 |

### D.2 黑市 barterPool（每場 1–2 件，**有查緝風險**）

| 暗號需求 | 換取物 | 等值幣（罰款計算用）|
|---|---|---|
| 鯊魚 ×10 + 熔岩魚 ×3 | 傳說寵物蛋 ×1 | ~2,400 |
| 彩虹石 ×5 + 黑玫瑰 ×3 | 永久 luck +0.5% 卷軸 | ~7,500 |
| 黑玫瑰 ×8 + 鑽石 ×3 | 試煉減半券 | ~6,400 |
| 靈魂碎片 ×10 + 鑽石 ×3 | 進化石 ×2 | ~6,400 |
| 賭石（劣質）×20 + 鐵 ×30 | 隨機 1 件罕見級道具 | ~3,800 |
| 章魚 ×8 + 鯊魚 ×3 | 限定稱號券 | ~1,400 |

> 罰款 = 等值幣 ×3（被查緝時）。

### D.3 流浪商人 商品池（依個性）

**🧙 古怪藥師艾莉莎（全商品 −5%）**

| 商品 | 模式 | 價格 / 需求 | 個人限購 |
|---|---|---|---|
| 幸運藥水 | coin | 240（原 300） | 3 |
| 戰鬥藥水 ×1 | coin | 850 | 1 |
| XP 藥水 ×1 | coin | 380 | 2 |
| 高級餵食餐 ×1 | coin | 1,200 | 1 |
| 龍息湯食譜 | **barter** | 熔岩魚 ×2 + 黑玫瑰 ×1 + 黃金 ×3 | 1（每人一生一次）|
| 永久 luck +1% 卷軸 | **barter** | 鯊魚 ×10 + 章魚 ×5 + 鐵 ×20 | 1 |

**🛡️ 退役騎士哈洛德（首購送「磨鎬石 ×1」）**

| 商品 | 模式 | 價格 / 需求 | 個人限購 |
|---|---|---|---|
| 體力藥水 | coin | 480（原 600） | 3 |
| 磨鎬石 | coin | 220（原 250）| 2 |
| 30 天 luck +0.5% 卷軸 | coin | 4,200 | 1 |
| 寵物玩具 | coin | 1,100 | 1 |
| 進化石 ×1 | **barter** | 鑽石 ×3 + 鯊魚 ×5 | 1 |
| 試煉減半券 | **barter** | 黃金 ×10 + 章魚 ×5 + 靈魂碎片 ×3 | 1 |

**🌸 花匠少女小百合（送「寵物餵食特餐 ×1」）**

| 商品 | 模式 | 價格 / 需求 | 個人限購 |
|---|---|---|---|
| 高級肥料券 | coin | 600 | 2 |
| 加溫石 ×1 | coin | 720（原 800） | 2 |
| 寵物玩具 | coin | 1,200 | 1 |
| 限定釣餌 ×3 | coin | 1,000 | 2 |
| 稀有寵物蛋 ×1 | **barter** | 紅蘿蔔 ×30 + 玉米 ×15 + 草莓 ×8 | 1 |
| 賭石換罕見 | **barter** | 賭石（劣質）×20 + 鐵 ×30 | 1 |

### D.4 商品池輪替機制

- **每場**從上述池隨機抽（依 weight 與個性偏好）
- **黑市違禁品**：每週**全服總出現次數**上限 3 次（避免快速通膨）
- **流浪商人 barter 名額**：每個商人每次出現帶 1–2 件 barter（從該個性 barter 池抽）
- **限定季節商品**（雪晶石 / 季節寵物蛋）：只在對應月份的商品池內

### D.5 商品池版本管理

- 商品池放 `src/config/black_market.json` 與 `src/config/wandering_merchant.json` 的 `itemPool` / `barterPool`
- 季賽 / 大改版時可單獨增刪商品，不需動程式
- 季賽結束舊限定品自動從池內移除（透過 `availableUntil` 欄位）
- Phase I 文字冒險上線後，再追加冒險產出（古文物 / 守衛核心 / 海妖之淚 等）對應的 barter 條目

---

_Last updated: 2026-06-16 — 增補 Phase K（神祕黑市）、Phase L（流浪商人）、以物易物機制、現有道具盤點（附錄 A / B / C / D）；移除 Phase I 文字冒險（延後）_
