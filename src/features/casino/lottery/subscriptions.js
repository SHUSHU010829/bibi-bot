// 訂閱買票:每期前 30 分鐘逐期扣款。

require("colors");
const crypto = require("crypto");

const { casino } = require("../../../config");
const grantCoins = require("../../economy/grantCoins");
const { getCurrentOpenDraw } = require("./runDraw");
const { checkAndAnnouncePoolMilestones } = require("./poolAnnouncer");

function getTypeConfig(lotteryType) {
  return casino?.lottery?.types?.[lotteryType] || {};
}

function getSubConfig() {
  return casino?.lottery?.subscription || {};
}

/**
 * 為單一訂閱嘗試扣款買當期票。
 * @returns {Promise<{ status, charged?, ticketIds? }>}
 */
async function processSubscription(client, sub) {
  if (!client.userCoinsCollection || !client.lotteryTicketsCollection) return null;

  const draw = await getCurrentOpenDraw(client, sub.lotteryType);
  if (!draw) return { status: "no_open_draw" };

  // 已經為這期扣過 → 跳過(冪等)
  if (sub.lastChargedDrawId === draw.drawId) return { status: "already_charged" };

  const typeCfg = getTypeConfig(sub.lotteryType);
  const ticketPrice = typeCfg.ticketPrice || 0;
  const cost = ticketPrice * (sub.ticketsPerDraw || 1);

  // 檢查餘額
  const userDoc = await client.userCoinsCollection.findOne({
    userId: sub.userId,
    guildId: sub.guildId,
  });
  const balance = userDoc?.totalCoins || 0;
  if (balance < cost) {
    const failures = (sub.consecutiveFailures || 0) + 1;
    const threshold = getSubConfig().consecutiveFailureThreshold || 2;
    const newStatus = failures >= threshold ? "cancelled" : "active";

    await client.lotterySubscriptionsCollection.updateOne(
      { subscriptionId: sub.subscriptionId },
      {
        $set: {
          consecutiveFailures: failures,
          status: newStatus,
          updatedAt: new Date(),
        },
      }
    );

    if (newStatus === "cancelled") {
      try {
        const user = await client.users.fetch(sub.userId).catch(() => null);
        await user?.send(
          `❌ 你的樂透訂閱因連續 ${failures} 次餘額不足已自動取消。`
        ).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    return { status: "insufficient", failures };
  }

  // 扣款
  const result = await grantCoins(client, {
    userId: sub.userId,
    guildId: sub.guildId,
    username: sub.username,
    amount: -cost,
    source: "bet",
    meta: {
      game: "lottery",
      lotteryType: sub.lotteryType,
      drawId: draw.drawId,
      subscriptionId: sub.subscriptionId,
      ticketCount: sub.ticketsPerDraw,
    },
  });
  if (!result) return { status: "charge_failed" };

  // 寫票券：訂閱每期同一組號碼，聚合成單一 doc + quantity（原本每張一筆）
  const ticketId = crypto.randomUUID();
  const ticketIds = [ticketId];
  await client.lotteryTicketsCollection.insertOne({
    ticketId,
    drawId: draw.drawId,
    lotteryType: sub.lotteryType,
    userId: sub.userId,
    guildId: sub.guildId,
    username: sub.username,
    numbers: [...sub.numbers],
    quantity: sub.ticketsPerDraw,
    pricePaid: ticketPrice,
    source: "subscription",
    subscriptionId: sub.subscriptionId,
    wheelingId: null,
    matched: 0,
    prize: null,
    payoutAmount: 0,
    createdAt: new Date(),
  });

  // 更新 draw 統計
  const updatedDraw = await client.lotteryDrawsCollection.findOneAndUpdate(
    { _id: draw._id },
    {
      $inc: {
        pool: cost,
        totalRevenue: cost,
        totalTickets: sub.ticketsPerDraw,
      },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" }
  );

  // 訂閱統計
  const drawsRemaining = (sub.drawsRemaining || 1) - 1;
  const newStatus = drawsRemaining <= 0 ? "completed" : "active";
  await client.lotterySubscriptionsCollection.updateOne(
    { subscriptionId: sub.subscriptionId },
    {
      $set: {
        consecutiveFailures: 0,
        drawsRemaining,
        status: newStatus,
        nextDrawId: newStatus === "active" ? null : null,
        lastChargedDrawId: draw.drawId,
        updatedAt: new Date(),
      },
      $inc: {
        totalTicketsBought: sub.ticketsPerDraw,
        totalSpent: cost,
      },
    }
  );

  // 觸發里程碑檢查
  const drawDoc = updatedDraw?.value || updatedDraw;
  if (drawDoc) {
    await checkAndAnnouncePoolMilestones(client, drawDoc._id);
  }

  return {
    status: "charged",
    charged: cost,
    ticketIds,
  };
}

async function processAllSubscriptions(client, options = {}) {
  if (!client.lotterySubscriptionsCollection) return;
  const filter = { status: "active" };
  if (options.lotteryType) filter.lotteryType = options.lotteryType;
  const subs = await client.lotterySubscriptionsCollection.find(filter).toArray();
  let successCount = 0;
  let failCount = 0;
  for (const sub of subs) {
    try {
      const r = await processSubscription(client, sub);
      if (r?.status === "charged") successCount++;
      else if (r?.status === "insufficient") failCount++;
    } catch (err) {
      console.log(`[LOTTERY] 訂閱處理失敗 ${sub.subscriptionId}:${err.message}`.red);
      failCount++;
    }
  }
  const tag = options.lotteryType ? `[${options.lotteryType}] ` : "";
  console.log(
    `[LOTTERY] ${tag}訂閱排程完成。成功 ${successCount} / 失敗 ${failCount} / 總計 ${subs.length}`.cyan
  );
}

module.exports = {
  processSubscription,
  processAllSubscriptions,
};
