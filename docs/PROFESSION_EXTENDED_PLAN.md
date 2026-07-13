# 職業系統延伸企劃（雙軌：生活職業 + 副本戰鬥職業）+ 技能樹整合 — 基於實碼

> 版本：v2.0（2026-07-13）
> **延伸自** `docs/PLAN_NEXT_PHASE.md` 的 **Phase J 轉職 / 職業系統**，並**併吞** `docs/PLAN_INTEGRATED.md` 的 **Phase S3 技能樹系統**（技能樹綁進職業，各職一條專屬線）；副本戰鬥軌接 `docs/PHASE_H_PLUS_DUNGEON_REFINEMENT.md`。
> **定位（v2 雙軌）**：玩家**同時**持有一個「**生活職業（正職）**」與一個「**副本戰鬥職業（兼職）**」，分情境生效——生活職業 buff 於平時（挖礦/經濟/PvP/社群）生效，副本戰鬥職業於副本/組隊戰鬥生效。前者沿身份光譜補「風險/犯罪 ↔ 秩序/執法」與「社群/服務」；後者補「坦/補/DPS/輔助」隊伍分工。
> **重要原則**：本企劃的每一條加成都標注**真實掛勾點（檔案:行號）與可行性分級**，不沿用理想數值。**本文件為設計企劃，不含程式碼變更。**

---

## 目錄

1. [現況檢視](#1-現況檢視)
2. [三個決定設計成敗的架構真相](#2-三個決定設計成敗的架構真相)
3. [統一框架：雙軌職業 + 專屬技能線](#3-統一框架雙軌職業--專屬技能線)
4. [生活職業軌 — 既有六職 retrofit](#4-生活職業軌--既有六職-retrofit)
4B. [延伸生活職業（犯罪者 + 3 職業）](#4b-延伸生活職業犯罪者--3-職業)
4C. [副本戰鬥職業軌（五角）](#4c-副本戰鬥職業軌五角)
5. [可行性分級總表](#5-可行性分級總表)
6. [完整度補充（exp / 試煉 / 稱號 / UX）](#6-完整度補充)
7. [平衡與經濟出口](#7-平衡與經濟出口)
8. [落地與檔案影響](#8-落地與檔案影響)
9. [待確認決策與分期建議](#9-待確認決策與分期建議)

---

## 1. 現況檢視

### 1-1. Phase J 與 S3 目前都只有企劃、零程式碼
- `src/features/` 下**完全沒有** profession / class / 職業 系統（已 grep 確認）。
- 犯罪骨幹 `theft` 已完整實作（`src/features/theft/*`、`src/config/theft.json`）；`casino`（30+ 賭局）、`cookService`（食物 buff）、`work`、`marketplace`、`quests`、`duelService`/`dungeonService` 皆已實作。
- **eventBus 已上線**（`src/features/eventBus/index.js`），但只 emit `mine.done`/`fish.done`/`harvest.done`/`boss.*`/`dungeon.*`/`item.*`/`coin.delta`；**theft 與 casino 完全沒有 emit**。
- **副本（`dungeonService`）100% 單人**：Phase H+ 多回合 HP 戰鬥（`battleEngine.simulate({ player, monster })`）已大致實作；**組隊/多人同場副本＝全新機制**（詳見 §2 真相 4、§4C）。

### 1-2. 定位差異（沿用 `PLAN_NEXT_PHASE.md` 對照，兩者可疊加）

| 維度 | S3 技能樹 | J 轉職系統 |
|---|---|---|
| 形式 | 解點數、可混點 | 選一身份、獨佔效果 |
| 效果 | 數值累加 | 數值 + 專屬指令 + 專屬視覺 |
| 玩家心智 | 「我有什麼能力」 | 「我是誰」 |

### 1-3. 身份光譜缺口 → 雙軌補完
現規劃六職業（礦工/漁夫/農夫/騎士/商人/學者）全落在**生產 / 戰鬥 / 經濟 / 收集**象限。缺口分兩類，對應雙軌：
- **生活軌缺**：風險/犯罪、秩序/執法、社群/服務 → §4B 補犯罪者/捕快/廚師/賭徒。
- **戰鬥軌缺**：副本內沒有「坦/補/DPS/輔助」隊伍分工身份（現有騎士只是單人 ATK 堆疊）→ §4C 補五個副本戰鬥職業，並把**騎士移入戰鬥軌**。

---

## 2. 三個決定設計成敗的架構真相

> 這幾點是整份企劃的地基。忽略它們，職業加成就會像「惡名衰退加速」那樣自相矛盾或根本掛不上去。

### 真相 1：buff 門面**不統一**，只真正介入挖礦
`src/features/buff/buffResolver.js` 的 `getMiningResolve()` 只被 `mineService.js:54` 呼叫。**釣魚（`fishService.js`）、農場（`farmService.js`）、theft、casino、打工都不走這個門面**，各自 inline 讀 food / 公會 / 世界事件加成。

→ 「職業加成統一走 buffResolver」**只有挖礦與 ATK 乾淨**；釣魚 / 農場 / theft / casino / 打工要**各自在自己的 service inline 注入**職業修正值。

### 真相 2：`grantCoins` 倍率鏈對 `FLAT_REWARD_SOURCES` 是**關的**
`grantCoins.js` 中 `mining_sell`、`work`、`quest_*`、`farm_harvest`、`farm_sell` 都在 `FLAT_REWARD_SOURCES` → 一律 `skipMultipliers=true`。**`sell.js` 裡印「賣礦含加成」的那行是死碼**，證明賣礦目前零乘率。

→ 這些玩法的「收入 +X%」**不能靠 grantCoins 倍率**；必須在 service 發幣前先乘、或把該 source 移出 FLAT 清單並在 grantCoins 加職業分支。

### 真相 3：多個企劃主動指令在現況**根本沒有機制**
- 騎士「挑釁」：決鬥（`duelService`）是一次性 `atk + 亂數` 對拚，**無回合、無鎖定目標、無狀態效果**。
- 料理師「開桌給多人 buff」：個人食物 buff **只加成自己**；唯一多人前例是公會宴會（`banquetService`，限公會範圍）。
- 賭場「每日首勝 / luck 影響賭場」：賭場**完全不讀玩家 luck**，也**無首勝機制**。

→ 這些是**新子系統**，不是「加一個 config 係數」。企劃須明確標為 **C 級**，避免低估工作量。

### 真相 4（v2 新增）：副本**100% 單人**，組隊是全新機制
- 兩套引擎（舊 `enterDungeon` binary、新 `enterDungeonHp` 多回合 HP）**都是單 player**；`battleEngine.simulate` 簽章 `{ player, monster, miniBoss }` 無隊伍容器。`raid_` 只是**按鈕命名前綴**（單人 owner 驗證），不是多人。
- 唯一多人共鬥範式是 **BOSS 系統 `bossEngine.js`**：共享血量實體 + 原子扣血（`$inc current_hp`）+ 逐筆傷害 log + 按貢獻分獎 + combo 接力。屬**非同步貢獻制**，**無**回合制坦/補/DPS 分工。
- **`battleEngine.rollPetAssist`（`battleEngine.js:181-213`）** 已實作 combat（追擊半傷）/ healer（回 5–10 HP）分流，呼叫端預留 `petType`（`dungeonService.js:834`）/ hpMax `pet` key（`:773`）。→ **副本職業的 per-round 貢獻直接仿此模板、平行加 `professionType`**。
- **目前完全沒有**「玩家 A 在戰鬥中對玩家 B 補血 / 加 ATK / 開護盾」的定向即時隊友 buff——這正是組隊 + 職業分工要新建的核心，`battleEngine` 的單 `player` 結構是最大改造點。

---

## 3. 統一框架：雙軌職業 + 專屬技能線

### 3-1. 雙軌、兩槽、分情境生效
每位玩家**同時**持有兩個職業槽（不互斥、不 double-dip）：

| 軌 | 槽 | 生效情境 | exp 來源 |
|---|---|---|---|
| **A 生活職業（正職）** | 1 | 平時：挖礦/釣魚/農場/經濟/PvP/社群 | 日常事件 `mine.done`/`fish.done`/`theft.*`/`cook.done`… |
| **B 副本戰鬥職業（兼職）** | 1 | 副本/組隊戰鬥中 | `dungeon.cleared`/`boss.killed` + 新戰鬥事件 |

「正職/兼職」＝兩頂帽子、兩個情境；生活職業 buff 不在戰鬥中作用、副本職業效果不在平時作用，故彼此不衝突、不需要平衡互扣。

### 3-2. 一個職業 = 身份 + 一條技能線
每個職業（兩軌皆同）→ ①被動 buff / 戰鬥角色 ②專屬主動指令 ③**專屬技能線**（5 技能前置鏈，沿用 S3 `{ id, cost, requires, effect }` 結構，綁定該職業，非選該職不能點）。

### 3-3. 兩種貨幣、兩種來源，永不 double-dip
- **技能點** = 玩家等級（`UserLevels` 升級給點）→ 廣度成長。
- **職業 exp** = eventBus 事件驅動 → 深度成長；生活軌與副本軌各自累計、各自一條線。
- 同一動作只給對應軌的職業 exp，不給技能點。

### 3-4. 轉職 = 換身份 + 換線
切換職業時，原職業已點技能點**保留但凍結**（比照 Phase J exp 凍結），轉回恢復；不同職業的線互不共用點。兩軌各自轉職、各自季賽。

### 3-5. 加成注入點（因門面不統一，須分系統寫清）
新增 `professionResolver`（compute-on-read），注入點依系統而異：

| 加成 | 真實注入點 |
|---|---|
| 挖礦 luck / qty | `buff/buffResolver.js:92-93`（門面內，乾淨） |
| 挖礦 CD | `buff/buffResolver.js:104` |
| 釣魚 成功率 / 稀有度 / 數量 | `fishService.js:148 / :312 / :318` inline |
| 農場 收成 | `farmService.js:354`；施肥豁免 `:675` inline |
| 打工收入 | `workService.js:97-99` |
| 拍賣手續費 | `marketplaceService.js:44 resolveSellerFeeRate` |
| 任務獎勵 | `questService.js:92 tryClaimOne` |
| theft（犯罪者 / 捕快） | `theftService.js:260 / :278 / :284 / :466 / :541 / :773`（見 §4B） |
| 副本 ATK / DEF / HP / crit / dmgPct | `dungeonService.js:257 / :788 / :771 / :786 / :777`（見 §4C） |
| 副本 per-round 協戰 | 仿 `battleEngine.js:181-213 rollPetAssist`（見 §4C） |

### 3-6. buffResolver 疊加順序
1. `base` → 2. `+ 技能線點數`（加法）→ 3. `+ 職業被動`（依職業 Lv 里程碑 Lv10 +20% / Lv30 +40% 放大）→ 4. `+ 到期型 buff` → 5. `套 cap`（luckCap、steal hardCap、§7 職業疊加天花板）。

---

## 4. 生活職業軌 — 既有六職 retrofit

把 S3 三通用線（採掘/戰鬥/商業）重分配為專屬線。**騎士移入副本戰鬥軌（§4C）**，故生活軌保留五個舊職 + §4B 四個新職。分級：A=插係數即可；B=掛點在但需接線；C=無機制需新做。

| 職業 | 被動（掛勾點） | 分級 | 專屬技能線（5 鏈） |
|---|---|---|---|
| ⛏️ **礦工** | 挖礦 qty/luck `buffResolver.js:92`、CD `:104` | **A** | 礦石感知→快速開採→採掘專精→稀礦直覺→彩虹共鳴 |
| ⛏️ 礦工（賣礦+%） | `mining_sell` 在 FLAT_REWARD，無乘率 | **B** | ↑（大宗貿易節點需接線） |
| 🎣 **漁夫** | 成功率 `fishService.js:148`、稀有 `:312`、一次兩條 `:318` | **A** | 漁獲直覺→撒網→深海探測→烹飪火候→傳說釣手 |
| 🌾 **農夫** | 收成量 `farmService.js:354` | **A** | 沃土→速成→豐收→間作→農神 |
| 🌾 農夫（施肥不耗礦石） | `fertilize() :675` 一律扣料，須加豁免 | **C** | ↑ |
| 💰 **商人** | 打工+ `workService.js:97`、拍賣費− `marketplaceService.js:44` | **A** | 市場嗅覺→談判技巧→拍賣達人→大宗貿易→壟斷市場 |
| 📚 **學者** | 任務+ `questService.js:92` | **A** | 博覽→速記→鑑價→考據→賢者 |

> 舊職的加成大多 **A 級**（幾乎免費）；例外：「賣礦收入+%」(B)、「施肥不耗礦石」(C)。

---

## 4B. 延伸生活職業（犯罪者 + 3 職業）

補「風險 ↔ 秩序」對位軸 + 一個社群職。統一模板：被動（掛勾點 + 分級）／主動指令／複用系統／適合玩家／平衡與防濫用。

### 4B-1. ⚖️ 犯罪者 Outlaw（風險核心）— 複用 `theft`

> **⚠️ 惡名雙面刃修正（本企劃最重要的一課）**
> 惡名（notoriety）在現有系統裡是竊賊的 **power 值**：
> - 單次偷竊上限 `min(3000 + 惡名×300, 12000)`（`theftService.js:275-278`）——**惡名越高偷越大**。
> - 成功率 `+1%/惡名`（上限 +15%，`:252-255`）。
> - 被追捕逃脫後躲藏冷卻**隨惡名變長**。
> - **唯一壞處**：賞金 `+100/惡名`（`:358`）。
>
> 因此「讓犯罪者惡名衰退加速（洗白快）」是**把核心 power 洗掉**、自相矛盾。**作廢。**

**正確設計（實碼已驗證）**：偷竊力**由職業 Lv 直接提供、完全不碰惡名**——

| 效果 | 掛勾點 | 分級 |
|---|---|---|
| 偷竊上限+（`stealCap` 加獨立 `jobStealPower`，不呼叫 `adjustNotoriety`） | `theftService.js:278` | A |
| 成功率+（clamp 前加 `jobStealRate`） | `:260` | A |
| 黑市抽成−（`blackMarketRakePct` 換有效抽成） | `:284` | A |
| 自首更便宜 | `:655-658 / :661` | A |

→ 玩家不必堆危險惡名就能偷大額，惡名/賞金風險維持低。「乾淨的職業竊賊」。

- **主動**：`/踩點`（偵察目標錢包區間）→ Lv20 `/銷贓`（抽成折扣漂白 hot 贓款）。
- **技能線**：潛行→開鎖→銷贓→越獄→教父。
- **平衡**：受 theft 既有防霸凌閘（新手保護 7 天 / 低餘額<500 免疫 / 每日 3 次 / 同目標 8h 冷卻）約束；由 §4B-2 捕快對位；compute-on-read。

### 4B-2. 🛡️ 捕快 / 賞金獵人 Lawman（秩序對位）— 複用 `theft` hunt/report

| 效果 | 掛勾點 | 說明 |
|---|---|---|
| 追捕率+ | `theftService.js:466` | clamp 內加 `jobHuntRate`（ATK 已走 buffResolver） |
| 罰金分成+ | `:541` | `Math.floor(fine/2)` 換 `floor(fine*huntSharePct)`；`:554 otherHalf` 自動平帳 |
| **偵探費減免** | `:773` | `fee = floor(tier.fee * (1 - jobDetectiveDiscount))`，插在 `:773`、`:775` 錢包檢查前。語意乾淨（執法者辦案成本低）、單一 knob |

- **主動**：`/巡邏`（範圍降低被偷率，compute-on-read 範圍 buff）。
- **陣營互斥 / 洗白·黑化**：犯罪者⇄捕快天然互斥，跨陣營走每季免費/轉職石。
- **平衡**：罰金是玩家間轉移非造幣（零和、不通膨）。

### 4B-3. 🍳 料理師 / 廚神 Chef（社群 / 服務軸）— 複用 `cookService`

| 效果 | 掛勾點 | 分級 |
|---|---|---|
| 烹飪產出+、食物 buff 時長+ | `cookService.js cook()` / `useFood()` | A |
| **`/開桌`（給多人 buff）** | 個人食物 buff 只加成自己 → **新子系統** | **C** |

- **`/開桌` 落地**：**直接複用公會宴會框架**（`banquetService` 已有「多人 compute-on-read 共讀一份 buff 文件」範式），改職業版——新建「開桌」文件（`buffs + expires_at + 受邀名單`），`buffResolver` 讀取端加分支。
- **技能線**：備料→火候→擺盤→宴席→米其林。
- **平衡**：材料為 coin/物品 sink；開桌 buff 時效制。

### 4B-4. 🎰 賭徒 / 亡命之徒 Gambler（風險軸）— 複用 `casino`

> **現況硬傷（見 §2 真相 3）**：賭場無中央結算層、不讀 luck、無首勝、無 casino.* 事件。→ 賭徒加成幾乎全 **C 級**。

- **先做（A/B）**：「樂透加注」——仿 `lottery.js:240/943` 既有 `lotteryTicketBonus` 抬購買上限。
- **後做（C）**：「賭場退水」需**新建共用 `casinoPayout()` helper** 包住派彩乘職業係數，再改 30+ 呼叫點；`/賭運`（臨時 luck buff）因賭場不讀 luck，需自訂職業結算。
- **exp**：訂閱 `coin.delta` 過濾 `meta.game`，或新增 `casino.*` emit。
- **平衡**：casino 獨立金池、加成保守；見 §6 responsible-gambling 註記。

### 4B-5. 選配願景（本次只列不展開）
💊 走私客（複用 Phase K 黑市，依賴未實作）／🐾 馴獸師（對接未來寵物 Phase H）。

---

## 4C. 副本戰鬥職業軌（五角）

> 補副本/組隊的「坦/補/DPS/輔助」分工。**騎士移入本軌**。效果**只在副本戰鬥生效**。掛勾點見 §2 真相 4。

### 4C-1. 五個角色（掛勾點 + 分級）

| 角色 | 定位 | 現成掛勾點 | 分級 |
|---|---|---|---|
| ⚔️ **鬥士 Fighter**（騎士轉生於此） | DPS，高 ATK / 暴擊 | ATK `dungeonService.js:257`、crit `:786`、dmgPct `:777`（最乾淨 % 匯流點） | **A**（自身數值） |
| 🛡️ **坦克 Guardian** | 高 DEF / HP / 格擋 + **嘲諷** | DEF `:788`、hp_max `:771`、盾格擋/反射 `battleEngine.js:28-86` | **A**（自身）／**C**（嘲諷=組隊威脅目標） |
| 💊 **補師 Healer** | 每回合補血 | 仿 `battleEngine.js:181-213 rollPetAssist` healer 分支（回 5–10 HP） | **B**（自補/仿模板）／**C**（補隊友） |
| ✨ **輔助 Support** | 上狀態 / debuff 怪、群 buff | 戰鬥狀態系統 `battleEngine`（中毒/暈眩/護甲/燃燒/麻痺已實作 tick） | **B**（對怪）／**C**（對隊友群 buff） |
| 🏹 **召喚師 Summoner**（可選獵人變體） | 召喚協戰單位（遠程/穿甲） | 直接複用預留 assist slot `dungeonService.js:834 professionType` + `rollPetAssist` 模板 | **B**（仿 pet assist） |

- **技能線範例**：鬥士 破甲→連擊→致命→狂暴→劍聖；坦克 硬化→格擋→嘲諷→反傷→不倒；補師 治療→群療→復活→淨化→聖光；輔助 弱化→上毒→加速→護盾→戰歌；召喚師 召喚→強化召喚物→雙重召喚→爆裂→大君。

### 4C-2. 組隊副本現況與落地路線
- 現況副本**100% 單人**，`battleEngine.simulate({ player, monster })` 單 player。**組隊＝全新機制**。
- 兩條路（見 §2 真相 4）：
  - **(a) 借 BOSS 非同步貢獻模型**（`bossEngine.js`：共享血量/原子扣血/按貢獻分獎/combo 接力）——較快，但**無真正坦補分工**（各玩各的輸出）。
  - **(b) 擴 `battleEngine` 成 `simulate({ party:[...], monster })`**、加回合行動者輪替 + 威脅（坦克嘲諷）/ 治療目標選擇——才有**真坦/補/DPS 分工**，是**最大工程**。
- 建議：真正的「坦補 DPS 分工」走 (b)。

### 4C-3. 分期（副本軌）
- **B1 單人版先上**：每個副本職業的「作用在自己身上」效果（鬥士自身 ATK+/crit、坦克自身 DEF/HP/格擋、補師戰鬥中自補、召喚師召喚協戰）→ 複用**現有單人 `battleEngine` + `rollPetAssist` 模板 + 屬性掛勾**，**現在就能落地**。等於先讓玩家有「副本身份 + 自我強化」。
- **B2 組隊版後做**：坦克嘲諷、補師補隊友、輔助群 buff、召喚物對隊友 → 需先把 `battleEngine` party 化（§4C-2 路線 b），或借 BOSS 非同步貢獻底。**最大 C 級工程**。

---

## 5. 可行性分級總表

> A=插係數即可；B=掛點在但需接線；C=新子系統。

### 生活軌
| 職業 | 效果 | 真實掛勾點 | 分級 |
|---|---|---|---|
| 礦工 | qty/luck/CD | `buffResolver.js:92-93/104` | A |
| 礦工/商人 | 賣礦收入+% | `grantCoins` FLAT_REWARD（`mining_sell`） | B |
| 漁夫 | 成功率/稀有/數量 | `fishService.js:148/312/318` | A |
| 農夫 | 收成量 | `farmService.js:354` | A |
| 農夫 | 施肥不耗礦石 | `fertilize() :675` | C |
| 商人 | 打工+ / 拍賣費− | `workService.js:97` / `marketplaceService.js:44` | A |
| 學者 | 任務+ | `questService.js:92` | A |
| 犯罪者 | 上限/成功率/抽成/自首 | `theftService.js:278/260/284/655` | A |
| 捕快 | 追捕率/分成/偵探費 | `theftService.js:466/541/773` | A |
| 料理師 | 烹飪產出/時長 | `cookService.js cook()/useFood()` | A |
| 料理師 | 開桌給多人 | 複用 `banquetService` 新建 | C |
| 賭徒 | 樂透加注 | `lottery.js:240/943` | A/B |
| 賭徒 | 賭場退水 / 賭運 | 無中央結算層 / 不讀 luck | C |

### 副本戰鬥軌
| 角色 | 效果 | 真實掛勾點 | 分級 |
|---|---|---|---|
| 鬥士 | 自身 ATK/暴擊/dmg% | `dungeonService.js:257/786/777` | A |
| 坦克 | 自身 DEF/HP/格擋 | `dungeonService.js:788/771`、`battleEngine.js:28-86` | A |
| 坦克 | 嘲諷（拉怪） | 需 party 威脅目標 | C |
| 補師 | 自補 | 仿 `rollPetAssist` `battleEngine.js:181-213` | B |
| 補師 | 補隊友 | 需 party 結構 | C |
| 輔助 | 對怪上狀態 | `battleEngine` 狀態系統 | B |
| 輔助 | 群 buff 隊友 | 需 party 結構 | C |
| 召喚師 | 召喚協戰 | 複用 `dungeonService.js:834 professionType` + `rollPetAssist` | B |
| **組隊副本容器** | party 同場 | `battleEngine` 單→party 擴寫（或借 BOSS 底） | **C（最大工程）** |

### eventBus emit 缺口
| 系統 | 現況 | 需補 |
|---|---|---|
| theft | **零 emit** | `theftService.js:323/587/711` 補 `theft.steal.done` / `theft.hunt.done` / `theft.surrender.done` |
| casino | **零 emit** | 新增 `casino.*` 或訂 `coin.delta`(`meta.game`) |
| cook | 無 `cook.done` | `cook()` / `useFood()` 補 emit |
| 挖礦/釣魚/農場/BOSS/地城 | ✅ 已 emit | 直接訂閱（副本軌 exp 用 `dungeon.cleared`/`boss.killed`） |

---

## 6. 完整度補充

### 6-1. 職業 exp 曲線 + 每事件 exp（🔴 必補）
- 兩軌各定義 Lv 0→50 曲線 + 里程碑（Lv10 +20% / Lv20 第二主動 / Lv30 +40% / Lv50 永久稱號）。
- 每個 eventBus 事件的 exp 值須逐一定義（生活軌 `mine.done`/`theft.steal.done`…；副本軌 `dungeon.cleared`/`boss.killed`…）。
- **防刷小號**：exp 綁「淨獲利」而非「動作次數」；對同目標/同小號遞減；犯罪者失風給少量 exp。

### 6-2. 新職業轉職試煉（🔴 必補）
| 職業 | 試煉範例 |
|---|---|
| 犯罪者 | 偷竊得手 N 次 |
| 捕快 | 追捕成功 N 次 |
| 料理師 | 烹飪 N 道 |
| 賭徒 | 下注 N 次 |
| 副本五角 | 以對應角色通關副本 N 次 / 造成 N 治療·傷害·承傷 |

（六舊職沿用 `PLAN_NEXT_PHASE.md` 既有試煉。）

### 6-3. 職業稱號整合（🔴 必補）
掛真實 `titles.json` 結構（`{ name, emoji, category, desc, req, weekly }` + `gameTitleService`）：新增 `categoryLabels.profession = "職業"`（犯罪者/捕快可複用 `theft`）；補職業之王稱號（盜賊之王/警長/廚神/賭神/副本征服者…）、**百業通**（所有職業 Lv30，永久）。

### 6-4. UI/UX 具體版面（🔴 必補，會撞元件上限）
- 生活軌 9 職 + 副本軌 5 角，每項都 Section+ActionRow **必爆 40 元件上限（UX #8）** → `/職業` 明訂**雙軌分頁 + StringSelect 選職業**，首頁 5–6 項。
- 錯誤訊息一律 `ContainerBuilder`（UX #2/#6）：未達 Lv20 / 無轉職石 / 試煉未完 / 專屬指令無對應職業，皆列條件 + 目前進度 + 解決方向。

### 6-5. 反共謀（🟡 建議補）
犯罪者⇄捕快小號對刷（互偷 + 自抓領賞）→ **複用既有 `economy/suspiciousTransferDetector.js` + `suspiciousAlert.js`** 納入偵測。

### 6-6. 整體職業 buff 疊加天花板（🟡 建議補）
挖礦有 `luckCap 0.25`，但 qty/CD/收入%/ATK/DEF/HP **無統一 cap**。職業 + 技能線 + 公會 + 食物 + 世界事件疊加要設**職業疊加上限**，防 runaway（副本軌尤須，避免坦克 DEF / 鬥士 ATK 破表）。

### 6-7. 騎士「挑釁」grounded MVP（🟡 建議補，C→B）
`duelService.js:261 declineDuel` 已存在 → 挑釁可 = **對方無法 `declineDuel`（拒絕即沒收賭注/判負）**，複用既有決鬥流程，不新建回合戰鬥。（註：騎士已移入副本軌成鬥士；此 MVP 若保留 PvP 挑釁動詞可掛在生活軌或副本軌，待定。）

### 6-8. 經濟遙測（🟡 建議補）
每職業 log 欄位：犯罪者淨轉移、捕快賞金收入、料理師 buff 發放數、賭徒淨盈虧、副本各角色治療/承傷/輸出量 — 供上線後調平衡。

### 6-9. 待擴充（⚪ 一句帶過）
- 與既有 `work` 5 級系統關係（商人「打工+20%」疊加不取代）。
- 無職業 / 放棄職業 的預設狀態與 UX（兩軌各可為空）。
- 技能線重置粒度（S3 原 5000 幣）。
- 賭徒 responsible-gambling 註記。
- `career_stone` 轉職石產出點與季通行證。

---

## 7. 平衡與經濟出口

- **犯罪者 ↔ 捕快制衡**：犯罪者加成越強偷越多，捕快追捕率/分成/偵探費全針對犯罪者收網。互斥選邊，貓鼠生態。
- **不通膨**：偷竊/賞金/罰金皆**玩家間轉移（零和）**，再被黑市抽成、保釋金、偵探費**淨回收**（sink）。賞金是通緝當下從小偷錢包託管、非系統產幣。
- **副本軌不產幣失衡**：副本職業效果作用於戰鬥屬性（ATK/DEF/HP/治療），不直接產幣；獎勵仍走既有 `rollLoot`/`clearReward` 與樓層倍率，職業只影響「打不打得贏」，不新增產幣管道。
- **加成全 compute-on-read**（對齊 `CLAUDE.md`）：DB 只存來源狀態（兩軌職業 / Lv / 已解鎖技能 / active buff + expires_at），加成於使用時才用 `professionResolver` 即時算。

---

## 8. 落地與檔案影響

> 供未來實作參考，**本企劃不含程式碼變更**。

### 新增檔案（沿用 Phase J 結構，擴為雙軌）
| 檔案 | 內容 |
|---|---|
| `src/config/profession.json` | 兩軌職業定義 + `lineAnchor` + 各職專屬技能線 + 試煉 + 季賽 |
| `src/features/profession/professionService.js` | 兩軌轉職、試煉、exp 累計（訂閱 eventBus） |
| `src/features/profession/professionResolver.js` | 給各 service / buffResolver / battleEngine 呼叫的修正值來源 |
| `src/commands/profession/profession.js` + `active/*.js` | `/職業` 指令群（雙軌分頁）+ 各職專屬主動指令 |
| `src/events/interactionCreate/handleProfessionButton.js` | 轉職按鈕（含確認、owner 驗證） |
| `src/events/ready/professionSeasonChecker.js` | 季賽結算 cron |

DB：`connectDb.js` 宣告 `user_professions`（含 `life_current` / `dungeon_current` 兩槽）/ `user_skills`，`{user_id, guild_id}` unique index。

### 改動既有檔案（依 §3-5 注入點）
`buff/buffResolver.js`、`fishService.js`、`farmService.js`、`workService.js`、`marketplaceService.js`、`questService.js`、`theftService.js`（注入 + 補 3 emit）、`eventBus/index.js`（補事件合約）、`commands/mining/buff.js`（`/加成` 加雙軌職業區塊）。
**副本軌**：`dungeonService.js`（`professionType` / 屬性注入 `:257/771/788/786/777`）、`battleEngine.js`（`rollProfessionAssist` 仿 `rollPetAssist`；組隊版須 party 化 `simulate`）。

### C 級新子系統（各自獨立段落標「需新做」）
料理師開桌（複用 `banquetService`）、賭徒賭場結算層（`casinoPayout()`）、**組隊副本容器（`battleEngine` party 化，最大工程）**、坦克嘲諷/補師補隊友/輔助群 buff（依賴 party 容器）。

### 規則對齊（`CLAUDE.md` / `AGENTS.md`）
名稱一律中文（新 buff key 先進 `buffLabels.js`、`titles.json`）；失敗/例外路徑也走中文表；新增玩家可見職業/道具同步 `bibi-website/src/lib/dashboard/botDefs.ts`；新指令逐項對 UX 檢查 #1–#9。

---

## 9. 待確認決策與分期建議

### 待確認（附建議預設）
| 決策 | 建議預設 |
|---|---|
| ✅ 雙軌並存、分情境生效 | 已定案（生活職業＋副本職業各一槽） |
| ✅ 騎士移入副本戰鬥軌 | 已定案（成為鬥士系） |
| ✅ 副本戰鬥職業五角 | 已定案（鬥士/坦克/補師/輔助/召喚師） |
| ✅ 捕快「偵探費減免」 | 已定案（`theftService.js:773`） |
| 第五角召喚師 vs 獵人 | 建議召喚師（直接複用預留 assist slot），獵人為變體 |
| 犯罪者⇄捕快跨陣營冷卻 | 沿用每季免費/轉職石，不加額外冷卻 |
| 賭徒本次範圍 | 只做 A/B「樂透加注」；賭場結算層/賭運(C) → 後期 |
| 料理師開桌 | 複用 `banquetService` 框架 |

### 分期建議
- **P1**：雙軌框架 + 生活軌 A 級（六舊職 + 犯罪者 + 捕快）+ 副本軌 **B1 單人版**（五角自我強化）+ theft 3 emit。
- **P2**：生活軌 B 級接線（賣礦乘率、賭徒樂透加注、挑釁 grounded MVP）。
- **P3**：C 級新子系統（料理師開桌、賭場結算層）+ **組隊副本容器（`battleEngine` party 化）→ 副本軌 B2 隊友分工**（嘲諷/補隊友/群 buff）。

---

> **交叉引用**：本文件延伸自 [`PLAN_NEXT_PHASE.md`](./PLAN_NEXT_PHASE.md) Phase J、併吞 [`PLAN_INTEGRATED.md`](./PLAN_INTEGRATED.md) Phase S3、副本戰鬥軌接 [`PHASE_H_PLUS_DUNGEON_REFINEMENT.md`](./PHASE_H_PLUS_DUNGEON_REFINEMENT.md)。
