require("colors");
const { gameTitles } = require("../../config");
const eventEngine = require("./eventEngine");
const { getOrCreate } = require("../mining/miningProfile");
const grantCoins = require("../economy/grantCoins");
const gameTitleService = require("../gameTitles/gameTitleService");

// 限定魚兌換所服務：用生效中活動的限定魚換獎勵（金幣 / CD 縮短券 / 連續通行證 / 稱號）。
// 兌換次數記在 miningProfiles.event_exchange_counts.<exchangeId>，扣魚與計次原子完成。

function titleName(titleId) {
  const def = gameTitles?.defs?.[titleId];
  return def ? `${def.emoji || "🏅"} ${def.name}` : titleId;
}

// 某獎勵在玩家視角的完整狀態（持有量、已兌換、上限、可否兌換）。
function decorate(x, bag, counts) {
  const owned = bag[x.cost.fish] || 0;
  const used = counts[x.id] || 0;
  const limit = x.limitPerUser || 0;
  const soldOut = limit > 0 && used >= limit;
  return {
    ...x,
    costFishDef: eventEngine.resolveFishDef(x.cost.fish),
    owned,
    used,
    limit,
    soldOut,
    affordable: owned >= x.cost.qty && !soldOut,
  };
}

async function listExchanges(client, { userId, guildId }) {
  const exchanges = eventEngine.getEventExchanges();
  if (exchanges.length === 0) return { active: false, items: [] };
  const profile = await getOrCreate(client, userId, guildId);
  const bag = profile.fish_bag || {};
  const counts = profile.event_exchange_counts || {};
  return { active: true, items: exchanges.map((x) => decorate(x, bag, counts)) };
}

// 發放獎勵，回傳 { text, titleAward? }。text 為可讀獎勵文字（供成功橫幅）；
// titleAward 僅在獎勵為稱號時附上 { titleId, newlyAdded }，供上層決定是否公告限定稱號。
// 魚已於外層原子扣除。
async function grantReward(client, { userId, guildId, username, member, exchange }) {
  const rw = exchange.reward || {};
  if (rw.type === "coins") {
    const g = await grantCoins(client, {
      userId,
      guildId,
      username,
      member,
      amount: rw.qty,
      source: "event_prize",
      meta: { exchange: exchange.id, event: exchange.eventId },
    }).catch(() => null);
    return { text: `🪙 ${(g?.granted ?? rw.qty).toLocaleString()} 幣` };
  }
  if (rw.type === "cdTicket") {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { cd_ticket_count: rw.qty }, $set: { updatedAt: new Date() } },
    );
    return { text: `🎫 CD 縮短券 ×${rw.qty}` };
  }
  if (rw.type === "batchPass") {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { batch_pass_count: rw.qty }, $set: { updatedAt: new Date() } },
    );
    return { text: `🎟️ 連續通行證 ×${rw.qty}` };
  }
  if (rw.type === "ore") {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [`backpack.${rw.oreKey}`]: rw.qty }, $set: { updatedAt: new Date() } },
    );
    const def = eventEngine.resolveOreDef(rw.oreKey) || {};
    return { text: `${def.emoji || "⛏️"} ${def.name || rw.oreKey} ×${rw.qty}` };
  }
  if (rw.type === "title") {
    const res = await gameTitleService
      .grant(client, {
        userId,
        guildId,
        member,
        titleId: rw.titleId,
        announce: false,
        source: "event",
      })
      .catch((e) => console.log(`[ERROR] event exchange grant title: ${e}`.red));
    return {
      text: `🏅 稱號「${titleName(rw.titleId)}」`,
      titleAward: { titleId: rw.titleId, newlyAdded: !!res?.newlyAdded },
    };
  }
  return { text: "獎勵" };
}

async function redeem(client, { userId, guildId, username, member, exchangeId }) {
  const x = eventEngine.getEventExchangeById(exchangeId);
  if (!x) return { ok: false, reason: "not_found" };

  const profile = await getOrCreate(client, userId, guildId);
  const bag = profile.fish_bag || {};
  const counts = profile.event_exchange_counts || {};
  const fishDef = eventEngine.resolveFishDef(x.cost.fish);
  const owned = bag[x.cost.fish] || 0;
  const used = counts[x.id] || 0;
  const limit = x.limitPerUser || 0;

  if (limit > 0 && used >= limit) {
    return { ok: false, reason: "limit", limit, used, exchange: x, fishDef };
  }
  if (owned < x.cost.qty) {
    return { ok: false, reason: "insufficient", need: x.cost.qty, have: owned, exchange: x, fishDef };
  }

  // 原子：扣魚 + 計次，兩者同時受守衛（魚量足夠、未達上限）
  const filter = {
    userId,
    guildId,
    [`fish_bag.${x.cost.fish}`]: { $gte: x.cost.qty },
  };
  if (limit > 0) {
    filter.$or = [
      { [`event_exchange_counts.${x.id}`]: { $lt: limit } },
      { [`event_exchange_counts.${x.id}`]: { $exists: false } },
    ];
  }
  const res = await client.miningProfilesCollection.updateOne(filter, {
    $inc: { [`fish_bag.${x.cost.fish}`]: -x.cost.qty, [`event_exchange_counts.${x.id}`]: 1 },
    $set: { updatedAt: new Date() },
  });
  if (res.modifiedCount === 0) {
    return { ok: false, reason: "retry", exchange: x, fishDef };
  }

  const reward = await grantReward(client, { userId, guildId, username, member, exchange: x });
  return {
    ok: true,
    exchange: x,
    fishDef,
    costQty: x.cost.qty,
    rewardText: reward.text,
    titleAward: reward.titleAward || null,
    usedAfter: used + 1,
    ownedAfter: owned - x.cost.qty,
  };
}

module.exports = { listExchanges, redeem, titleName };
