# Phase A — 公會系統 詳細企劃書

> 本文件為 `PLAN_INTEGRATED.md` Phase A 的實作級規格書，覆蓋資料模型、流程、UX、檔案結構、開發階段。
> 原 Phase A 條目（PLAN_INTEGRATED.md L204–275）為 outline，本文件為 spec。
>
> 建立日期：2026-06-03
> 預估開發時間：5–7 天

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
| 人數上限 | ⚠️ **隨等級擴張**：Lv1=10 → Lv2=12 → Lv3=15 → Lv4=18 → Lv5=20 | 全程固定 20 |
| 加入流程 | ⚠️ **邀請式**：會長執行 `/公會 邀請 @user`，玩家收到按鈕點擊加入 | 申請式（額外審批 UI） |
| 退出 | 普通成員直接退；會長必須先 `/公會 轉讓` 或 `/公會 解散` | — |
| 會長缺席 | 連續 14 天未上線可由副會長 `/公會 接管`（v2，MVP 不做） | — |
| 解散處理 | ⚠️ Treasury 平分給所有現任成員，公會 doc 標 `disbanded_at`（軟刪除，保留 logs） | 銷毀 / 進系統 |
| 共享 buff 計算 | 由 `buffResolver` 動態讀取使用者的 `guild_club_members` → `guilds_club.level` 即時加成 | 推到 `UserCoins.activeBuffs` |
| Buff 與既有疊加 | ⚠️ **加總**：例如挖礦 luck +5% 與既有 luck 同加成池；qty +1 與 pickaxe qty 累加 | 取最大值 |
| LuckCap | 公會 buff 也吃 `luckCap`（與其他 buff 公平） | 不吃 |
| 任務領取 | ⚠️ **達成自動入帳到金庫**（不需手動 claim），廣播到公告頻道 | 由會長手動 claim |
| 任務統計來源 | 直接 aggregate 既有 logs（`mineLogs`、`dungeonLogs`、`casinoLogs`），不重複寫表 | 新增 `guild_club_quest_progress` |
| 金庫提領 | **不可提領**（防退坑套現） | 可由會長提領 |
| 升級觸發 | 在 donate / quest_reward 等增加金庫的點，原子檢查是否跨門檻，跨越則寫入並廣播 | 排程定期掃描 |
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

### 3.4 `guild_club_invitations` — 邀請（邀請式加入）

```js
{
  guild_club_id:  String,
  guildId:        String,
  invitee_id:     String,
  inviter_id:     String,
  status:         String,       // 'pending' | 'accepted' | 'declined' | 'expired'
  expiresAt:      Date,         // 7 天後過期
  createdAt:      Date,
  respondedAt:    Date|null,
}
```

**索引**：
- `{ invitee_id: 1, guildId: 1, status: 1 }`
- TTL：`{ expiresAt: 1 }` expireAfterSeconds 0（pending 過期自動清）

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

### 5.2 邀請與加入

```
/公會 邀請 @user
  ↓ (僅會長可用)
驗證：被邀請人未屬其他公會 / 公會未滿員 / 沒有 pending 邀請
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
  if newDoc.treasury crosses next threshold:
    findOneAndUpdate guilds_club { level: oldLv } $set { level: newLv, max_members: newMax }
    若成功 → 廣播升級（沿用 BOSS announceChannel）
  ↓
回覆：成功 Container + 快捷按鈕「再捐 1000」「查看公會」
```

> **升級原子性**：用 findOneAndUpdate 並 match 舊 level，確保並發捐款只觸發一次升級廣播。

### 5.4 每週任務

```
/公會 任務（查詢）
  ↓
ephemeral Container:
  weekStart = luxon week start (resetTimezone)
  對每個 weeklyQuests 任務：
    progress = aggregate( source collection, filter: { createdAt >= weekStart, userId IN members } )
    已領取 = guild_club_quest_claims.findOne({ guild_club_id, questId, period })
  顯示 [✅ 已完成 / 🔄 進度 X/Y / 🎁 已領取]
  ↓
自動領取（每次查詢時順手檢查）：
  for each quest with progress >= target AND no claim record:
    insertOne guild_club_quest_claims (unique → 競態 safe)
    若 insert 成功（非 duplicate-key error）：
      $inc treasury + treasury_current
      insert guild_club_logs (source="quest_reward")
      checkLevelUp
      公告：「🏆 公會「XXX」完成週任務「礦業大隊」，金庫 +5000」
```

> **自動領取時機**：MVP 階段「成員查詢任務時順手結算」就夠。後續可加 cron。

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
| `/公會 邀請 [使用者]` | ❌ 公開 | 會長邀請玩家（含按鈕） |
| `/公會 加入 [名稱]` | ❌ 公開 | 直接加入（**若採申請式**才需要） |
| `/公會 退會` | ❌ 公開 | 退出公會 |
| `/公會 解散` | ❌ 公開 | 會長解散（雙確認） |
| `/公會 轉讓 [使用者]` | ❌ 公開 | 轉讓會長 |
| `/公會 踢人 [使用者]` | ❌ 公開 | 會長踢人 |
| `/公會 捐款 [金額]` | ❌ 公開 | 捐款進金庫 |
| `/公會 資訊 [名稱?]` | ✅ Ephemeral | 查看公會詳情（無參數＝查自己的） |
| `/公會 任務` | ✅ Ephemeral | 查看本週任務進度（順手自動結算） |
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
| `gc_invite_accept_<inviteId>_<inviteeId>` | 接受邀請 | `interaction.user.id === inviteeId` |
| `gc_invite_decline_<inviteId>_<inviteeId>` | 婉拒邀請 | 同上 |
| `gc_donate_<userId>_<amount>` | 快捷捐款（資訊頁按鈕） | 同上 |
| `gc_disband_confirm_<leaderId>_<guildClubId>` | 解散二次確認 | `interaction.user.id === leaderId` |
| `gc_disband_cancel_<leaderId>` | 取消解散 | 同上 |
| `gc_kick_<leaderId>_<targetId>` | 踢人 | 同上 |
| `gc_view_<userId>_<guildClubId>` | 從排行進入詳情 | userId（避免 ephemeral 串流給他人） |

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
| `src/features/guild_club/guildClubMembership.js` | 邀請 / 加入 / 退會 / 踢人 / 轉讓 |
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
| `src/events/ready/connectDb.js` | 宣告 5 個 collection + 索引 |
| `src/features/buff/buffResolver.js` | 整合公會 buff（4 處） |
| `src/commands/mining/buff.js` | `/加成` 顯示公會 buff |
| `src/commands/profile/profile.js`（若存在） | 顯示所屬公會 |
| `docs/PLAN_INTEGRATED.md` | 完成後標記 Phase A |

---

## 11. 開發階段拆解

| Day | 任務 | 驗收 |
|---|---|---|
| **D1** | DB 層 + config + service skeleton（建立 / 解散 / 查詢） | 可建立公會、寫進 DB、`/公會 資訊` 看得到 |
| **D2** | 成員管理（邀請、加入、退會、踢人、轉讓） | 完整加入退出 flow，邀請過期可工作 |
| **D3** | 捐款 + 升級觸發 + 廣播 | 跨等級會廣播，並發捐款只觸發一次升級 |
| **D4** | buffResolver 整合 + `/加成` 更新 | 公會 buff 實際影響挖礦/打工結果 |
| **D5** | 週任務 aggregate + 自動領取 + 排行榜 | 任務達標自動入帳，排行正確 |
| **D6** | UX 打磨（錯誤 Container、按鈕、快捷後續、零值收底） | 對照 §9 全綠 |
| **D7** | 測試 + 文件更新 + PLAN_INTEGRATED.md 標完成 | §12 全過 |

---

## 12. 測試計畫

### 12.1 功能測試

- [ ] 建立公會：餘額不足、名稱重複、名稱超長、含禁字、成功
- [ ] 邀請：被邀請者已屬公會、公會已滿、邀請過期、接受、婉拒
- [ ] 退會：普通成員、會長（有成員/單人）、不在公會
- [ ] 解散：treasury 平分整除 / 有餘數的處理、log 寫入
- [ ] 轉讓：對象不在公會、自己轉讓給自己
- [ ] 捐款：金額為 0、負數、超過餘額
- [ ] 升級：跨單一門檻、跨兩個門檻（一次捐 60 萬從 Lv1 → Lv5？預設拒絕？或全升）
- [ ] 任務：剛好達標、超標、跨週重置、同週重複領取（應失敗）
- [ ] Buff：mining qty +1 確實生效、luck cap 不超過、打工 +10% 累乘正確

### 12.2 並發測試

- [ ] 兩人同時捐款跨同一門檻：只觸發一次升級廣播
- [ ] 邀請同一人兩次：第二次應拒絕（pending 已存在）
- [ ] 任務剛好達標時兩人同時查詢：只有一筆 quest_claim 插入成功

### 12.3 UX 測試

- [ ] 錯誤訊息全部為 Container（無純文字）
- [ ] 成員列表的踢出按鈕在對應 Section 內，不在訊息底部
- [ ] 查詢類訊息為 ephemeral
- [ ] 公會 buff 在 `/加成` 正確顯示
- [ ] 0 值 buff 收到底部 `-#` 行

---

## 13. 未決議題

開發前需確認以下決策：

1. **加入流程**：邀請式（推薦，UX 簡潔）vs 申請式（PLAN_INTEGRATED.md 原文）vs 雙軌都做？
2. **人數上限**：隨等級擴張（推薦，給升級多一個誘因）vs 全程 20？
3. **共享 buff 與既有 buff**：加總疊加（推薦，符合「努力越多越強」）vs 取最大值？
4. **任務獎勵**：達標自動入金庫（推薦）vs 由會長手動 claim？
5. **解散金庫**：平分給成員（推薦）vs 銷毀 vs 進系統？
6. 跨多個門檻一次升級：允許（推薦）vs 一次只升一級？

---

> 確認以上議題後即可進入 D1 開發。
