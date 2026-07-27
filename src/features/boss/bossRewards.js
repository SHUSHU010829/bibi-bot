require("colors");
const { boss, guildClub } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const grantActivityXp = require("../leveling/grantActivityXp");
const gameTitleService = require("../gameTitles/gameTitleService");
const guildClubContribution = require("../guild_club/guildClubContribution");

const RARE_KEY = "legendary_fragments";

async function grantRare(client, { userId, guildId, qty }) {
  if (!client.miningProfilesCollection || qty <= 0) return;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [RARE_KEY]: qty }, $set: { updatedAt: new Date() } },
    { upsert: true },
  );
}

async function fetchMember(guild, userId) {
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

// 解算玩家所屬公會（用於 B/C 連動）。回傳 { guild_club_id, name, level } 或 null。
async function lookupMembership(client, userId, guildId) {
  if (!guildClub?.enabled) return null;
  if (!client?.guildClubMembersCollection || !client?.guildsClubCollection) return null;
  const m = await client.guildClubMembersCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!m) return null;
  const club = await client.guildsClubCollection
    .findOne({ guild_club_id: m.guild_club_id, disbanded_at: null })
    .catch(() => null);
  if (!club) return null;
  return { guild_club_id: club.guild_club_id, name: club.name, level: club.level };
}

// 把累積出來的金額入帳到指定公會。`locked=true` 用 locked_entries（有解鎖期），
// `locked=false` 直接進可分配 treasury_current；兩者都會推升 treasury（升級用累積）。
async function depositToClub(client, { clubId, amount, locked, source, meta, lockMs }) {
  if (!client?.guildsClubCollection || amount <= 0) return null;
  const now = new Date();
  let update;
  if (locked) {
    const unlocksAt = new Date(now.getTime() + (lockMs || 0));
    update = {
      $inc: { treasury: amount, treasury_locked: amount },
      $push: {
        locked_entries: {
          amount,
          unlocksAt,
          source,
          ...meta,
        },
      },
      $set: { updated_at: now },
    };
  } else {
    update = {
      $inc: { treasury: amount, treasury_current: amount },
      $set: { updated_at: now },
    };
  }
  const upd = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: clubId, disbanded_at: null },
    update,
    { returnDocument: "after" },
  ).catch(() => null);
  const updDoc = upd?.value || upd;
  if (!updDoc) return null;
  await client.guildClubLogsCollection.insertOne({
    guild_club_id: clubId,
    user_id: null,
    amount,
    source,
    meta: meta || {},
    createdAt: now,
  }).catch(() => {});
  return updDoc;
}

async function distribute(client, guild, settlement) {
  // BOSS 逃離＝討伐失敗，不發放任何金幣、稀有材料、公會分潤與稱號。
  if (!settlement.rewarded) {
    settlement.guildAggregates = [];
    return;
  }
  const guildId = guild?.id || settlement.bossDoc.guild_id;
  // 預先建立 userId → membership 快取（B/C 都會用到）
  const userIds = new Set();
  for (const p of settlement.payouts) userIds.add(p.userId);
  if (settlement.killerUserId) userIds.add(settlement.killerUserId);
  if (settlement.mvpUserId) userIds.add(settlement.mvpUserId);
  if (settlement.firstStrikerUserId) userIds.add(settlement.firstStrikerUserId);
  const membershipByUser = new Map();
  for (const uid of userIds) {
    const m = await lookupMembership(client, uid, guildId);
    if (m) membershipByUser.set(uid, m);
  }

  // 公會聚合（每場結算一次，避免每攻擊一次寫庫）
  const sync = boss?.guildSync || {};
  const dmgContribRatio = sync.damageContributionRatio || 0;
  const dmgTreasuryRatio = sync.damageTreasuryRatio || 0;
  const killerTreasuryRatio = sync.killerTreasuryRatio || 0;
  const mvpTreasuryRatio = sync.mvpTreasuryRatio || 0;
  const lockMs = (sync.treasuryLockHours || 0) * 3600 * 1000;
  // perClub: { clubId: { name, dmgSum, dripTreasury, lockedTreasury, lockedBreakdown } }
  const perClub = new Map();
  const getBucket = (m) => {
    if (!perClub.has(m.guild_club_id)) {
      perClub.set(m.guild_club_id, {
        name: m.name,
        level: m.level,
        dmgSum: 0,
        contributors: 0,
        dripTreasury: 0,
        lockedTreasury: 0,
        lockedBreakdown: { killer: 0, mvp: 0 },
      });
    }
    return perClub.get(m.guild_club_id);
  };

  for (const p of settlement.payouts) {
    const member = await fetchMember(guild, p.userId);
    const username = member?.user?.username || p.username || p.userId;

    if (p.share > 0) {
      await grantCoins(client, {
        userId: p.userId,
        guildId,
        username,
        member,
        amount: p.share,
        source: "boss_loot",
      }).catch((e) => console.log(`[BOSS] grant share fail ${p.userId}: ${e.message}`.red));
    }
    if (p.killBonus > 0) {
      await grantCoins(client, {
        userId: p.userId,
        guildId,
        username,
        member,
        amount: p.killBonus,
        source: "boss_kill_bonus",
      }).catch(() => {});
    }
    if (p.killerBonus) {
      await grantCoins(client, {
        userId: p.userId,
        guildId,
        username,
        member,
        amount: p.killerBonus,
        source: "boss_killer",
      }).catch(() => {});
    }
    if (p.firstStrikeBonus) {
      await grantCoins(client, {
        userId: p.userId,
        guildId,
        username,
        member,
        amount: p.firstStrikeBonus,
        source: "boss_first_strike",
      }).catch(() => {});
    }
    // 擊殺加碼經驗：把牠打死時，所有有輸出的參戰者多拿一筆 XP（結算獎勵）。
    const killXpBonus = boss?.rewards?.killXpBonus ?? 0;
    if (settlement.killRewarded && killXpBonus > 0 && p.damage > 0) {
      const xp = await grantActivityXp(client, "boss", {
        userId: p.userId,
        guildId,
        username,
        member,
        amount: killXpBonus,
        meta: { boss_id: settlement.bossDoc.boss_id, kind: "kill_bonus" },
      });
      p.xpBonus = xp;
    }
    const totalRare = (p.rareReward || 0) + (p.killerRare || 0);
    if (totalRare > 0) {
      await grantRare(client, { userId: p.userId, guildId, qty: totalRare });
    }
    if ((p.diamondReward || 0) > 0) {
      await client.miningProfilesCollection.updateOne(
        { userId: p.userId, guildId },
        {
          $inc: { "backpack.diamond": p.diamondReward, "lifetime_ore.diamond": p.diamondReward },
          $set: { updatedAt: new Date() },
        },
        { upsert: true },
      ).catch(() => {});
    }

    // ── B: 個人公會貢獻 ──────────────────────────────
    const mb = membershipByUser.get(p.userId);
    if (mb && sync.enabled !== false && dmgContribRatio > 0 && p.damage > 0) {
      const contribPoints = Math.floor(p.damage * dmgContribRatio);
      if (contribPoints > 0) {
        await guildClubContribution.addContribution(client, {
          userId: p.userId,
          guildId,
          guildClubId: mb.guild_club_id,
          amount: contribPoints,
        }).catch(() => {});
        p.guildContribution = contribPoints;
        p.guildClubName = mb.name;
      }
    }

    // ── 公會聚合（drip + C 用）──────────────────────
    if (mb && sync.enabled !== false) {
      const bucket = getBucket(mb);
      if (p.damage > 0) bucket.dmgSum += p.damage;
      bucket.contributors += 1;
      if (dmgTreasuryRatio > 0 && p.damage > 0) {
        bucket.dripTreasury += Math.floor(p.damage * dmgTreasuryRatio);
      }
      const isKiller = settlement.killerUserId === p.userId;
      const isMvp = settlement.mvpUserId === p.userId;
      if (isKiller && killerTreasuryRatio > 0 && (p.killerBonus || 0) > 0) {
        const cut = Math.floor((p.killerBonus || 0) * killerTreasuryRatio);
        if (cut > 0) {
          bucket.lockedTreasury += cut;
          bucket.lockedBreakdown.killer += cut;
        }
      }
      if (isMvp && mvpTreasuryRatio > 0 && (p.share || 0) > 0) {
        const cut = Math.floor((p.share || 0) * mvpTreasuryRatio);
        if (cut > 0) {
          bucket.lockedTreasury += cut;
          bucket.lockedBreakdown.mvp += cut;
        }
      }
    }
  }

  // ── 公會聚合入帳（drip 直入可分配 / 鎖定條目）──────
  const guildAggregates = [];
  for (const [clubId, b] of perClub.entries()) {
    let totalDeposited = 0;
    if (b.dripTreasury > 0) {
      await depositToClub(client, {
        clubId,
        amount: b.dripTreasury,
        locked: false,
        source: "boss_damage_share",
        meta: {
          boss_id: settlement.bossDoc.boss_id,
          damage_sum: b.dmgSum,
          contributors: b.contributors,
        },
      }).catch(() => {});
      totalDeposited += b.dripTreasury;
    }
    if (b.lockedTreasury > 0) {
      await depositToClub(client, {
        clubId,
        amount: b.lockedTreasury,
        locked: true,
        source: "boss_bonus_share",
        meta: {
          boss_id: settlement.bossDoc.boss_id,
          breakdown: b.lockedBreakdown,
          lockHours: sync.treasuryLockHours || 0,
        },
        lockMs,
      }).catch(() => {});
      totalDeposited += b.lockedTreasury;
    }
    guildAggregates.push({
      guild_club_id: clubId,
      name: b.name,
      level: b.level,
      damage: b.dmgSum,
      contributors: b.contributors,
      treasuryAdded: totalDeposited,
      treasuryLocked: b.lockedTreasury,
      treasuryUnlocked: b.dripTreasury,
    });
  }
  guildAggregates.sort((a, b) => b.damage - a.damage);
  settlement.guildAggregates = guildAggregates;
  settlement.guildSync = sync;

  // 稱號授予
  if (settlement.killerUserId) {
    const member = await fetchMember(guild, settlement.killerUserId);
    await gameTitleService.grant(client, {
      userId: settlement.killerUserId,
      guildId,
      member,
      titleId: "dragon_slayer",
      source: "boss",
    }).catch(() => {});
    // 屠龍累積與地下城 mini-BOSS 共用 dragon_slayer_kills；龍裔由 RESOLVER 統一判定
    await client.miningProfilesCollection?.updateOne(
      { userId: settlement.killerUserId, guildId },
      { $inc: { dragon_slayer_kills: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true },
    ).catch(() => {});
    await gameTitleService.check(
      client,
      { userId: settlement.killerUserId, guildId, member },
      ["boss"],
    ).catch(() => {});
  }
  if (settlement.mvpUserId) {
    const member = await fetchMember(guild, settlement.mvpUserId);
    await gameTitleService.grant(client, {
      userId: settlement.mvpUserId,
      guildId,
      member,
      titleId: "boss_mvp",
      source: "boss",
    }).catch(() => {});
  }
  if (settlement.comboMvpUserId) {
    const member = await fetchMember(guild, settlement.comboMvpUserId);
    await gameTitleService.grant(client, {
      userId: settlement.comboMvpUserId,
      guildId,
      member,
      titleId: "combo_starter",
      source: "boss",
    }).catch(() => {});
  }
  if (settlement.punchingBagUserId) {
    const member = await fetchMember(guild, settlement.punchingBagUserId);
    await gameTitleService.grant(client, {
      userId: settlement.punchingBagUserId,
      guildId,
      member,
      titleId: "punching_bag",
      source: "boss",
    }).catch(() => {});
  }
}

module.exports = { distribute };
