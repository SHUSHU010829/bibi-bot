// 任務「完成 DM 通知」開關。
//
// 指令觸發的任務（挖礦／賣礦／打工／合成／簽到）一律以 ephemeral 私人回覆呈現，
// 不受此開關影響。此開關只控制「被動事件」（發言／語音／表情／賭博／股市等沒有
// interaction 的情境）完成任務時，是否額外私訊（DM）通知玩家。
//
// 預設開啟；玩家可在 /通知設定 介面用按鈕自行關閉。
// 資料存於 QuestSettings：{ userId, guildId, dmNotify } 以 (userId, guildId) 唯一。

require("colors");

function coll(client) {
  return client.questSettingsCollection || null;
}

async function isDmEnabled(client, userId, guildId) {
  const c = coll(client);
  if (!c) return true;
  const doc = await c.findOne({ userId, guildId }).catch(() => null);
  // 只有明確存成 false 才算關閉；其餘（含沒有 doc）一律視為開啟。
  return doc?.dmNotify !== false;
}

// 切換開/關，回傳新的狀態 { ok, enabled }。
async function toggle(client, userId, guildId) {
  const c = coll(client);
  if (!c) return { ok: false };

  const existing = await c.findOne({ userId, guildId }).catch(() => null);
  const current = existing?.dmNotify !== false;
  const nextEnabled = !current;

  await c
    .updateOne(
      { userId, guildId },
      {
        $set: { dmNotify: nextEnabled, updatedAt: new Date() },
        $setOnInsert: { userId, guildId, createdAt: new Date() },
      },
      { upsert: true }
    )
    .catch(() => {});

  return { ok: true, enabled: nextEnabled };
}

module.exports = {
  isDmEnabled,
  toggle,
};
