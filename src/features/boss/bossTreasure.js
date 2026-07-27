// BOSS 亂入寶箱 / 擬態怪
//
// 戰鬥進行中，每分鐘掃描（bossScheduler.expirySweep）機率丟出一個公用寶箱：
//   - 稀有度分級（木/銀/金/傳說），越稀有獎勵越誇張、出場氣勢越大。
//   - 手速最快的人按「開寶箱」搶到（無 owner 鎖，先搶先贏）。
//   - 真寶箱 → 金幣（可再「賭一把」翻倍或歸零）＋機率碎片/鑽石。
//   - 擬態怪 → 多半反咬一口只給安慰獎，但有機率被你反殺爆一筆。
// 狀態存在 boss doc 的 active_treasure，搶奪 / 賭局 / 過期都用原子更新避免重複。
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
const TAKE_PREFIX = "boss_gtake_";
const ROLL_PREFIX = "boss_groll_";
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

function fmt(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

function tierList() {
  const list = tcfg().tiers;
  if (Array.isArray(list) && list.length) return list;
  return [{ key: "wood", name: "寶箱", emoji: "🎁", weight: 1, coinMin: 300, coinMax: 900, rareChance: 0.12, rareQty: 1, diamond: 0 }];
}

function pickTier() {
  const list = tierList();
  const total = list.reduce((s, t) => s + (t.weight || 0), 0);
  if (total <= 0) return list[0];
  let r = Math.random() * total;
  for (const t of list) {
    r -= t.weight || 0;
    if (r <= 0) return t;
  }
  return list[list.length - 1];
}

function tierByKey(key) {
  return tierList().find((t) => t.key === key) || tierList()[0];
}

async function resolveChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

async function grantDiamond(client, { userId, guildId, qty }) {
  if (!client.miningProfilesCollection || qty <= 0) return;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { "backpack.diamond": qty, "lifetime_ore.diamond": qty }, $set: { updatedAt: new Date() } },
    { upsert: true },
  ).catch(() => {});
}

async function grantRare(client, { userId, guildId, qty }) {
  if (!client.miningProfilesCollection || qty <= 0) return;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [RARE_KEY]: qty }, $set: { updatedAt: new Date() } },
    { upsert: true },
  ).catch(() => {});
}

function openRow(bossId, treasureId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${bossId}_${treasureId}`)
      .setLabel("開寶箱")
      .setEmoji("🎁")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function gambleRow(bossId, treasureId, userId, coins) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TAKE_PREFIX}${bossId}_${treasureId}_${userId}`)
      .setLabel(`收下 ${coins.toLocaleString()}`)
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${ROLL_PREFIX}${bossId}_${treasureId}_${userId}`)
      .setLabel("賭一把（雙倍/歸零）")
      .setEmoji("🎲")
      .setStyle(ButtonStyle.Danger),
  );
}

// 每分鐘掃描：收掉過期未開的寶箱、逾時自動收下賭局、機率生成新寶箱。
async function tick(client, guild) {
  const cfg = tcfg();
  if (!cfg.enabled) return;
  const guildId = guild?.id;
  if (!guildId || !client.bossEventsCollection) return;

  const bossDoc = await client.bossEventsCollection.findOne({ guild_id: guildId, status: "active" });
  if (!bossDoc) return;
  const now = Date.now();

  const t = bossDoc.active_treasure;
  if (t) {
    if (!t.claimed_by) {
      if (now >= t.expires_at) await expireTreasure(client, bossDoc.boss_id, bossDoc.guild_id, t);
      return; // 場上已有進行中的寶箱，不再生成
    }
    const pg = t.pending_gamble;
    if (pg && !pg.resolved) {
      if (now >= pg.deadline) await autoCollectGamble(client, bossDoc, t);
      return; // 賭局進行中，不生成新寶箱
    }
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
  const tier = pickTier();
  const mimicChance = tier.mimicChance ?? cfg.mimicChance ?? 0.3;
  const isMimic = Math.random() < mimicChance;
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
          tier: tier.key,
          is_mimic: isMimic,
          spawned_at: now,
          expires_at: expiresAt,
          claimed_by: null,
          message_id: null,
          pending_gamble: null,
        },
      },
    },
    { returnDocument: "after" },
  );
  if (!(claimRes?.value || claimRes)) return;

  const banner = tier.banner || `${tier.emoji || "🎁"} 戰場上滾出一個${tier.name || "寶箱"}！`;
  const flavor = pickFrom(cfg.spawnFlavors) || "手速最快的人才能開，先搶先贏！";
  const endsAt = Math.floor(expiresAt / 1000);
  const msg = await ch.send({
    content: `${banner}\n${flavor}\n-# <t:${endsAt}:R> 消失`,
    components: [openRow(bossDoc.boss_id, treasureId)],
    allowedMentions: { parse: [] },
  }).catch(() => null);

  if (msg) {
    await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, "active_treasure.id": treasureId },
      { $set: { "active_treasure.message_id": msg.id } },
    ).catch(() => {});
    console.log(`[BOSS] treasure spawned ${treasureId} tier=${tier.key} mimic=${isMimic}`.cyan);
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
      components: [openRow(bossId, t.id, true)],
    }).catch(() => {});
  }
}

// 按鈕點擊：第一個按到的人搶下寶箱（無 owner 鎖，原子判定勝者）。
async function claim(client, interaction) {
  const cfg = tcfg();
  const rest = interaction.customId.slice(PREFIX.length);
  const sep = rest.lastIndexOf("_");
  if (sep < 0) return;
  const bossId = rest.slice(0, sep);
  const treasureId = rest.slice(sep + 1);
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const username = interaction.user.username;
  const member = interaction.member;
  const userMention = `<@${userId}>`;

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
  const tier = tierByKey(t.tier);
  const tierName = tier.name || "寶箱";

  // ── 擬態怪：反咬（安慰獎）或被反殺（爆一筆）──
  if (t.is_mimic) {
    let resultText;
    if (Math.random() < (cfg.mimicSlayChance ?? 0)) {
      const coins = rand(cfg.mimicSlayCoinMin ?? 800, cfg.mimicSlayCoinMax ?? 1600);
      await grantCoins(client, { userId, guildId, username, member, amount: coins, source: "boss_treasure" }).catch(() => {});
      let rareLine = "";
      if (Math.random() < (cfg.mimicSlayRareChance ?? 0)) {
        await grantRare(client, { userId, guildId, qty: 1 });
        rareLine = `\n🌟 還從牠肚子裡摳出傳說碎片 ×1！`;
      }
      resultText = fmt(pickFrom(cfg.mimicSlayMessages) || "⚔️ {user} 反殺擬態怪，搜出 {coins} 金幣！", {
        user: userMention, coins: coins.toLocaleString(), tier: tierName,
      }) + rareLine;
    } else {
      const coins = cfg.mimicConsolationCoins ?? 0;
      if (coins > 0) {
        await grantCoins(client, { userId, guildId, username, member, amount: coins, source: "boss_treasure" }).catch(() => {});
      }
      resultText = fmt(pickFrom(cfg.mimicMessages) || "😱 是擬態怪！{user} 只摸到 {coins} 金幣。", {
        user: userMention, coins: coins.toLocaleString(), tier: tierName,
      });
    }
    bossBoard.scheduleRefresh(client, guildId, true);
    return finalizeMessage(interaction, resultText, openRow(bossId, treasureId, true), userId);
  }

  // ── 真寶箱：稀有碎片 / 鑽石當場入袋，金幣可再賭一把 ──
  const extraLines = [];
  if (tier.rareChance && Math.random() < tier.rareChance) {
    const qty = tier.rareQty ?? 1;
    await grantRare(client, { userId, guildId, qty });
    extraLines.push(fmt(pickFrom(cfg.chestRareMessages) || "🌟 {user} 開出傳說碎片 ×{rare}！", {
      user: userMention, rare: String(qty), tier: tierName,
    }));
  }
  if ((tier.diamond ?? 0) > 0) {
    await grantDiamond(client, { userId, guildId, qty: tier.diamond });
    extraLines.push(fmt(pickFrom(cfg.chestDiamondMessages) || "💎 {user} 開出鑽石 ×{diamond}！", {
      user: userMention, diamond: String(tier.diamond), tier: tierName,
    }));
  }

  const coins = rand(tier.coinMin ?? 300, tier.coinMax ?? 900);
  const gcfg = cfg.gamble || {};

  if (gcfg.enabled) {
    const deadline = Date.now() + (gcfg.windowSec ?? 30) * 1000;
    await client.bossEventsCollection.updateOne(
      { boss_id: bossId, "active_treasure.id": treasureId },
      { $set: { "active_treasure.pending_gamble": { userId, username, coins, deadline, resolved: false } } },
    ).catch(() => {});
    const prompt = fmt(pickFrom(cfg.gamblePromptMessages) || "🎲 {user} 找到 {coins} 金幣——收下還是賭一把？", {
      user: userMention, coins: coins.toLocaleString(),
    });
    const content = [...extraLines, prompt].join("\n");
    bossBoard.scheduleRefresh(client, guildId, true);
    return finalizeMessage(interaction, content, gambleRow(bossId, treasureId, userId, coins), userId);
  }

  // 沒有賭局：金幣直接入袋
  await grantCoins(client, { userId, guildId, username, member, amount: coins, source: "boss_treasure" }).catch(() => {});
  const openLine = fmt(pickFrom(cfg.chestMessages) || "🎉 {user} 開出 {coins} 金幣！", {
    user: userMention, coins: coins.toLocaleString(), tier: tierName,
  });
  bossBoard.scheduleRefresh(client, guildId, true);
  return finalizeMessage(interaction, [openLine, ...extraLines].join("\n"), openRow(bossId, treasureId, true), userId);
}

async function finalizeMessage(interaction, content, row, userId) {
  await interaction.update({
    content,
    components: [row],
    allowedMentions: { users: [userId] },
  }).catch(async () => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  });
}

// 賭局按鈕：收下（take）或賭一把（roll）。只有戰利品擁有者能操作（owner 鎖）。
async function resolveGamble(client, interaction, action) {
  const cfg = tcfg();
  const gcfg = cfg.gamble || {};
  const prefix = action === "roll" ? ROLL_PREFIX : TAKE_PREFIX;
  const rest = interaction.customId.slice(prefix.length);
  const parts = rest.split("_");
  const ownerId = parts.pop();
  const treasureId = parts.pop();
  const bossId = parts.join("_");

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的寶箱戰利品，別人的賭局插不了手！",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  // 原子搶結算：只有第一個成功（且尚未逾時自動收下）的動作生效。
  const res = await client.bossEventsCollection.findOneAndUpdate(
    {
      boss_id: bossId,
      "active_treasure.id": treasureId,
      "active_treasure.pending_gamble.userId": ownerId,
      "active_treasure.pending_gamble.resolved": false,
    },
    { $set: { "active_treasure.pending_gamble.resolved": true } },
    { returnDocument: "after" },
  );
  const doc = res?.value || res;
  if (!doc) {
    return interaction.reply({
      content: "⌛ 這場賭局已經結束了。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  const pg = doc.active_treasure.pending_gamble;
  const guildId = interaction.guildId;
  const username = interaction.user.username;
  const member = interaction.member;
  const userMention = `<@${ownerId}>`;
  const base = pg.coins;
  let resultText;

  if (action === "roll") {
    if (Math.random() < (gcfg.winChance ?? 0.5)) {
      const total = base * (gcfg.winMult ?? 2);
      await grantCoins(client, { userId: ownerId, guildId, username, member, amount: total, source: "boss_treasure" }).catch(() => {});
      resultText = fmt(pickFrom(cfg.gambleWinMessages) || "🎉 賭贏了！{base} → {coins} 金幣！", {
        user: userMention, base: base.toLocaleString(), coins: total.toLocaleString(),
      });
    } else {
      resultText = fmt(pickFrom(cfg.gambleLoseMessages) || "💸 崩盤了！{base} 金幣全部飛走……", {
        user: userMention, base: base.toLocaleString(),
      });
    }
  } else {
    await grantCoins(client, { userId: ownerId, guildId, username, member, amount: base, source: "boss_treasure" }).catch(() => {});
    resultText = fmt(pickFrom(cfg.gambleTakeMessages) || "💰 {user} 穩穩收下 {coins} 金幣。", {
      user: userMention, coins: base.toLocaleString(),
    });
  }

  bossBoard.scheduleRefresh(client, guildId, true);
  return finalizeMessage(interaction, resultText, openRow(bossId, treasureId, true), ownerId);
}

// 逾時沒出手 → 自動收下（不賭），把金幣入袋，避免玩家離開就丟失戰利品。
async function autoCollectGamble(client, bossDoc, t) {
  const cfg = tcfg();
  const res = await client.bossEventsCollection.findOneAndUpdate(
    {
      boss_id: bossDoc.boss_id,
      "active_treasure.id": t.id,
      "active_treasure.pending_gamble.resolved": false,
    },
    { $set: { "active_treasure.pending_gamble.resolved": true } },
    { returnDocument: "after" },
  );
  const doc = res?.value || res;
  if (!doc) return;
  const pg = doc.active_treasure.pending_gamble;
  await grantCoins(client, {
    userId: pg.userId, guildId: bossDoc.guild_id, username: pg.username, amount: pg.coins, source: "boss_treasure",
  }).catch(() => {});
  bossBoard.scheduleRefresh(client, bossDoc.guild_id, true);
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch || !t.message_id) return;
  const msg = await ch.messages.fetch(t.message_id).catch(() => null);
  if (msg) {
    const text = fmt(pickFrom(cfg.gambleAutoMessages) || "⌛ {user} 沒出手，{coins} 金幣自動入袋。", {
      user: `<@${pg.userId}>`, coins: pg.coins.toLocaleString(),
    });
    await msg.edit({
      content: text,
      components: [openRow(bossDoc.boss_id, t.id, true)],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

module.exports = { tick, claim, resolveGamble, PREFIX, TAKE_PREFIX, ROLL_PREFIX };
