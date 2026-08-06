# 逼逼機器人 — 開發規則與 UX 必要檢查

## 專案概要

Discord bot（discord.js v14，Node 22，MongoDB）。
指令在 `src/commands/`，核心邏輯在 `src/features/`，事件處理在 `src/events/`，設定統一從 `src/config/index.js` 匯出。

---

## UX 必要檢查清單

每次新增或修改 slash command 前，逐項確認：

### 1. 按鈕位置：緊靠對應項目，不丟到最外頭

- **列表型指令**（背包、魚袋、市集、拍賣行等）：每個項目的操作按鈕必須放在**該項目正下方的 ActionRow**，不能全部集中在訊息最底部。
- 判斷標準：「這個按鈕是針對第幾項的？」→ 就放在第幾項下面。
- 反例（禁止）：五種魚列成一塊文字，賣魚按鈕丟在整個訊息最底部。
- 正例：每種魚獨立一個文字區塊 + 緊接一個 ActionRow 含「賣全部（+X 幣）」。

### 2. 錯誤訊息：用 Container，不用純文字

- 所有失敗情境（材料不足、冷卻中、未解鎖、餘額不足…）一律用 `ContainerBuilder` 呈現。
- 必須包含：**標題說明問題**、**具體差距**（需要 X 有 Y）、**解決方向提示**（-# 小字）。
- 反例（禁止）：`interaction.editReply("❌ 材料不足！")`
- 正例：accent 紅色 Container → 標題「❌ 材料不足」→ Separator → 詳細缺少項目 → -# 解決提示。

### 3. 成功訊息：附快捷後續按鈕

- 操作成功後，根據「玩家下一步最可能做什麼」放置快捷按鈕。
- 常見模式：
  - 釣到魚 → 「立刻賣掉（+X 幣）」+ 「查看魚袋」
  - 烹飪成功 → 「查看魚袋 & Buff」
  - 賣出後 → 「查看背包 / 魚袋」
  - 挖礦後 → 「找鑑定師賭石」（若挖到石頭）
- 不是每個成功訊息都必須有按鈕；若下一步沒有明確的快捷需求可省略。

### 4. 按鈕 owner 驗證

- 任何帶有玩家 ID 的按鈕（customId 含 `_<userId>`），處理器必須驗證 `interaction.user.id === ownerId`。
- 驗證失敗 → ephemeral 回覆「這不是你的 XXX！」，不執行操作。

### 5. 零值項目的顯示策略

- 列表中值為 0 的項目（背包 0 個、魚袋 0 條）**不應占據主要視覺空間**。
- 處理方式：有值的項目正常顯示（含操作按鈕），0 值的項目**統一收到底部一行** `-# 尚無：A・B・C`。

### 6. 地點 / 功能解鎖的錯誤訊息格式

- 說明：**哪個功能未解鎖**、**解鎖條件是什麼**、**目前進度** 三項全寫。
- 範例：`🔒 熔岩湖 尚未解鎖！\n解鎖條件：等級 40 + 地下城通關 10 次\n目前：Lv.23・通關 4 次`

### 7. Ephemeral 一致性

- 查詢類（背包、魚袋、加成、個人資料）→ `MessageFlags.Ephemeral`（只自己看得到）。
- 行動類（挖礦、釣魚、打工、購買）→ 公開訊息（讓頻道看到動態）。
- 按鈕的 follow-up / 結果訊息：原訊息是 ephemeral → follow-up 也要 ephemeral。

### 8. Discord 元件數量上限：先算再放

- 單一訊息最多 40 個元件（Components v2 包含 Container/Section/Separator/TextDisplay/ActionRow/Button）；單個 ActionRow 最多 5 個 Button。
- **列表型訊息要先估**：N 個項目 × (1 TextDisplay + 1 ActionRow + 2 Button + 1 Separator) ≈ 5N 元件。超過 7–8 項就會頂到上限。
- 解法：用 **Select Menu**（一個 ActionRow 內含一個 StringSelect，最多 25 個 option）替代「每項一個按鈕」；或者**分頁**（上一頁/下一頁），首頁 5–6 項。
- 升級 / 製造類列表（熔爐配方、建築升級）若超過 3 項，優先考慮「Select 選物品 → 確認 Container」兩段式，不要一次塞 N 排按鈕。
- 寧可一次少顯示幾項+加分頁，也不要冒「Discord 直接拒收」的風險。送出前在腦中數一次元件數，超過 35 就要重構。

### 9. 物品 / 配方 / Buff key 一律中文顯示

- 任何送到 UI 的字串（Container 標題、按鈕 label、Select option name、TextDisplay 內容）**不能出現** `building_material`、`mining_cooldown_pct`、`shark`、`treasure_map_fragment` 這類 snake_case key。
- 必須查 config 的中文標籤（如 `guildWarehouse.items.building_material.name === "建材"`、`buffLabels.mining_cooldown_pct === "挖礦冷卻"`、`craft.materials.treasure_map_fragment.name === "藏寶圖碎片"`）。
- 若 key 沒有對應中文標籤，**先加** config / 就近的標籤檔（buff → `src/features/buff/buffLabels.js`、合成材料 → `src/config/craft.json` 的 `materials`）再用。不要直接 fallback 印 key 名。
- customId / log 欄位 / DB 欄位 可以維持英文 key（系統內部），但只要會被玩家看到就一定中文。

#### 名稱轉換最常漏的地方（這類 bug 反覆出現，務必逐項檢查）

- **錯誤 / 例外路徑也要轉**：happy path（成功訊息）通常記得轉中文，但「材料不足／庫存不足／冷卻中」這些失敗訊息常常直接內插原始 key（例：`broken_trap_fragment ×5`）。送出前把**每一條**失敗訊息也走一次名稱表。
- **名稱表只能有一份**：同一種物品的 `materialLabel` / `itemLabel` 不要在 command、view、button handler 各自複製一份——其中一份一定會漏更新而印出英文 id。抽成共用模組（例：合成走 `src/features/mining/craftMaterials.js` 的 `materialLabel`），所有路徑共用。
- **持有量與標籤同源**：顯示「有 X / 需要 Y」時，持有量查詢（`ownedMaterial`）也要跟標籤走同一份來源；特殊材料（碎片）存在 profile 獨立欄位、不在 backpack，讀錯欄位會永遠顯示 0 而誤判為材料不足。
- **新增材料同步網站**：bot 新增可被玩家看到的材料時，同步 `bibi-website` 的 `src/lib/dashboard/botDefs.ts`，否則網站 fallback 成 `(id)`。

### 10. Autocomplete 欄位：顯示字串也要吃得下（複製貼上不能壞）

- 前提：autocomplete 的 `name`（顯示）與 `value`（送出）不同時，玩家一定會複製顯示文字貼回欄位，Discord 會把整串原文原封不動送出。指令層若直接把 `getString()` 當 id 用就必然查無此項（`.trim().toUpperCase()` 不算解析）。
- 所以任何 `setAutocomplete(true)` 的欄位，值在使用前**一律先過 `src/utils/choiceInput.js` 的 `resolveChoice()`**，把「整行顯示字串 / 中文名 / 大小寫 / 全形 / emoji」還原成 `value`。
- **選單清單與輸入解析共用同一份選項來源**：先寫一個 `xxxChoices()` 回傳 `{name, value, search?}[]`，autocomplete 用 `respondChoices()` 過濾它、run() 用 `resolveChoice()` 解析它。兩邊各寫一份比對規則 = 其中一份一定會漏。
- autocomplete 比對必須**雙向**（`respondChoices` 已內建）：除了「選項含輸入」還要「輸入含選項」。玩家貼整行時選單若變 0 筆，他只能硬送出 → 100% 觸發這個 bug。
- 顯示用的尾巴（`（還剩 N 天）`、`｜持有 N 股`、`已下市`）用 `strip` 參數剝掉，讓「只貼名稱」也能完全命中。
- 解析失敗一律用 `buildChoiceErrorContainer()`（`src/utils/choiceErrorContainer.js`）：寫出玩家**實際輸入了什麼** + 列出可選項目 + `-#` 提示。禁止只回「找不到 XXX」。
- 只在下拉選單顯示「可用的」項目，但**解析時要用完整清單**——否則未解鎖 / 沒持有的項目會回「找不到」，而不是「你還沒解鎖 XXX」這種講得清楚的訊息。
- **例外**：`value === name` 的欄位（例：`/天氣 城市`）貼什麼吃什麼，不需要解析器。
- **最危險**：value 是 ObjectId 或內部 key、顯示卻是中文標題的欄位（`/倒數`、`/合成`、`/稱號`、`/event-admin`）——玩家貼上顯示文字時完全無從還原，這種欄位一定要有解析器。

---

## 架構規則

### 新增 slash command

1. 在 `src/commands/<分類>/` 建立檔案，export `{ data, run }`。
2. 設定型參數放 `src/config/<功能>.json`，透過 `src/config/index.js` `...spread` 匯出。
3. 核心邏輯放 `src/features/<功能>/`，指令層只負責呈現，不寫業務邏輯。

### 新增按鈕 handler

1. 在 `src/events/interactionCreate/` 建立 `handle<Feature>Button.js`。
2. 檔案頂部先 `if (!interaction.isButton()) return;` 過濾。
3. customId 格式：`<prefix>_<ownerId>_<payload...>`，prefix 要有唯一性。
4. 一定要做 owner 驗證（見 UX 檢查 #4）。

### DB collection 新增

1. 在 `src/events/ready/connectDb.js` 宣告 collection、掛到 `client`、建索引。
2. `(userId, guildId)` 唯一的 collection 必須建 unique index。
3. 純紀錄類 collection（logs）要建 TTL index（通常 90 天）。

### Buff 新增

所有加成來源統一走 `src/features/buff/buffResolver.js`，不直接在各指令裡散算。
新增 buff 類型時同步更新 `/加成` 指令（`src/commands/mining/buff.js`）的顯示區塊。

#### 加成一律「動態換算」，不准寫死進 DB

加成必須反映玩家**當前狀態**，狀態一變（公會升級/降級、退出公會、buff 到期、稱號/裝備換掉）就要即時跟著變。實作原則：

- **存來源，不存結果**：DB 只存來源狀態（公會等級、建築等級、道具數量、`active_*_buffs` 條目 + `expires_at`），加成值在**顯示 / 使用時**才用 resolver 即時算。
- **禁止在事件當下把加成寫死**：打造、購買、烹飪、加入公會、建築升級…等時機，**不可**把「base ×(1+加成%)」算好塞進 profile 欄位。上限型欄位（`*_max_*`、容量、次數上限）一律存原始 base，加成由讀取端換算（範例：`weapon_max_durability` 存原始上限，`buildingService.effectiveWeaponMaxDurability()` 讀取時才吃鐵匠鋪 %）。
- **紅旗訊號**：只要出現「loop 全公會成員把某個 buff 值寫進每個 profile」的 `sync*` 函式，或把 `1 + pct/100` 乘進 `$set` 欄位，幾乎都是寫死 → 改成 compute-on-read。
- **到期型 buff**：存 `expires_at`，用的時候才判定有效性（比照 `cleanExpiredBuffs` / `isActiveBanquet`），不要靠排程去「清掉」欄位。
- **例外**：真正屬於「某個實體自身狀態」的累積值（如農地施肥累積的 `yield_bonus_pct`）存在該實體上是對的——那不是玩家當前狀態的 buff，不受此規則限制。

---

## 程式碼慣例

- **不加多餘 comment**：只在「為什麼這樣做不明顯」時才寫，不寫「做了什麼」。
- **不做防禦性空轉**：只在 system boundary（使用者輸入、外部 API）驗證，內部流程信任已有的保護。
- **config 驅動**：數值、文案、清單放 JSON，不寫死在程式裡。
- **指令層不含業務邏輯**：run() 只做：取參數 → 呼叫 service → 呈現結果。
- **錯誤處理統一 catch**：每個 run() 最外層包 try/catch，catch 裡 `console.log` + ephemeral 回覆。
- **ContainerBuilder 方法名稱**：`addComponents` 不存在於 ContainerBuilder，正確方法為：
  - ActionRow → `container.addActionRowComponents(new ActionRowBuilder()...)`
  - Section → `container.addSectionComponents(new SectionBuilder()...)`
  - TextDisplay → `container.addTextDisplayComponents(...)`
  - Separator → `container.addSeparatorComponents(...)`
  - `addComponents` 只存在於 ActionRowBuilder 本身（用來加 Button / SelectMenu）。
