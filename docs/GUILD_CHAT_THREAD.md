# 公會聊天室企劃（Guild Chat Thread）

> 每個公會自動建立一條 Discord 私人討論串作為內部聊天室；新人加入時自動拉進串並 @ 歡迎、退會/被踢自動移出、公會解散自動封存。

---

## 0. 已決定的設計參數

| 項目 | 值 |
|---|---|
| 父頻道 ID | `1511655301953228800`（沿用 `guildClub.announce.channelIdOverride`）|
| 串類型 | **私人討論串**（`ChannelType.PrivateThread`）|
| 自動封存時長 | `1440` 分鐘（1 天）— 平時有訊息就自動延期 |
| 串名稱格式 | `🏛️ {公會名稱}` |
| 串描述（首則 pin） | 公會簡介、成員數、等級 |

private thread 邊界：頻道內成員若沒被加進串 → 看不到串。Bot 需要 `CREATE_PRIVATE_THREADS` + `MANAGE_THREADS` 權限。

---

## 1. 觸發點對照（5 個 hook）

| 事件 | 既有實作位置 | 串動作 |
|---|---|---|
| 創立公會（leader 自動成為成員） | `guildClubService.js:190` insertOne leader | 建串 + add leader + 發歡迎 |
| 邀請接受 | `guildClubMembership.js:151` insertOne member | add member + 發歡迎 |
| 申請被批准 | `guildClubMembership.js:334` insertOne member | add member + 發歡迎 |
| 自願退會 | `guildClubMembership.js:375` deleteOne | thread.members.remove |
| 被踢 | `guildClubMembership.js:417` deleteOne | thread.members.remove + 發告別 |
| 解散公會 | `guildClubService.js:202 / 262` set disbanded_at | 發解散公告 + setArchived(true).setLocked(true) |

---

## 2. Schema

### `guildsClubCollection` doc 新增欄位

```js
{
  chat_thread_id: "1234567890" | null,  // Discord thread ID
  chat_thread_created_at: Date | null,
}
```

舊公會 `chat_thread_id = undefined`，採 lazy 建立（下一次成員加入時順手建）。

---

## 3. 服務模組

新增 `src/features/guild_club/guildClubChat.js`，集中所有 thread 相關邏輯。指令層 / membership 層只呼叫這裡，不直接操作 thread。

```js
// guildClubChat.js（簡化版骨架）

const { ChannelType } = require("discord.js");
const { guildClub } = require("../../config");

const CHAT_AUTO_ARCHIVE = 1440;
const parentChannelId = () =>
  guildClub?.chatThread?.parentChannelId
    || guildClub?.announce?.channelIdOverride
    || null;

// 取得（或 lazy 建立）公會聊天串
async function ensureThread(client, club) {
  if (club.chat_thread_id) {
    const thread = await client.channels.fetch(club.chat_thread_id).catch(() => null);
    if (thread && !thread.archived) return thread;
    if (thread && thread.archived) {
      await thread.setArchived(false).catch(() => {});
      return thread;
    }
    // 串被手動刪除 → 走建立路徑
  }
  return createThread(client, club);
}

async function createThread(client, club) {
  const parentId = parentChannelId();
  if (!parentId) return null;
  const parent = await client.channels.fetch(parentId).catch(() => null);
  if (!parent) return null;

  const thread = await parent.threads.create({
    name: `🏛️ ${club.name}`,
    type: ChannelType.PrivateThread,
    autoArchiveDuration: CHAT_AUTO_ARCHIVE,
    invitable: false, // 只有 manager 能拉人，避免成員私拉外人
    reason: `公會聊天串：${club.name}`,
  }).catch((e) => {
    console.log(`[GUILD_CHAT] 建串失敗：${e.message}`.yellow);
    return null;
  });
  if (!thread) return null;

  await client.guildsClubCollection.updateOne(
    { guild_club_id: club.guild_club_id },
    { $set: { chat_thread_id: thread.id, chat_thread_created_at: new Date() } }
  );

  // pin 介紹訊息
  await thread.send({
    content: `📌 **${club.name}** 公會聊天室\n等級 Lv.${club.level}・最大成員 ${club.max_members}`,
  }).then((m) => m.pin().catch(() => {})).catch(() => {});

  return thread;
}

async function addMemberWithWelcome(client, { club, userId, source }) {
  const thread = await ensureThread(client, club);
  if (!thread) return;
  await thread.members.add(userId).catch(() => {});

  const welcomes = {
    create:  `🎉 公會創立！歡迎會長 <@${userId}> 開拓新天地`,
    invite:  `🎊 <@${userId}> 接受邀請加入公會！這裡是大家聊天的地方，有任何問題都可以提出來～`,
    apply:   `✅ <@${userId}> 通過申請加入公會！這裡是大家聊天的地方，有任何問題都可以提出來～`,
  };
  const msg = welcomes[source] || `👋 <@${userId}> 加入公會！`;
  await thread.send({ content: msg, allowedMentions: { users: [userId] } })
    .catch((e) => console.log(`[GUILD_CHAT] 歡迎失敗：${e.message}`.yellow));
}

async function removeMember(client, { club, userId, reason }) {
  if (!club.chat_thread_id) return;
  const thread = await client.channels.fetch(club.chat_thread_id).catch(() => null);
  if (!thread) return;

  if (reason === "kick") {
    await thread.send({
      content: `👢 <@${userId}> 已被移出公會`,
      allowedMentions: { users: [] }, // 不打擾被踢的人
    }).catch(() => {});
  } else if (reason === "leave") {
    await thread.send({
      content: `🚪 <@${userId}> 離開了公會`,
      allowedMentions: { users: [] },
    }).catch(() => {});
  }
  await thread.members.remove(userId).catch(() => {});
}

async function archiveOnDisband(client, club, reason) {
  if (!club.chat_thread_id) return;
  const thread = await client.channels.fetch(club.chat_thread_id).catch(() => null);
  if (!thread) return;
  await thread.send({
    content: `🔒 公會 **${club.name}** 已解散${reason ? `（${reason}）` : ""}，本聊天室將被封存。`,
  }).catch(() => {});
  await thread.setLocked(true).catch(() => {});
  await thread.setArchived(true).catch(() => {});
}

module.exports = {
  ensureThread,
  addMemberWithWelcome,
  removeMember,
  archiveOnDisband,
};
```

---

## 4. 串接位置（最小改動）

### 4.1 `guildClubService.createClub`（leader 加入時）

在 `guildClubMembersCollection.insertOne` 寫入 leader 後加：

```js
guildClubChat
  .addMemberWithWelcome(client, { club: doc, userId, source: "create" })
  .catch(() => {});
```

非阻塞、catch 全吃 — 建串失敗不該擋公會創建。

### 4.2 `guildClubMembership.acceptInvitation`（成員加入）

在 `guildClubMembersCollection.insertOne` 後（line 151~158 後）加：

```js
guildClubChat
  .addMemberWithWelcome(client, { club, userId, source: "invite" })
  .catch(() => {});
```

### 4.3 `guildClubMembership.respondApplication`（批准申請）

在 `guildClubMembersCollection.insertOne` 後（line 334~341 後）加：

```js
guildClubChat
  .addMemberWithWelcome(client, { club, userId: app.applicant_id, source: "apply" })
  .catch(() => {});
```

### 4.4 `guildClubMembership.leaveClub` / `kickMember`

在 `deleteOne` 之後加：

```js
guildClubChat
  .removeMember(client, { club, userId: targetId, reason: "leave" /* or "kick" */ })
  .catch(() => {});
```

### 4.5 `guildClubService.disbandClub`

在 `set disbanded_at` 之後加：

```js
guildClubChat.archiveOnDisband(client, doc, reason).catch(() => {});
```

---

## 5. Config（`guild_club.json`）

新增區塊（向後相容；不設則 fallback 到 `announce.channelIdOverride`）：

```jsonc
{
  "guildClub": {
    // ...既有
    "chatThread": {
      "enabled": true,
      "parentChannelId": "1511655301953228800",
      "autoArchiveDuration": 1440
    }
  }
}
```

---

## 6. 邊界情況

| 情況 | 處理 |
|---|---|
| Bot 重啟期間有人加入 | DM 通知還是會走（既有），但歡迎訊息會漏。下次加入時的 `ensureThread` 會檢查並修復 |
| 串被管理員手動刪除 | `ensureThread` fetch fail → 走 `createThread` 新建一條，updateOne 蓋舊 ID |
| 串被自動封存（24h 無訊息） | `ensureThread` 偵測到 archived → `setArchived(false)` 解封後使用 |
| Bot 不在父頻道 / 無權限 | createThread return null → 加入流程不阻擋，只記 log |
| 玩家被踢後立刻又申請 | 既有 cooldown 已擋（`rejoinCooldownHours: 48`）|
| 公會改名（如果未來支援） | 一併呼叫 `thread.setName('🏛️ {新名稱}')` — 目前公會不支援改名，先不寫 |
| 同一個玩家短時間內加入兩個不同公會 | 不可能發生（`getMembership` 既有檢查）|

---

## 7. 落地步驟

1. **config**：`guild_club.json` 加 `chatThread` 區塊
2. **service**：新增 `src/features/guild_club/guildClubChat.js`（按 §3 骨架）
3. **5 個 hook 點插入呼叫**（見 §4，全部 catch 包好不阻擋主流程）
4. **schema 補欄位**：不需要 migration，MongoDB schema-less，`chat_thread_id` 預設 null
5. **舊公會 lazy 補建**：第一次有人加入時，`ensureThread` 會自動建並 update doc
6. **測試**：
   - 建公會 → 看到 🏛️ 串、leader 在串裡、有歡迎訊息
   - 邀請接受 / 申請批准 → 新人被加進串、看到 @ 歡迎
   - 退會 / 被踢 → 串裡留下記錄、玩家被移出
   - 解散 → 串被 archive + lock

預估工程量：**約半個工作天**（含測試）。

---

## 8. 不在這份的範圍

- 公會內專屬指令（`/公會 聊天 釘訊息`、`/公會 聊天 設定話題`）→ 改天另開
- 串內的 bot 互動（例：在串裡用按鈕查公會貢獻榜）→ 改天另開
- 公會等級升級時改串名前綴（例：Lv.5 加 ⭐）→ 改天另開

---

是否要我直接照這份實作？目前所有改動都在 `guild_club` 模組內、是 additive、不會影響既有玩家行為。
