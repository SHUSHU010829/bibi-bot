require("colors");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { theft } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const buffResolver = require("../buff/buffResolver");
const theftProfile = require("./theftProfile");

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 累進級距：每一段錢包只抽該段的比例，越後面的錢比例越低。
// 大戶總額仍隨財富上升，但邊際遞減，避免鯨魚一次被搬空。
function grossSteal(wallet, brackets) {
  if (!Array.isArray(brackets) || !brackets.length) return 0;
  let prev = 0;
  let total = 0;
  for (const b of brackets) {
    const upper = b.upTo == null ? Infinity : b.upTo;
    const width = Math.max(0, Math.min(wallet, upper) - prev);
    total += width * (b.pct || 0);
    prev = upper;
    if (wallet <= upper) break;
  }
  return Math.floor(total);
}

function cfg() {
  return theft || {};
}
function tz() {
  return cfg().timezone || "Asia/Taipei";
}
function dayKey() {
  return DateTime.now().setZone(tz()).toISODate();
}
function dayStart() {
  return DateTime.now().setZone(tz()).startOf("day").toJSDate();
}

// 非阻塞觸發盜賊類稱號解鎖檢查（慣竊 / 賞金獵人）。
function checkTheftTitles(client, userId, guildId, member) {
  try {
    require("../gameTitles/gameTitleService")
      .check(client, { userId, guildId, member }, ["theft"])
      .catch(() => {});
  } catch (_) {
    /* gameTitleService 未載入就靜默 */
  }
}

async function getWallet(client, userId, guildId) {
  const doc = await client.userCoinsCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  return { balance: doc?.totalCoins || 0, createdAt: doc?.createdAt || null };
}

async function activeWanted(client, userId, guildId) {
  return client.wantedListCollection
    .findOne({ userId, guildId, status: "wanted" })
    .catch(() => null);
}

async function logEvent(client, doc) {
  return client.theftLogsCollection
    .insertOne({ ...doc, day: dayKey(), ts: new Date() })
    .catch((e) => console.log(`[THEFT] log insert 失敗：${e.message}`.yellow));
}

// ── /偷竊 ─────────────────────────────────────────────
async function steal(client, { guildId, actorId, actorName, targetId, targetName, member }) {
  const c = cfg();
  if (!c.enabled || !client.wantedListCollection || !client.theftLogsCollection) {
    return { ok: false, reason: "disabled" };
  }
  const s = c.steal || {};

  // 自己通緝中不可偷
  if (await activeWanted(client, actorId, guildId)) {
    return { ok: false, reason: "self_wanted" };
  }

  // 賞金本金門檻：錢包須付得起失風的託管賞金
  const actorWallet = await getWallet(client, actorId, guildId);
  const bountyMin = c.bountyMin ?? 300;
  if (actorWallet.balance < bountyMin) {
    return { ok: false, reason: "no_bounty_funds", need: bountyMin, have: actorWallet.balance };
  }

  // 每日次數
  const dailyLimit = c.dailyLimit ?? 3;
  const todaySteals = await client.theftLogsCollection
    .countDocuments({ guildId, type: "steal", actor_id: actorId, ts: { $gte: dayStart() } })
    .catch(() => 0);
  if (todaySteals >= dailyLimit) {
    return { ok: false, reason: "daily_limit", dailyLimit, todayCount: todaySteals };
  }

  // 同目標冷卻
  const pairCdMs = c.samePairCooldownMs ?? 0;
  if (pairCdMs > 0) {
    const recent = await client.theftLogsCollection
      .findOne(
        { guildId, type: "steal", actor_id: actorId, target_id: targetId },
        { sort: { ts: -1 } }
      )
      .catch(() => null);
    if (recent?.ts) {
      const readyAt = new Date(recent.ts).getTime() + pairCdMs;
      if (Date.now() < readyAt) return { ok: false, reason: "pair_cooldown", readyAt };
    }
  }

  // 目標保護
  const targetWallet = await getWallet(client, targetId, guildId);
  const newbieDays = c.newbieProtectDays ?? 7;
  if (!targetWallet.createdAt) {
    return { ok: false, reason: "target_newbie" };
  }
  const ageDays = DateTime.now().diff(DateTime.fromJSDate(targetWallet.createdAt), "days").days;
  if (ageDays < newbieDays) {
    return { ok: false, reason: "target_newbie" };
  }
  const minWallet = c.minTargetWallet ?? 500;
  if (targetWallet.balance < minWallet) {
    return { ok: false, reason: "target_poor", minWallet };
  }

  const targetProfile = await theftProfile.getOrCreate(client, targetId, guildId);
  // 看門狗：完全免疫下一次偷竊，擋一次即消耗
  if ((targetProfile.watchdog_count || 0) > 0) {
    await client.theftProfilesCollection.updateOne(
      { userId: targetId, guildId },
      { $inc: { watchdog_count: -1 }, $set: { updatedAt: new Date() } }
    );
    return { ok: false, reason: "target_watchdog" };
  }
  // 當日被偷上限
  const maxStolen = c.maxStolenPerDayPerTarget ?? 3;
  const targetStolenToday = await client.theftLogsCollection
    .countDocuments({
      guildId,
      type: "steal",
      target_id: targetId,
      success: true,
      ts: { $gte: dayStart() },
    })
    .catch(() => 0);
  if (targetStolenToday >= maxStolen) {
    return { ok: false, reason: "target_maxed" };
  }

  // 成功率
  const actorProf = await theftProfile.getOrCreate(client, actorId, guildId);
  const notoriety = actorProf.notoriety_effective || 0;
  let rate = (s.baseRate ?? 0.55) + Math.min(
    notoriety * (s.notorietyRatePer ?? 0.01),
    s.notorietyRateCap ?? 0.15
  );
  // 夜行衣（攻方，消耗一次）
  const usedCloak = (actorProf.night_cloak_count || 0) > 0;
  if (usedCloak) rate += c.defense?.cloakRate ?? 0.15;
  // 保險箱（守方，降低被偷率）
  if (theftProfile.safeboxActive(targetProfile)) rate -= c.defense?.safeboxRate ?? 0.2;
  rate = clamp(rate, s.minRate ?? 0.15, s.maxRate ?? 0.85);

  const success = Math.random() < rate;

  if (usedCloak) {
    await client.theftProfilesCollection.updateOne(
      { userId: actorId, guildId },
      { $inc: { night_cloak_count: -1 }, $set: { updatedAt: new Date() } }
    );
  }

  if (success) {
    // 上限用惡名解鎖：新手封在 baseCap，越資深的慣竊才偷得到大額
    const hardCap = s.hardCap ?? 12000;
    const stealCap = Math.min(
      (s.baseCap ?? 3000) + notoriety * (s.capPerNotoriety ?? 300),
      hardCap
    );
    const gross = grossSteal(targetWallet.balance, s.brackets);
    let stolen = clamp(gross, s.stealMin ?? 100, stealCap);
    stolen = Math.min(stolen, targetWallet.balance);
    // 被惡名上限壓住（且還有成長空間）→ 提示玩家再有名一點能偷更多
    const cappedByNotoriety = gross > stealCap && stealCap < hardCap;
    const rake = Math.floor(stolen * (s.blackMarketRakePct ?? 0.2));
    const net = stolen - rake;

    const debit = await grantCoins(client, {
      userId: targetId,
      guildId,
      username: targetName,
      amount: -stolen,
      source: "steal_loss",
      meta: { actorId },
    });
    if (!debit) return { ok: false, reason: "race" };

    const credit = await grantCoins(client, {
      userId: actorId,
      guildId,
      username: actorName,
      amount: net,
      source: "steal_gain",
      member,
      meta: { targetId, gross: stolen, rake },
    });

    await client.theftProfilesCollection.updateOne(
      { userId: actorId, guildId },
      {
        $inc: { lifetime_stolen: stolen, steal_success: 1 },
        $set: { last_steal_date: dayKey(), updatedAt: new Date() },
      }
    );
    await theftProfile.adjustNotoriety(client, actorId, guildId, c.notoriety?.successGain ?? 1);
    await logEvent(client, {
      guildId,
      type: "steal",
      actor_id: actorId,
      target_id: targetId,
      success: true,
      amount: stolen,
      net,
    });

    checkTheftTitles(client, actorId, guildId, member);

    return {
      ok: true,
      success: true,
      stolen,
      net,
      rake,
      usedCloak,
      notoriety,
      stealCap,
      cappedByNotoriety,
      newBalance: credit?.doc?.totalCoins ?? null,
    };
  }

  // 失手 → 通緝，賞金從錢包託管
  await client.theftProfilesCollection.updateOne(
    { userId: actorId, guildId },
    { $inc: { steal_fail: 1 }, $set: { last_steal_date: dayKey(), updatedAt: new Date() } }
  );
  const settledNotoriety = await theftProfile.adjustNotoriety(
    client,
    actorId,
    guildId,
    c.notoriety?.failGain ?? 2
  );

  const b = c.bounty || {};
  const currentWallet = (await getWallet(client, actorId, guildId)).balance;
  let bounty = clamp(
    Math.floor(
      (b.base ?? 500) +
        settledNotoriety * (b.perNotoriety ?? 50) +
        (actorProf.lifetime_stolen || 0) * (b.stolenPct ?? 0.05)
    ),
    bountyMin,
    Math.min(b.max ?? 8000, currentWallet)
  );

  const escrow = await grantCoins(client, {
    userId: actorId,
    guildId,
    username: actorName,
    amount: -bounty,
    source: "bounty_escrow",
    meta: { targetId },
  });
  if (!escrow) return { ok: false, reason: "race" };

  const wantedId = crypto.randomUUID();
  const expiresAt = Date.now() + (b.wantedTtlHours ?? 48) * 3600 * 1000;
  await client.wantedListCollection.updateOne(
    { userId: actorId, guildId },
    {
      $set: {
        wanted_id: wantedId,
        userId: actorId,
        guildId,
        username: actorName,
        status: "wanted",
        bounty,
        reason_target_id: targetId,
        notoriety_at: settledNotoriety,
        created_at: new Date(),
        expires_at: new Date(expiresAt),
        hunt_cooldown_until: 0,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );
  await logEvent(client, {
    guildId,
    type: "steal",
    actor_id: actorId,
    target_id: targetId,
    success: false,
    amount: 0,
  });

  return { ok: true, success: false, bounty, expiresAt };
}

// ── /追捕 ─────────────────────────────────────────────
async function huntWanted(client, { guildId, hunterId, hunterName, wantedUserId, member }) {
  const c = cfg();
  if (!c.enabled || !client.wantedListCollection) return { ok: false, reason: "disabled" };
  const h = c.hunt || {};

  if (hunterId === wantedUserId) return { ok: false, reason: "self" };

  const wanted = await activeWanted(client, wantedUserId, guildId);
  if (!wanted) return { ok: false, reason: "not_wanted" };

  // 逃脫冷卻：上一次有人追捕失敗後，通緝犯躲起來一陣子，期間任何人都不能追捕
  if (wanted.hunt_cooldown_until && Date.now() < wanted.hunt_cooldown_until) {
    return { ok: false, reason: "hunt_cooldown", readyAt: wanted.hunt_cooldown_until };
  }

  const huntLimit = h.dailyLimit ?? 3;
  const todayHunts = await client.theftLogsCollection
    .countDocuments({ guildId, type: "hunt", actor_id: hunterId, ts: { $gte: dayStart() } })
    .catch(() => 0);
  if (todayHunts >= huntLimit) {
    return { ok: false, reason: "daily_limit", dailyLimit: huntLimit, todayCount: todayHunts };
  }

  // 鎖定，避免同一通緝被兩人同時處理
  const locked = await client.wantedListCollection.findOneAndUpdate(
    { userId: wantedUserId, guildId, status: "wanted" },
    { $set: { status: "resolving", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  const [hunterAtk, wantedAtk] = await Promise.all([
    buffResolver.getEffectiveAtk(client, hunterId, guildId).catch(() => 0),
    buffResolver.getEffectiveAtk(client, wantedUserId, guildId).catch(() => 0),
  ]);
  const rate = clamp(
    (h.baseRate ?? 0.5) + (hunterAtk - wantedAtk) * (h.atkDiffScale ?? 0.003),
    h.minRate ?? 0.2,
    h.maxRate ?? 0.8
  );
  const success = Math.random() < rate;

  if (!success) {
    // 逃脫：復原通緝狀態，並讓通緝犯躲起來一段冷卻，期間不可再被追捕
    // 冷卻隨通緝犯惡名遞增——越大尾的逃犯躲越久
    const wantedNotoriety = wanted.notoriety_at || 0;
    const cooldownMs = Math.min(
      (h.escapeCooldownBaseMs ?? 1800000) +
        wantedNotoriety * (h.escapeCooldownPerNotorietyMs ?? 300000),
      h.escapeCooldownMaxMs ?? 10800000
    );
    const cooldownUntil = Date.now() + cooldownMs;
    await client.wantedListCollection.updateOne(
      { userId: wantedUserId, guildId },
      { $set: { status: "wanted", hunt_cooldown_until: cooldownUntil, updated_at: new Date() } }
    );
    await logEvent(client, {
      guildId,
      type: "hunt",
      actor_id: hunterId,
      target_id: wantedUserId,
      success: false,
      amount: 0,
    });
    return { ok: true, success: false, hunterAtk, wantedAtk, bounty: wanted.bounty, cooldownUntil };
  }

  // 抓到：託管賞金給獵人
  const payout = await grantCoins(client, {
    userId: hunterId,
    guildId,
    username: hunterName,
    amount: wanted.bounty,
    source: "bounty_payout",
    member,
    meta: { wantedUserId, wantedId: wanted.wanted_id },
  });

  // 贖罪金：從通緝犯當下錢包扣，一半給獵人、一半銷毀
  const wantedWallet = (await getWallet(client, wantedUserId, guildId)).balance;
  const fine = Math.floor(wantedWallet * (h.caughtFinePct ?? 0.1));
  let hunterFineShare = 0;
  if (fine > 0) {
    const fineDebit = await grantCoins(client, {
      userId: wantedUserId,
      guildId,
      username: wanted.username,
      amount: -fine,
      source: "bounty_fine",
      meta: { hunterId },
    });
    if (fineDebit) {
      hunterFineShare = Math.floor(fine / 2);
      if (hunterFineShare > 0) {
        await grantCoins(client, {
          userId: hunterId,
          guildId,
          username: hunterName,
          amount: hunterFineShare,
          source: "bounty_fine_reward",
          member,
          meta: { wantedUserId },
        });
      }
    }
  }

  await client.wantedListCollection.updateOne(
    { userId: wantedUserId, guildId },
    { $set: { status: "caught", caught_by: hunterId, caught_at: new Date(), updated_at: new Date() } }
  );
  await theftProfile.adjustNotoriety(client, wantedUserId, guildId, -(c.notoriety?.caughtLoss ?? 2));
  await client.theftProfilesCollection.updateOne(
    { userId: hunterId, guildId },
    { $inc: { hunt_success: 1 }, $set: { updatedAt: new Date() } }
  );
  await logEvent(client, {
    guildId,
    type: "hunt",
    actor_id: hunterId,
    target_id: wantedUserId,
    success: true,
    amount: wanted.bounty + hunterFineShare,
  });

  checkTheftTitles(client, hunterId, guildId, member);

  return {
    ok: true,
    success: true,
    bounty: wanted.bounty,
    fine,
    hunterFineShare,
    hunterAtk,
    wantedAtk,
    hunterBalance: payout?.doc?.totalCoins ?? null,
  };
}

// ── /自首 ─────────────────────────────────────────────
async function surrender(client, { guildId, userId, username, member }) {
  const c = cfg();
  if (!c.enabled || !client.wantedListCollection) return { ok: false, reason: "disabled" };

  const locked = await client.wantedListCollection.findOneAndUpdate(
    { userId, guildId, status: "wanted" },
    { $set: { status: "resolving", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const wanted = locked?.value || locked;
  if (!wanted) return { ok: false, reason: "not_wanted" };

  const bail = Math.floor(wanted.bounty * (c.surrender?.bailForfeitPct ?? 0.6));
  // 先全額退回託管，再沒收保釋（帳本清楚）
  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: wanted.bounty,
    source: "bounty_refund",
    member,
    meta: { reason: "surrender", wantedId: wanted.wanted_id },
  });
  if (bail > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: -bail,
      source: "bail",
      meta: { wantedId: wanted.wanted_id },
    });
  }

  await client.wantedListCollection.updateOne(
    { userId, guildId },
    { $set: { status: "surrendered", updated_at: new Date() } }
  );
  await theftProfile.adjustNotoriety(client, userId, guildId, -(c.notoriety?.surrenderLoss ?? 1));

  return { ok: true, bail, refunded: wanted.bounty - bail, bounty: wanted.bounty };
}

// ── /報案 ─────────────────────────────────────────────
async function report(client, { guildId, userId, username }) {
  const c = cfg();
  if (!c.enabled || !client.theftLogsCollection) return { ok: false, reason: "disabled" };
  const r = c.report || {};

  const fee = r.detectiveFee ?? 500;
  const wallet = (await getWallet(client, userId, guildId)).balance;
  if (wallet < fee) return { ok: false, reason: "insufficient", fee, have: wallet };

  const since = new Date(Date.now() - (r.windowHours ?? 24) * 3600 * 1000);
  const events = await client.theftLogsCollection
    .find({ guildId, type: "steal", target_id: userId, success: true, ts: { $gte: since } })
    .sort({ ts: -1 })
    .toArray()
    .catch(() => []);

  // 沒有任何案件可查 → 退費（無事可查不收錢）
  if (!events.length) {
    return { ok: true, charged: false, found: false, culprits: [], noCase: true };
  }

  // 收委託費
  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -fee,
    source: "detective_fee",
    meta: {},
  });

  const investigateRate = r.investigateRate ?? 0.7;
  const byActor = new Map();
  for (const ev of events) {
    if (Math.random() >= investigateRate) continue; // 這筆查不出來
    const cur = byActor.get(ev.actor_id) || { actorId: ev.actor_id, amount: 0, count: 0 };
    cur.amount += ev.amount || 0;
    cur.count += 1;
    byActor.set(ev.actor_id, cur);
  }
  const culprits = [...byActor.values()].sort((a, b) => b.amount - a.amount);

  let refunded = false;
  if (!culprits.length && r.refundOnMiss) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: fee,
      source: "bounty_refund",
      meta: { reason: "detective_miss_refund" },
    });
    refunded = true;
  }

  return {
    ok: true,
    charged: true,
    found: culprits.length > 0,
    culprits,
    fee,
    refunded,
    totalCases: events.length,
  };
}

async function listWanted(client, guildId) {
  if (!client.wantedListCollection) return [];
  const rows = await client.wantedListCollection
    .find({ guildId, status: "wanted" })
    .sort({ bounty: -1 })
    .limit(25)
    .toArray()
    .catch(() => []);
  for (const row of rows) {
    row.wallet = (await getWallet(client, row.userId, guildId)).balance;
  }
  return rows;
}

// ── cron：通緝時效到期 → 退回託管賞金、惡名 −1 ──────────
async function expireWanted(client, wanted) {
  const locked = await client.wantedListCollection.findOneAndUpdate(
    { userId: wanted.userId, guildId: wanted.guildId, status: "wanted" },
    { $set: { status: "resolving", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return false;

  await grantCoins(client, {
    userId: wanted.userId,
    guildId: wanted.guildId,
    username: wanted.username,
    amount: wanted.bounty,
    source: "bounty_refund",
    meta: { reason: "wanted_expired", wantedId: wanted.wanted_id },
  }).catch(() => {});
  await client.wantedListCollection.updateOne(
    { userId: wanted.userId, guildId: wanted.guildId },
    { $set: { status: "expired", updated_at: new Date() } }
  );
  await theftProfile
    .adjustNotoriety(client, wanted.userId, wanted.guildId, -(cfg().notoriety?.expireLoss ?? 1))
    .catch(() => {});
  return true;
}

module.exports = {
  steal,
  huntWanted,
  surrender,
  report,
  listWanted,
  activeWanted,
  expireWanted,
  getWallet,
};
