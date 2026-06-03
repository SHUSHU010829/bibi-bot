# Phase A — 公會系統 詳細企劃書

> 本文件為 `PLAN_INTEGRATED.md` Phase A 的實作級規格書，覆蓋資料模型、流程、UX、檔案結構、開發階段。
> 原 Phase A 條目（PLAN_INTEGRATED.md L204–275）為 outline，本文件為 spec。
>
> 建立日期：2026-06-03
> 完成日期：2026-06-03（D1–D6 全數實作完成）
> 實際開發時間：< 1 天（D1 至 D6 連續開發）
>
> **狀態：✅ 已上線**

---

## 目錄

1. [目標與定位](#1-目標與定位)
2. [設計決策摘要](#2-設計決策摘要)
3. [資料模型](#3-資料模型)
4. [配置檔 `guild_club.json`](#4-配置檔-guild_clubjson)
5. [核心流程](#5-核心流程)
6. [指令清單](#6-指令清單)
7. [按鈕互動設計](#7-按鈕互動設計)
8. [與既有系統整合](#8-與既有系統整合)
9. [UX 檢查清單對照](#9-ux-檢查清單對照)
10. [檔案清單](#10-檔案清單)
11. [開發階段拆解](#11-開發階段拆解)
12. [測試計畫](#12-測試計畫)
13. [未決議題](#13-未決議題)

---

## 1. 目標與定位

| 項目 | 內容 |
|---|---|
| 定位 | 長期留存機制，讓玩家有歸屬感與集體目標 |
| 前置依賴 | Phase 5（拍賣行）✅、Opt-5（buffResolver）✅、grantCoins、questService 模式 |
| 核心循環 | 加入公會 → 捐款累積金庫 → 解鎖共享 buff → 全員一起做週任務 → 拿獎勵再捐款 |
| 主要互動 | 公會內部凝聚、公會間排行較勁、與 BOSS 共鬥形成綜效 |

---

## 2. 設計決策摘要

> 本節列出所有「不只一種合理寫法」的決策，並標註預設選擇。標 ⚠️ 的需使用者確認，見 §13。

| 決策 | 預設選擇 | 備選 |
|---|---|---|
| Discord scope | 每個 Discord 伺服器獨立公會池（`guildId` 為 hard 隔離） | — |
| 公會名稱 | 1–12 字、伺服器內唯一、不可含 `@` `#` `<` `>` ` `` ` | 允許改名（收費） |
| 建立費 | 5,000 幣（從 `UserCoins` 扣，記 `source=guild_create`） | 可改 |
| 人數上限 | **隨等級擴張**：Lv1=10 → Lv2=12 → Lv3=15 → Lv4=18 → Lv5=20 | — |
| 加入流程 | **雙軌制**：A) 會長 `/公會 邀請 @user` 玩家點按鈕接受；B) 玩家 `/公會 申請 [名稱]` 會長從 `/公會 申請列表` 批准 | — |
| 退出 | 普通成員直接退；會長必須先 `/公會 轉讓` 或 `/公會 解散` | — |
| 會長缺席 | 連續 14 天未上線可由副會長 `/公會 接管`（v2，MVP 不做） | — |
| 解散處理 | Treasury 平分給所有現任成員，公會 doc 標 `disbanded_at`（軟刪除，保留 logs） | — |
| 共享 buff 計算 | 由 `buffResolver` 動態讀取使用者的 `guild_club_members` → `guilds_club.level` 即時加成 | 推到 `UserCoins.activeBuffs` |
| Buff 與既有疊加 | **加總疊加**：luck 與其他來源同池加總後吃 luckCap、qty 直接加、收入倍率累乘 | — |
| LuckCap | 公會 luck buff 與其他來源加總後一起吃 `luckCap` | — |
| 任務領取 | **會長手動 `/公會 領獎`**：達標後不會自動入帳，需會長執行領獎指令 | — |
| 任務統計來源 | 直接 aggregate 既有 logs（`mineLogs`、`dungeonLogs`、`casinoLogs`），不重複寫表 | 新增 `guild_club_quest_progress` |
| 金庫提領 | **不可提領**（防退坑套現） | 可由會長提領 |
| 升級觸發 | **一次只升一級**：捐款後檢查單一門檻，跨多門檻則只升一級、剩餘金額繼續累計；廣播時附「一口氣跨越 N 個門檻」紅利文案 | 一次升到底 |
| 公告頻道 | 沿用 BOSS 公告頻道（`guild_club.announceChannelId`，可改） | 各公會自選 |

---

## 3. 資料模型

### 3.1 `guilds_club` — 公會主檔

```js
{
  _id:               ObjectId,
  guild_club_id:     String,    // 自動產生 short id (e.g. "gc_xxxxxx")
  guildId:           String,    // Discord guild
  name:              String,    // 1–12 字
  leader_id:         String,    // userId
  treasury:          Number,    // 累積總額（含領出，僅用於等級判定）
  treasury_current:  Number,    // 目前餘額（升級扣除後）— 等級判定用 `treasury` 累積值
  level:             Number,    // 1–5
  max_members:       Number,    // 依 level 計算後快取
  created_at:        Date,
  disbanded_at:      Date|null, // 軟刪除
  updated_at:        Date,
}
```

> **設計細節**：等級判定用「歷史累積金庫總額」（`treasury`），避免會長領空又重複升級的漏洞。`treasury_current` 顯示用，可在解散時做平分依據。

**索引**：
- `{ guildId: 1, name: 1 }` unique（同伺服器名稱不重複，含已解散則 partial filter）
- `{ guildId: 1, disbanded_at: 1 }`
- `{ guild_club_id: 1 }` unique

### 3.2 `guild_club_members` — 成員資料

```js
{
  guild_club_id:   String,
  userId:          String,
  guildId:         String,
  role:            String,    // 'leader' | 'member'
  joined_at:       Date,
  total_donated:   Number,    // 個人累積捐款（用於個人勳章 / 顯示）
}
```

**索引**：
- `{ userId: 1, guildId: 1 }` unique（一人在同伺服器最多屬於一個公會）
- `{ guild_club_id: 1 }`

### 3.3 `guild_club_logs` — 金庫流水

```js
{
  guild_club_id:  String,
  user_id:        String|null,  // null = 系統入帳（quest_reward）
  amount:         Number,       // 正=入帳 負=支出
  source:         String,       // 'donate' | 'quest_reward' | 'upgrade_cost' | 'disband_payout' | 'create_grant'
  meta:           Object,
  createdAt:      Date,
}
```

**索引**：
- `{ guild_club_id: 1, createdAt: -1 }`
- TTL：`{ createdAt: 1 }` expireAfterSeconds 90 天

### 3.4 `guild_club_invitations` — 邀請（會長 → 玩家）

```js
{
  guild_club_id:  String,
  guildId:        String,
  invitee_id:     String,
  inviter_id:     String,       // 會長 userId
  status:         String,       // 'pending' | 'accepted' | 'declined' | 'expired'
  expiresAt:      Date,         // 7 天後過期
  createdAt:      Date,
  respondedAt:    Date|null,
}
```

**索引**：
- `{ invitee_id: 1, guildId: 1, status: 1 }`
- TTL：`{ expiresAt: 1 }` expireAfterSeconds 0（pending 過期自動清）

### 3.4b `guild_club_applications` — 申請（玩家 → 會長）

```js
{
  guild_club_id:  String,
  guildId:        String,
  applicant_id:   String,       // 申請者 userId
  message:        String|null,  // 可選的申請理由（指令參數）
  status:         String,       // 'pending' | 'approved' | 'rejected' | 'expired'
  expiresAt:      Date,         // 7 天後過期
  createdAt:      Date,
  respondedAt:    Date|null,
  responded_by:   String|null,  // 處理的會長 userId
}
```

**索引**：
- `{ guild_club_id: 1, status: 1, createdAt: -1 }`（會長列出 pending 申請用）
- `{ applicant_id: 1, guildId: 1, status: 1 }`（防止同人重複申請同公會）
- TTL：`{ expiresAt: 1 }` expireAfterSeconds 0

> **防濫申請**：同一玩家對同一公會在 7 天內只能有一筆 pending 申請。被拒絕後 24 小時內不能對同公會再申請（applicant 端 cooldown，service 層檢查）。

### 3.5 `guild_club_quest_claims` — 週任務領取記錄

```js
{
  guild_club_id:  String,
  questId:        String,
  period:         String,     // ISO week "YYYY-Www"
  claimedAt:      Date,
  amount:         Number,
}
```

**索引**：
- `{ guild_club_id: 1, questId: 1, period: 1 }` unique（同公會同任務同週只能領一次）

> **設計細節**：任務「進度」不存表，每次 `/公會 任務` 即時 aggregate 既有 logs。只記錄「已領取」防重複入帳。

---

## 4. 配置檔 `guild_club.json`

```json
{
  "guildClub": {
    "enabled": true,
    "createCost": 5000,
    "name": {
      "minLength": 1,
      "maxLength": 12,
      "forbiddenChars": ["@", "#", "<", ">", "`"]
    },
    "levels": [
      {
        "level": 1,
        "threshold": 0,
        "maxMembers": 10,
        "buffs": []
      },
      {
        "level": 2,
        "threshold": 10000,
        "maxMembers": 12,
        "buffs": [{ "type": "mining_qty_bonus", "value": 1 }]
      },
      {
        "level": 3,
        "threshold": 50000,
        "maxMembers": 15,
        "buffs": [
          { "type": "mining_qty_bonus", "value": 1 },
          { "type": "work_income_multiplier", "value": 0.10 }
        ]
      },
      {
        "level": 4,
        "threshold": 150000,
        "maxMembers": 18,
        "buffs": [
          { "type": "mining_qty_bonus", "value": 1 },
          { "type": "work_income_multiplier", "value": 0.10 },
          { "type": "dungeon_stamina_max", "value": 1 }
        ]
      },
      {
        "level": 5,
        "threshold": 500000,
        "maxMembers": 20,
        "buffs": [
          { "type": "mining_qty_bonus", "value": 1 },
          { "type": "work_income_multiplier", "value": 0.10 },
          { "type": "dungeon_stamina_max", "value": 1 },
          { "type": "mining_luck_pct", "value": 0.05 }
        ]
      }
    ],
    "invitation": {
      "expireHours": 168
    },
    "application": {
      "expireHours": 168,
      "rejectCooldownHours": 24,
      "messageMaxLength": 100
    },
    "weeklyQuests": [
      {
        "id": "guild_mining_squad",
        "name": "礦業大隊",
        "description": "公會成員本週合計挖礦 ≥ 100 次",
        "source": "mineLogs",
        "target": 100,
        "reward": 5000
      },
      {
        "id": "guild_dungeon_team",
        "name": "地下探索隊",
        "description": "公會成員本週合計通關地下城 ≥ 30 次",
        "source": "dungeonLogs",
        "target": 30,
        "reward": 8000
      },
      {
        "id": "guild_casino_league",
        "name": "賭場聯盟",
        "description": "公會成員本週合計賭場 ≥ 50 局",
        "source": "casinoLogs",
        "target": 50,
        "reward": 6000
      }
    ],
    "resetTimezone": "Asia/Taipei",
    "announce": {
      "useBossChannel": true,
      "channelIdOverride": null
    },
    "disband": {
      "treasuryDistribution": "even_split"
    }
  }
}
```

新增到 `src/config/index.js`：
```js
const guildClub = require("./guild_club.json");
module.exports = { ...existing, ...guildClub };
```

---

## 5. 核心流程

### 5.1 建立公會

```
/公會 建立 [名稱]
  ↓
驗證：名稱合法 / 不重複 / 玩家未屬其他公會 / 餘額 ≥ 5000
  ↓
  ├ 失敗 → ContainerBuilder 錯誤訊息（accent 紅，列出原因 + 解決提示）
  └ 成功 →
       transaction-like flow:
       1. grantCoins(amount=-5000, source="guild_create", meta={name})
       2. insert guilds_club (level=1, treasury=0, treasury_current=0)
       3. insert guild_club_members (role="leader")
       4. insert guild_club_logs (source="create_grant", amount=0)
       ↓
       公開訊息：「✅ 公會「XXX」成立！」+ 按鈕「邀請成員」「查看公會」
```

> **原子性**：MongoDB 不開 transaction（社群版可能無 replica set）。改用「先扣幣 → 失敗則退費」的補償邏輯：扣幣成功後 insert，失敗則 grantCoins(+5000, source="guild_create_refund")。

### 5.2 加入流程（雙軌）

#### A. 邀請式（會長主動）

```
/公會 邀請 @user
  ↓ (僅會長可用)
驗證：被邀請人未屬其他公會 / 公會未滿員 / 沒有對該人 pending 邀請
  ↓
insert guild_club_invitations (status="pending", expiresAt=now+7d)
  ↓
公開訊息（含 @user mention）：
  「📨 邀請已送出，@user 請點擊下方按鈕回應」
  按鈕：「✅ 加入」「❌ 婉拒」（customId 含 invitee_id 做 owner 驗證）
  ↓
被邀請人點「加入」：
  原子：findOneAndUpdate invitation status="accepted" + 檢查公會未滿員
  insert guild_club_members
  公告：「🎉 @user 加入了 XXX 公會！」
```

#### B. 申請式（玩家主動）

```
/公會 申請 [名稱] [理由?]
  ↓
驗證：玩家未屬其他公會 / 公會存在且未滿員 / 申請者非 24h 內被該公會拒絕過 /
      無 pending 申請對該公會
  ↓
insert guild_club_applications (status="pending", expiresAt=now+7d)
  ↓
ephemeral 回覆申請者：「✅ 已送出申請。會長批准後會通知你」
  ↓
若公會有 announce 頻道（或預設用 boss 公告頻道）→ 發送會長提示：
  「📬 XXX 公會收到新申請：@user」「使用 /公會 申請列表 處理」
  （此訊息為公開、所有會長若不只一人都看得到——MVP 階段公會只有單一會長）

/公會 申請列表  （僅會長可用）
  ↓
ephemeral Container：
  TextDisplay「📬 待處理申請（N 筆）」
  for each pending application (排序 createdAt asc)：
    Section
      accessory: Button「✅ 批准」customId=gc_app_approve_<leaderId>_<applicationId>
      text: 「@user · 申請於 X 小時前\n> 理由：申請訊息（若有）」
    Section
      accessory: Button「❌ 拒絕」customId=gc_app_reject_<leaderId>_<applicationId>
      text: -# 「拒絕後 24 小時內該玩家不能再申請」
  若無 pending：TextDisplay「目前沒有待處理申請」
  ↓
會長按「批准」：
  原子：findOneAndUpdate application status="approved" WHERE status="pending"
        + 再次檢查公會未滿員、申請者未加入其他公會
  insert guild_club_members
  ephemeral 更新申請列表（移除該筆）
  公告：「🎉 @user 通過申請加入 XXX 公會！」
  （MVP 不主動 DM 申請者；申請者下次 /公會 資訊 即可看到所屬公會）
  
會長按「拒絕」：
  findOneAndUpdate application status="rejected", respondedAt=now, responded_by=leaderId
  ephemeral 更新申請列表（移除該筆）
  不發送公告（保留申請者面子）
```

> **單一會長假設**：MVP 階段公會只有一名會長（無副會長），所以「會長」=「leader_id」。`/公會 申請列表` 直接 `leader_id === userId` 驗證即可。

### 5.3 捐款與升級檢查

```
/公會 捐款 [金額]
  ↓
驗證：屬於某公會 / 餘額足 / 金額 > 0
  ↓
grantCoins(amount=-N, source="guild_donate")
findOneAndUpdate guilds_club $inc { treasury: N, treasury_current: N }, return new doc
更新 guild_club_members total_donated +N
insert guild_club_logs (source="donate")
  ↓
checkLevelUp(newDoc):
  currentLv = newDoc.level
  nextLvDef = levels.find(l => l.level === currentLv + 1)
  if nextLvDef AND newDoc.treasury >= nextLvDef.threshold:
    // 一次只升一級
    findOneAndUpdate guilds_club { _id, level: currentLv } $set { level: currentLv+1, max_members: nextLvDef.maxMembers }
    若成功：
      // 統計這次捐款一口氣跨越幾個門檻（純文案用，不影響實際等級）
      crossedThresholds = levels.filter(l => l.level > currentLv && l.threshold <= newDoc.treasury).length
      廣播升級（沿用 BOSS announceChannel）：
        若 crossedThresholds == 1: 「⬆️ 公會「XXX」升級到 Lv.N！」
        若 crossedThresholds >= 2: 「⚡ 公會「XXX」一口氣跨越 {N} 個門檻！本次升到 Lv.M（剩餘金額將繼續累計升等）」
  ↓
回覆：成功 Container + 快捷按鈕「再捐 1000」「查看公會」
```

> **升級原子性**：用 findOneAndUpdate 並 match 舊 level，確保並發捐款只觸發一次升級廣播。
> **多級門檻策略**：剩餘金額不會「消耗」掉——`treasury` 是累積值，下次任何金庫變動（再捐款、任務領獎）都會再次觸發 `checkLevelUp`，自然升到下一級。等於把多級升等拆成多次廣播事件，每一級都有獨立的儀式感。

### 5.4 每週任務（會長手動領獎）

```
/公會 任務（查詢，任一成員可用）
  ↓
ephemeral Container:
  weekStart = luxon week start (resetTimezone)
  對每個 weeklyQuests 任務：
    progress = aggregate( source collection, filter: { createdAt >= weekStart, userId IN members } )
    claim = guild_club_quest_claims.findOne({ guild_club_id, questId, period })
    狀態判定：
      claim 存在 → 🎁 已領取（X/Y）
      progress >= target → 🏆 可領取（會長執行 /公會 領獎）
      else → 🔄 進度 X/Y
  顯示每個任務一個 Section + （若可領取且使用者是會長）accessory Button「領取 +N 幣」
  ↓
非會長看到「🏆 可領取」 → 附 -# 小字「請會長執行 /公會 領獎」
會長看到「🏆 可領取」 → 直接顯示按鈕（也可走 /公會 領獎 指令）

/公會 領獎  （僅會長可用）
  ↓
驗證：使用者為會長 / 屬於某公會
週次 period = ISO week
ready = []
for each weeklyQuests 任務：
  progress = aggregate(...)
  if progress >= target:
    try insertOne guild_club_quest_claims { guild_club_id, questId, period, claimedAt: now, amount: reward }
    若 insert 成功（非 duplicate-key error）：
      $inc guilds_club.treasury + treasury_current by reward
      insert guild_club_logs (source="quest_reward", amount=reward)
      ready.push(questDef)

if ready.length == 0:
  錯誤 Container：「目前沒有可領取的任務」+ 列出各任務進度
else:
  總額 = sum(ready.reward)
  checkLevelUp(updatedDoc)  // 連續升級可能觸發
  公告：「🏆 公會「XXX」完成 {N} 項週任務：礦業大隊、地下探索隊…，金庫 +{總額}」
  ephemeral 成功 Container + 快捷按鈕「查看公會」
```

> **競態 safe**：`guild_club_quest_claims` 的 unique index `{guild_club_id, questId, period}` 確保同一週同任務只能領一次。
> **進度查詢成本**：MVP 階段每次 `/公會 任務` 即時 aggregate。若實測太慢（>500ms）再加 5 min 快取（in-memory `Map<guildClubId, {ts, data}>`）。

### 5.5 退會 / 解散

```
/公會 退會
  ├ if role="leader" AND members.length > 1:
  │    → 拒絕，提示「請先 /公會 轉讓 或 /公會 解散」
  ├ if role="leader" AND members.length == 1:
  │    → 視為解散
  └ else:
       delete guild_club_members
       公告：「👋 @user 退出 XXX 公會」

/公會 解散（僅會長）
  ↓
雙重確認（按鈕）：「⚠️ 此操作不可逆。剩餘金庫 X 幣將平分給 N 名成員」「確定解散」「取消」
  ↓
payoutPerMember = floor(treasury_current / members.length)
for each member: grantCoins(+payoutPerMember, source="guild_disband_payout")
update guilds_club { disbanded_at: now, treasury_current: 0 }
delete guild_club_members where guild_club_id
公告：「💔 XXX 公會解散，金庫平分」

/公會 轉讓 @newLeader
  ↓
驗證：被轉讓者為公會成員
update guild_club_members 兩筆 role 互換
公開：「👑 會長已轉讓給 @newLeader」
```

### 5.6 共享 buff 整合

修改 `src/features/buff/buffResolver.js`：

```js
// 新增 helper
const getGuildClubBuffs = async (client, userId, guildId) => {
  const member = await client.guildClubMembersCollection.findOne({ userId, guildId });
  if (!member) return { buffs: [], guildClub: null };
  const club = await client.guildsClubCollection.findOne({
    guild_club_id: member.guild_club_id,
    disbanded_at: null,
  });
  if (!club) return { buffs: [], guildClub: null };
  const levelDef = guildClub.levels.find(l => l.level === club.level);
  return { buffs: levelDef?.buffs || [], guildClub: club };
};
```

在 `summary()` / `getMiningResolve()` / `getEffectiveIncomeMultiplier()` 等位置整合：

| Buff type | 整合點 | 計算 |
|---|---|---|
| `mining_qty_bonus` | `getMiningResolve()` 後 `qtyBonus += value` | 加總 |
| `mining_luck_pct` | `getMiningResolve()` 後 `luckBonus += value`（吃 luckCap） | 加總 |
| `work_income_multiplier` | `getEffectiveIncomeMultiplier()` 當 source="work" 時 multiplier *= (1 + value) | 累乘 |
| `dungeon_stamina_max` | 地下城 stamina 計算處（需另查找位置） | 加總 |

並在 `summary()` 回傳新增 `guildClub: { id, name, level, buffs }` 欄位，讓 `/加成` 指令可顯示。

---

## 6. 指令清單

> 全部以 `/公會` 為 root，內部 subcommand。

| 指令 | Ephemeral | 描述 |
|---|---|---|
| `/公會 建立 [名稱]` | ❌ 公開 | 建立公會，扣 5000 幣 |
| `/公會 邀請 [使用者]` | ❌ 公開 | 會長邀請玩家（含接受/婉拒按鈕） |
| `/公會 申請 [名稱] [理由?]` | ✅ Ephemeral | 玩家申請加入指定公會 |
| `/公會 申請列表` | ✅ Ephemeral | 會長查看待處理申請、批准/拒絕 |
| `/公會 退會` | ❌ 公開 | 退出公會 |
| `/公會 解散` | ❌ 公開 | 會長解散（雙確認） |
| `/公會 轉讓 [使用者]` | ❌ 公開 | 轉讓會長 |
| `/公會 踢人 [使用者]` | ❌ 公開 | 會長踢人 |
| `/公會 捐款 [金額]` | ❌ 公開 | 捐款進金庫 |
| `/公會 資訊 [名稱?]` | ✅ Ephemeral | 查看公會詳情（無參數＝查自己的） |
| `/公會 任務` | ✅ Ephemeral | 查看本週任務進度 |
| `/公會 領獎` | ❌ 公開 | 會長一次領取所有達標任務獎勵入金庫 |
| `/公會 排行` | ✅ Ephemeral | 全伺服器公會金庫排行 |

> 對 UX 檢查 #7：查詢類 ephemeral、行動類公開。✅

### 6.1 `/公會 資訊` 視覺結構

```
ContainerBuilder (accent=金色)
├─ TextDisplay: 「🏰 公會「XXX」  Lv.3」
├─ Separator
├─ TextDisplay: 「會長：@leader   成員：7/15」
├─ TextDisplay: 「金庫：50,000 / 150,000（下一級）」
├─ Separator
├─ TextDisplay: 「**共享 Buff**\n挖礦 qty +1\n打工收入 +10%」
├─ Separator
├─ TextDisplay: 「**成員列表**」
├─ Section（每名成員）
│    accessory: Button「踢出」（僅會長可見＋使用）
│    text: 「@user · 捐款 3,200 幣 · 加入 5/28」
├─ Separator
└─ ActionRow: [捐款 1000][捐款 5000][查看任務]
```

> 對 UX 檢查 #1：成員的「踢出」按鈕緊靠該成員所在 Section。✅

### 6.2 `/公會 排行` 視覺結構

```
ContainerBuilder (accent=金色)
├─ TextDisplay: 「🏆 公會排行榜（依金庫累積）」
├─ Separator
├─ Section × top 10
│    accessory: Button「查看詳情」（→ open /公會 資訊 同樣 ephemeral）
│    text: 「#1 XXX · Lv.5 · 累積 520,000 幣 · 18 人」
└─ Separator
```

---

## 7. 按鈕互動設計

新增 `src/events/interactionCreate/handleGuildClubButton.js`。

| customId 格式 | 觸發 | Owner 驗證 |
|---|---|---|
| `gc_invite_accept_<inviteeId>_<inviteId>` | 接受邀請 | `interaction.user.id === inviteeId` |
| `gc_invite_decline_<inviteeId>_<inviteId>` | 婉拒邀請 | 同上 |
| `gc_app_approve_<leaderId>_<applicationId>` | 批准申請（會長） | `interaction.user.id === leaderId` |
| `gc_app_reject_<leaderId>_<applicationId>` | 拒絕申請（會長） | 同上 |
| `gc_donate_<userId>_<amount>` | 快捷捐款（資訊頁按鈕） | `interaction.user.id === userId` |
| `gc_quest_claim_<leaderId>` | 從任務頁直接領獎 | `interaction.user.id === leaderId` |
| `gc_disband_confirm_<leaderId>_<guildClubId>` | 解散二次確認 | `interaction.user.id === leaderId` |
| `gc_disband_cancel_<leaderId>` | 取消解散 | 同上 |
| `gc_kick_<leaderId>_<targetId>` | 踢人 | 同上 |
| `gc_view_<userId>_<guildClubId>` | 從排行進入詳情 | `interaction.user.id === userId`（避免 ephemeral 串流給他人） |

> 對 UX 檢查 #4：每個按鈕都做 owner 驗證。✅

---

## 8. 與既有系統整合

| 接點 | 整合方式 |
|---|---|
| **buffResolver** | 新增 `getGuildClubBuffs()`，在 `summary()` / mining resolve / income multiplier 三處加總 |
| **/加成 指令** | `src/commands/mining/buff.js` 新增公會 buff 區塊（讀 `summary().guildClub`） |
| **grantCoins** | 新增 sources：`guild_create`、`guild_create_refund`、`guild_donate`、`guild_disband_payout`、`guild_quest_reward`（在 `grantSourceFor` 註冊不需要——guild_donate 是負數扣幣，走 grantCoins(amount<0) 即可） |
| **mineLogs / dungeonLogs / casinoLogs** | aggregate 讀取做週任務統計，不寫新資料 |
| **questService** | 不複用（不同 scope），但**沿用 `periodKey` 邏輯**：複製 `kkkk-'W'WW` 格式 + `Asia/Taipei` |
| **BOSS 公告頻道** | 公會升級 / 任務達成廣播沿用 boss announce channel，若沒設定才用 `channelIdOverride` |
| **`/profile` 指令** | 個人資料新增「所屬公會」一行 |

### 8.1 connectDb.js 需新增

```js
// L100+ 區段宣告
const guildsClubCollection = database.collection("guilds_club");
const guildClubMembersCollection = database.collection("guild_club_members");
const guildClubLogsCollection = database.collection("guild_club_logs");
const guildClubInvitationsCollection = database.collection("guild_club_invitations");
const guildClubQuestClaimsCollection = database.collection("guild_club_quest_claims");

// L205+ 區段掛 client
client.guildsClubCollection = guildsClubCollection;
client.guildClubMembersCollection = guildClubMembersCollection;
client.guildClubLogsCollection = guildClubLogsCollection;
client.guildClubInvitationsCollection = guildClubInvitationsCollection;
client.guildClubQuestClaimsCollection = guildClubQuestClaimsCollection;

// L300+ 區段建索引（見 §3）
```

---

## 9. UX 檢查清單對照

| UX 規則 | 落實點 |
|---|---|
| #1 按鈕緊靠對應項目 | 成員列表用 Section + accessory Button（踢出 / 查看），排行榜用 Section + Button（查看詳情） |
| #2 錯誤訊息用 Container | 「名稱已存在」「餘額不足」「人數已滿」「未屬公會」「邀請已過期」一律 accent 紅 Container + Separator + -# 解決提示 |
| #3 成功訊息附快捷後續 | 建立成功 → [邀請成員][查看公會]；捐款成功 → [再捐 1000][查看任務]；加入成功 → [查看公會] |
| #4 按鈕 owner 驗證 | 所有 customId 含 ownerId，handler 第一步驗證（見 §7） |
| #5 零值項目策略 | 公會 buff 列表中 0 值 buff 收到底部 `-# 尚無：地下城體力上限`（Lv5 以下時部分 buff 未解鎖） |
| #6 解鎖錯誤訊息格式 | 公會未升到 Lv3 → 「🔒 打工收入 +10% 尚未解鎖！解鎖條件：公會 Lv.3（累積金庫 50,000）目前：Lv.2・累積 12,500」 |
| #7 Ephemeral 一致性 | 表 §6 |

---

## 10. 檔案清單

### 10.1 新增

| 檔案 | 內容 |
|---|---|
| `src/config/guild_club.json` | 等級、buff、任務、名稱規則 |
| `src/features/guild_club/guildClubService.js` | 建立 / 解散 / 升級檢查 |
| `src/features/guild_club/guildClubMembership.js` | 邀請 / 申請 / 加入 / 退會 / 踢人 / 轉讓 |
| `src/features/guild_club/guildClubDonation.js` | 捐款邏輯 + 升級觸發 |
| `src/features/guild_club/guildClubQuest.js` | 週任務 aggregate + 自動領取 |
| `src/features/guild_club/guildClubBuff.js` | 提供給 buffResolver 的 helper |
| `src/features/guild_club/guildClubView.js` | 所有 ContainerBuilder 視圖（資訊 / 排行 / 錯誤） |
| `src/features/guild_club/guildClubAnnouncer.js` | 升級 / 任務 / 解散廣播 |
| `src/commands/guild_club/guild.js` | `/公會` 指令群（subcommand dispatcher） |
| `src/events/interactionCreate/handleGuildClubButton.js` | 全部按鈕 handler |

### 10.2 修改

| 檔案 | 修改內容 |
|---|---|
| `src/config/index.js` | spread `guild_club.json` |
| `src/events/ready/connectDb.js` | 宣告 6 個 collection + 索引 |
| `src/features/buff/buffResolver.js` | 整合公會 buff（4 處） |
| `src/commands/mining/buff.js` | `/加成` 顯示公會 buff |
| `src/commands/profile/profile.js`（若存在） | 顯示所屬公會 |
| `docs/PLAN_INTEGRATED.md` | 完成後標記 Phase A |

---

## 11. 開發階段拆解

| Day | 任務 | 驗收 |
|---|---|---|
| **D1** | DB 層 + config + service skeleton（建立 / 解散 / 查詢） | 可建立公會、寫進 DB、`/公會 資訊` 看得到 |
| **D2** | 成員管理（邀請、申請、申請列表、退會、踢人、轉讓） | 雙軌加入完整可走、邀請/申請過期 TTL 生效、24h cooldown 生效 |
| **D3** | 捐款 + 升級觸發 + 廣播 | 跨等級會廣播，並發捐款只觸發一次升級 |
| **D4** | buffResolver 整合 + `/加成` 更新 | 公會 buff 實際影響挖礦/打工結果 |
| **D5** | 週任務 aggregate + 會長手動 `/公會 領獎` + 排行榜 | 達標需會長領、unique index 防重複領、排行正確 |
| **D6** | UX 打磨（錯誤 Container、按鈕、快捷後續、零值收底） | 對照 §9 全綠 |
| **D7** | 測試 + 文件更新 + PLAN_INTEGRATED.md 標完成 | §12 全過 |

---

## 12. 測試計畫

### 12.1 功能測試

- [ ] 建立公會：餘額不足、名稱重複、名稱超長、含禁字、成功
- [ ] 邀請：被邀請者已屬公會、公會已滿、邀請過期、接受、婉拒
- [ ] 申請：玩家已屬公會、公會已滿、24h 內被同公會拒絕過、重複申請同公會、批准、拒絕、過期
- [ ] 退會：普通成員、會長（有成員/單人）、不在公會
- [ ] 解散：treasury 平分整除 / 有餘數的處理、log 寫入
- [ ] 轉讓：對象不在公會、自己轉讓給自己
- [ ] 捐款：金額為 0、負數、超過餘額
- [ ] 升級：跨單一門檻廣播一次升一級、一次跨多門檻廣播附「跨越 N 個門檻」紅利文案、後續事件繼續升下一級
- [ ] 任務：剛好達標、超標、跨週重置、會長 /公會 領獎、非會長無法領、同週重複領取（應失敗）、無任何任務達標時的錯誤訊息
- [ ] Buff：mining qty +1 確實生效、luck cap 不超過、打工 +10% 累乘正確

### 12.2 並發測試

- [ ] 兩人同時捐款跨同一門檻：只觸發一次升級廣播
- [ ] 邀請同一人兩次：第二次應拒絕（pending 已存在）
- [ ] 兩名會員同時送出對同公會的申請：兩筆都成立（不同 applicant），但同 applicant 二次申請應失敗
- [ ] 會長同時點兩次「批准」：只有一筆 application 從 pending → approved，member 不重複插入

### 12.3 UX 測試

- [ ] 錯誤訊息全部為 Container（無純文字）
- [ ] 成員列表的踢出按鈕在對應 Section 內，不在訊息底部
- [ ] 查詢類訊息為 ephemeral
- [ ] 公會 buff 在 `/加成` 正確顯示
- [ ] 0 值 buff 收到底部 `-#` 行

---

## 13. 已確認決策摘要（2026-06-03）

| 決策 | 結論 |
|---|---|
| 加入流程 | **雙軌制**：邀請（會長主動）+ 申請（玩家主動，會長批准） |
| 人數上限 | 隨等級擴張 Lv1=10 → Lv5=20 |
| 解散金庫 | 平分給現任成員 |
| 共享 buff 疊加 | 加總疊加，luck 與其他來源同池吃 luckCap |
| 任務獎勵 | 會長手動 `/公會 領獎`（達標不自動入帳） |
| 跨多級升等 | 一次升一級；廣播時若一口氣跨多門檻附「跨越 N 個門檻」紅利文案 |

---

## 14. 實作交付摘要（2026-06-03）

### 14.1 新增檔案

| 檔案 | 用途 |
|---|---|
| `src/config/guild_club.json` | 等級表、buff 清單、邀請/申請、週任務、廣播頻道設定 |
| `src/features/guild_club/guildClubService.js` | 建立、解散、捐款、升級檢查（含原子並發保護） |
| `src/features/guild_club/guildClubMembership.js` | 邀請、申請、批准/拒絕、退會、踢人、轉讓 |
| `src/features/guild_club/guildClubQuest.js` | 週任務 aggregate / 領獎 / 排行榜 |
| `src/features/guild_club/guildClubAnnouncer.js` | 升級 / 任務 / 解散廣播 |
| `src/features/guild_club/guildClubView.js` | 14 個 Container builder |
| `src/commands/guild_club/guild.js` | `/公會` 13 個 subcommand |
| `src/events/interactionCreate/handleGuildClubButton.js` | 11 個按鈕分支 |

### 14.2 修改檔案

| 檔案 | 變更 |
|---|---|
| `src/config/index.js` | spread `guild_club.json` |
| `src/events/ready/connectDb.js` | 6 個 collection 宣告 + 11 條索引（含 partial unique、TTL） |
| `src/features/economy/grantCoins.js` | 新增 4 個 source、`source === "work"` 時套用公會打工加成 |
| `src/features/buff/buffResolver.js` | `getGuildClubBuffs` helper + 整合進 `getMiningResolve` / `getEffectiveIncomeMultiplier` / `summary` |
| `src/commands/mining/buff.js` | `/狀態` 新增公會 buff 區塊 |

### 14.3 完整指令清單

| 指令 | 範圍 | 說明 |
|---|---|---|
| `/公會 建立 [名稱]` | 公開 | 扣 5000 幣建立公會 |
| `/公會 邀請 [使用者]` | 公開 | 會長邀請玩家（含接受/婉拒按鈕） |
| `/公會 申請 [名稱] [理由?]` | Ephemeral | 玩家主動申請加入（24h 拒絕冷卻） |
| `/公會 申請列表` | Ephemeral | 會長查看 pending 申請，inline 批准/拒絕 |
| `/公會 退會` | 公開 | 退出公會（會長須先轉讓或解散） |
| `/公會 解散` | 公開 | 會長解散（雙確認，金庫平分給成員） |
| `/公會 轉讓 [使用者]` | 公開 | 會長身分轉移 |
| `/公會 踢人 [使用者]` | 公開 | 會長踢出成員 |
| `/公會 捐款 [金額]` | 公開 | 捐款進金庫，附「再捐 1000」/「查看公會」按鈕 |
| `/公會 資訊 [名稱?]` | Ephemeral | 公會詳情；會長視角每位成員配「踢出」按鈕 |
| `/公會 任務` | Ephemeral | 週任務進度，會長可從這裡一鍵領獎 |
| `/公會 領獎` | 公開 | 一鍵領取所有達標任務獎勵入金庫 |
| `/公會 排行` | Ephemeral | 排行榜，每筆配「查看」按鈕 |

### 14.4 完整按鈕清單

| customId 格式 | 觸發 | Owner |
|---|---|---|
| `gc_disband_confirm_<leaderId>_<guildClubId>` | 確定解散 | leader |
| `gc_disband_cancel_<leaderId>` | 取消解散 | leader |
| `gc_invite_accept_<inviteeId>_<invitationId>` | 接受邀請 | invitee |
| `gc_invite_decline_<inviteeId>_<invitationId>` | 婉拒邀請 | invitee |
| `gc_app_approve_<leaderId>_<applicationId>` | 批准申請 | leader |
| `gc_app_reject_<leaderId>_<applicationId>` | 拒絕申請 | leader |
| `gc_donate_<userId>_<amount>` | 快捷再捐款 | user |
| `gc_view_<userId>` | 查看自己的公會 | user |
| `gc_view_club_<userId>_<guildClubId>` | 從排行榜查看任一公會 | user |
| `gc_rank_<userId>` | 從領獎成功跳到排行榜 | user |
| `gc_quest_claim_<leaderId>` | 一鍵領取週任務獎勵 | leader |
| `gc_kick_<leaderId>_<targetId>` | 從資訊面板踢人（ephemeral 靜默） | leader |

### 14.5 共享 Buff 實際生效情況

| Buff 類型 | 整合位置 | 生效 |
|---|---|---|
| `mining_qty_bonus` | `buffResolver.getMiningResolve()` → 加到 `qtyBonus` | ✅ 即時生效於挖礦 |
| `mining_luck_pct` | `buffResolver.getMiningResolve()` → 加到 `luckBonus`（luckCap 外） | ✅ 即時生效於挖礦 |
| `work_income_multiplier` | `grantCoins.js` source=`work` 時累乘 | ✅ 即時生效於打工 |
| `dungeon_stamina_max` | `staminaMax(member, club)` 接受公會 doc + 各 async 呼叫端先 `getMemberClub` 再 pass | ✅ 即時生效於地下城 / BOSS / 農場防禦 / 體力藥水購買 |

### 14.6 後續工作（v2）

- 會長缺席接管機制（連續 14 天未上線可由副會長接管）
- 改名功能（收費）
- 副會長 / 成員角色細分

