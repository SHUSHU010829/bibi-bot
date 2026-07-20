// BOSS 共鬥排程（Phase C）
//
// 兩個 job：
//   1. boss.saturday_spawn — 每週六 21:00 在主伺服器召喚 BOSS
//   2. boss.expiry_sweep   — 每分鐘掃過期 / 剛被擊殺但還沒結算的 BOSS，補做結算
//
// 結算流程：bossEngine.settleBoss → bossRewards.distribute → bossAnnouncer.announceSettlement。
require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { boss, serverId } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossRewards = require("../../features/boss/bossRewards");
const bossAnnouncer = require("../../features/boss/bossAnnouncer");
const bossTreasure = require("../../features/boss/bossTreasure");

async function spawnSaturday(client) {
  const guildId = serverId;
  if (!guildId) return;
  const existing = await bossEngine.getActiveBoss(client, guildId);
  if (existing) {
    console.log(`[BOSS] saturday_spawn skip：${existing.boss_id} 仍在進行中`.gray);
    return;
  }
  const spec = boss?.saturdaySpawn || {};
  const res = await bossEngine.spawnBoss(client, {
    guildId,
    name: spec.name,
    emoji: spec.emoji,
  });
  if (res.ok) {
    console.log(`[BOSS] spawned ${res.boss.boss_id} hp=${res.boss.max_hp}`.cyan);
    await bossAnnouncer.announceSpawn(client, res.boss);
  }
}

async function expirySweep(client) {
  const guildId = serverId;
  const guild = guildId ? client.guilds.cache.get(guildId) : null;

  // 1. 被擊殺但還沒結算的 → 補做結算
  const defeated = await bossEngine.findFreshlyDefeatedBosses(client);
  for (const d of defeated) {
    const settlement = await bossEngine.settleBoss(client, d);
    if (settlement) {
      await bossRewards.distribute(client, guild, settlement);
      await bossAnnouncer.announceSettlement(client, settlement);
    }
  }

  // 2. 時間到的 active → 標記 expired + 結算
  const expired = await bossEngine.findExpiredActiveBosses(client);
  for (const e of expired) {
    const settlement = await bossEngine.settleBoss(client, e);
    if (settlement) {
      await bossRewards.distribute(client, guild, settlement);
      await bossAnnouncer.announceSettlement(client, settlement);
    }
  }

  // 3. 亂入寶箱：對進行中的 BOSS 收過期寶箱 / 機率生成新寶箱
  await bossTreasure.tick(client, guild).catch((e) =>
    console.log(`[BOSS] treasure tick failed: ${e.message}`.red),
  );
}

module.exports = (client) => {
  if (!boss?.enabled) return;
  const spec = boss?.saturdaySpawn || {};
  if (spec.schedule) {
    registerCron(client, {
      name: "boss.saturday_spawn",
      label: "BOSS 週六召喚",
      schedule: spec.schedule,
      timezone: spec.timezone || "Asia/Taipei",
      runner: () => spawnSaturday(client),
    });
  }
  registerCron(client, {
    name: "boss.expiry_sweep",
    label: "BOSS 到期 / 擊殺結算掃描",
    schedule: "* * * * *",
    timezone: "Asia/Taipei",
    runner: () => expirySweep(client),
  });
};
