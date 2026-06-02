require("colors");
const { mining } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("./miningProfile");
const { weightedRandom } = require("./weightedRandom");
const { priceOf } = require("./overflowConfirm");
const grantCoins = require("../economy/grantCoins");

function cfg() {
  return mining?.stoneAppraisal || {};
}

// 逐顆開石頭（純函式，不碰 DB）。回傳贏得礦石總表與每顆結果（供呈現）。
function rollOutcomes(count) {
  const outcomes = Array.isArray(cfg().outcomes) ? cfg().outcomes : [];
  const weights = {};
  outcomes.forEach((o, i) => {
    weights[String(i)] = o.weight || 0;
  });

  const winnings = {}; // ore -> qty
  const rolls = []; // 每顆：{ ore, qty } 或 null（碎掉）
  for (let i = 0; i < count; i++) {
    const idx = weightedRandom(weights);
    const o = idx != null ? outcomes[Number(idx)] : null;
    if (!o || !o.ore) {
      rolls.push(null);
      continue;
    }
    const min = o.minQty ?? 1;
    const max = o.maxQty ?? min;
    const q = Math.floor(Math.random() * (max - min + 1)) + min;
    winnings[o.ore] = (winnings[o.ore] || 0) + q;
    rolls.push({ ore: o.ore, qty: q });
  }
  return { winnings, rolls };
}

// 賭石：把「剛挖到那一次」的石頭付費逐顆開出，有機率變成別種礦。
// ts 為按鈕帶上的挖礦時間戳，必須與 DB 中 pending_appraisal.ts 相符（單次性 + 只認最新一次挖礦）。
// allowOverflow=true：開出的礦背包放不下時，依系統收購價依序折最低價礦為金幣（保留高價礦）。
async function appraise(client, { userId, guildId, member, username, ts, allowOverflow = false }) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection || !client.userCoinsCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);
  const pending = profile.pending_appraisal;

  // 只有剛挖到石頭那次（pending 存在、ts 對得上、未逾時）才能賭
  if (!pending || typeof pending.ts !== "number") {
    return { ok: false, reason: "no_pending" };
  }
  if (typeof ts === "number" && pending.ts !== ts) {
    return { ok: false, reason: "stale" };
  }
  const windowMs = c.windowMs || 0;
  if (windowMs > 0 && Date.now() - pending.ts > windowMs) {
    return { ok: false, reason: "expired" };
  }

  const pendingQty = Math.max(0, Math.floor(pending.qty || 0));
  const haveStone = profile.backpack?.stone || 0;
  // 挖到後若被事件扣掉，照實際剩下的石頭數量賭（有幾顆賭幾顆）
  const count = Math.min(pendingQty, haveStone);
  if (count <= 0) return { ok: false, reason: "no_stone" };

  const feePerStone = Math.max(0, Math.floor(c.feePerStone || 0));
  const fee = feePerStone * count;

  const balanceDoc = await client.userCoinsCollection
    .findOne({ userId, guildId }, { projection: { totalCoins: 1 } })
    .catch(() => null);
  const totalCoins = balanceDoc?.totalCoins || 0;
  if (totalCoins < fee) {
    return { ok: false, reason: "no_coins", fee, balance: totalCoins };
  }

  // 先 roll，再算背包淨變化（石頭被消耗、贏得礦石加回）
  const { winnings, rolls } = rollOutcomes(count);
  const gained = Object.values(winnings).reduce((s, n) => s + n, 0);
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  const freeAfterConsume = cap - (used - count);

  // 算出哪些 winnings 進背包、哪些折金幣
  const acceptedWinnings = { ...winnings };
  const foldedWinnings = {};
  let overflowCoins = 0;
  if (gained > freeAfterConsume) {
    if (!allowOverflow) {
      return { ok: false, reason: "backpack_full", used, cap };
    }
    let needToFold = gained - freeAfterConsume;
    const sortedOres = Object.keys(acceptedWinnings).sort(
      (a, b) => priceOf(a) - priceOf(b)
    );
    for (const ore of sortedOres) {
      if (needToFold <= 0) break;
      const have = acceptedWinnings[ore] || 0;
      const fold = Math.min(have, needToFold);
      if (fold > 0) {
        acceptedWinnings[ore] = have - fold;
        foldedWinnings[ore] = (foldedWinnings[ore] || 0) + fold;
        overflowCoins += priceOf(ore) * fold;
        needToFold -= fold;
      }
    }
  }

  // 原子更新：條件鎖 pending_appraisal.ts（保證單次）與石頭庫存，扣石頭 + 加礦 + 清 pending
  const inc = { "backpack.stone": -count };
  for (const [ore, q] of Object.entries(acceptedWinnings)) {
    if (q > 0) inc[`backpack.${ore}`] = (inc[`backpack.${ore}`] || 0) + q;
  }
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      "pending_appraisal.ts": pending.ts,
      "backpack.stone": { $gte: count },
    },
    { $inc: inc, $set: { pending_appraisal: null, updatedAt: new Date() } }
  );
  // 沒改到：pending 已被用掉（重複點）或石頭已不足
  if (res.modifiedCount === 0) return { ok: false, reason: "stale" };

  // 扣鑑定費（sink）。失敗則回滾礦石異動，避免免費賭石
  const grant = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -fee,
    source: "stone_appraisal",
    member,
    meta: { count, winnings },
  });
  if (!grant) {
    const rollback = { "backpack.stone": count };
    for (const [ore, q] of Object.entries(acceptedWinnings)) {
      if (q > 0) rollback[`backpack.${ore}`] = -q;
    }
    await client.miningProfilesCollection
      .updateOne(
        { userId, guildId },
        { $inc: rollback, $set: { updatedAt: new Date() } }
      )
      .catch(() => {});
    return { ok: false, reason: "charge_failed" };
  }

  // 折金幣入帳（不影響 fee 扣款）
  let balanceAfter = grant.doc?.totalCoins ?? totalCoins - fee;
  if (overflowCoins > 0) {
    const ofGrant = await grantCoins(client, {
      userId, guildId, username,
      amount: overflowCoins,
      source: "stone_appraisal_overflow",
      member,
      meta: { count, foldedWinnings },
    }).catch(() => null);
    if (ofGrant?.doc?.totalCoins != null) balanceAfter = ofGrant.doc.totalCoins;
  }

  return {
    ok: true,
    count,
    fee,
    winnings,
    acceptedWinnings,
    foldedWinnings,
    overflowCoins,
    rolls,
    gainedDiamond: (winnings.diamond || 0) > 0,
    balanceAfter,
  };
}

module.exports = { appraise, rollOutcomes };
