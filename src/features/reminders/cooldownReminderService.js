// 打工 / 挖礦「到點通知」訂閱服務。
//
// 玩家在 /打工、/挖礦 結果訊息下方的按鈕可開關通知。開啟後一旦該活動的冷卻
// 結束，cron 掃描器（events/ready/cooldownReminderScheduler.js）會 DM 提醒玩家。
//
// 資料存於 CooldownReminders：{ userId, guildId, type, enabled, readyAt, notified }
// 以 (userId, guildId, type) 唯一。readyAt 為冷卻結束的 epoch ms；notified 防重複 DM。

require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { casino, commandChannels, normalChannelId } = require("../../config");
const notifyPrefs = require("./notifyPrefs");

const CUSTOM_ID_PREFIX = "cdnotify";

// 各活動的呈現與 DM 文案。type 同時用於 customId 與 DB 欄位。
// notifyText：若有指定，scanAndNotify 會用它取代預設「冷卻結束囉」的文案；
// 用於語意不是「冷卻結束」的提醒（例如地下城體力補滿）。
// channelKey：對應 server.json commandChannels 的分類，DM 用來附上前往該頻道的連結。
const TYPE_META = {
  work: { label: "打工", emoji: "💼", command: "/打工", channelKey: "mining" },
  mining: { label: "挖礦", emoji: "⛏️", command: "/挖礦", channelKey: "mining" },
  fish: { label: "釣魚", emoji: "🎣", command: "/釣魚", channelKey: "fishing" },
  crash: { label: "火箭", emoji: "🚀", command: "/火箭", channelKey: "casino" },
  dungeon: {
    label: "地下城",
    emoji: "🔋",
    command: "/地下城",
    notifyText: "體力已補滿，快來大顯身手！",
    channelKey: "mining",
  },
};

// 依活動分類取出該頻道的 Discord 深連結，找不到時退回一般頻道。
function channelLink(guildId, channelKey) {
  const channelId =
    (commandChannels && commandChannels[channelKey]?.[0]) || normalChannelId;
  if (!channelId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function coll(client) {
  return client.cooldownRemindersCollection || null;
}

function buildCustomId(type, ownerId) {
  return `${CUSTOM_ID_PREFIX}_${type}_${ownerId}`;
}

// 解析 cdnotify_<type>_<ownerId>。ownerId 為純數字 Discord ID，不含底線。
function parseCustomId(customId) {
  if (typeof customId !== "string") return null;
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}_`)) return null;
  const rest = customId.slice(CUSTOM_ID_PREFIX.length + 1);
  const idx = rest.indexOf("_");
  if (idx < 0) return null;
  const type = rest.slice(0, idx);
  const ownerId = rest.slice(idx + 1);
  if (!TYPE_META[type] || !ownerId) return null;
  return { type, ownerId };
}

// 產生通知開關按鈕。enabled 決定外觀（開＝綠燈鈴鐺，關＝灰色靜音）。
function buildButtonRow({ type, ownerId, enabled }) {
  const button = new ButtonBuilder()
    .setCustomId(buildCustomId(type, ownerId))
    .setLabel(enabled ? "到點通知：開" : "到點通知：關")
    .setEmoji(enabled ? "🔔" : "🔕")
    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(button);
}

async function getState(client, { userId, guildId, type }) {
  const c = coll(client);
  if (!c) return null;
  return c.findOne({ userId, guildId, type }).catch(() => null);
}

// 讀取目前冷卻結束時間（epoch ms）。沒有資料或已結束回 0。
async function currentCooldownAt(client, { userId, guildId, type }) {
  if (type === "work") {
    const p = await client.workProfilesCollection
      ?.findOne({ userId, guildId })
      .catch(() => null);
    return p?.work_cooldown_at || 0;
  }
  if (type === "dungeon") {
    // 地下城體力滿的預估時間：拿目前 stamina + 回復速率推算到上限為止。
    // 透過 guild 反查 member 才能算進 Twitch 訂閱的體力上限加乘。
    const dungeonService = require("../mining/dungeonService");
    let member = null;
    try {
      const guild = client.guilds?.cache?.get(guildId);
      if (guild) {
        member =
          guild.members.cache.get(userId) ||
          (await guild.members.fetch(userId).catch(() => null));
      }
    } catch (_) {
      member = null;
    }
    return dungeonService.staminaFullAt(client, { userId, guildId, member });
  }
  if (type === "crash") {
    // 火箭沒有冷卻 profile，改由「上一局結算時間 + 補燃料冷卻」推算下次可發射時間。
    const cooldownSec = casino?.crash?.cooldownSeconds ?? 0;
    if (cooldownSec <= 0) return 0;
    const lastSettled = await client.crashGamesCollection
      ?.findOne(
        { userId, guildId, status: "settled" },
        { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } }
      )
      .catch(() => null);
    if (!lastSettled?.updatedAt) return 0;
    const readyAt = +lastSettled.updatedAt + cooldownSec * 1000;
    return readyAt > Date.now() ? readyAt : 0;
  }
  const p = await client.miningProfilesCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  if (type === "fish") return p?.fish_cooldown_at || 0;
  return p?.mine_cooldown_at || 0;
}

// 切換開/關。開啟時記錄本次冷卻結束時間並重置 notified；若冷卻已結束則直接標記
// notified（無需提醒）。回傳新的 enabled 狀態。
async function toggle(client, { userId, guildId, type, readyAt }) {
  const c = coll(client);
  if (!c) return { ok: false };

  const existing = await c.findOne({ userId, guildId, type }).catch(() => null);
  const nextEnabled = !existing?.enabled;
  const ready = readyAt || 0;

  await c
    .updateOne(
      { userId, guildId, type },
      {
        $set: {
          enabled: nextEnabled,
          readyAt: nextEnabled ? ready : existing?.readyAt || 0,
          // 開啟但冷卻已過 → 無需提醒；開啟且還在冷卻 → 等掃描器觸發
          notified: nextEnabled ? ready <= Date.now() : true,
          updatedAt: new Date(),
        },
        $setOnInsert: { userId, guildId, type, createdAt: new Date() },
      },
      { upsert: true }
    )
    .catch(() => {});

  return { ok: true, enabled: nextEnabled };
}

// 只有「已開啟通知」的訂閱才更新到最新冷卻並重置 notified；沒訂閱不主動建立。
// 供 /打工、/挖礦 成功後呼叫，讓通知持續追蹤最近一次的冷卻。
// 若 readyAt 已過（例如用 CD 縮短券把冷卻直接歸零），代表玩家當下就能挖、人也在現場，
// 直接標記 notified 避免掃描器補送多餘的「冷卻結束」DM。
async function refreshIfEnabled(client, { userId, guildId, type, readyAt }) {
  const c = coll(client);
  if (!c) return;
  await c
    .updateOne(
      { userId, guildId, type, enabled: true },
      {
        $set: {
          readyAt,
          notified: (readyAt || 0) <= Date.now(),
          updatedAt: new Date(),
        },
      }
    )
    .catch(() => {});
}

// 掃描所有到點且尚未通知的訂閱，DM 提醒。先原子標記 notified 再 DM，避免重複洗版。
async function scanAndNotify(client) {
  const c = coll(client);
  if (!c) return;

  const now = Date.now();
  const due = await c
    .find({ enabled: true, notified: false, readyAt: { $gt: 0, $lte: now } })
    .limit(200)
    .toArray()
    .catch(() => []);

  for (const r of due) {
    const claim = await c
      .updateOne(
        { _id: r._id, notified: false },
        { $set: { notified: true, updatedAt: new Date() } }
      )
      .catch(() => ({ modifiedCount: 0 }));
    if (!claim.modifiedCount) continue;

    const meta = TYPE_META[r.type];
    if (!meta) continue;

    // 通知總開關關閉時，靜默跳過（已標記 notified，不會反覆補送）。
    const masterOn = await notifyPrefs.isMasterEnabled(
      client,
      r.userId,
      r.guildId
    );
    if (!masterOn) continue;

    const user = await client.users.fetch(r.userId).catch(() => null);
    if (!user) continue;

    const guildName = client.guilds.cache.get(r.guildId)?.name || "伺服器";
    const body = meta.notifyText
      ? `${meta.emoji} 你在 **${guildName}** 的${meta.label}${meta.notifyText}快來 \`${meta.command}\`！`
      : `${meta.emoji} 你在 **${guildName}** 的${meta.label}冷卻結束囉，快來 \`${meta.command}\`！`;
    const link = channelLink(r.guildId, meta.channelKey);
    const cta = link
      ? `\n👉 前往 ${link} 使用 \`${meta.command}\``
      : "";
    await user.send(`${body}${cta}`).catch(() => {});
  }
}

module.exports = {
  TYPE_META,
  buildCustomId,
  parseCustomId,
  buildButtonRow,
  getState,
  currentCooldownAt,
  toggle,
  refreshIfEnabled,
  scanAndNotify,
};
