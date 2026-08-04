require("colors");
const { MessageFlags } = require("discord.js");

const { eventFundraise, hostedEvents: hostedEventsConfig } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const itemRegistry = require("../economy/itemRegistry");
const { getOrCreate } = require("../mining/miningProfile");
const view = require("./fundraiseView");

const FUNDING_STATUSES = ["PENDING_REVIEW", "FUNDRAISING"];
const HOST_ACTIVE_STATUSES = [...FUNDING_STATUSES, "RECRUITING"];

function cfg() {
  return eventFundraise || {};
}

function isEnabled() {
  return cfg().enabled !== false;
}

function maxRetentionPct() {
  const n = cfg().maxHostRetentionPct;
  return Number.isFinite(n) ? n : 10;
}

function maxRankCount() {
  return hostedEventsConfig?.maxRankCount || 5;
}

function newFundraiseId(hostId) {
  return `evt-${Date.now().toString(36)}-${hostId.slice(-5)}`;
}

function err(title, body, hint) {
  return { ok: false, error: { title, body, hint } };
}

// 主辦人保留額 = 募資總額 × 保留比例（無條件捨去），其餘全部必須在結算時發出去。
function retentionAmount(doc) {
  const f = doc.funding || {};
  if (f.retentionAmount !== undefined) return f.retentionAmount;
  return Math.floor((f.raised || 0) * ((f.hostRetentionPct || 0) / 100));
}

function isFundingOpen(doc) {
  if (doc.status !== "FUNDRAISING") return false;
  const deadline = doc.funding?.deadline;
  return !deadline || new Date(deadline).getTime() > Date.now();
}

function itemPoolOf(doc) {
  return doc.funding?.itemPool || [];
}

async function applyFundraise(client, opts) {
  const {
    guild,
    host,
    member,
    name,
    description,
    goal,
    rankCount,
    minParticipants,
    maxParticipants,
    days,
    retentionPct,
  } = opts;

  const c = cfg();
  if (!isEnabled()) {
    return err("🔧 募資活動尚未開放", "管理員目前關閉了活動募資功能。");
  }
  if (!client.hostedEventsCollection || !client.eventFundDonationsCollection) {
    return err("🔧 募資系統尚未啟動", "資料庫尚未連線，請稍後再試或聯絡舒舒。");
  }

  const minGoal = c.minGoal ?? 1000;
  const maxGoal = c.maxGoal ?? 3000000;
  // 目標是選填的，只影響卡片上的進度條；不填就不畫進度條，募多少算多少。
  if (goal != null && (goal < minGoal || goal > maxGoal)) {
    return err(
      "❌ 募資目標超出範圍",
      `可設定範圍：**${minGoal.toLocaleString()} ~ ${maxGoal.toLocaleString()}** credits\n你填的是：${goal.toLocaleString()}`,
      "也可以不填目標，卡片就只顯示「已募得多少」。",
    );
  }
  if (rankCount < 1 || rankCount > maxRankCount()) {
    return err("❌ 名次數超出範圍", `可設定 **1 ~ ${maxRankCount()}** 名，你填的是：${rankCount}`);
  }
  const minDays = c.minFundDays ?? 1;
  const maxDays = c.maxFundDays ?? 14;
  if (days < minDays || days > maxDays) {
    return err("❌ 募資天數超出範圍", `可設定 **${minDays} ~ ${maxDays}** 天，你填的是：${days}`);
  }
  if (retentionPct < 0 || retentionPct > maxRetentionPct()) {
    return err(
      "❌ 保留比例超出上限",
      `主辦人最多只能保留 **${maxRetentionPct()}%**，你填的是：${retentionPct}%`,
      "剩下的募款必須全數在活動中發成獎金，這是募資錢包的規則。",
    );
  }
  if (minParticipants < 1) {
    return err("❌ 最少人數不合法", "最少人數需 ≥ 1。");
  }
  if (maxParticipants && maxParticipants < minParticipants) {
    return err(
      "❌ 人數上下限衝突",
      `最多人數（${maxParticipants}）不能小於最少人數（${minParticipants}）。`,
    );
  }

  const maxActive = c.maxActivePerHost ?? 1;
  const active = await client.hostedEventsCollection.countDocuments({
    guildId: guild.id,
    hostId: host.id,
    funding: { $exists: true },
    status: { $in: HOST_ACTIVE_STATUSES },
  });
  if (active >= maxActive) {
    return err(
      "❌ 你已經有進行中的募資活動",
      `同時最多只能有 **${maxActive}** 個（審核中／募資中／報名中都算）。`,
      "先把手上的活動結算或取消，再開新的募資。",
    );
  }

  const reviewChannelId = c.reviewChannelId;
  const reviewChannel = await guild.channels.fetch(reviewChannelId).catch(() => null);
  if (!reviewChannel?.isTextBased?.()) {
    return err(
      "❌ 找不到審核頻道",
      `設定的審核頻道（${reviewChannelId}）不存在或機器人看不到。`,
      "請聯絡舒舒調整 eventFundraise.reviewChannelId。",
    );
  }

  const now = new Date();
  const doc = {
    eventId: newFundraiseId(host.id),
    guildId: guild.id,
    channelId: null,
    messageId: null,
    hostId: host.id,
    hostName: member?.displayName || host.username,
    name,
    description: description || null,
    prizePool: 0,
    rankCount,
    minParticipants,
    maxParticipants: maxParticipants || null,
    participants: [],
    status: "PENDING_REVIEW",
    funding: {
      goal,
      raised: 0,
      itemPool: [],
      donorCount: 0,
      days,
      deadline: null,
      hostRetentionPct: retentionPct,
      reviewChannelId: reviewChannel.id,
      reviewMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
  };

  await client.hostedEventsCollection.insertOne(doc);

  let reviewMsg;
  try {
    reviewMsg = await reviewChannel.send({
      components: [view.buildReviewContainer(doc, guild)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    // 送不出審核卡就沒人能通過它，留著只會卡住「同時只能有一個」的額度。
    await client.hostedEventsCollection.deleteOne({ eventId: doc.eventId }).catch(() => {});
    console.log(`[ERROR] fundraise review post ${doc.eventId}: ${e}`.red);
    return err("❌ 送出申請失敗", "審核訊息發不出去，申請沒有建立。", "請聯絡舒舒檢查審核頻道權限。");
  }
  await client.hostedEventsCollection.updateOne(
    { eventId: doc.eventId },
    { $set: { "funding.reviewMessageId": reviewMsg.id, updatedAt: new Date() } },
  );
  doc.funding.reviewMessageId = reviewMsg.id;

  return { ok: true, doc, reviewMessage: reviewMsg };
}

function unwrap(res) {
  if (!res) return null;
  return res.value !== undefined ? res.value : res;
}

async function approve(client, eventDoc, reviewer) {
  const publishChannelId = hostedEventsConfig?.publishChannelId;
  const guild = client.guilds.cache.get(eventDoc.guildId);
  const channel = await client.channels.fetch(publishChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return err(
      "❌ 找不到活動發布頻道",
      `設定的發布頻道（${publishChannelId}）不存在或機器人看不到。`,
      "請聯絡舒舒調整 hostedEvents.publishChannelId。",
    );
  }

  const now = new Date();
  const deadline = new Date(now.getTime() + eventDoc.funding.days * 24 * 60 * 60 * 1000);
  const updated = unwrap(
    await client.hostedEventsCollection.findOneAndUpdate(
      { _id: eventDoc._id, status: "PENDING_REVIEW" },
      {
        $set: {
          status: "FUNDRAISING",
          updatedAt: now,
          "funding.deadline": deadline,
          "funding.approvedBy": reviewer.id,
          "funding.approvedAt": now,
        },
      },
      { returnDocument: "after" },
    ),
  );
  if (!updated) {
    return err("❌ 這個申請已經處理過了", "狀態已不是「審核中」，可能已被通過或駁回。");
  }

  let msg;
  try {
    msg = await channel.send({
      components: [view.buildFundraisingContainer(updated, guild, { open: true })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    // 沒有募資卡片就沒有任何按鈕可按，退回審核中讓管理員重按一次。
    await client.hostedEventsCollection.updateOne(
      { _id: eventDoc._id },
      { $set: { status: "PENDING_REVIEW", updatedAt: new Date() }, $unset: { "funding.approvedBy": "", "funding.approvedAt": "", "funding.deadline": "" } },
    );
    console.log(`[ERROR] fundraise publish ${eventDoc.eventId}: ${e}`.red);
    return err("❌ 發布募資訊息失敗", "活動已退回「審核中」，沒有開始募資。", "請檢查機器人在活動頻道的發言權限後再按一次通過。");
  }
  const withMessage = unwrap(
    await client.hostedEventsCollection.findOneAndUpdate(
      { _id: eventDoc._id },
      { $set: { channelId: channel.id, messageId: msg.id, updatedAt: new Date() } },
      { returnDocument: "after" },
    ),
  );

  return { ok: true, doc: withMessage, message: msg };
}

async function reject(client, eventDoc, reviewer, reason) {
  const now = new Date();
  const updated = unwrap(
    await client.hostedEventsCollection.findOneAndUpdate(
      { _id: eventDoc._id, status: "PENDING_REVIEW" },
      {
        $set: {
          status: "REJECTED",
          rejectedAt: now,
          updatedAt: now,
          "funding.rejectedBy": reviewer.id,
          "funding.rejectedAt": now,
          "funding.rejectReason": reason,
        },
      },
      { returnDocument: "after" },
    ),
  );
  if (!updated) {
    return err("❌ 這個申請已經處理過了", "狀態已不是「審核中」，可能已被通過或駁回。");
  }
  return { ok: true, doc: updated };
}

async function recordDonation(client, eventDoc, entry) {
  const isNewDonor =
    (await client.eventFundDonationsCollection.countDocuments({
      eventId: eventDoc.eventId,
      userId: entry.userId,
    })) === 0;

  await client.eventFundDonationsCollection.insertOne({
    eventId: eventDoc.eventId,
    guildId: eventDoc.guildId,
    createdAt: new Date(),
    refundedAt: null,
    ...entry,
  });
  return isNewDonor;
}

async function donateCoins(client, eventDoc, { user, member, amount }) {
  const c = cfg();
  const min = c.minCoinDonation ?? 100;
  if (!Number.isInteger(amount) || amount < min) {
    return err(
      "❌ 贊助金額不合法",
      `最低贊助 **${min.toLocaleString()}** credits，你輸入的是：${Number.isFinite(amount) ? amount.toLocaleString() : "不是數字"}`,
    );
  }
  if (!isFundingOpen(eventDoc)) {
    return err("⏰ 募資已截止", `「${eventDoc.name}」目前不接受新的贊助。`, "等主辦人開始報名後就能參加活動囉。");
  }

  const wallet = await client.userCoinsCollection.findOne({
    userId: user.id,
    guildId: eventDoc.guildId,
  });
  const balance = wallet?.totalCoins || 0;
  if (balance < amount) {
    return err(
      "❌ 餘額不足",
      `需要 **${amount.toLocaleString()}** credits，你只有 **${balance.toLocaleString()}**（差 ${(amount - balance).toLocaleString()}）。`,
      "可以先去 /打工 或 /挖礦 賺一點再回來贊助。",
    );
  }

  const debit = await grantCoins(client, {
    userId: user.id,
    guildId: eventDoc.guildId,
    username: member?.displayName || user.username,
    avatarHash: user.avatar,
    amount: -amount,
    source: "event_fund_donate",
    member,
    meta: { eventId: eventDoc.eventId, name: eventDoc.name, hostId: eventDoc.hostId },
  });
  if (!debit) {
    return err("❌ 扣款失敗", "沒有扣到款，這筆贊助沒有成立。", "稍後再試一次，若持續失敗請聯絡舒舒。");
  }

  const isNewDonor = await recordDonation(client, eventDoc, {
    userId: user.id,
    username: member?.displayName || user.username,
    kind: "coin",
    coins: amount,
  });

  const updated = unwrap(
    await client.hostedEventsCollection.findOneAndUpdate(
      { _id: eventDoc._id, status: "FUNDRAISING" },
      {
        $inc: { "funding.raised": amount, "funding.donorCount": isNewDonor ? 1 : 0 },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" },
    ),
  );
  if (!updated) {
    await grantCoins(client, {
      userId: user.id,
      guildId: eventDoc.guildId,
      amount,
      source: "event_fund_refund",
      meta: { eventId: eventDoc.eventId, reason: "status_changed" },
    }).catch(() => {});
    await client.eventFundDonationsCollection.updateOne(
      { eventId: eventDoc.eventId, userId: user.id, kind: "coin", coins: amount, refundedAt: null },
      { $set: { refundedAt: new Date() } },
    );
    return err("❌ 募資已結束", "在你送出的同時主辦人結束了募資，金額已退回你的錢包。");
  }

  return { ok: true, doc: updated, amount };
}

async function donateItem(client, eventDoc, { user, member, value, qty }) {
  const c = cfg();
  const item = itemRegistry.resolve(value);
  if (!item) {
    return err("❌ 找不到這個物品", "請從清單重新選擇一次。");
  }
  const maxQty = c.maxItemQtyPerDonation ?? 999;
  if (!Number.isInteger(qty) || qty < 1 || qty > maxQty) {
    return err(
      "❌ 數量不合法",
      `單次可贊助 **1 ~ ${maxQty.toLocaleString()}** 個，你輸入的是：${Number.isFinite(qty) ? qty.toLocaleString() : "不是數字"}`,
    );
  }
  if (!isFundingOpen(eventDoc)) {
    return err("⏰ 募資已截止", `「${eventDoc.name}」目前不接受新的贊助。`);
  }

  const profile = await getOrCreate(client, user.id, eventDoc.guildId);
  const have = itemRegistry.ownedQty(profile, value);
  if (have < qty) {
    return err(
      "❌ 物品不足",
      `需要 **${item.label} ×${qty.toLocaleString()}**，你只有 **${have.toLocaleString()}**（差 ${(qty - have).toLocaleString()}）。`,
      "先去挖礦／釣魚／收成補貨吧。",
    );
  }

  const pool = itemPoolOf(eventDoc);
  const maxKinds = c.maxItemKinds ?? 10;
  if (!pool.some((p) => p.value === value) && pool.length >= maxKinds) {
    return err(
      "❌ 物品獎池種類已滿",
      `這個活動的物品獎池最多 **${maxKinds}** 種，目前已有 ${pool.length} 種。`,
      "可以改贊助已在獎池裡的物品，或改用 credits 贊助。",
    );
  }

  const taken = await itemRegistry.take(client, user.id, eventDoc.guildId, value, qty);
  if (!taken) {
    return err("❌ 物品不足", `扣除 **${item.label} ×${qty.toLocaleString()}** 時失敗，可能剛剛用掉了。`);
  }

  const isNewDonor = await recordDonation(client, eventDoc, {
    userId: user.id,
    username: member?.displayName || user.username,
    kind: "item",
    itemValue: value,
    qty,
  });

  const inc = await client.hostedEventsCollection.updateOne(
    { _id: eventDoc._id, status: "FUNDRAISING", "funding.itemPool.value": value },
    {
      $inc: { "funding.itemPool.$.qty": qty, "funding.donorCount": isNewDonor ? 1 : 0 },
      $set: { updatedAt: new Date() },
    },
  );
  let updated;
  if (inc.matchedCount === 0) {
    updated = unwrap(
      await client.hostedEventsCollection.findOneAndUpdate(
        { _id: eventDoc._id, status: "FUNDRAISING" },
        {
          $push: { "funding.itemPool": { value, qty } },
          $inc: { "funding.donorCount": isNewDonor ? 1 : 0 },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: "after" },
      ),
    );
  } else {
    updated = await client.hostedEventsCollection.findOne({ _id: eventDoc._id });
  }

  if (!updated) {
    await itemRegistry.grant(client, user.id, eventDoc.guildId, value, qty);
    await client.eventFundDonationsCollection.updateOne(
      { eventId: eventDoc.eventId, userId: user.id, kind: "item", itemValue: value, qty, refundedAt: null },
      { $set: { refundedAt: new Date() } },
    );
    return err("❌ 募資已結束", "在你送出的同時主辦人結束了募資，物品已退回你的背包。");
  }

  return { ok: true, doc: updated, item, qty };
}

// 募資 → 報名：把錢包鎖成獎金池（扣掉主辦人保留額），之後就走既有的活動流程。
async function startRecruiting(client, eventDoc) {
  if (eventDoc.status !== "FUNDRAISING") {
    return err("❌ 這個活動不在募資階段", `目前狀態：${eventDoc.status}`);
  }
  const raised = eventDoc.funding.raised || 0;
  const pool = itemPoolOf(eventDoc);
  if (raised <= 0 && pool.length === 0) {
    return err(
      "❌ 還沒有任何贊助",
      "募資金額 0 credits、物品獎池 0 件，沒有東西可以當獎品。",
      "再等等贊助者，或直接取消這個活動。",
    );
  }

  const retention = Math.floor(raised * ((eventDoc.funding.hostRetentionPct || 0) / 100));
  const prizePool = raised - retention;
  const now = new Date();
  const updated = unwrap(
    await client.hostedEventsCollection.findOneAndUpdate(
      { _id: eventDoc._id, status: "FUNDRAISING" },
      {
        $set: {
          status: "RECRUITING",
          prizePool,
          updatedAt: now,
          "funding.closedAt": now,
          "funding.retentionAmount": retention,
        },
      },
      { returnDocument: "after" },
    ),
  );
  if (!updated) {
    return err("❌ 狀態已改變", "這個活動已經不在募資階段了。");
  }
  return { ok: true, doc: updated, prizePool, retention };
}

async function listDonors(client, eventId) {
  const rows = await client.eventFundDonationsCollection
    .find({ eventId, refundedAt: null })
    .toArray();
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.userId)) {
      byUser.set(row.userId, { userId: row.userId, username: row.username, coins: 0, items: [] });
    }
    const donor = byUser.get(row.userId);
    if (row.kind === "coin") {
      donor.coins += row.coins || 0;
    } else {
      const existing = donor.items.find((i) => i.value === row.itemValue);
      if (existing) existing.qty += row.qty;
      else donor.items.push({ value: row.itemValue, qty: row.qty });
    }
  }
  return [...byUser.values()].sort((a, b) => b.coins - a.coins);
}

// 活動取消：所有尚未退還的贊助原路退回，主辦人一分都拿不到。
async function refundAllDonors(client, eventDoc) {
  const donors = await listDonors(client, eventDoc.eventId);
  let refundedCoins = 0;
  let refundedItems = 0;

  for (const donor of donors) {
    if (donor.coins > 0) {
      const ok = await grantCoins(client, {
        userId: donor.userId,
        guildId: eventDoc.guildId,
        amount: donor.coins,
        source: "event_fund_refund",
        meta: { eventId: eventDoc.eventId, reason: "cancelled", hostId: eventDoc.hostId },
      }).catch((e) => {
        console.log(`[ERROR] fundraise coin refund ${eventDoc.eventId} → ${donor.userId}: ${e}`.red);
        return null;
      });
      if (ok) refundedCoins += donor.coins;
    }
    for (const item of donor.items) {
      const ok = await itemRegistry
        .grant(client, donor.userId, eventDoc.guildId, item.value, item.qty)
        .catch((e) => {
          console.log(`[ERROR] fundraise item refund ${eventDoc.eventId} → ${donor.userId}: ${e}`.red);
          return false;
        });
      if (ok) refundedItems += item.qty;
    }
  }

  await client.eventFundDonationsCollection.updateMany(
    { eventId: eventDoc.eventId, refundedAt: null },
    { $set: { refundedAt: new Date() } },
  );

  return { donorCount: donors.length, refundedCoins, refundedItems };
}

async function payHostRetention(client, eventDoc) {
  const amount = retentionAmount(eventDoc);
  if (amount <= 0) return 0;
  const paid = await grantCoins(client, {
    userId: eventDoc.hostId,
    guildId: eventDoc.guildId,
    amount,
    source: "event_fund_host_share",
    meta: {
      eventId: eventDoc.eventId,
      raised: eventDoc.funding?.raised || 0,
      pct: eventDoc.funding?.hostRetentionPct || 0,
    },
  }).catch((e) => {
    console.log(`[ERROR] fundraise host share ${eventDoc.eventId}: ${e}`.red);
    return null;
  });
  return paid ? amount : 0;
}

module.exports = {
  isEnabled,
  maxRetentionPct,
  maxRankCount,
  retentionAmount,
  isFundingOpen,
  itemPoolOf,
  applyFundraise,
  approve,
  reject,
  donateCoins,
  donateItem,
  startRecruiting,
  listDonors,
  refundAllDonors,
  payHostRetention,
  FUNDING_STATUSES,
};
