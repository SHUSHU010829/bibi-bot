// 通知總開關（master switch）服務。
//
// 玩家可在 /通知設定 面板用「通知總開關」一次靜音／開啟所有私訊提醒。
// 總開關預設為「開」（沒有資料 → 視為開），關閉後：
//   - 打工 / 挖礦 / 火箭 的到點 DM（cooldownReminderService.scanAndNotify）會被跳過
//   - 任務完成的被動 DM（notifyQuestClaim）會被跳過
//
// 各情境的「個別開關」仍各自獨立保存（見 cooldownReminderService、questNotifyPref），
// 總開關只是在發送前的最後一道閘門，不會動到個別設定。
//
// 資料存於 NotifySettings：{ userId, guildId, masterEnabled } 以 (userId, guildId) 唯一。

function coll(client) {
  return client.notifySettingsCollection || null;
}

// 讀取總開關。沒有資料 → 預設開啟（true）。
async function isMasterEnabled(client, userId, guildId) {
  const c = coll(client);
  if (!c) return true;
  const doc = await c.findOne({ userId, guildId }).catch(() => null);
  // 只有明確存成 false 才算關閉；其餘（含沒有 doc）一律視為開啟。
  return doc?.masterEnabled !== false;
}

// 切換總開關，回傳新的狀態 { ok, enabled }。
async function toggleMaster(client, userId, guildId) {
  const c = coll(client);
  if (!c) return { ok: false };

  const existing = await c.findOne({ userId, guildId }).catch(() => null);
  const current = existing?.masterEnabled !== false; // 同上：預設開
  const nextEnabled = !current;

  await c
    .updateOne(
      { userId, guildId },
      {
        $set: { masterEnabled: nextEnabled, updatedAt: new Date() },
        $setOnInsert: { userId, guildId, createdAt: new Date() },
      },
      { upsert: true }
    )
    .catch(() => {});

  return { ok: true, enabled: nextEnabled };
}

module.exports = {
  isMasterEnabled,
  toggleMaster,
};
