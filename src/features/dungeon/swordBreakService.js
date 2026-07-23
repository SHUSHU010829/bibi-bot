// 傳說之劍斷裂：紀錄、公告、雙週排行榜、亡靈制 buff 的單一入口。
//
// 設計：
// - 每斷一次傳說之劍寫一筆 SwordBreaks（雙週榜資料源，TTL 由 connectDb 設）；
//   同時 $inc profile.legendary_sword_breaks 作為永久累積（全時榜 / 公告顯示）。
// - 雙週榜以「每月 1 號 / 16 號」為切點結算（見 cronSchedule），冠軍獲得「亡靈制」。
// - 亡靈制一律 compute-on-read：只存 profile.active_undead_buff.expires_at，
//   加成值在 dungeonService 讀取時即時換算，狀態一過期就自動失效（不靠排程清欄位）。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { DateTime } = require("luxon");

const { dungeon } = require("../../config");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const LEGENDARY_SWORD = "legendary_sword";
const MEDALS = ["🥇", "🥈", "🥉"];

function cfg() {
  return dungeon?.swordBreaker || {};
}
function undeadCfg() {
  return dungeon?.undead || {};
}
function tz() {
  return cfg().timezone || "Asia/Taipei";
}

function swordLabel() {
  const w = dungeon?.weapons?.[LEGENDARY_SWORD] || {};
  return `${w.emoji || "🔥"} ${w.name || "傳說之劍"}`;
}

// ── 亡靈制 debuff（斷劍王的詛咒，compute-on-read）─────────
function isUndeadActive(profile) {
  const exp = profile?.active_undead_buff?.expires_at;
  return typeof exp === "number" && exp > Date.now();
}

// 亡靈制纏身時的地下城 ATK 懲罰（回傳正整數的懲罰幅度，呼叫端相減）。
function undeadAtkPenaltyPct(profile) {
  return isUndeadActive(profile) ? undeadCfg().atkPenaltyPct || 0 : 0;
}

// 亡靈制纏身時，每場戰鬥額外多扣的武器耐久（怨靈讓兵刃更快崩壞）。
function undeadExtraDurabilityCost(profile) {
  return isUndeadActive(profile) ? undeadCfg().extraDurabilityCost || 0 : 0;
}

// 每場擲一次「亡靈軍團作祟」詛咒：命中則回傳損失，否則 null。
function rollUndeadCurse(profile) {
  if (!isUndeadActive(profile)) return null;
  const c = undeadCfg().curse || {};
  const chance = c.chancePct || 0;
  if (chance <= 0) return null;
  if (Math.random() * 100 >= chance) return null;
  return {
    hpLossPct: c.hpLossPct || 0,
    coinLoss: c.coinLoss || 0,
  };
}

// ── 雙週視窗（每月 1 號 / 16 號為切點）───────────────────
// 上半月 = [1 號 00:00, 16 號 00:00)；下半月 = [16 號 00:00, 次月 1 號 00:00)。
function windowOf(dt) {
  const monthStart = dt.startOf("month");
  const sixteenth = monthStart.plus({ days: 15 });
  if (dt < sixteenth) {
    return { start: monthStart.toJSDate(), end: sixteenth.toJSDate(), startDt: monthStart, endDt: sixteenth };
  }
  const nextMonth = monthStart.plus({ months: 1 });
  return { start: sixteenth.toJSDate(), end: nextMonth.toJSDate(), startDt: sixteenth, endDt: nextMonth };
}

function labelOf(win) {
  const s = win.startDt.toFormat("M/d");
  const e = win.endDt.minus({ days: 1 }).toFormat("M/d");
  return `${s}–${e}`;
}

// 現在所屬的雙週視窗（給排行榜看即時榜）。
function currentWindow(now = DateTime.now().setZone(tz())) {
  const w = windowOf(now);
  return { ...w, label: labelOf(w) };
}

// 剛結束、待結算的雙週視窗（cron 在 1 號 / 16 號 00:05 跑時取此）。
function previousWindow(now = DateTime.now().setZone(tz())) {
  const w = windowOf(now.minus({ days: 1 }));
  return { ...w, label: labelOf(w) };
}

// ── 紀錄斷劍 ─────────────────────────────────────────────
async function recordBreak(client, { userId, guildId }) {
  const now = new Date();
  if (client.swordBreaksCollection) {
    await client.swordBreaksCollection
      .insertOne({ user_id: userId, guild_id: guildId, weapon: LEGENDARY_SWORD, broken_at: now })
      .catch((e) => console.log(`[WARN] SwordBreaks insert: ${e.message}`.yellow));
  }
  let lifetime = 0;
  if (client.miningProfilesCollection) {
    const updated = await client.miningProfilesCollection
      .findOneAndUpdate(
        { userId, guildId },
        { $inc: { legendary_sword_breaks: 1 }, $set: { updatedAt: now } },
        { upsert: true, returnDocument: "after" },
      )
      .catch(() => null);
    lifetime = (updated?.value || updated)?.legendary_sword_breaks || 0;
  }
  return { lifetime };
}

async function breakCountInWindow(client, guildId, userId, win) {
  if (!client.swordBreaksCollection) return 0;
  return client.swordBreaksCollection
    .countDocuments({
      guild_id: guildId,
      user_id: userId,
      broken_at: { $gte: win.start, $lt: win.end },
    })
    .catch(() => 0);
}

// ── 斷劍即時公告 ─────────────────────────────────────────
async function announceBreak(client, { userId, guildId, biweekly, lifetime }) {
  const channelId = cfg().announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const guild = client.guilds.cache.get(guildId);
  const who = plainifyUserMentions(guild, `<@${userId}>`);

  const container = new ContainerBuilder()
    .setAccentColor(0x992d22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 💥 ${swordLabel()} 應聲斷裂！`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${who} 在地下城硬生生把 ${swordLabel()} 砍斷了！\n` +
          `本期已斷 **${biweekly}** 次 ・ 生涯累計 **${lifetime}** 次`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 斷劍榜每月 1 號 / 16 號結算，斷最多的人將被封為 ☠️ 斷劍王，遭「亡靈制」詛咒纏身（debuff）。用 `/排行榜` → 斷劍王 查看戰況。",
      ),
    );

  await channel
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

// dungeonService 在偵測到傳說之劍斷裂時 fire-and-forget 呼叫（自帶錯誤吞掉）。
async function handleLegendaryBreak(client, { userId, guildId }) {
  if (!cfg().enabled) return;
  try {
    const { lifetime } = await recordBreak(client, { userId, guildId });
    const biweekly = await breakCountInWindow(client, guildId, userId, currentWindow());
    await announceBreak(client, { userId, guildId, biweekly, lifetime });
  } catch (e) {
    console.log(`[WARN] handleLegendaryBreak: ${e.message}`.yellow);
  }
}

// ── 排行榜資料 ───────────────────────────────────────────
// 雙週榜：SwordBreaks 於指定視窗內 group by user。
async function rankByWindow(client, guildId, win, limit = 10) {
  if (!client.swordBreaksCollection) return [];
  return client.swordBreaksCollection
    .aggregate([
      { $match: { guild_id: guildId, broken_at: { $gte: win.start, $lt: win.end } } },
      { $group: { _id: "$user_id", breaks: { $sum: 1 } } },
      { $sort: { breaks: -1 } },
      { $limit: limit },
      { $project: { _id: 0, userId: "$_id", breaks: 1 } },
    ])
    .toArray()
    .catch(() => []);
}

// 全時榜：profile.legendary_sword_breaks 累積數。
async function rankLifetime(client, guildId, limit = 10) {
  if (!client.miningProfilesCollection) return [];
  return client.miningProfilesCollection
    .find({ guildId, legendary_sword_breaks: { $gt: 0 } })
    .project({ userId: 1, legendary_sword_breaks: 1 })
    .sort({ legendary_sword_breaks: -1 })
    .limit(limit)
    .toArray()
    .then((docs) => docs.map((d) => ({ userId: d.userId, breaks: d.legendary_sword_breaks || 0 })))
    .catch(() => []);
}

async function guildsWithBreaks(client, win) {
  if (!client.swordBreaksCollection) return [];
  return client.swordBreaksCollection
    .distinct("guild_id", { broken_at: { $gte: win.start, $lt: win.end } })
    .catch(() => []);
}

// ── 亡靈制授予 / 卸任 ────────────────────────────────────
// 授予冠軍亡靈制，效期到下個結算切點（下次雙週視窗結束）。
async function grantUndead(client, { userId, guildId, expiresAt, cycleLabel }) {
  if (!client.miningProfilesCollection) return;
  await client.miningProfilesCollection
    .updateOne(
      { userId, guildId },
      {
        $set: {
          active_undead_buff: { expires_at: expiresAt, cycle: cycleLabel, granted_at: Date.now() },
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    )
    .catch((e) => console.log(`[WARN] grantUndead: ${e.message}`.yellow));
}

// 卸下同 guild 內其他人身上的亡靈制（保證同時只有一位斷劍王持有）。
async function revokeUndeadExcept(client, guildId, keepUserId) {
  if (!client.miningProfilesCollection) return;
  await client.miningProfilesCollection
    .updateMany(
      { guildId, userId: { $ne: keepUserId }, "active_undead_buff.expires_at": { $exists: true } },
      { $unset: { active_undead_buff: "" } },
    )
    .catch((e) => console.log(`[WARN] revokeUndeadExcept: ${e.message}`.yellow));
}

module.exports = {
  LEGENDARY_SWORD,
  MEDALS,
  swordLabel,
  isUndeadActive,
  undeadAtkPenaltyPct,
  undeadExtraDurabilityCost,
  rollUndeadCurse,
  currentWindow,
  previousWindow,
  recordBreak,
  breakCountInWindow,
  handleLegendaryBreak,
  rankByWindow,
  rankLifetime,
  guildsWithBreaks,
  grantUndead,
  revokeUndeadExcept,
};
