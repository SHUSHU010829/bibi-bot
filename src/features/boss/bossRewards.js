require("colors");
const { boss } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const gameTitleService = require("../gameTitles/gameTitleService");
const bossEngine = require("./bossEngine");

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

async function distribute(client, guild, settlement) {
  const guildId = guild?.id || settlement.bossDoc.guild_id;
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
    const totalRare = (p.rareReward || 0) + (p.killerRare || 0);
    if (totalRare > 0) {
      await grantRare(client, { userId: p.userId, guildId, qty: totalRare });
    }
  }

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
    const kills = await bossEngine.incrementKillCount(client, {
      userId: settlement.killerUserId,
      guildId,
    });
    const threshold = boss?.rewards?.dragonHeirThreshold ?? 10;
    if (kills >= threshold) {
      await gameTitleService.grant(client, {
        userId: settlement.killerUserId,
        guildId,
        member,
        titleId: "dragon_heir",
        source: "boss",
      }).catch(() => {});
    }
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
