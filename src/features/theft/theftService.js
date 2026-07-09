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

// ── 治安基金：犯罪者繳的錢（贖罪金燒掉那半 + 自首保釋）累積，週結算發給榜首獵人 ──
function fundKey(guildId) {
  return `theft_fund:${guildId}`;
}
async function addToFund(client, guildId, amount) {
  if (!client.countersCollection || !(amount > 0)) return;
  await client.countersCollection
    .updateOne(
      { _id: fundKey(guildId) },
      { $inc: { pool: amount }, $set: { updatedAt: new Date() } },
      { upsert: true }
    )
    .catch(() => {});
}
async function getFund(client, guildId) {
  if (!client.countersCollection) return 0;
  const doc = await client.countersCollection.findOne({ _id: fundKey(guildId) }).catch(() => null);
  return doc?.pool || 0;
}
// 週結算：本週賞金收入最高的獵人領走整池，池歸零。無人可領則累積到下週。
async function payoutWeeklyFund(client, guildId) {
  const f = cfg().fund || {};
  if (!client.countersCollection || !client.theftLogsCollection) return null;
  const pool = await getFund(client, guildId);
  if (pool < (f.minPool ?? 1)) return { paid: false, pool, reason: "empty" };

  const since = new Date(Date.now() - (f.weekWindowMs ?? 604800000));
  const agg = await client.theftLogsCollection
    .aggregate([
      { $match: { guildId, type: "hunt", success: true, ts: { $gte: since } } },
      { $group: { _id: "$actor_id", earned: { $sum: "$amount" }, hunts: { $sum: 1 } } },
      { $sort: { earned: -1, hunts: -1 } },
      { $limit: 1 },
    ])
    .toArray()
    .catch(() => []);
  const top = agg[0];
  if (!top) return { paid: false, pool, reason: "no_hunter" };

  await grantCoins(client, {
    userId: top._id,
    guildId,
    amount: pool,
    source: "fund_payout",
    meta: { reason: "weekly_bounty_hunter", hunts: top.hunts },
  }).catch(() => {});
  await client.countersCollection
    .updateOne({ _id: fundKey(guildId) }, { $set: { pool: 0, updatedAt: new Date() } })
    .catch(() => {});
  return { paid: true, winnerId: top._id, amount: pool, earned: top.earned, hunts: top.hunts };
}

async function logEvent(client, doc) {
  return client.theftLogsCollection
    .insertOne({ ...doc, day: dayKey(), ts: new Date() })
    .catch((e) => console.log(`[THEFT] log insert 失敗：${e.message}`.yellow));
}

// 釋放託管的賞金（脫罪 / 到期時）：
//   一般通緝＝通緝犯自己凍結的錢 → 退還本人；
//   懸賞通緝（funded_by＝報案人出的錢）→ 進治安基金，不退兇手也不退報案人。
async function releaseEscrowedBounty(client, wanted, reason) {
  if (!(wanted.bounty > 0)) return;
  if (wanted.funded_by) {
    await addToFund(client, wanted.guildId, wanted.bounty);
    return;
  }
  await grantCoins(client, {
    userId: wanted.userId,
    guildId: wanted.guildId,
    username: wanted.username,
    amount: wanted.bounty,
    source: "bounty_refund",
    meta: { reason, wantedId: wanted.wanted_id },
  }).catch(() => {});
}

// ── /偷竊 ─────────────────────────────────────────────
async function steal(client, { guildId, actorId, actorName, targetId, targetName, member }) {
  const c = cfg();
  if (!c.enabled || !client.wantedListCollection || !client.theftLogsCollection) {
    return { ok: false, reason: "disabled" };
  }
  const s = c.steal || {};

  // 自己通緝中 / 逃亡中不可偷
  const ongoing = await client.wantedListCollection
    .findOne({ userId: actorId, guildId, status: { $in: ["wanted", "fleeing", "resolving"] } })
    .catch(() => null);
  if (ongoing) {
    return { ok: false, reason: "self_wanted" };
  }

  // 自首後的假釋觀察期：期間不能再犯，代價從「純扣錢」延伸為時間成本
  const actorProf = await theftProfile.getOrCreate(client, actorId, guildId);
  if ((actorProf.parole_until || 0) > Date.now()) {
    return { ok: false, reason: "parole", until: actorProf.parole_until };
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

  // 當日被偷上限（免費保護，先擋）——已被偷滿就不該再白白消耗看門狗
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

  // 看門狗：最後一道防線，只有在目標仍可被偷時才消耗（擋一次即用掉）
  if ((targetProfile.watchdog_count || 0) > 0) {
    await client.theftProfilesCollection.updateOne(
      { userId: targetId, guildId },
      { $inc: { watchdog_count: -1 }, $set: { updatedAt: new Date() } }
    );
    // 被狗擋下仍算一次出手：記 steal log，照樣吃每日次數與同目標冷卻
    // （但不上通緝、不加惡名——被擋下不算失風）
    await logEvent(client, {
      guildId,
      type: "steal",
      actor_id: actorId,
      target_id: targetId,
      success: false,
      amount: 0,
      watchdog: true,
    });
    return {
      ok: false,
      reason: "target_watchdog",
      pairReadyAt: pairCdMs > 0 ? Date.now() + pairCdMs : null,
    };
  }

  // 成功率
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

  // 失手 → 記一次失手、惡名 +failGain（賞金先算好但尚未扣，等被逮才託管）
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

  // 失手 → 不立刻通緝：先進入「逃亡」小遊戲，甩開就清白脫身，被逮 / 逾時才上通緝榜
  const e = fleeCfg();
  const wantedTtlMs = (b.wantedTtlHours ?? 48) * 3600 * 1000;
  const fleeToken = crypto.randomUUID();
  await client.wantedListCollection.updateOne(
    { userId: actorId, guildId },
    {
      $set: {
        wanted_id: crypto.randomUUID(),
        userId: actorId,
        guildId,
        username: actorName,
        status: "fleeing",
        bounty,
        reason_target_id: targetId,
        notoriety_at: settledNotoriety,
        created_at: new Date(),
        expires_at: new Date(Date.now() + wantedTtlMs),
        hunt_cooldown_until: 0,
        escaped_hunters: [],
        escape_count: 0,
        flee: {
          distance: 0,
          token: fleeToken,
          expires_at: new Date(Date.now() + (e.runExpiresMs ?? 600000)),
        },
        updated_at: new Date(),
      },
      // 自己偷竊失風＝自己出賞金：清掉上一輪可能殘留的懸賞標記（別人出錢的 funded_by）
      $unset: { caught_by: "", caught_at: "", funded_by: "" },
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

  // 逃亡系統未啟用 → 退回舊行為：立刻通緝（當場凍結賞金）
  if (!e.enabled || !fleeRoutes(e).length) {
    const w = await becomeWanted(client, { userId: actorId, guildId, username: actorName });
    return {
      ok: true,
      success: false,
      fleeing: false,
      bounty: w?.bounty ?? bounty,
      expiresAt: w?.expiresAt ?? Date.now() + wantedTtlMs,
    };
  }

  return { ok: true, success: false, fleeing: true, token: fleeToken, bounty, stage: fleeStageInfo(e, 0) };
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

  // 每人只有一次機會：追捕失敗過的獵人，這次通緝期間不能再追同一人
  if ((wanted.escaped_hunters || []).includes(hunterId)) {
    return { ok: false, reason: "already_failed" };
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
    await logEvent(client, {
      guildId,
      type: "hunt",
      actor_id: hunterId,
      target_id: wantedUserId,
      success: false,
      amount: 0,
    });

    const escapeCount = (wanted.escape_count || 0) + 1;
    const clearAt = h.escapeClearCount ?? 5;

    // 逃脫達上限 → 成功脫罪：釋放託管賞金（自己的錢退還／懸賞金進基金）、惡名 −1、通緝解除
    if (escapeCount >= clearAt) {
      await releaseEscrowedBounty(client, wanted, "escaped_free");
      await client.wantedListCollection.updateOne(
        { userId: wantedUserId, guildId },
        { $set: { status: "escaped", escape_count: escapeCount, updated_at: new Date() } }
      );
      await theftProfile
        .adjustNotoriety(client, wantedUserId, guildId, -(c.notoriety?.expireLoss ?? 1))
        .catch(() => {});
      return { ok: true, success: false, escaped: true, escapeCount, clearAt, hunterAtk, wantedAtk, bounty: wanted.bounty };
    }

    // 尚未脫罪：復原通緝、記下這名獵人（不能再追）、進入躲藏冷卻。
    // 惡名越高躲藏 CD 越短（老手優惠，能更快洗清通緝繼續行竊），但夾在下限之上。
    const wantedNotoriety = wanted.notoriety_at || 0;
    const cooldownMs = Math.max(
      (h.escapeCooldownBaseMs ?? 240000) -
        wantedNotoriety * (h.escapeCooldownDiscountPerNotorietyMs ?? 30000),
      h.escapeCooldownMinMs ?? 60000
    );
    const cooldownUntil = Date.now() + cooldownMs;
    await client.wantedListCollection.updateOne(
      { userId: wantedUserId, guildId },
      {
        $set: { status: "wanted", hunt_cooldown_until: cooldownUntil, updated_at: new Date() },
        $addToSet: { escaped_hunters: hunterId },
        $inc: { escape_count: 1 },
      }
    );
    return { ok: true, success: false, hunterAtk, wantedAtk, bounty: wanted.bounty, cooldownUntil, escapeCount, clearAt };
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
      // 沒發給獵人的那半：一般通緝 → 進治安基金；懸賞通緝 → 補償出錢掛榜的報案人
      const otherHalf = fine - hunterFineShare;
      if (otherHalf > 0) {
        if (wanted.funded_by) {
          await grantCoins(client, {
            userId: wanted.funded_by,
            guildId,
            amount: otherHalf,
            source: "bounty_victim_compensation",
            meta: { culpritId: wantedUserId, wantedId: wanted.wanted_id },
          }).catch(() => {});
        } else {
          await addToFund(client, guildId, otherHalf);
        }
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
  const s = c.surrender || {};

  const active = await activeWanted(client, userId, guildId);

  // 懸賞通緝（別人出錢掛的）不能自首洗白：只能被追捕、或撐到時效（賞金進基金）。
  if (active?.funded_by) return { ok: false, reason: "bounty_no_surrender" };

  // 硬性前提：不管時間鎖 / 惡名優惠怎麼算，至少要被追捕過一次才能自首。
  // escape_count 為通緝期間被追捕失敗的次數，沒人挑戰過（0）就不准洗白。
  const minHunts = s.minHuntsBeforeSurrender ?? 0;
  if (active && minHunts > 0 && (active.escape_count || 0) < minHunts) {
    return {
      ok: false,
      reason: "surrender_needs_hunt",
      need: minHunts,
      have: active.escape_count || 0,
    };
  }

  // 剛上通緝榜的鎖定期：被通緝一段時間內不能立刻自首，留空窗給獵人出手。
  // 惡名越高鎖定期越短（老手優惠，能更早自首洗白），但夾在下限之上保留最短空窗。
  const baseLockMs = s.lockMs ?? 0;
  if (baseLockMs > 0 && active) {
    const wantedAt = active.wanted_at ? new Date(active.wanted_at).getTime() : null;
    const lockMs = Math.max(
      baseLockMs - (active.notoriety_at || 0) * (s.lockDiscountPerNotorietyMs ?? 0),
      s.lockMinMs ?? 0
    );
    if (wantedAt && Date.now() - wantedAt < lockMs) {
      return { ok: false, reason: "surrender_locked", readyAt: wantedAt + lockMs };
    }
  }

  const locked = await client.wantedListCollection.findOneAndUpdate(
    { userId, guildId, status: "wanted" },
    { $set: { status: "resolving", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const wanted = locked?.value || locked;
  if (!wanted) return { ok: false, reason: "not_wanted" };

  const now = Date.now();
  const prof = await theftProfile.getOrCreate(client, userId, guildId);

  // 累犯遞增：短期內重複自首，保釋比例逐次加碼（洗白越來越貴）
  const windowMs = s.repeatWindowMs ?? 86400000;
  const recentSurrenders = (prof.surrender_history || []).filter((t) => now - t < windowMs);
  const repeatCount = recentSurrenders.length;
  const forfeitPct = Math.min(
    (s.bailForfeitPct ?? 0.6) + repeatCount * (s.repeatSurchargePct ?? 0),
    s.maxForfeitPct ?? 1
  );

  // 贓款抽成：吐回歷史累積贓款的一定比例，偷越多、自首越貴
  const disgorge = Math.floor((prof.lifetime_stolen || 0) * (s.stolenDisgorgePct ?? 0));

  // 保釋金上限夾在「退回託管後付得起的額度」內，避免錢包被扣成負值
  const walletBefore = (await getWallet(client, userId, guildId)).balance;
  const bail = Math.min(
    Math.floor(wanted.bounty * forfeitPct) + disgorge,
    walletBefore + wanted.bounty
  );

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
      meta: { wantedId: wanted.wanted_id, disgorge, repeatCount },
    });
    // 保釋金 → 進治安基金
    await addToFund(client, guildId, bail);
  }

  await client.wantedListCollection.updateOne(
    { userId, guildId },
    { $set: { status: "surrendered", updated_at: new Date() } }
  );
  await theftProfile.adjustNotoriety(client, userId, guildId, -(c.notoriety?.surrenderLoss ?? 1));

  // 假釋觀察期 + 記錄本次自首（供累犯遞增判定，只留窗內時間戳）
  const paroleMs = s.paroleCooldownMs ?? 0;
  const paroleUntil = paroleMs > 0 ? now + paroleMs : 0;
  await client.theftProfilesCollection.updateOne(
    { userId, guildId },
    {
      $set: {
        parole_until: paroleUntil,
        surrender_history: [...recentSurrenders, now],
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    bail,
    refunded: wanted.bounty - bail,
    bounty: wanted.bounty,
    disgorge,
    forfeitPct,
    repeatCount,
    paroleUntil,
  };
}

// ── 偵探分級 ───────────────────────────────────────────
// 報案可挑不同等級的偵探：越貴查到率越高、遇上壞事件（跑路/被收買/黑吃黑）機率越低、
// 好事件（線人爆料保證破案）機率越高。所有數值 config 驅動，指令選單也由這份清單生成。
function reportTiers() {
  return cfg().report?.tiers || [];
}

function resolveTier(tierKey) {
  const r = cfg().report || {};
  const tiers = reportTiers();
  const chosen =
    (tierKey && tiers.find((t) => t.key === tierKey)) ||
    tiers.find((t) => t.key === r.defaultTier) ||
    tiers[0];
  if (chosen) return chosen;
  // 沒設分級 → 退回單一偵探（相容舊 config）
  return {
    key: "default",
    name: "偵探",
    emoji: "🔎",
    fee: r.detectiveFee ?? 500,
    investigateRate: r.investigateRate ?? 0.7,
    investigateRateStale: r.investigateRateStale ?? 0.2,
    goodEventChance: 0,
    badEventChance: r.abscondChance ?? 0.02,
  };
}

// 依 weight 隨機挑一個 event key；空清單回 null。
function pickWeighted(list) {
  const items = (list || []).filter((e) => (e.weight ?? 1) > 0);
  if (!items.length) return null;
  const total = items.reduce((s, e) => s + (e.weight ?? 1), 0);
  let roll = Math.random() * total;
  for (const e of items) {
    roll -= e.weight ?? 1;
    if (roll < 0) return e.key;
  }
  return items[items.length - 1].key;
}

// ── /報案 ─────────────────────────────────────────────
async function report(client, { guildId, userId, username, tierKey }) {
  const c = cfg();
  if (!c.enabled || !client.theftLogsCollection) return { ok: false, reason: "disabled" };
  const r = c.report || {};
  const tier = resolveTier(tierKey);

  const fee = tier.fee ?? 500;
  const wallet = (await getWallet(client, userId, guildId)).balance;
  if (wallet < fee) return { ok: false, reason: "insufficient", fee, have: wallet, tier };

  const nowMs = Date.now();
  const windowMs = (r.windowHours ?? 24) * 3600 * 1000;
  const since = new Date(nowMs - windowMs);
  const events = await client.theftLogsCollection
    .find({ guildId, type: "steal", target_id: userId, success: true, ts: { $gte: since } })
    .sort({ ts: -1 })
    .toArray()
    .catch(() => []);

  // 已強制決鬥或已放過的兇手視為已結案，不再列入偵查（同窗口只能處理一次）
  const settled = events.length
    ? await client.theftLogsCollection
        .find({ guildId, type: { $in: ["revenge", "forgive", "bounty"] }, actor_id: userId, ts: { $gte: since } })
        .toArray()
        .catch(() => [])
    : [];
  const settledSet = new Set(settled.map((e) => e.target_id));
  const openEvents = events.filter((ev) => !settledSet.has(ev.actor_id));

  // 沒有任何（未結）案件可查 → 退費（無事可查不收錢）
  if (!openEvents.length) {
    return { ok: true, charged: false, found: false, culprits: [], noCase: true, tier };
  }

  // 收委託費
  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -fee,
    source: "detective_fee",
    meta: { tier: tier.key },
  });

  // 專屬特殊事件（各偵探獨立擲骰、優先於一般壞事件）：
  //   王牌偵探極小機率「變身阿拉雷」抄棒子捅你，除委託費外再捲走固定一筆。
  for (const sp of tier.specialEvents || []) {
    if (Math.random() >= (sp.chance ?? 0)) continue;
    if (sp.key === "arale") {
      const w2 = (await getWallet(client, userId, guildId)).balance;
      const loss = Math.min(sp.loss ?? 0, w2);
      if (loss > 0) {
        await grantCoins(client, {
          userId,
          guildId,
          username,
          amount: -loss,
          source: "detective_arale",
          meta: { tier: tier.key },
        });
      }
      return { ok: true, charged: true, badEvent: "arale", fee, araleLoss: loss, tier };
    }
    // 其餘專屬壞事件（如王牌偵探也會捲款跑路）走一般壞事件呈現與後續選擇
    return { ok: true, charged: true, badEvent: sp.key, fee, tier };
  }

  // 壞事件（互斥、優先於調查）：越菜的偵探越常出包，王牌不會。
  //   abscond 捲款跑路 / bribed 被兇手收買 → 收費、查無結果；
  //   crooked 壞人偵探 → 收費之外還黑吃黑，再從你錢包偷一筆。
  const eventsCfg = r.events || {};
  if (Math.random() < (tier.badEventChance ?? 0)) {
    const bad = pickWeighted(eventsCfg.bad) || "abscond";
    if (bad === "crooked") {
      const w2 = (await getWallet(client, userId, guildId)).balance;
      const extra = Math.min(
        Math.floor(w2 * (r.crookedStealPct ?? 0.1)),
        r.crookedStealMax ?? 2000,
        w2
      );
      if (extra > 0) {
        await grantCoins(client, {
          userId,
          guildId,
          username,
          amount: -extra,
          source: "detective_crooked",
          meta: { tier: tier.key },
        });
      }
      return { ok: true, charged: true, badEvent: "crooked", fee, extraStolen: extra, tier };
    }
    return { ok: true, charged: true, badEvent: bad, fee, tier };
  }

  // 好事件：線人爆料 → 保證破案（即使調查 RNG 全落空，也強制鎖定窗口內偷最多的主嫌）
  const goodEvent =
    Math.random() < (tier.goodEventChance ?? 0) ? pickWeighted(eventsCfg.good) : null;

  // 線索隨時間變冷：越久前的竊案越難查，接近窗口邊緣時查到率降到 investigateRateStale
  // 該兇手在窗口內偷你的總額（不受偵查 RNG 影響）→ 懸賞金基準，與 placeBounty 實扣同源
  const fullByActor = new Map();
  for (const ev of openEvents) {
    fullByActor.set(ev.actor_id, (fullByActor.get(ev.actor_id) || 0) + (ev.amount || 0));
  }

  const investigateRate = tier.investigateRate ?? 0.7;
  const investigateRateStale = tier.investigateRateStale ?? investigateRate;
  const byActor = new Map();
  for (const ev of openEvents) {
    const ageFrac = clamp((nowMs - new Date(ev.ts).getTime()) / windowMs, 0, 1);
    const rate = investigateRate + (investigateRateStale - investigateRate) * ageFrac;
    if (Math.random() >= rate) continue; // 這筆查不出來（時間太久線索也可能斷）
    const cur = byActor.get(ev.actor_id) || { actorId: ev.actor_id, amount: 0, count: 0 };
    cur.amount += ev.amount || 0;
    cur.count += 1;
    byActor.set(ev.actor_id, cur);
  }

  // 線人爆料：把窗口內偷最多的主嫌強制納入（即使上面 RNG 沒查到他）
  let informant = false;
  if (goodEvent === "informant") {
    let topId = null;
    let topAmt = -1;
    for (const [aid, amt] of fullByActor) {
      if (amt > topAmt) {
        topAmt = amt;
        topId = aid;
      }
    }
    if (topId) {
      if (!byActor.has(topId)) {
        let amount = 0;
        let count = 0;
        for (const ev of openEvents) {
          if (ev.actor_id === topId) {
            amount += ev.amount || 0;
            count += 1;
          }
        }
        byActor.set(topId, { actorId: topId, amount, count });
      }
      informant = true;
    }
  }

  const culprits = [...byActor.values()]
    .map((c) => ({ ...c, totalStolen: fullByActor.get(c.actorId) || c.amount }))
    .sort((a, b) => b.amount - a.amount);

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
    totalCases: openEvents.length,
    tier,
    informant,
  };
}

// ── 報案壞事件後「試圖逮捕偵探」：50% 討回全部損失，失敗被反咬多搶一筆 ──
async function catchDetective(client, { guildId, userId, username, recoverable }) {
  const c = cfg();
  if (!c.enabled || !client.theftLogsCollection) return { ok: false, reason: "disabled" };
  const cc = c.report?.catch || {};

  if (Math.random() < (cc.winRate ?? 0.5)) {
    const recovered = Math.max(0, Math.floor(recoverable || 0));
    if (recovered > 0) {
      await grantCoins(client, {
        userId,
        guildId,
        username,
        amount: recovered,
        source: "detective_catch_win",
        meta: {},
      });
    }
    return { ok: true, win: true, recovered };
  }

  const wallet = (await getWallet(client, userId, guildId)).balance;
  const penalty = Math.min(
    Math.max(Math.floor(wallet * (cc.losePenaltyPct ?? 0.12)), cc.losePenaltyMin ?? 0),
    cc.losePenaltyMax ?? Infinity,
    wallet
  );
  if (penalty > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: -penalty,
      source: "detective_catch_lose",
      meta: {},
    });
  }
  return { ok: true, win: false, penalty };
}

// ── 報案後的強制決鬥：贏了從兇手錢包討回被偷金額的一半 ──
async function revengeDuel(client, { guildId, victimId, victimName, culpritId, member }) {
  const c = cfg();
  if (!c.enabled || !client.theftLogsCollection) return { ok: false, reason: "disabled" };
  if (victimId === culpritId) return { ok: false, reason: "self" };
  const rv = c.revenge || {};
  const since = new Date(Date.now() - (c.report?.windowHours ?? 24) * 3600 * 1000);

  // 只能決鬥一次：同一窗口內對同一兇手已討過帳
  const already = await client.theftLogsCollection
    .findOne({ guildId, type: "revenge", actor_id: victimId, target_id: culpritId, ts: { $gte: since } })
    .catch(() => null);
  if (already) return { ok: false, reason: "already_done" };

  // 該兇手在窗口內偷走你的總額
  const events = await client.theftLogsCollection
    .find({ guildId, type: "steal", actor_id: culpritId, target_id: victimId, success: true, ts: { $gte: since } })
    .toArray()
    .catch(() => []);
  const stolen = events.reduce((s, e) => s + (e.amount || 0), 0);
  if (stolen <= 0) return { ok: false, reason: "no_case" };

  // 判定：攻擊力 + 隨機（比照追捕計分）
  const [victimAtk, culpritAtk] = await Promise.all([
    buffResolver.getEffectiveAtk(client, victimId, guildId).catch(() => 0),
    buffResolver.getEffectiveAtk(client, culpritId, guildId).catch(() => 0),
  ]);
  const rate = clamp(
    (rv.baseRate ?? 0.5) + (victimAtk - culpritAtk) * (rv.atkDiffScale ?? 0.003),
    rv.minRate ?? 0.2,
    rv.maxRate ?? 0.8
  );
  const win = Math.random() < rate;

  // 成敗都記一筆，確保只能決鬥一次
  await logEvent(client, { guildId, type: "revenge", actor_id: victimId, target_id: culpritId, success: win, amount: 0 });

  if (!win) return { ok: true, win: false, victimAtk, culpritAtk };

  // 贏 → 從兇手錢包討回一半（上限為兇手現有錢包）
  const wantRecover = Math.floor(stolen * (rv.recoverPct ?? 0.5));
  const culpritWallet = (await getWallet(client, culpritId, guildId)).balance;
  const recover = Math.max(0, Math.min(wantRecover, culpritWallet));
  if (recover > 0) {
    const debit = await grantCoins(client, {
      userId: culpritId,
      guildId,
      amount: -recover,
      source: "revenge_pay",
      meta: { victimId },
    });
    if (debit) {
      await grantCoins(client, {
        userId: victimId,
        guildId,
        username: victimName,
        amount: recover,
        source: "revenge_win",
        member,
        meta: { culpritId },
      });
    }
  }
  return { ok: true, win: true, recover, stolen, victimAtk, culpritAtk };
}

// ── 報案後選擇放過兇手：一筆勾銷，之後報案不再列出他 ──
async function forgiveCulprit(client, { guildId, victimId, culpritId }) {
  const c = cfg();
  if (!c.enabled || !client.theftLogsCollection) return { ok: false, reason: "disabled" };
  if (victimId === culpritId) return { ok: false, reason: "self" };
  const since = new Date(Date.now() - (c.report?.windowHours ?? 24) * 3600 * 1000);

  // 已強制決鬥或已放過 → 這筆帳早就結清了
  const already = await client.theftLogsCollection
    .findOne({
      guildId,
      type: { $in: ["revenge", "forgive"] },
      actor_id: victimId,
      target_id: culpritId,
      ts: { $gte: since },
    })
    .catch(() => null);
  if (already) return { ok: false, reason: "already_done" };

  // 該兇手在窗口內確實偷過你才有帳可勾銷
  const stole = await client.theftLogsCollection
    .findOne({ guildId, type: "steal", actor_id: culpritId, target_id: victimId, success: true, ts: { $gte: since } })
    .catch(() => null);
  if (!stole) return { ok: false, reason: "no_case" };

  await logEvent(client, { guildId, type: "forgive", actor_id: victimId, target_id: culpritId, success: true, amount: 0 });

  return { ok: true };
}

// 懸賞金 = 被偷總額 × 比例，夾最低值。/報案 按鈕標示與 placeBounty 實扣共用這一份，保證一致。
function bountyPlaceAmount(stolen) {
  const r = cfg().report || {};
  return Math.max(Math.floor((stolen || 0) * (r.bountyPlacePct ?? 0.5)), r.bountyPlaceMin ?? 0);
}

// ── 報案後「懸賞通緝」：報案人出錢把成功偷他的兇手掛上通緝榜 ──
// 賞金由報案人託管：被抓→獵人領走 + 贖罪金補償報案人；逃掉/到期→賞金進治安基金（不退兇手也不退報案人）。
// 被懸賞者不能自首（見 surrender 的 funded_by 檢查），只能被追捕或撐到時效。
async function placeBounty(client, { guildId, victimId, victimName, culpritId, culpritName }) {
  const c = cfg();
  if (!c.enabled || !client.wantedListCollection || !client.theftLogsCollection) {
    return { ok: false, reason: "disabled" };
  }
  if (victimId === culpritId) return { ok: false, reason: "self" };
  const r = c.report || {};
  const since = new Date(Date.now() - (r.windowHours ?? 24) * 3600 * 1000);

  // 同一窗口對同一兇手只能處理一次（決鬥 / 放過 / 懸賞 三選一）
  const already = await client.theftLogsCollection
    .findOne({
      guildId,
      type: { $in: ["revenge", "forgive", "bounty"] },
      actor_id: victimId,
      target_id: culpritId,
      ts: { $gte: since },
    })
    .catch(() => null);
  if (already) return { ok: false, reason: "already_done" };

  // 該兇手在窗口內成功偷你的總額 → 懸賞金依此比例計（與 /報案 按鈕標示同源）
  const events = await client.theftLogsCollection
    .find({ guildId, type: "steal", actor_id: culpritId, target_id: victimId, success: true, ts: { $gte: since } })
    .toArray()
    .catch(() => []);
  const stolen = events.reduce((s, e) => s + (e.amount || 0), 0);
  if (stolen <= 0) return { ok: false, reason: "no_case" };

  // 兇手已在逃 / 通緝中 → 不能再掛（他已經在榜上了）
  const ongoing = await client.wantedListCollection
    .findOne({ userId: culpritId, guildId, status: { $in: ["wanted", "fleeing", "resolving"] } })
    .catch(() => null);
  if (ongoing) return { ok: false, reason: "already_wanted" };

  // 報案人付得起懸賞金（被偷總額 × 比例，夾最低值）
  const bounty = bountyPlaceAmount(stolen);
  const wallet = (await getWallet(client, victimId, guildId)).balance;
  if (wallet < bounty) return { ok: false, reason: "insufficient", need: bounty, have: wallet };

  const debit = await grantCoins(client, {
    userId: victimId,
    guildId,
    username: victimName,
    amount: -bounty,
    source: "bounty_place_escrow",
    meta: { culpritId },
  });
  if (!debit) return { ok: false, reason: "insufficient", need: bounty, have: wallet };

  const b = c.bounty || {};
  const culpritProf = await theftProfile.getOrCreate(client, culpritId, guildId);
  const wantedTtlMs = (b.wantedTtlHours ?? 48) * 3600 * 1000;
  const expiresAt = Date.now() + wantedTtlMs;

  await client.wantedListCollection.updateOne(
    { userId: culpritId, guildId },
    {
      $set: {
        wanted_id: crypto.randomUUID(),
        userId: culpritId,
        guildId,
        username: culpritName || null,
        status: "wanted",
        bounty,
        funded_by: victimId,
        reason_target_id: victimId,
        notoriety_at: culpritProf.notoriety_effective || 0,
        wanted_at: new Date(),
        created_at: new Date(),
        expires_at: new Date(expiresAt),
        hunt_cooldown_until: 0,
        escaped_hunters: [],
        escape_count: 0,
        updated_at: new Date(),
      },
      $unset: { flee: "", caught_by: "", caught_at: "" },
    },
    { upsert: true }
  );

  await logEvent(client, {
    guildId,
    type: "bounty",
    actor_id: victimId,
    target_id: culpritId,
    success: true,
    amount: bounty,
  });

  return { ok: true, bounty, expiresAt, culpritId };
}

// ── 失風追逃：章節式逃跑小遊戲 ───────────────────────
// 偷竊失手不會立刻上通緝榜，而是先進入「逃亡」：逐關選路線甩開追捕。
// 躲到終點 → 清白脫身（從未被通緝、不扣賞金）；被逮 / 逾時未逃成 → 才上通緝榜、凍結賞金。
function fleeCfg() {
  return cfg().escapeRun || {};
}

function fleeRoutes(e) {
  return Array.isArray(e.routes) && e.routes.length ? e.routes : [];
}

// 該關某路線的被逮率：熱度隨已逃距離上升，再乘路線風險係數。
function stepCatchRate(e, distance, route) {
  const heat = Math.min(
    (e.baseCatchRate ?? 0.2) + distance * (e.catchRatePerDistance ?? 0.1),
    e.catchRateMax ?? 0.85
  );
  return clamp(heat * (route.riskMul ?? 1), 0.02, e.catchRateMax ?? 0.85);
}

// 把某關各路線的即時風險組成回傳給 view（含被逮率、前進格數）。
function fleeStageInfo(e, distance) {
  const clear = e.distanceToClear ?? 4;
  return {
    distance,
    distanceToClear: clear,
    routes: fleeRoutes(e).map((r) => ({
      key: r.key,
      emoji: r.emoji,
      name: r.name,
      advance: r.advance ?? 1,
      catchRate: stepCatchRate(e, distance, r),
    })),
  };
}

// 把逃亡失敗者正式送上通緝榜：託管賞金、狀態轉 wanted、時效由此刻起算。
// 回傳 { bounty, expiresAt, username }；若已無 fleeing 局可轉（競態 / 已結算）回 null。
async function becomeWanted(client, { userId, guildId, username, token }) {
  const b = cfg().bounty || {};
  const filter = { userId, guildId, status: "fleeing" };
  if (token) filter["flee.token"] = token;
  const locked = await client.wantedListCollection.findOneAndUpdate(
    filter,
    { $set: { status: "resolving", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const doc = locked?.value || locked;
  if (!doc) return null;

  const wallet = (await getWallet(client, userId, guildId)).balance;
  const escrowAmount = Math.max(0, Math.min(doc.bounty || 0, wallet));
  if (escrowAmount > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username: username || doc.username,
      amount: -escrowAmount,
      source: "bounty_escrow",
      meta: { targetId: doc.reason_target_id },
    }).catch(() => {});
  }
  const expiresAt = Date.now() + (b.wantedTtlHours ?? 48) * 3600 * 1000;
  await client.wantedListCollection.updateOne(
    { userId, guildId, status: "resolving" },
    {
      $set: {
        status: "wanted",
        bounty: escrowAmount,
        wanted_at: new Date(),
        expires_at: new Date(expiresAt),
        hunt_cooldown_until: 0,
        escaped_hunters: [],
        escape_count: 0,
        updated_at: new Date(),
      },
      $unset: { flee: "" },
    }
  );
  return { bounty: escrowAmount, expiresAt, username: doc.username };
}

// 逃亡的一關：選路線 → 擲判定。前進 / 清白脫身 / 被逮上榜。token compare-and-set 防重複結算。
async function fleeStep(client, { guildId, userId, username, token, routeKey }) {
  const e = fleeCfg();
  const route = fleeRoutes(e).find((r) => r.key === routeKey);
  if (!route) return { ok: false, reason: "stale" };

  const doc = await client.wantedListCollection
    .findOne({ userId, guildId, status: "fleeing" })
    .catch(() => null);
  if (!doc || doc.flee?.token !== token) return { ok: false, reason: "stale" };

  const distance = doc.flee?.distance ?? 0;
  const bounty = doc.bounty;
  const clear = e.distanceToClear ?? 4;
  const caught = Math.random() < stepCatchRate(e, distance, route);

  if (caught) {
    const w = await becomeWanted(client, { userId, guildId, username, token });
    if (!w) return { ok: false, reason: "stale" };
    await logEvent(client, { guildId, type: "flee", actor_id: userId, success: false, amount: w.bounty });
    return { ok: true, outcome: "caught", route, distance, bounty: w.bounty, expiresAt: w.expiresAt };
  }

  const nextDistance = distance + (route.advance ?? 1);

  if (nextDistance >= clear) {
    // 清白脫身：從未託管、無需退款；狀態轉 escaped（不上榜、不驚動任何人）
    const res = await client.wantedListCollection.findOneAndUpdate(
      { userId, guildId, status: "fleeing", "flee.token": token },
      { $set: { status: "escaped", updated_at: new Date() }, $unset: { flee: "" } }
    );
    if (!(res?.value || res)) return { ok: false, reason: "stale" };
    await logEvent(client, { guildId, type: "flee", actor_id: userId, success: true, amount: 0 });
    return { ok: true, outcome: "escaped", route, distance: nextDistance, bounty };
  }

  const nextToken = crypto.randomUUID();
  const res = await client.wantedListCollection.findOneAndUpdate(
    { userId, guildId, status: "fleeing", "flee.token": token },
    {
      $set: {
        "flee.distance": nextDistance,
        "flee.token": nextToken,
        "flee.expires_at": new Date(Date.now() + (e.runExpiresMs ?? 600000)),
        updated_at: new Date(),
      },
    }
  );
  if (!(res?.value || res)) return { ok: false, reason: "stale" };
  return { ok: true, outcome: "advance", route, token: nextToken, bounty, stage: fleeStageInfo(e, nextDistance) };
}

// cron：逾時未逃成的逃亡 → 送上通緝榜（放著不玩＝視同沒逃掉）。回傳新上榜清單供公告。
async function sweepFleeingTimeouts(client) {
  if (!client.wantedListCollection) return [];
  const now = new Date();
  const stale = await client.wantedListCollection
    .find({ status: "fleeing", "flee.expires_at": { $lte: now } })
    .toArray()
    .catch(() => []);
  const listed = [];
  for (const doc of stale) {
    const w = await becomeWanted(client, {
      userId: doc.userId,
      guildId: doc.guildId,
      username: doc.username,
    }).catch(() => null);
    if (w) {
      await logEvent(client, {
        guildId: doc.guildId,
        type: "flee",
        actor_id: doc.userId,
        success: false,
        amount: w.bounty,
      }).catch(() => {});
      listed.push({ userId: doc.userId, guildId: doc.guildId, bounty: w.bounty, expiresAt: w.expiresAt });
    }
  }
  return listed;
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

  await releaseEscrowedBounty(client, wanted, "wanted_expired");
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
  reportTiers,
  catchDetective,
  revengeDuel,
  forgiveCulprit,
  placeBounty,
  bountyPlaceAmount,
  fleeStep,
  becomeWanted,
  sweepFleeingTimeouts,
  listWanted,
  activeWanted,
  expireWanted,
  getWallet,
  getFund,
  payoutWeeklyFund,
};
