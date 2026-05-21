# 🗳️ 通用投票系統使用指南

## 🎯 系統概述

這是一個通用化的投票系統，支援多種預設模板，可以處理伺服器的各種提案投票。系統獨立運作，也可以選擇與 Ticket 系統整合使用。

## ✨ 主要特色

- ✅ **5 種預設模板**：遊戲頻道新增/封存、活動提案、規則修改、一般提案
- ✅ **獨立使用**：不依賴 Ticket，可在任何頻道發起投票
- ✅ **Ticket 整合**：在 Ticket 中使用時自動綁定並通知結果
- ✅ **權重計分**：支援不同選項的權重設定
- ✅ **自動結算**：投票結束自動統計並通知
- ✅ **即時更新**：投票訊息即時顯示當前票數

## 📋 預設模板詳解

### 1. 🎮 遊戲頻道新增 (game_create)

**適用場景：** 成員提議新增遊戲頻道

**投票選項：**
- 🔥 我會玩（權重 3 分）- 核心玩家
- 👍 純支持（權重 1 分）- 觀望者  
- 😶 沒興趣（權重 0 分）- 不計分

**通過條件：**
- 總分 ≥ 15 分
- 核心玩家 ≥ 3 人
- **必須同時滿足**

**使用範例：**
```
/ticket vote create template:遊戲頻道新增 title:Monster Hunter Wilds
```

---

### 2. 📦 遊戲頻道封存 (game_archive)

**適用場景：** 提議封存不活躍的遊戲頻道

**投票選項：**
- ✋ 我還在玩（反對封存）
- 📦 同意封存

**通過條件：**
- 「我還在玩」的人數 ≤ 1 人
- **反向邏輯**：只要有 2 人以上在玩就保留

**使用範例：**
```
/ticket vote create template:遊戲頻道封存 title:Among Us
```

---

### 3. 🎉 活動提案 (event)

**適用場景：** 舉辦伺服器活動、聚會、比賽

**投票選項：**
- 🎉 我會參加（權重 3 分）- 確定參加
- 👀 有興趣（權重 1 分）- 觀望中
- 🚫 沒興趣（權重 0 分）- 不參加

**通過條件：**
- 總分 ≥ 20 分
- 確定參加 ≥ 5 人
- **必須同時滿足**

**使用範例：**
```
/ticket vote create template:活動提案 title:農曆新年線上聚會 description:時間：2月1日晚上8點，活動內容：遊戲、抽獎 duration:48
```

---

### 4. 📜 規則修改 (rule_change)

**適用場景：** 伺服器規則修改、政策變更

**投票選項：**
- ✅ 贊成（權重 1 分）
- ❌ 反對（權重 1 分）

**通過條件：**
- 總投票數 ≥ 10 票
- 贊成票 > 反對票
- **必須同時滿足**

**使用範例：**
```
/ticket vote create template:規則修改 title:允許在聊天頻道分享 Meme description:現行規則禁止在一般聊天分享 Meme，提議開放此限制
```

---

### 5. 💡 一般提案 (general)

**適用場景：** 任何不屬於上述類型的提案

**投票選項：**
- 👍 支持（權重 1 分）
- 👎 反對（權重 0 分）

**通過條件：**
- 支持票 ≥ 10 票

**使用範例：**
```
/ticket vote create template:一般提案 title:增設深夜安靜時段 description:晚上11點後語音頻道降低音量提醒
```

## 🎮 指令使用方式

### 基本指令格式

```
/ticket vote create template:[模板名稱] title:[標題] description:[說明] duration:[時長] channel:[頻道]
```

### 必填參數

- `template`: 選擇投票模板（必填）
  - 🎮 遊戲頻道新增
  - 📦 遊戲頻道封存
  - 🎉 活動提案
  - 📜 規則修改
  - 💡 一般提案

- `title`: 投票標題（必填）
  - 遊戲名稱、活動名稱、規則描述等

### 選填參數

- `description`: 詳細說明（選填）
  - 補充說明、活動細節、規則內容等

- `duration`: 投票時長（選填，預設 24 小時）
  - 單位：小時
  - 範圍：1-168 小時（7 天）

- `channel`: 指定投票頻道（選填）
  - 不指定則使用 config.json 中設定的預設投票頻道

## 💡 使用情境範例

### 情境 1：在任何頻道發起投票

管理員可以在任何頻道直接發起投票：

```
/ticket vote create template:活動提案 title:週末Among Us大賽 description:週六晚上8點，前三名有獎品！ duration:48
```

系統會自動在投票頻道發布，結果公開顯示。

---

### 情境 2：在 Ticket 中發起投票

當使用者在 Ticket 中提出需求時，管理員可以在 Ticket 內發起投票：

1. **使用者**：在 Ticket 中寫「我想新增 Elden Ring 頻道」
2. **管理員**：在同一個 Ticket 中輸入
   ```
   /ticket vote create template:遊戲頻道新增 title:Elden Ring
   ```
3. **系統**：
   - 在投票頻道發布投票
   - 在 Ticket 中顯示投票連結
   - 投票結束後自動通知 Ticket
   - 如果未通過，5 分鐘後自動關閉 Ticket

---

### 情境 3：調整投票時間

對於重要提案，可以延長投票時間：

```
/ticket vote create template:規則修改 title:禁止政治討論 description:是否要在規則中明文禁止政治話題 duration:72
```

投票將持續 72 小時（3 天）。

---

### 情境 4：指定投票頻道

如果想在特定頻道發布投票：

```
/ticket vote create template:一般提案 title:更換伺服器圖示 channel:#公告頻道
```

---

## ⚙️ 設定步驟

### 1. 設定投票頻道 ID

編輯 `src/config.json`：

```json
"voting": {
  "votingChannelId": "YOUR_CHANNEL_ID",  // 改成你的投票頻道 ID
  "defaultDurationHours": 24
}
```

### 2. 調整模板參數（可選）

如果想要調整通過門檻或權重，編輯 `config.json` 中的 `voting.templates`：

```json
"game_create": {
  ...
  "passCondition": {
    "type": "weighted",
    "minTotalScore": 15,    // 調整總分門檻
    "minHighInterest": 3    // 調整最低核心玩家數
  }
}
```

### 3. 重啟 Bot

```bash
npm start
```

## 📊 投票結果判定邏輯

### 權重投票 (weighted)

用於：遊戲頻道新增、活動提案

**計算方式：**
```
總分 = (高意願人數 × 高權重) + (低意願人數 × 低權重)
通過條件 = (總分 ≥ 門檻) AND (高意願人數 ≥ 最小值)
```

**範例：**
- 核心玩家 4 人 (4 × 3 = 12 分)
- 純支持 6 人 (6 × 1 = 6 分)
- 總分 = 18 分
- 判定：18 ≥ 15 ✅ 且 4 ≥ 3 ✅ → **通過**

---

### 反向邏輯 (reverse)

用於：遊戲頻道封存

**判定方式：**
```
通過條件 = 活躍玩家數 ≤ 最大值
```

**範例：**
- 我還在玩：1 人
- 同意封存：15 人
- 判定：1 ≤ 1 ✅ → **封存通過**

---

### 簡單多數決 (majority)

用於：規則修改

**判定方式：**
```
通過條件 = (總票數 ≥ 最小值) AND (贊成票 > 反對票)
```

**範例：**
- 贊成：8 票
- 反對：5 票
- 總票數：13 票
- 判定：13 ≥ 10 ✅ 且 8 > 5 ✅ → **通過**

---

### 簡單支持票 (simple)

用於：一般提案

**判定方式：**
```
通過條件 = 支持票 ≥ 門檻
```

**範例：**
- 支持：12 票
- 反對：3 票
- 判定：12 ≥ 10 ✅ → **通過**

---

## 🔧 進階功能

### 即時票數顯示

當成員投票時，投票訊息會**即時更新**，顯示當前票數和通過門檻。

### 互斥投票

每個使用者在同一個投票中只能選擇一個選項。點擊其他選項會自動更換。

### 自動結算通知

投票結束後：
1. 投票訊息更新為最終結果
2. 移除投票按鈕
3. 如果有綁定 Ticket，自動發送通知
4. 列出所有高意願參與者（如適用）

### Ticket 整合

在 Ticket 中發起的投票會：
- 自動綁定提案人
- 結果自動通知到 Ticket
- 未通過時自動關閉 Ticket
- 通過時列出核心參與者名單

---

## 📝 常見問題

### Q: 如何修改投票權重？

A: 編輯 `config.json` 中對應模板的 `buttons` → `weight` 值。

### Q: 能否建立自訂模板？

A: 可以！參考 `config.json` 中現有模板的格式，添加新的模板配置。

### Q: 投票時間可以更短嗎？

A: 可以，使用 `duration` 參數設定 1-168 小時的任意時長。

### Q: 如何在非 Ticket 頻道使用？

A: 直接在任何頻道使用 `/ticket vote create` 指令即可。

### Q: 可以改變投票嗎？

A: 可以！使用者隨時可以點擊其他選項更改投票。

### Q: 如何查看誰投了什麼票？

A: 目前投票是匿名統計的，只顯示總數。如需查看詳細名單，請聯繫開發者添加功能。

---

## 🆚 與 `/ticket proposal` 的差異

| 功能 | `/ticket proposal` | `/ticket vote` |
|------|--------------------|----------------|
| **模板數量** | 2 種（新增 / 封存） | 5 種模板 |
| **使用限制** | 僅 Ticket 中 | 任何頻道 |
| **自訂時長** | ❌ 固定 24h | ✅ 1-168h |
| **自訂頻道** | ❌ 固定頻道 | ✅ 可指定 |
| **Ticket 整合** | ✅ 必須 | ✅ 可選 |
| **適用場景** | 遊戲頻道管理 | 所有伺服器事務 |

---

## 📂 技術資訊

### 資料庫結構

```javascript
{
  voteId: "unique_id",
  ticketChannelId: "...",      // 可選，有則綁定 Ticket
  proposerId: "user_id",
  title: "投票標題",
  templateKey: "game_create",  // 模板鍵值
  customDescription: "...",    // 自訂說明
  status: "VOTING",            // VOTING, PASSED, FAILED
  messageId: "...",
  channelId: "...",
  guildId: "...",
  votes: {
    high_interest: ["user1", "user2"],
    support: ["user3"],
    no_interest: []
  },
  createdAt: Date,
  expiresAt: Date,
  duration: 24
}
```

### 檔案結構

```
src/
├── commands/ticket/
│   └── ticket.js            # /ticket 主指令（含 setup / close / proposal / suggestion-setup / vote）
├── features/ticket/handlers/
│   ├── vote.js              # /ticket vote 處理邏輯
│   └── proposal.js          # /ticket proposal 處理邏輯
├── events/
│   ├── ready/
│   │   └── voteScheduler.js # 自動結算 cron
│   └── interactionCreate/
│       └── interactionCreate.js # 按鈕互動處理
└── config.json              # 模板配置
```

---

## 🚀 更新日誌

### v2.0.0 (最新版)
- ✅ 新增 5 種投票模板
- ✅ 支援獨立使用（不依賴 Ticket）
- ✅ 可自訂投票時長和頻道
- ✅ 重構為通用化投票系統
- ✅ 保留向後相容性

### v1.0.0
- ✅ 基礎 Ticket 投票整合
- ✅ 遊戲頻道新增/封存功能

---

## 💬 技術支援

如有問題或建議，請聯繫伺服器管理員或查看 Bot 源碼倉庫。
