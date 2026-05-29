# bibi-bot 對外 API 介接契約

> 給 **bibi-website** 串接 bibi-bot 用的端點契約，以 bibi-bot 的 `src/httpServer/` 程式碼為準。
> bibi-bot 是所有 DB 寫入的唯一入口；website 對共用 MongoDB 僅持唯讀帳號，任何寫入都必須走本文件的 API。
>
> 最後更新：2026-05-29

---

## 通用約定

| 項目 | 值 |
|---|---|
| Base URL | bot 服務 `PORT`（預設 `8080`） |
| Content-Type | `application/json`（request body 上限 1 MB） |
| 抖內端點驗證 | `Authorization: Bearer <DONATION_GRANT_SECRET>` |
| 排行榜端點驗證 | 無（但皆須帶 `?guildId=`） |
| 錯誤格式 | 失敗一律回 `{ "error": "<reason>" }` |

---

## 1. 健康檢查 / 診斷

### `GET /health`
```jsonc
// 200
{ "ok": true, "ready": true }   // ready = bot 是否已連上 Discord
```

### `GET /diagnostics`
最近時間窗各服務（source）的成功/失敗統計。若 bot 設了環境變數 `DISCORD_BOT_DIAGNOSTICS_TOKEN`，須帶 header `x-diagnostics-token`。
```jsonc
// 200
{
  "ok": true,
  "ready": true,
  "windowMs": 600000,
  "sources": {
    "donation-grant": { "errorsLastWindow": 0, "errorsTotal": 3, "successesTotal": 120 }
    // …其餘 source
  }
}
// 401 { "error": "unauthorized" }   // token 不符
```

---

## 2. 抖內（website → bot）

驗證：`Authorization: Bearer <DONATION_GRANT_SECRET>`（兩支共用）。

### `POST /api/donation/session` — 付款前建立 session

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `userId` | string | ✅ | Discord 使用者 ID |
| `guildId` | string | ✅ | Discord 伺服器 ID |
| `amountNtd` | number | ✅ | 金額（NTD，≥ 1，會無條件取整） |
| `platform` | string | ✅ | `"ecpay"` 或 `"opay"` |

```jsonc
// 200
{
  "ok": true,
  "sessionId": "uuid",
  "code": "ABCD1234"   // 短碼：donor 於付款頁 / 備註填入，供 grant 回對 session
}
```
錯誤：
- `400 { error }` — `missing userId` / `missing guildId` / `invalid amountNtd` / `invalid platform`
- `401 { error: "unauthorized" }`
- `503 { error }` — `donation disabled` / `secret not configured` / `db not ready` / `code collision`（短碼連續撞 5 次）

> session 預設 30 分鐘到期（`donation.sessionTtlMinutes`）。

### `POST /api/donation/grant` — webhook 驗證成功後發放

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tradeNo` | string | ✅ | 金流交易編號，**冪等鍵**（unique） |
| `amountNtd` | number | ✅ | 實際付款金額（NTD，> 0） |
| `platform` | string | ✅ | `"ecpay"` 或 `"opay"` |
| `code` | string | ⬜ | 建立 session 時回傳的短碼；用來還原 donor 身分 |
| `patronName` | string | ⬜ | 顯示用贊助者名稱 |
| `patronNote` | string | ⬜ | 贊助留言 |

```jsonc
// 200 — 發放成功
{ "ok": true, "matched": true, "alreadyGranted": false,
  "perks": ["12,000 金幣", "贊助者身分組（30 天）", "挖礦 luck +5%（30 天）"],
  "grants": { /* 各項實際發放結果旗標 */ } }

// 200 — 冪等（同 tradeNo 已處理過，安全可重送）
{ "ok": true, "matched": true, "alreadyGranted": true, "perks": [ … ] }

// 200 — code 對不到 session：已寫 unmatched_donations 待人工補發，webhook 不需重送
{ "ok": true, "matched": false }
```
錯誤：`400`（`missing tradeNo` / `invalid amountNtd` / `invalid platform`）、`401`、`503`。

**重要規則**
- **冪等**：以 `tradeNo` 為唯一鍵，webhook 重送安全。
- **身分還原**：`userId` / `guildId` 一律由 bot 依 `code` 從 session 還原；**webhook 不得帶入身分欄位**（防偽造）。
- **方案判定依實付金額**：donor 可能在付款頁改金額，bot 以 `amountNtd` 對應方案；低於最低門檻仍回 `matched:true` 並寫 record，但無方案回饋（`tierId: null`）。
- `perks` 為字串清單，供 website 成功頁顯示（金幣 / 道具 / 身分組 / luck / 卡面 / 稱號…）。

---

## 3. 排行榜（dashboard → bot）

無需 Auth，但**所有端點都必須帶 `?guildId=<id>`**，否則回 `400 { error: "missing guildId" }`。

### `GET /api/v1/leaderboard/mining`
| Query | 預設 | 說明 |
|---|---|---|
| `guildId` | — | 必填 |
| `type` | `count` | `count`（挖礦次數）/ `value`（賣礦收入）/ `diamond`（鑽石數） |
| `period` | `week` | `today` / `week` / `month` / `all`；`type=diamond` 時強制 `all` |
| `limit` | `10` | 上限 100 |
```jsonc
// 200
{ "ok": true, "type": "count", "period": "week", "rows": [ /* … */ ] }
```

### `GET /api/v1/leaderboard/titles`
| Query | 預設 | 說明 |
|---|---|---|
| `guildId` | — | 必填 |
| `limit` | `10` | 上限 100 |
```jsonc
// 200
{ "ok": true, "rows": [ /* 依稱號數排序 */ ] }
```

### `GET /api/v1/leaderboard/weekly-summary`
| Query | 預設 | 說明 |
|---|---|---|
| `guildId` | — | 必填 |
| `top` | `3` | 上限 25 |
```jsonc
// 200
{ "ok": true, /* …各週榜摘要欄位 */ }
```

---

## 4. Twitch 聊天積分（外部服務 → bot）

### `POST /api/twitch-chat-score`
由 Twitch 端服務回沖聊天積分。請求/回應契約詳見 bibi-bot 的 `src/httpServer/flushChatScore.js`。

---

## 5. 尚未實作（Phase G 待辦）

以下為 Dashboard / 贊助後台規劃但**尚未實作**的端點，串接前請先確認 bibi-bot 已上線：

- 身分驗證：`/api/v1/auth/{login,callback,logout,me}`
- 管理後台：`/api/v1/admin/{economy/adjust, voting/proposals, push/feeds, shop/items, logs/transactions, cron/*}`
- 個人：`/api/v1/me/{profile,history}`
- 一般：`/api/v1/voting/proposals`、`/api/v1/shop/items`
- 贊助後台：`/api/v1/admin/donation/{records, unmatched, patrons, stats}`、`POST …/unmatched/:id/resolve`
