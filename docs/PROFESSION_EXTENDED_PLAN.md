# 職業系統延伸企劃（含犯罪者）+ 技能樹整合 — 基於實碼

> 版本：v1.0（2026-07-13）
> **延伸自** `docs/PLAN_NEXT_PHASE.md` 的 **Phase J 轉職 / 職業系統**，並**併吞** `docs/PLAN_INTEGRATED.md` 的 **Phase S3 技能樹系統**（技能樹綁進職業，各職一條專屬線）。
> **定位**：把「職業（身份）」與「技能樹（點數）」合併成一套成長系統，並沿身份光譜往「風險/犯罪 ↔ 秩序/執法」與「社群/服務」延伸。
> **重要原則**：本企劃的每一條加成都標注**真實掛勾點（檔案:行號）與可行性分級**，不沿用理想數值。**本文件為設計企劃，不含程式碼變更。**

---

## 目錄

1. [現況檢視](#1-現況檢視)
2. [三個決定設計成敗的架構真相](#2-三個決定設計成敗的架構真相)
3. [統一框架：職業＝身份 + 專屬技能線](#3-統一框架職業身份--專屬技能線)
4. [既有六職業 → 專屬技能線 retrofit](#4-既有六職業--專屬技能線-retrofit)
5. [延伸職業提案（犯罪者 + 3 職業）](#5-延伸職業提案犯罪者--3-職業)
6. [可行性分級總表](#6-可行性分級總表)
7. [完整度補充（exp / 試煉 / 稱號 / UX）](#7-完整度補充)
8. [平衡與經濟出口](#8-平衡與經濟出口)
9. [落地與檔案影響](#9-落地與檔案影響)
10. [待確認決策與分期建議](#10-待確認決策與分期建議)

---

## 1. 現況檢視

### 1-1. Phase J 與 S3 目前都只有企劃、零程式碼
- `src/features/` 下**完全沒有** profession / class / 職業 系統（已 grep 確認）。
- 犯罪骨幹 `theft` 已完整實作（`src/features/theft/*`、`src/config/theft.json`）；`casino`（30+ 賭局）、`cookService`（食物 buff）、`work`、`marketplace`、`quests`、`duelService`/`dungeonService` 皆已實作。
- **eventBus 已上線**（`src/features/eventBus/index.js`），但只 emit `mine.done`/`fish.done`/`harvest.done`/`boss.*`/`dungeon.*`/`item.*`/`coin.delta`；**theft 與 casino 完全沒有 emit**。

### 1-2. 定位差異（沿用 `PLAN_NEXT_PHASE.md` 對照，兩者可疊加）

| 維度 | S3 技能樹 | J 轉職系統 |
|---|---|---|
| 形式 | 解點數、可混點 | 選一身份、獨佔效果 |
| 效果 | 數值累加 | 數值 + 專屬指令 + 專屬視覺 |
| 玩家心智 | 「我有什麼能力」 | 「我是誰」 |

### 1-3. 身份光譜缺口
現規劃六職業（礦工/漁夫/農夫/騎士/商人/學者）全落在**生產 / 戰鬥 / 經濟 / 收集**象限。缺兩塊：
- **風險 / 犯罪**（高風險高報酬、PvP 掠奪）：`theft` 系統已做底，但沒有「身份」包裝。
- **秩序 / 執法**（守序玩家的對位身份）：`/追捕`、`/報案` 目前人人可用，缺乏「捕快」身份感。
- **社群 / 服務**（增益他人的支援型身份）：目前完全空白。

→ 延伸方向不是再加一個生產職，而是補「犯罪 ↔ 執法」對位軸 + 一個社群職，讓 PvP 生態與社交有身份張力。

---

## 2. 三個決定設計成敗的架構真相

> 這三點是整份企劃的地基。忽略它們，職業加成就會像「惡名衰退加速」那樣自相矛盾或根本掛不上去。

### 真相 1：buff 門面**不統一**，只真正介入挖礦
`src/features/buff/buffResolver.js` 的 `getMiningResolve()` 只被 `mineService.js:54` 呼叫。**釣魚（`fishService.js`）、農場（`farmService.js`）、theft、casino、打工都不走這個門面**，各自 inline 讀 food / 公會 / 世界事件加成。

→ 「職業加成統一走 buffResolver」**只有挖礦與 ATK 乾淨**；釣魚 / 農場 / theft / casino / 打工要**各自在自己的 service inline 注入**職業修正值。

### 真相 2：`grantCoins` 倍率鏈對 `FLAT_REWARD_SOURCES` 是**關的**
`grantCoins.js` 中 `mining_sell`、`work`、`quest_*`、`farm_harvest`、`farm_sell` 都在 `FLAT_REWARD_SOURCES` → 一律 `skipMultipliers=true`。**`sell.js` 裡印「賣礦含加成」的那行是死碼**（因 `mining_sell` 永遠 `granted===total`），證明賣礦目前零乘率。

→ 這些玩法的「收入 +X%」**不能靠 grantCoins 倍率**；必須在 service 發幣前先乘、或把該 source 移出 FLAT 清單並在 grantCoins 加職業分支。

### 真相 3：多個企劃主動指令在現況**根本沒有機制**
- 騎士「挑釁」：決鬥（`duelService`）是一次性 `atk + 亂數` 對拚，**無回合、無鎖定目標、無狀態效果**。
- 料理師「開桌給多人 buff」：個人食物 buff **只加成自己**；唯一多人前例是公會宴會（`banquetService`，限公會範圍）。
- 賭場「每日首勝 / luck 影響賭場」：賭場**完全不讀玩家 luck**（luck 是挖礦專屬），也**無首勝機制**。

→ 這些是**新子系統**，不是「加一個 config 係數」。企劃須明確把它們標為 **C 級**，避免低估工作量。

---

## 3. 統一框架：職業＝身份 + 專屬技能線

### 3-1. 一個職業 = 身份 + 一條技能線
選一個職業 → 獲得該職業的：
1. **被動 buff**（身份加成）
2. **專屬主動指令**（獨佔動詞）
3. **專屬技能線**（5 技能前置鏈，沿用 S3 的 `{ id, cost, requires, effect }` 結構，但**綁定該職業**，非選職業不能點）

### 3-2. 兩種貨幣、兩種來源，永不 double-dip
| 成長軸 | 來源 | 性質 |
|---|---|---|
| **技能點** | 玩家等級（`UserLevels` 升級給點） | 廣度成長 |
| **職業 exp** | eventBus 事件驅動（訂閱對應事件） | 深度成長 |

同一動作（如成功偷竊）**只給職業 exp、不給技能點**；技能點永遠只來自升等。避免單一行為雙重獎勵。

### 3-3. 轉職 = 換身份 + 換線
切換職業時，原職業已點的技能點**保留但凍結**（比照 Phase J 的 exp 凍結），轉回即恢復；不同職業的線互不共用點。

### 3-4. 加成注入點（因門面不統一，須分系統寫清）
新增 `professionResolver`（compute-on-read），但**注入點依系統而異**：

| 加成 | 真實注入點 |
|---|---|
| 挖礦 luck / qty | `buff/buffResolver.js:92-93`（門面內，乾淨） |
| 挖礦 CD | `buff/buffResolver.js:104` |
| ATK（騎士） | `dungeonService.js:257 playerAtk`（全戰鬥共用；程式碼註解已預留此擴充點） |
| 釣魚 成功率 / 稀有度 / 數量 | `fishService.js:148 / :312 / :318` inline |
| 農場 收成 | `farmService.js:354`；施肥豁免 `:675` inline |
| 打工收入 | `workService.js:97-99`（與 foodWorkBonus 同層） |
| 拍賣手續費 | `marketplaceService.js:44 resolveSellerFeeRate`（已有 Twitch 疊加前例） |
| 任務獎勵 | `questService.js:92 tryClaimOne` |
| theft（犯罪者 / 捕快） | `theftService.js:260 / :278 / :284 / :466 / :541 / :773`（見 §5） |

### 3-5. buffResolver 疊加順序（有加法有乘法，須明訂）
1. `base`（原始值）
2. `+ 技能線點數`（加法累計）
3. `+ 職業被動`（身份加成，再依職業 Lv 里程碑放大：Lv10 +20% / Lv30 +40%）
4. `+ 到期型 buff`（藥水 / 宴會 / 稱號 / 身分組）
5. `套 cap`（luckCap、steal hardCap，以及 §8 的職業疊加天花板）

theft 類數值（偷竊上限、成功率、抽成）走**同一條 resolver 管線**，不在 theftService 內散算。

---

## 4. 既有六職業 → 專屬技能線 retrofit

把 S3 三通用線（採掘 / 戰鬥 / 商業）重分配為六職業專屬線。下表對每個效果標**可行性分級**（A=有現成掛點插係數即可；B=掛點在但需接線；C=無機制需新做）。

| 職業 | 被動（掛勾點） | 分級 | 專屬技能線（5 鏈） |
|---|---|---|---|
| ⛏️ **礦工** | 挖礦 qty/luck `buffResolver.js:92`、CD `:104` | **A** | 礦石感知→快速開採→採掘專精→稀礦直覺→彩虹共鳴 |
| ⛏️ 礦工（賣礦+%） | `mining_sell` 在 FLAT_REWARD，無乘率 | **B** | ↑（大宗貿易節點需接線） |
| 🎣 **漁夫** | 成功率 `fishService.js:148`、稀有 `:312`、一次兩條 `:318` | **A** | 漁獲直覺→撒網→深海探測→烹飪火候→傳說釣手 |
| 🌾 **農夫** | 收成量 `farmService.js:354` | **A** | 沃土→速成→豐收→間作→農神 |
| 🌾 農夫（施肥不耗礦石） | `fertilize()` 一律扣料 `:675`，須加豁免 | **C** | ↑ |
| ⚔️ **騎士** | ATK+ `dungeonService.js:257` | **A** | 鬥志覺醒→體能強化→致命一擊→BOSS 剋星→不死鬥魂 |
| ⚔️ 騎士（挑釁） | 決鬥無回合/鎖定 → 見 §7 grounded MVP | **B**（降級後） | ↑ |
| 💰 **商人** | 打工+ `workService.js:97`、拍賣費− `marketplaceService.js:44` | **A** | 市場嗅覺→談判技巧→拍賣達人→大宗貿易→壟斷市場 |
| 📚 **學者** | 任務+ `questService.js:92` | **A** | 博覽→速記→鑑價→考據→賢者 |

> 舊六職業的加成大多是 **A 級**（幾乎免費）；唯二例外：「賣礦收入+%」(B)、「施肥不耗礦石」(C)。

---

## 5. 延伸職業提案（犯罪者 + 3 職業）

補「風險 ↔ 秩序」對位軸 + 一個社群職。統一模板：被動（掛勾點 + 分級）／主動指令／複用系統／適合玩家／平衡與防濫用。

### 5-1. ⚖️ 犯罪者 Outlaw（風險核心）— 複用 `theft`

> **⚠️ 惡名雙面刃修正（本企劃最重要的一課）**
> 惡名（notoriety）在現有系統裡是竊賊的 **power 值**：
> - 單次偷竊上限 `min(3000 + 惡名×300, 12000)`（`theftService.js:275-278`）——**惡名越高偷越大**，惡名 30 才解到 12000 頂。
> - 成功率 `+1%/惡名`（上限 +15%，`:252-255`）。
> - 被追捕逃脫後躲藏冷卻**隨惡名變長**（越大尾越難再抓）。
> - **唯一壞處**：賞金 `+100/惡名`（`:358`）——頭上懸賞越高、越多人想抓。
>
> 因此「讓犯罪者惡名衰退加速（洗白快）」是**把核心 power 洗掉**、自相矛盾。**作廢。**

**正確設計（實碼已驗證可行）**：犯罪者的偷竊力**由職業 Lv 直接提供、完全不碰惡名**——
- 偷竊上限：在 `theftService.js:278` 的 `stealCap = Math.min(baseCap + 惡名×capPerNotoriety, hardCap)` 加一個獨立 `jobStealPower` 項。
- 成功率：在 `:260`（clamp 前）加 `jobStealRate`。
- **不呼叫 `adjustNotoriety`** → 玩家不必堆危險惡名就能偷大額，惡名/賞金風險維持低。「乾淨的職業竊賊」。
- 淨收益 buff：黑市抽成折扣，`:284` 把 `blackMarketRakePct` 換成 resolver 修正後的有效抽成。
- 自首更便宜：`:655-658 forfeitPct` / `:661 disgorgePct`。

| 效果 | 掛勾點 | 分級 |
|---|---|---|
| 偷竊上限+（不靠惡名） | `theftService.js:278` | A |
| 成功率+ | `:260`（clamp 前） | A |
| 黑市抽成− | `:284` | A |
| 自首更便宜 | `:655-658 / :661` | A |

- **主動指令**：`/踩點`（偵察目標錢包區間，每日限次）→ Lv20 解鎖 `/銷贓`（抽成折扣漂白 hot 贓款）。
- **技能線**：潛行→開鎖→銷贓→越獄→教父（效果同以修正值注入上述行號）。
- **適合玩家**：愛 PvP、風險偏好、掠奪型。
- **平衡**：受 theft 既有防霸凌閘（新手保護 7 天 / 低餘額<500 免疫 / 每日 3 次 / 同目標 8h 冷卻）約束；由 §5-2 捕快對位；加成 compute-on-read。

### 5-2. 🛡️ 捕快 / 賞金獵人 Lawman（秩序對位）— 複用 `theft` hunt/report

存在理由＝制衡犯罪者，讓守序玩家有身份。被動全 A 級（皆有精確掛點）：

| 效果 | 掛勾點 | 說明 |
|---|---|---|
| 追捕率+ | `theftService.js:466` | clamp 內加 `jobHuntRate`（ATK 已走 buffResolver） |
| 罰金分成+ | `:541` | `Math.floor(fine/2)` 換 `floor(fine*huntSharePct)`；`:554 otherHalf = fine - hunterFineShare` 自動平帳 |
| **偵探費減免** | `:773` | `fee = floor(tier.fee * (1 - jobDetectiveDiscount))`，插在 `:773`、`:775` 錢包檢查前。語意乾淨（執法者辦案成本低）、單一 knob |

- **主動指令**：`/巡邏`（一段時間內降低頻道/公會範圍成員被偷率，走 compute-on-read 範圍 buff）。
- **平衡**：罰金是玩家間轉移非造幣（零和、不通膨）；與犯罪者**陣營互斥**。
- **陣營互斥 / 洗白·黑化**：犯罪者⇄捕快天然互斥（職業本就獨佔），跨陣營走每季免費/轉職石，形成「洗白 ↔ 黑化」敘事張力。

### 5-3. 🍳 料理師 / 廚神 Chef（社群 / 服務軸）— 複用 `cookService`

補「服務他人」象限——價值來自增益別人。

| 效果 | 掛勾點 | 分級 |
|---|---|---|
| 烹飪產出+、食物 buff 時長+ | `cookService.js cook()` / `useFood()` | A |
| **`/開桌`（給多人 buff）** | 個人食物 buff 只加成自己 → **新子系統** | **C** |

- **`/開桌` 落地建議**：**直接複用公會宴會框架**（`banquetService`，已有「多人 compute-on-read 共讀一份 buff 文件」的範式），改成職業版——新建「開桌」文件（`buffs + expires_at + 受邀 userId 名單`），在 `buffResolver` 讀取端加一個分支加總。比從零建省一半。
- **技能線**：備料→火候→擺盤→宴席→米其林。
- **平衡**：材料為 coin/物品 sink；開桌 buff 時效制、compute-on-read。

### 5-4. 🎰 賭徒 / 亡命之徒 Gambler（風險軸）— 複用 `casino`

> **現況硬傷（見 §2 真相 3）**：賭場**無中央結算層**（30+ 分散的 `bet`/`payout` 呼叫）、**不讀 luck**、**無「每日首勝」**、**無 casino.* 事件**（只有間接 `coin.delta(meta.game)`）。→ 賭徒加成幾乎全是 **C 級**。

務實設計（分階段）：
- **先做（A/B）**：「樂透加注」——仿 `lottery.js:240/943` 既有的 `lotteryTicketBonus`（訂閱加票前例）抬高購買上限。
- **後做（C）**：被動「賭場淨利/退水」需**新建共用 `casinoPayout()` helper** 包住派彩、乘職業係數，再逐一改 30+ 呼叫點；主動 `/賭運`（臨時 luck buff）因賭場不讀 luck，需自訂職業專屬結算。
- **exp**：訂閱 `coin.delta` 過濾 `meta.game`，或新增 `casino.*` emit。
- **平衡**：casino 為獨立金池、加成刻意保守；見 §7 responsible-gambling 註記。

### 5-5. 選配願景（本次只列不展開）
- **💊 走私客 Smuggler**（複用 Phase K 黑市，**依賴黑市未實作**）。
- **🐾 馴獸師 / 牧場主**（對接未來寵物 Phase H / 畜牧 F3）。

---

## 6. 可行性分級總表

> 讓人一眼看出「哪些幾乎免費、哪些是大工程」。A=插係數即可；B=掛點在但需接線；C=新子系統。

| 職業 | 效果 | 真實掛勾點 | 分級 |
|---|---|---|---|
| 礦工 | qty/luck/CD | `buffResolver.js:92-93/104` | A |
| 礦工/商人 | 賣礦收入+% | `grantCoins` FLAT_REWARD（`mining_sell`） | B |
| 漁夫 | 成功率/稀有/數量 | `fishService.js:148/312/318` | A |
| 農夫 | 收成量 | `farmService.js:354` | A |
| 農夫 | 施肥不耗礦石 | `fertilize() :675` | C |
| 騎士 | ATK+ | `dungeonService.js:257` | A |
| 騎士 | 挑釁 | `duelService.js:261 declineDuel`（見 §7） | B |
| 商人 | 打工+ / 拍賣費− | `workService.js:97` / `marketplaceService.js:44` | A |
| 學者 | 任務+ | `questService.js:92` | A |
| 犯罪者 | 上限/成功率/抽成/自首 | `theftService.js:278/260/284/655` | A |
| 捕快 | 追捕率/分成/偵探費 | `theftService.js:466/541/773` | A |
| 料理師 | 烹飪產出/時長 | `cookService.js cook()/useFood()` | A |
| 料理師 | 開桌給多人 | 複用 `banquetService` 新建 | C |
| 賭徒 | 樂透加注 | `lottery.js:240/943` | A/B |
| 賭徒 | 賭場退水 / 賭運 | 無中央結算層 / 不讀 luck | C |

### eventBus emit 缺口（職業 exp 累計所需）
| 系統 | 現況 | 需補 |
|---|---|---|
| theft | **零 emit** | `theftService.js:323/587/711` 補 `theft.steal.done` / `theft.hunt.done` / `theft.surrender.done` |
| casino | **零 emit** | 新增 `casino.*` 或訂閱 `coin.delta`(`meta.game`) 過濾 |
| cook | 無 `cook.done` | `cook()` / `useFood()` 補 emit |
| 挖礦/釣魚/農場/BOSS/地城 | ✅ 已 emit | 直接訂閱 |

---

## 7. 完整度補充

### 7-1. 職業 exp 曲線 + 每事件 exp（🔴 必補）
- 定義職業 Lv 0→50 曲線（沿用 Phase J 里程碑：Lv10 buff+20% / Lv20 第二主動 / Lv30 被動+40% / Lv50 永久稱號）。
- **每個 eventBus 事件給多少 exp**須逐一定義（`mine.done` / `fish.done` / `harvest.done` / `theft.steal.done` / `theft.hunt.done` / `boss.killed` / `dungeon.cleared` …）。
- **防刷小號**：exp 綁「淨獲利」而非「動作次數」；對**同一目標 / 同一小號**遞減；犯罪者失風給**少量** exp（避免鼓勵送頭）。

### 7-2. 新職業轉職試煉（🔴 必補）
Phase J 規定要完成「轉職試煉」才能初次轉職。新職業試煉：

| 職業 | 試煉範例 |
|---|---|
| 犯罪者 | 偷竊得手 N 次 |
| 捕快 | 追捕成功 N 次 |
| 料理師 | 烹飪 N 道料理 |
| 賭徒 | 下注 N 次 |

（六舊職業沿用 `PLAN_NEXT_PHASE.md` 既有試煉定義。）

### 7-3. 職業稱號整合（🔴 必補）
掛真實 `titles.json` 結構（`{ name, emoji, category, desc, req, weekly }` + `gameTitleService`）：
- 新增 `categoryLabels.profession = "職業"`（或犯罪者/捕快複用既有 `theft` 分類）。
- 補職業之王稱號：盜賊之王 / 警長 / 廚神 / 賭神 …（季冠軍，`weekly`/季 req）；**百業通**（所有職業 Lv30，永久）。

### 7-4. UI/UX 具體版面（🔴 必補，會撞元件上限）
- **10 職業若每項都 Section+ActionRow → 必爆 Discord 40 元件上限（UX #8）**。→ `/職業 列表` 明訂用 **StringSelect 選職業 + 分頁**，首頁 5–6 項。
- 錯誤訊息一律 `ContainerBuilder`（UX #2 / #6）：
  - 未達 Lv20：紅色 accent，「需要 Lv.20、目前 Lv.17」。
  - 無轉職石 / 試煉未完 / 專屬指令無職業：明列條件 + 目前進度 + 解決方向（-# 小字）。

### 7-5. 反共謀（🟡 建議補）
犯罪者⇄捕快 小號對刷（一個小號互偷 + 另一號自抓領賞金）是明顯漏洞。**複用既有 `economy/suspiciousTransferDetector.js` + `suspiciousAlert.js`**，把此模式納入偵測；exp 綁淨獲利 + 對同對象遞減亦同時抑制。

### 7-6. 整體職業 buff 疊加天花板（🟡 建議補）
挖礦有 `luckCap 0.25`，但 **qty / CD / 收入% / ATK 目前無統一 cap**。職業 + 技能線 + 公會 + 食物 + 世界事件疊起來要設**職業疊加上限**，防 runaway combo。

### 7-7. 騎士「挑釁」grounded MVP（🟡 建議補，C→B）
不必新建回合戰鬥子系統。`duelService.js:261 declineDuel` 已存在（status `pending`→`declined`、退回賭注）→ 挑釁可 = **對方無法 `declineDuel`（拒絕即沒收賭注 / 判負）**，複用既有決鬥 accept/decline 流程。降為 B 級。

### 7-8. 經濟遙測（🟡 建議補）
Phase J 前置就要經濟儀表板。補「每職業要 log 什麼」：犯罪者淨轉移額、捕快賞金收入、料理師 buff 發放數、賭徒淨盈虧 — 供上線後調平衡。

### 7-9. 待擴充（⚪ 一句帶過）
- 與既有 `work` 5 級系統（打工新手→王牌員工）的關係：商人「打工+20%」是疊加、不取代其等級。
- 無職業 / 放棄職業 的預設狀態與 UX。
- 技能線重置粒度（S3 原本 5000 幣）：每線各自重置 vs 整體。
- 賭徒 responsible-gambling 註記（每日損失提醒 / 上限）。
- `career_stone` 轉職石產出點（黑市 / BOSS / 抖內）與季通行證。

---

## 8. 平衡與經濟出口

- **犯罪者 ↔ 捕快制衡**：犯罪者加成越強 → 偷得越多；但捕快追捕率/分成/偵探費全針對犯罪者收網。兩者互斥選邊，形成貓鼠生態。
- **不通膨**：偷竊/賞金/罰金都是**玩家間轉移（零和）**，再被黑市抽成、保釋金、偵探費**淨回收**（sink）。賞金是通緝當下從小偷錢包託管、非系統產幣。方向與財富稅一致（收縮）。
- **coin sink 對照 `grantCoins.js`**：新職業的 sink（黑市抽成 `steal_rake`、保釋 `bail`、偵探費 `detective_fee`、料理材料、賭場稅）皆已在 SINK/PEER 分類內或比照新增。
- **加成全 compute-on-read**（對齊 `CLAUDE.md`「加成不寫死」）：DB 只存來源狀態（職業 / 職業 Lv / 已解鎖技能 / active buff + expires_at），加成值於使用時才用 `professionResolver` 即時算。

---

## 9. 落地與檔案影響

> 供未來實作參考，**本企劃不含程式碼變更**。

### 新增檔案（沿用 Phase J 結構）
| 檔案 | 內容 |
|---|---|
| `src/config/profession.json` | 職業定義 + `lineAnchor`（對應技能線）+ 各職專屬技能線 + 試煉 + 季賽 |
| `src/features/profession/professionService.js` | 轉職、試煉、exp 累計（訂閱 eventBus） |
| `src/features/profession/professionResolver.js` | 給各 service / buffResolver 呼叫的修正值來源 |
| `src/commands/profession/profession.js` + `active/*.js` | `/職業` 指令群 + 各職專屬主動指令 |
| `src/events/interactionCreate/handleProfessionButton.js` | 轉職按鈕（含確認、owner 驗證） |
| `src/events/ready/professionSeasonChecker.js` | 季賽結算 cron |

DB：`connectDb.js` 宣告 `user_professions` / `user_skills`，`{user_id, guild_id}` unique index。

### 改動既有檔案（依 §3-4 注入點）
`buff/buffResolver.js`（挖礦 / ATK / `summary`）、`fishService.js`、`farmService.js`、`workService.js`、`marketplaceService.js`、`questService.js`、`dungeonService.js`、`theftService.js`（注入 + 補 3 emit）、`eventBus/index.js`（補事件合約）、`commands/mining/buff.js`（`/加成` 加職業區塊）。

### C 級新子系統（各自獨立段落，標「需新做」）
料理師開桌（複用 `banquetService` 框架）、賭徒賭場結算層（`casinoPayout()` helper）、騎士挑釁（`declineDuel` 改造，已降 B）。

### 規則對齊（`CLAUDE.md` / `AGENTS.md`）
名稱一律中文（新 buff key 先進 `buffLabels.js`、`titles.json`）；失敗/例外路徑也走中文表；新增玩家可見職業/道具同步 `bibi-website/src/lib/dashboard/botDefs.ts`；新指令逐項對 UX 檢查 #1–#9（`/踩點`/`/巡邏`/`/開桌` 屬行動類→公開；`/職業 列表`→ephemeral）。

---

## 10. 待確認決策與分期建議

### 待確認（本企劃已附建議預設）
| 決策 | 建議預設 |
|---|---|
| ✅ 捕快「偵探費減免」 | 已定案（`theftService.js:773`），取代破案率+ |
| 犯罪者⇄捕快跨陣營冷卻 | 沿用每季免費/轉職石，**不加額外冷卻**（陣營切換已有 exp 凍結成本） |
| 賭徒本次範圍 | 只做 A/B 級「樂透加注」；賭場結算層/賭運(C) → P3 |
| 料理師開桌 | **直接複用 `banquetService` 公會宴會框架**改職業版 |

### 分期建議
- **P1**：框架（`professionService` / `professionResolver` / `user_professions` / `/職業` 指令）+ **A 級效果**（六職業 + 犯罪者 + 捕快核心）+ theft 3 emit。
- **P2**：**B 級接線**（賣礦收入乘率、騎士挑釁 grounded MVP、賭徒樂透加注）。
- **P3**：**C 級新子系統**（料理師開桌、賭徒賭場結算層/賭運、農夫施肥豁免）。

---

> **交叉引用**：本文件延伸自 [`PLAN_NEXT_PHASE.md`](./PLAN_NEXT_PHASE.md) Phase J、併吞 [`PLAN_INTEGRATED.md`](./PLAN_INTEGRATED.md) Phase S3。
