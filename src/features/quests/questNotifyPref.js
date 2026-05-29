// 任務「完成 DM 通知」開關。
//
// 指令觸發的任務（挖礦／賣礦／打工／合成／簽到）一律以 ephemeral 私人回覆呈現，
// 不受此開關影響。此開關只控制「被動事件」（發言／語音／表情／賭博／股市等沒有
// interaction 的情境）完成任務時，是否額外私訊（DM）通知玩家。
//
// 預設關閉（靜默自動入帳）；玩家可在 /逼幣任務 介面用按鈕自行開啟。
// 資料存於 QuestSettings：{ userId, guildId, dmNotify } 以 (userId, guildId) 唯一。

require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const CUSTOM_ID_PREFIX = "questnotify";

function coll(client) {
  return client.questSettingsCollection || null;
}

function buildCustomId(userId) {
  return `${CUSTOM_ID_PREFIX}_${userId}`;
}

// 解析 questnotify_<userId>。userId 為純數字 Discord ID。
function parseCustomId(customId) {
  if (typeof customId !== "string") return null;
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}_`)) return null;
  const userId = customId.slice(CUSTOM_ID_PREFIX.length + 1);
  if (!userId) return null;
  return { userId };
}

// 產生通知開關按鈕（開＝綠燈鈴鐺，關＝灰色靜音）。
function buildButtonRow({ userId, enabled }) {
  const button = new ButtonBuilder()
    .setCustomId(buildCustomId(userId))
    .setLabel(enabled ? "完成 DM 通知：開" : "完成 DM 通知：關")
    .setEmoji(enabled ? "🔔" : "🔕")
    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(button);
}

// 讀取目前是否開啟 DM 通知。沒有資料 → 預設關閉。
async function isDmEnabled(client, userId, guildId) {
  const c = coll(client);
  if (!c) return false;
  const doc = await c.findOne({ userId, guildId }).catch(() => null);
  return !!doc?.dmNotify;
}

// 切換開/關，回傳新的狀態 { ok, enabled }。
async function toggle(client, userId, guildId) {
  const c = coll(client);
  if (!c) return { ok: false };

  const existing = await c.findOne({ userId, guildId }).catch(() => null);
  const nextEnabled = !existing?.dmNotify;

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
  CUSTOM_ID_PREFIX,
  buildCustomId,
  parseCustomId,
  buildButtonRow,
  isDmEnabled,
  toggle,
};
