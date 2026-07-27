// BOSS 亂入寶箱 / 擬態怪
//
// 戰鬥進行中，每分鐘掃描（bossScheduler.expirySweep）機率丟出一個公用寶箱：
//   - 手速最快的人按「開寶箱」搶到（無 owner 鎖，先搶先贏）。
//   - 真寶箱 → 金幣或傳說碎片；擬態怪 → 反咬一口只給安慰獎。
// 狀態存在 boss doc 的 active_treasure，搶奪 / 過期都用原子更新避免重複。
require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { boss } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const bossBoard = require("./bossBoard");

const PREFIX = "boss_chest_";
const EXPIRED_MARK = "__expired__";
const RARE_KEY = "legendary_fragments";

function tcfg() {
  return boss?.treasure || {};
}

function pickFrom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function resolveChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

function chestRow(bossId, treasureId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${bossId}_${treasureId}`)
      .setLabel("開寶箱")
      .setEmoji("🎁")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

// 每分鐘掃描：收掉過期未開的寶箱、機率生成新寶箱。
async function tick(client, guild) {
  const cfg = tcfg();
  if (!cfg.enabled) return;
  const guildId = guild?.id;
  if (!guildId || !client.bossEventsCollection) return;

  const bossDoc = await client.bossEventsCollection.findOne({ guild_id: guildId, status: "active" });
  if (!bossDoc) return;
  const now = Date.now();

  const t = bossDoc.active_treasure;
  if (t && !t.claimed_by) {
    if (now >= t.expires_at) await expireTreasure(client, bossDoc.boss_id, bossDoc.guild_id, t);
    return; // 場上已有進行中的寶箱，不再生成
  }

  // ends_at 為 null＝招喚場無時間限制，隨時都還有時間，跳過「剩餘時間不足」的攔截。
  if (bossDoc.ends_at != null) {
    const remainMin = (bossDoc.ends_at - now) / 60000;
    if (remainMin < (cfg.minRemainingMinutes ?? 3)) return;
  }
  if (Math.random() >= (cfg.spawnChancePerMinute ?? 0.3)) return;

  await spawnTreasure(client, bossDoc);
}

async function spawnTreasure(client, bossDoc) {
  const cfg = tcfg();
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const now = Date.now();
  const treasureId = `t${now}`;
  const isMimic = Math.random() < (cfg.mimicChance ?? 0.35);
  const expiresAt = now + (cfg.durationSec ?? 60) * 1000;

  // 原子搶佔：只有在目前沒有進行中的寶箱時才建立。
  const claimRes = await client.bossEventsCollection.findOneAndUpdate(
    {
      boss_id: bossDoc.boss_id,
      status: "active",
      $or: [{ active_treasure: null }, { "active_treasure.claimed_by": { $ne: null } }],
    },
    {
      $set: {
        active_treasure: {
          id: treasureId,
          is_mimic: isMimic,
          spawned_at: now,
          expires_at: expiresAt,
          claimed_by: null,
          message_id: null,
        },
      },
    },
    { returnDocument: "after" },
  );
  if (!(claimRes?.value || claimRes)) return;

  const intro = pickFrom(cfg.spawnMessages) || "🎁 戰場上滾出一個寶箱！先搶先贏！";
  const endsAt = Math.floor(expiresAt / 1000);
  const msg = await ch.send({
    content: `${intro}\n-# 手速最快的人才能開 · <t:${endsAt}:R> 消失`,
    components: [chestRow(bossDoc.boss_id, treasureId)],
    allowedMentions: { parse: [] },
  }).catch(() => null);

  if (msg) {
    await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, "active_treasure.id": treasureId },
      { $set: { "active_treasure.message_id": msg.id } },
    ).catch(() => {});
    console.log(`[BOSS] treasure spawned ${treasureId} mimic=${isMimic}`.cyan);
    bossBoard.scheduleRefresh(client, bossDoc.guild_id, true);
  }
}

async function expireTreasure(client, bossId, guildId, t) {
  // 原子標記已處理，避免掃描重複編輯。
  const res = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossId, "active_treasure.id": t.id, "active_treasure.claimed_by": null },
    { $set: { "active_treasure.claimed_by": EXPIRED_MARK } },
    { returnDocument: "after" },
  );
  if (!(res?.value || res)) return;
  bossBoard.scheduleRefresh(client, guildId, true);
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch || !t.message_id) return;
  const msg = await ch.messages.fetch(t.message_id).catch(() => null);
  if (msg) {
    await msg.edit({
      content: tcfg().expiredMessage || "💨 沒人開，寶箱溜走了。",
      components: [chestRow(bossId, t.id, true)],
    }).catch(() => {});
  }
}

// 按鈕點擊：第一個按到的人搶下寶箱（無 owner 鎖，原子判定勝者）。
async function claim(client, interaction) {
  const cfg = tcfg();
  const customId = interaction.customId;
  const rest = customId.slice(PREFIX.length);
  const sep = rest.lastIndexOf("_");
  if (sep < 0) return;
  const bossId = rest.slice(0, sep);
  const treasureId = rest.slice(sep + 1);
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const username = interaction.user.username;

  const res = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossId, "active_treasure.id": treasureId, "active_treasure.claimed_by": null },
    { $set: { "active_treasure.claimed_by": userId, "active_treasure.claimed_at": Date.now() } },
    { returnDocument: "after" },
  );
  const doc = res?.value || res;
  if (!doc) {
    return interaction.reply({
      content: "🥲 手慢了！這個寶箱已經被別人開走（或消失）了。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const t = doc.active_treasure;
  const member = interaction.member;
  const userMention = `<@${userId}>`;
  let resultText;

  if (t.is_mimic) {
    const coins = cfg.mimicConsolationCoins ?? 0;
    if (coins > 0) {
      await grantCoins(client, {
        userId, guildId, username, member, amount: coins, source: "boss_treasure",
      }).catch(() => {});
    }
    resultText = (pickFrom(cfg.mimicMessages) || "😱 是擬態怪！{user} 只摸到 {coins} 金幣。")
      .replace(/\{user\}/g, userMention)
      .replace(/\{coins\}/g, coins.toLocaleString());
  } else if (Math.random() < (cfg.chestRareChance ?? 0)) {
    const rare = 1;
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [RARE_KEY]: rare }, $set: { updatedAt: new Date() } },
      { upsert: true },
    ).catch(() => {});
    resultText = (pickFrom(cfg.chestRareMessages) || "🌟 {user} 開出了傳說碎片 ×{rare}！")
      .replace(/\{user\}/g, userMention)
      .replace(/\{rare\}/g, String(rare));
  } else {
    const coins = rand(cfg.chestCoinMin ?? 200, cfg.chestCoinMax ?? 600);
    await grantCoins(client, {
      userId, guildId, username, member, amount: coins, source: "boss_treasure",
    }).catch(() => {});
    resultText = (pickFrom(cfg.chestMessages) || "🎉 {user} 開出了 {coins} 金幣！")
      .replace(/\{user\}/g, userMention)
      .replace(/\{coins\}/g, coins.toLocaleString());
  }

  bossBoard.scheduleRefresh(client, guildId, true);

  await interaction.update({
    content: resultText,
    components: [chestRow(bossId, treasureId, true)],
    allowedMentions: { users: [userId] },
  }).catch(async () => {
    await interaction.reply({ content: resultText, flags: MessageFlags.Ephemeral }).catch(() => {});
  });
}

module.exports = { tick, claim, PREFIX };
