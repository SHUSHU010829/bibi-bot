// BOSS 共鬥排程（Phase C）
//
// 三個 job：
//   1. boss.saturday_spawn — 每週六 21:00 在主伺服器召喚 BOSS
//   2. boss.saturday_notice — 週六場出沒前 preNotice.minutesBefore 分鐘的小通知
//   3. boss.expiry_sweep   — 每分鐘掃過期 / 剛被擊殺但還沒結算的 BOSS，補做結算
//      （同一支掃描也負責「召喚場預約」的預告與登場，見 bossSummon.tickPending）
//
// 結算流程：bossEngine.settleBoss → bossRewards.distribute → bossAnnouncer.announceSettlement。
require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { boss, serverId } = require("../../config");
const bossEngine = require("../../features/boss/bossEngine");
const bossRewards = require("../../features/boss/bossRewards");
const bossAnnouncer = require("../../features/boss/bossAnnouncer");
const bossTreasure = require("../../features/boss/bossTreasure");
const bossSkills = require("../../features/boss/bossSkills");
const bossBoard = require("../../features/boss/bossBoard");
const bossSummon = require("../../features/boss/bossSummon");

async function spawnSaturday(client) {
  const guildId = serverId;
  if (!guildId) return;
  const existing = await bossEngine.getActiveBoss(client, guildId);
  if (existing) {
    console.log(`[BOSS] saturday_spawn skip：${existing.boss_id} 仍在進行中`.gray);
    return;
  }
  const spec = boss?.saturdaySpawn || {};
  // 週六場是全社群集合的主場，血量另外吃 saturdaySpawn.hpMult（跟召喚場的 summonHpMult 分開調）。
  const res = await bossEngine.spawnBoss(client, {
    guildId,
    name: spec.name,
    emoji: spec.emoji,
    hpMult: spec.hpMult ?? 1,
  });
  if (res.ok) {
    console.log(`[BOSS] spawned ${res.boss.boss_id} hp=${res.boss.max_hp}`.cyan);
    await bossAnnouncer.announceSpawn(client, res.boss);
  }
}

// 週六場的預告：cron 排在出沒前 minutesBefore 分鐘，出沒時刻就是「現在 + minutesBefore」。
async function saturdayNotice(client) {
  const guildId = serverId;
  if (!guildId) return;
  const existing = await bossEngine.getActiveBoss(client, guildId);
  if (existing) return; // 場上已有魔王，週六場本來就會被跳過，預告也不用發
  const minutes = boss?.preNotice?.minutesBefore ?? 10;
  await bossAnnouncer.announcePreNotice(client, {
    spawnAt: Date.now() + minutes * 60 * 1000,
    source: "saturday",
  });
}

// 把 cron 的「分 時」往前挪 N 分鐘，用來排週六場的預告。
// 只處理固定的分/時（週六場就是這種）；跨日或含 * / 清單的寫法要連星期欄一起挪，直接放棄不發預告。
function shiftCronMinutes(expr, minutes) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [m, h, ...rest] = parts;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return null;
  const total = Number(h) * 60 + Number(m) - minutes;
  if (total < 0) return null;
  return [total % 60, Math.floor(total / 60), ...rest].join(" ");
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

  // 3. 魔王技能：收過期技能 / 脫戰回血 / 到點施放新技能
  await skillTick(client, guildId).catch((e) =>
    console.log(`[BOSS] skill tick failed: ${e.message}`.red),
  );

  // 4. 亂入寶箱：對進行中的 BOSS 收過期寶箱 / 機率生成新寶箱
  await bossTreasure.tick(client, guild).catch((e) =>
    console.log(`[BOSS] treasure tick failed: ${e.message}`.red),
  );

  // 5. 討伐能量已滿但當時卡在冷卻 / 週次 / 場上有王：這些條件是時間到自己解除的，
  //    不能只靠下一次地下城通關來觸發（貢獻上限扣完的社群可能等不到），每分鐘重試一次。
  if (guildId && boss?.summon?.enabled) {
    // 已預約的召喚場：到點發預告 / 到點登場（順延也在這裡處理）。
    await bossSummon.tickPending(client, guildId).catch((e) =>
      console.log(`[BOSS] summon pending tick failed: ${e.message}`.red),
    );
    await bossSummon.trySummon(client, guildId).catch((e) =>
      console.log(`[BOSS] summon retry failed: ${e.message}`.red),
    );
  }
}

async function skillTick(client, guildId) {
  if (!guildId) return;
  const bossDoc = await bossEngine.getActiveBoss(client, guildId);
  if (!bossDoc) return;
  const { events } = await bossSkills.tick(client, bossDoc);
  if (!events.length) return;
  await bossAnnouncer.announceSkillEvents(client, events);
  bossBoard.scheduleRefresh(client, guildId, true);
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
    const noticeSchedule = boss?.preNotice?.enabled
      ? shiftCronMinutes(spec.schedule, boss.preNotice.minutesBefore ?? 10)
      : null;
    if (noticeSchedule) {
      registerCron(client, {
        name: "boss.saturday_notice",
        label: "BOSS 週六場出沒預告",
        schedule: noticeSchedule,
        timezone: spec.timezone || "Asia/Taipei",
        runner: () => saturdayNotice(client),
      });
    }
  }
  registerCron(client, {
    name: "boss.expiry_sweep",
    label: "BOSS 到期 / 擊殺結算掃描",
    schedule: "* * * * *",
    timezone: "Asia/Taipei",
    runner: () => expirySweep(client),
  });
};
