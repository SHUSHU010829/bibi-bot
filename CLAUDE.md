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

---

## 程式碼慣例

- **不加多餘 comment**：只在「為什麼這樣做不明顯」時才寫，不寫「做了什麼」。
- **不做防禦性空轉**：只在 system boundary（使用者輸入、外部 API）驗證，內部流程信任已有的保護。
- **config 驅動**：數值、文案、清單放 JSON，不寫死在程式裡。
- **指令層不含業務邏輯**：run() 只做：取參數 → 呼叫 service → 呈現結果。
- **錯誤處理統一 catch**：每個 run() 最外層包 try/catch，catch 裡 `console.log` + ephemeral 回覆。
