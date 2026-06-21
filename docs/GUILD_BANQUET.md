# 公會宴會企劃（Guild Banquet）

> 農膳坊 Lv.5 滿級後解鎖的公會級活動。把農膳坊從「個人 buff 來源」升級成「公會集體事件」，創造高階作物與高階魚的長期 sink，並呼應 `guildClub.weeklyQuests` 的團隊節奏。
>
> 對齊現有 `guild_warehouse.json`、`guild_club.json`、`fishing.json`、`farming.json`、`buffResolver.js`、`guildClubAnnouncer.js`。

---

## 0. 基準資料對照

### 倉庫容量（`guild_warehouse.json`）

| 作物 / 魚 | capacityDefault | 單價 |
|---|---|---|
| 紅蘿蔔 | 300 | 65 |
| 玉米 | 150 | 175 |
| 草莓 | 80 | 450 |
| 黑玫瑰 | 25 | 1350 |
| 鯊魚 | 300 | 60 |
| 章魚 | 100 | 150 |
| 熔岩魚 | 25 | 600 |

宴會材料設計原則：**單次宴會消耗 ≈ 倉容 1/3**，挑戰但不會把倉清空，公會還有得周轉。

### 公會升級 threshold（`guild_club.json`）

| Lv | threshold |
|---|---|
| 4 | 150,000 |
| 5 | 500,000 |

### 現有食物 buff 結構（`cookService.js` line 8~13）

```js
// miningProfiles.active_food_buffs：
//   { type, value, expires_at, uses_left }
//   type: "work_income" | "dungeon_atk" | "mine_luck" | "all_boost" | "fish_fortune" | ...
```

宴會 buff 走「公會層」而不是「個人層」（理由見 §3.2），但 buff 類型沿用既有 type 系統，避免再造一輪 hook。

### 公告頻道（`guildClubAnnouncer.js`）

已有 `announce.channelIdOverride` / `boss.announceChannelId` 走 BossChannel 廣播。宴會開席/結束直接沿用同一條。

---

## 1. 觸發與限制

### 1.1 解鎖門檻

- 公會等級 ≥ Lv.4（與鐵匠鋪同層；宴會本身不解鎖戰鬥能力，安排在這層合理）
- 農膳坊建築等級 = **Lv.5**（必須滿級才解鎖宴會 — 給玩家明確的「升滿農膳坊」目標）
- 兩個條件**同時滿足**才能在 `/公會建築` 看到「召集宴會」按鈕

### 1.2 發起者權限

- 必須是 `guildClubService.isManager(membership.role) === true`（幹部以上）
- 與「升級建築」「設定倉庫參數」同權限級

### 1.3 冷卻

- 每公會 **24 小時** 一次（在 `guildsClub` doc 加 `last_banquet_at`）
- 同一公會正在進行中的宴會（`active_banquet.expires_at > now`）不可重新發起
- 冷卻時間採絕對時間戳，避免重開機洗冷卻

### 1.4 取消／中斷

- 宴會一旦開始就**不可取消**，材料不退回（避免被當鎖倉手段）
- 公會解散時若有 active_banquet，buff 過期前依然生效（避免解散當刻全員 buff 消失）

---

## 2. 菜單設計（三道，初版）

每道菜對應一條 buff 路徑，玩家依公會風格選擇。所有材料從 **公會倉庫**（`guildClubWarehouseCollection`）扣除，不是個人背包。

### 2.1 豐年宴（farming-focused, 入門）

| 項目 | 值 |
|---|---|
| 材料 | 紅蘿蔔 ×80、玉米 ×40、章魚 ×30 |
| 倉容佔比 | 27% / 27% / 30% |
| buff | `work_income` +0.20、`harvest_coin_pct` +10 |
| 時效 | 1 小時 |
| 文案 | 「公會宴席滿桌時鮮，今晚打工的兄弟姐妹手感特別好」 |

**設計邏輯**：低階消耗、生活線玩家全吃到。`work_income` +20% 是公會幹部都熟悉的數值（食物 `fish_bento` 已是 +25%），不會比個人食物強。

### 2.2 海陸雙拼（combat-focused, 中階）

| 項目 | 值 |
|---|---|
| 材料 | 草莓 ×25、鯊魚 ×100、煤炭 ×50 |
| 倉容佔比 | 31% / 33% / — |
| buff | `dungeon_atk` +30、`dungeon_def` +15 |
| 時效 | 2 小時 |
| 文案 | 「公會主廚親自掌勺，今晚下副本的兄弟刀刀致命」 |

**設計邏輯**：中量級消耗，主打副本團。`dungeon_atk` +30 比個人 `shark_noodle` 煤炭版（+35）略低一點，因為宴會涵蓋全公會 + 2 小時長效，不能比個人版強。

### 2.3 黑玫瑰盛宴（all-boost, 終極）

| 項目 | 值 |
|---|---|
| 材料 | 黑玫瑰 ×10、熔岩魚 ×10、鋼錠 ×5 |
| 倉容佔比 | 40% / 40% / — |
| buff | `all_boost` +0.10 |
| 時效 | 90 分鐘 |
| 文案 | 「黑玫瑰熬煮的高湯與熔岩魚的烈焰精華，全公會今晚天時地利人和」 |

**設計邏輯**：高階消耗（黑玫瑰 10 = 一週 7~10 株自然種植量），`all_boost` 0.10 套到 mine_luck / work / dungeon_atk / dungeon_def / dungeon_hp_max 全部 +10% 等比加成。比個人 `lava_hotpot` 煤炭版（0.20、90 分鐘）一半強度 — 因為這是「全公會 ×20 人 ×90 分」的廣播 buff，合理性夠。

---

## 3. 實作架構

### 3.1 新 collection 還是放在現有 doc？

**放在 `guildsClubCollection` 的 doc**，新增兩個欄位：

```js
{
  // ...既有欄位
  active_banquet: {
    menu_id: "harvest_feast" | "surf_and_turf" | "black_rose_grand",
    buffs: [{ type: "work_income", value: 0.20 }, ...],
    started_at: 1718000000000,
    expires_at: 1718003600000,
    started_by_user_id: "123456789",
  } | null,
  last_banquet_at: 1717900000000,
}
```

不另開 collection 的理由：宴會是 club-level 短時態，跟著 club 生命週期，沒有跨 club 查詢需求。讀寫頻率低（一公會每 24h 一次），不需要獨立索引。

### 3.2 buff 套用方式 — 寫公會 doc 而非每人 profile

**選 club doc 路線**，理由：

1. 公會中途加入的成員自動吃到剩下時間 → 招新友善
2. 公會中途退出的成員自動失去 buff → 不會帶 buff 跑去別公會躺
3. 不需要 batch 寫入 ~20 個 profile，I/O 一次搞定
4. buff 過期由 `buffResolver` 讀取時直接判斷 `expires_at > now`，不需要排程清掃

代價：`buffResolver.getGuildClubBuffs()` 要多讀一段 `active_banquet`。這是輕量操作（同一 doc）。

### 3.3 buff 串接（`buffResolver.js`）

在 `getGuildClubBuffs` 既有的「公會等級 buff + 建築 buff」彙整後再加一段：

```js
// 公會宴會 buff（時效類）
const banquet = club.active_banquet;
if (banquet && banquet.expires_at > Date.now()) {
  for (const b of banquet.buffs || []) {
    buffsByType[b.type] = (buffsByType[b.type] || 0) + (b.value || 0);
  }
}
```

下游的所有 buff 套用（atk/def/mine_luck/work_income 等）**完全不用改**，因為它們已經吃 `buffsByType`。這是把宴會插進系統最低成本的位置。

### 3.4 材料扣除流程（`banquetService.startBanquet`）

```
1. 檢查發起者 isManager
2. 檢查農膳坊 Lv.5、公會 Lv.4
3. 檢查 last_banquet_at + 24h 已過
4. 檢查 active_banquet 為 null 或已過期
5. 對 menu.materials 每項：
   - 從 guildClubWarehouseCollection 查 available_qty
   - 若任一不足 → 回 { ok: false, reason: "insufficient", missing }
6. 一次性原子扣除（$inc 多 row、用 session.withTransaction 包起來）
7. 寫 active_banquet + last_banquet_at 到 club doc
8. announce 到 boss channel：誰開、什麼菜、buff、何時結束
9. 寫 banquetLogs 記錄（TTL 90 天）
```

材料不足訊息要走 CLAUDE.md UX #2：用 ContainerBuilder，列出每項「需要 X 有 Y」，並提示「-# 可在 `/公會倉庫` 查看當前庫存」。

### 3.5 公告（沿用 `guildClubAnnouncer.js`）

```js
async function announceBanquetStart(client, { club, menu, banquet, starterTag }) {
  const ch = await getAnnounceChannel(client);
  if (!ch) return;
  await ch.send({
    content:
      `🍽️ **${club.name}** 召開宴席！\n` +
      `主廚：${starterTag}\n` +
      `菜色：**${menu.name}**\n` +
      `效果：${formatBuffs(banquet.buffs)}\n` +
      `席間至 <t:${Math.floor(banquet.expires_at / 1000)}:R>`,
  });
}
```

席終再廣播一次（可由 cron 30 分鐘掃一次過期的宴會發結束公告），不強制必要。

### 3.6 新增 buff key（`buffLabels.js`）

宴會本身不引入新 buff type — 全部走既有的 `work_income`、`dungeon_atk`、`dungeon_def`、`all_boost`、`harvest_coin_pct`（後者來自農膳坊企劃）。**唯一要做的是在 `/加成` summary 顯示「公會宴會」這條來源**，讓玩家看得到剩餘時間。

### 3.7 UI（`/公會建築` 加按鈕）

農膳坊 Lv.5 已滿級的 Section 下方加：

- 「🍽️ 召集宴會」按鈕（manager 才顯示，非 manager 灰色 disabled）
- 點下去進入 menu 選擇（Container + StringSelect，三道菜為 options）
- 選完顯示確認 Container（菜名 / 材料消耗 / 倉庫餘量 / 預期 buff）→ 「確認召集」按鈕
- 中途返回不扣材料

依 CLAUDE.md UX #2/#8：用 ContainerBuilder + StringSelect，元件數確保 ≤ 35。

---

## 4. 數值平衡複核

### 4.1 與個人食物 buff 比較

| buff 類型 | 個人最強食物（煤炭版） | 宴會最強菜色 |
|---|---|---|
| work_income | `fish_bento` +0.35（4 次） | 豐年宴 +0.20（1h ×全公會） |
| dungeon_atk | `shark_noodle` +35（4h） | 海陸雙拼 +30（2h ×全公會） |
| all_boost | `lava_hotpot` +0.20（90m） | 黑玫瑰盛宴 +0.10（90m ×全公會） |

宴會單值都 **比個人最強版略低**，但廣播給 18~20 人 → 公會總價值高、個人並未取代食物（兩者可疊）。

### 4.2 與宴會材料的對等收益（黑玫瑰盛宴範例）

材料市值（用倉庫單價計）：
- 黑玫瑰 10 × 1350 = 13,500
- 熔岩魚 10 × 600 = 6,000
- 鋼錠 5 ≈ 後期材料無直接市價，但生產成本 = 100 鐵 + 50 煤
- 合計沉沒成本：**~19,500 幣 + 100 鐵 + 50 煤**

每人收益估計（90 分鐘 `all_boost` +10%）：
- 假設成員 90 分鐘平均做：5 次副本、3 次打工、2 次釣魚
- ATK +10% 在副本傷害公式中換算約多 1~2 場副本通關機會
- 打工 +10% × 3 ≈ 多 1500~3000 幣 / 人
- 礦運 +10% 隱性收益約 500 幣 / 人
- 18 人 × ~3000 幣 = 54,000 幣公會總收益

**ROI ≈ 2.7×**。可接受 — 是團隊事件而不是賺錢機器。

### 4.3 冷卻設計

24h 冷卻 → 每週最多 7 次宴會 → 一週最高消耗：
- 紅蘿蔔 560、玉米 280（豐年宴 ×7） — 公會倉容 1.9 倍 / 1.9 倍
- 高階盛宴只能週 7 次黑玫瑰 70 株 — 黑玫瑰自然種植產出（每人滿地 8 × 1 株 / 24h × 18 人 = 144 株 / 24h，但實務上沒人會把所有地都種黑玫瑰）

冷卻不會餓死公會倉，但宴會也不會塞滿倉、必須持續補。

---

## 5. 衍生 / 未來擴充

- **公會料理長頭銜**：在宴會發起者 profile 累積「宴會發起次數」，達標解鎖頭銜（連動 `titles.json`）
- **季節菜單**：跟 `worldEvents` 連動，世界事件期間多一道限定菜（例：冰雪節 → 「暖湯宴」）
- **公會等級加碼**：Lv.5 公會發起宴會 buff 時效 +30 分鐘（不影響數值，只延長）
- **個人加碼**：在宴會期間做特定行為（種黑玫瑰、副本通關）的玩家額外吃到一個「席間最佳」獎章 → 入 weekly quest 系統

---

## 6. 落地步驟

1. **config**：`guild_buildings.json` 新增 `farm_kitchen.banquet_menus` 區塊（菜單材料/效果寫成 config）
2. **collection**：`guildsClub` doc 加 `active_banquet` / `last_banquet_at` 欄位（schema-less，無需 migration）
3. **service**：`src/features/guild_club/banquetService.js`
   - `startBanquet(client, { userId, guildId, menuId })`
   - `getActiveBanquet(club)`
4. **buff 接點**：`buffResolver.js` `getGuildClubBuffs` 多讀 active_banquet
5. **UI**：
   - `/公會建築` 農膳坊 Section 加「召集宴會」按鈕（manager + Lv.5）
   - 新 handler `handleGuildBanquetButton.js`
   - 菜單選擇 → 確認 → 公告
6. **公告**：`guildClubAnnouncer.js` 加 `announceBanquetStart`
7. **顯示**：`/加成` summary 加「公會宴會」來源區塊（剩餘時間、加成內容）
8. **網站**：`bibi-website/src/lib/dashboard/botDefs.ts` 新增 banquet 菜單名稱對照

預估工程量：**1~1.5 個工作天**（含測試）。

---

## 7. 邊界情況檢查

| 情況 | 處理 |
|---|---|
| 宴會中公會解散 | buff 自然過期，無補償 |
| 宴會中玩家退會加入新公會 | 新公會無 active_banquet → buff 自然消失 |
| 同時兩個公會都辦宴會（同類 buff） | `buffsByType` 累加（玩家不會同時在兩個公會，無此情境） |
| 倉庫材料剛好被人撤走 | atomic check + 扣 → 失敗回 insufficient |
| Bot 重啟時 active_banquet | 走 expires_at 判斷，重啟不影響 |
| 兩個 manager 同時點召集 | 用 `last_banquet_at` 做 optimistic lock（findOneAndUpdate where last_banquet_at < threshold）|
