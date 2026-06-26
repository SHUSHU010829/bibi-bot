// 樂透開獎流程 + 期數管理。
// - getCurrentOpenDraw: 取得當期 open draw
// - ensureNextDraw: 開新一期(含 rollover、期中提醒排程)
// - runDraw: 執行開獎(鎖期 → 抽號 → 比對 → 派彩 → 滾池 → 開新期)

require("colors");
const { DateTime } = require("luxon");

const { casino } = require("../../../config");
const {
  generateWinningNumbers,
  generateSpecialNumber,
  generateBonusBall,
  buildDrawId,
} = require("./draw");
const { countMatches, hasConsecutiveRun, hasSecondZone } = require("./numbers");
const { calculatePayout } = require("./payout");
const { generateReminderSchedule } = require("./reminderScheduler");
const { nextDrawTime } = require("./schedule");
const grantCoins = require("../../economy/grantCoins");

const TZ = "Asia/Taipei";

function getLotteryConfig() {
  return casino?.lottery || {};
}

function getTypeConfig(lotteryType) {
  return getLotteryConfig().types?.[lotteryType] || {};
}

function formatDrawIdDate(scheduledAt) {
  return DateTime.fromJSDate(scheduledAt).setZone(TZ).toFormat("yyyyMMdd");
}

async function getCurrentOpenDraw(client, lotteryType) {
  if (!client.lotteryDrawsCollection) return null;
  return client.lotteryDrawsCollection.findOne({
    lotteryType,
    status: "open",
  });
}

/**
 * 開新一期(若尚未存在)。
 * @param {object} client
 * @param {string} lotteryType
 * @param {object} options
 * @param {number} [options.rolledOverAmount=0]
 * @param {string} [options.rolledOverFromDrawId]
 * @returns {Promise<object|null>} 新建的 draw doc (若已有 open 期則回傳該期)
 */
async function ensureNextDraw(client, lotteryType, options = {}) {
  if (!client.lotteryDrawsCollection) return null;

  const existing = await getCurrentOpenDraw(client, lotteryType);
  if (existing) return existing;

  const typeCfg = getTypeConfig(lotteryType);
  if (!typeCfg.enabled) return null;

  const drawTime = nextDrawTime(lotteryType);
  const dateStr = formatDrawIdDate(drawTime.toJSDate());
  const drawId = buildDrawId(dateStr, lotteryType);

  // 先檢查 drawId 是否已存在(可能是 settled 期),若存在就略過
  const dup = await client.lotteryDrawsCollection.findOne({ drawId });
  if (dup) {
    if (dup.status === "open") return dup;
    return null;
  }

  // drawNumber:該玩法已開過幾期 + 1
  const lastBy = await client.lotteryDrawsCollection
    .find({ lotteryType })
    .sort({ drawNumber: -1 })
    .limit(1)
    .toArray();
  const drawNumber = (lastBy[0]?.drawNumber || 0) + 1;

  const systemSeed = typeCfg.systemSeed || 0;
  const rolledOverAmount = Math.max(0, Math.floor(options.rolledOverAmount || 0));
  const initialPool = systemSeed + rolledOverAmount;

  const scheduledReminders = generateReminderSchedule(drawTime.toJSDate());

  const doc = {
    drawId,
    lotteryType,
    drawNumber,
    status: "open",
    scheduledAt: drawTime.toJSDate(),
    drawnAt: null,
    winningNumbers: null,
    pool: initialPool,
    systemSeedAmount: systemSeed,
    rolledOverFrom: rolledOverAmount > 0 ? options.rolledOverFromDrawId || null : null,
    announcedMilestones: [],
    scheduledReminders,
    payout: null,
    totalTickets: 0,
    totalRevenue: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const result = await client.lotteryDrawsCollection.insertOne(doc);
    doc._id = result.insertedId;
    console.log(
      `[LOTTERY] 開新期 ${drawId}(底池 ${initialPool},開獎 ${drawTime.toFormat("MM-dd HH:mm")})`.green
    );
    return doc;
  } catch (err) {
    if (err.code === 11000) {
      // 別人剛好同時開了,讀回來
      return client.lotteryDrawsCollection.findOne({ drawId });
    }
    throw err;
  }
}

/**
 * 執行開獎(冪等,只會處理 status=open 的期)。
 */
async function runDraw(client, lotteryType) {
  if (!client.lotteryDrawsCollection || !client.lotteryTicketsCollection) {
    throw new Error("DB not ready");
  }

  // 鎖期:open → drawing(scheduledAt 已到才開,避免兩開週中誤開未到期的 draw)
  const lockResult = await client.lotteryDrawsCollection.findOneAndUpdate(
    { lotteryType, status: "open", scheduledAt: { $lte: new Date() } },
    { $set: { status: "drawing", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const draw = lockResult?.value || lockResult;
  if (!draw) {
    console.log(`[LOTTERY] runDraw ${lotteryType}: 沒有 open 期可開`.yellow);
    return null;
  }

  console.log(`[LOTTERY] 開始開獎 ${draw.drawId}(彩池 ${draw.pool})`.cyan);

  const winningNumbers = generateWinningNumbers(lotteryType);
  // 威力彩式雙區：抽第二區號碼
  const winningSpecial = hasSecondZone(lotteryType)
    ? generateSpecialNumber(lotteryType)
    : null;
  const tickets = await client.lotteryTicketsCollection
    .find({ drawId: draw.drawId })
    .toArray();

  // 比對每張票（第一區命中數 + 第二區是否命中）
  const ticketMatched = tickets.map((t) => ({
    ticketId: t.ticketId,
    matched: countMatches(t.numbers, winningNumbers),
    specialMatched: winningSpecial != null && t.special === winningSpecial,
  }));

  const typeCfg = getTypeConfig(lotteryType);

  // 加碼球 + 連號加碼：系統固定額側獎，獨立於彩池分配（不影響頭/二/三/四獎與滾池）。
  const bonusBallCfg = typeCfg.bonusBall || {};
  const consecutiveCfg = typeCfg.consecutiveBonus || {};
  const winSet = new Set(winningNumbers);
  const bonusBall =
    bonusBallCfg.enabled && bonusBallCfg.prize > 0
      ? generateBonusBall(lotteryType, winningNumbers)
      : null;
  const consecMinRun = consecutiveCfg.minRun ?? 3;
  // 每張票的側獎：bonusBall 命中 + 中獎號碼中含連號
  const ticketBonus = new Map();
  for (const t of tickets) {
    let amount = 0;
    const flags = { bonusBall: false, consecutive: false };
    if (bonusBall != null && t.numbers.includes(bonusBall)) {
      amount += bonusBallCfg.prize;
      flags.bonusBall = true;
    }
    if (consecutiveCfg.enabled && consecutiveCfg.prize > 0) {
      const matchedNums = t.numbers.filter((n) => winSet.has(n));
      if (hasConsecutiveRun(matchedNums, consecMinRun)) {
        amount += consecutiveCfg.prize;
        flags.consecutive = true;
      }
    }
    if (amount > 0) ticketBonus.set(t.ticketId, { amount, flags });
  }
  const { prizes, ticketAssignments } = calculatePayout({
    lotteryType,
    pool: draw.pool,
    tickets: ticketMatched,
    config: typeCfg,
  });

  // bulkWrite 票券更新
  const ticketsById = new Map(tickets.map((t) => [t.ticketId, t]));
  const bonusSummary = {
    bonusBall,
    bonusBallPrize: bonusBallCfg.prize || 0,
    consecutivePrize: consecutiveCfg.prize || 0,
    consecutiveMinRun: consecMinRun,
    bonusBallWinners: 0,
    consecutiveWinners: 0,
    totalBonusPaid: 0,
  };
  if (ticketAssignments.length > 0) {
    const ops = [];
    for (const a of ticketAssignments) {
      const tk = ticketsById.get(a.ticketId);
      const mInfo = ticketMatched.find((m) => m.ticketId === a.ticketId);
      const matched = mInfo?.matched || 0;
      const bonus = ticketBonus.get(a.ticketId);
      const bonusAmount = bonus?.amount || 0;
      ops.push({
        updateOne: {
          filter: { ticketId: a.ticketId },
          update: {
            $set: {
              matched,
              specialMatched: !!mInfo?.specialMatched,
              prize: a.prize,
              payoutAmount: a.payoutAmount,
              bonusPayout: bonusAmount,
              bonusFlags: bonus?.flags || { bonusBall: false, consecutive: false },
            },
          },
        },
      });
      // 派彩(只發中獎的)
      if (a.prize && a.payoutAmount > 0 && tk) {
        await grantCoins(client, {
          userId: tk.userId,
          guildId: tk.guildId,
          username: tk.username,
          amount: a.payoutAmount,
          source: "payout",
          meta: {
            game: "lottery",
            lotteryType,
            drawId: draw.drawId,
            ticketId: a.ticketId,
            prize: a.prize,
            matched,
          },
        });
      }
      // 側獎派彩（加碼球 / 連號），系統固定額，獨立發放
      if (bonusAmount > 0 && tk) {
        if (bonus.flags.bonusBall) bonusSummary.bonusBallWinners += 1;
        if (bonus.flags.consecutive) bonusSummary.consecutiveWinners += 1;
        bonusSummary.totalBonusPaid += bonusAmount;
        await grantCoins(client, {
          userId: tk.userId,
          guildId: tk.guildId,
          username: tk.username,
          amount: bonusAmount,
          source: "payout",
          meta: {
            game: "lottery",
            lotteryType,
            drawId: draw.drawId,
            ticketId: a.ticketId,
            prize: "bonus",
            bonusFlags: bonus.flags,
          },
        });
      }
    }
    if (ops.length > 0) {
      await client.lotteryTicketsCollection.bulkWrite(ops, { ordered: false });
    }
  }

  // 包牌彙總
  const wheelingIds = new Set(
    tickets.map((t) => t.wheelingId).filter(Boolean)
  );
  for (const wid of wheelingIds) {
    const wheelTickets = tickets.filter((t) => t.wheelingId === wid);
    let totalWon = 0;
    let bestPrize = null;
    const prizeRank = { jackpot: 4, second: 3, third: 2, fourth: 1 };
    for (const t of wheelTickets) {
      const a = ticketAssignments.find((x) => x.ticketId === t.ticketId);
      if (!a) continue;
      totalWon += a.payoutAmount || 0;
      if (a.prize && (!bestPrize || prizeRank[a.prize] > prizeRank[bestPrize])) {
        bestPrize = a.prize;
      }
    }
    await client.lotteryWheelsCollection?.updateOne(
      { wheelingId: wid },
      { $set: { totalWon, bestPrize } }
    );
  }

  // 更新訂閱統計(該期被買的票對應的 subscriptionId)
  const subIds = new Set(
    tickets.map((t) => t.subscriptionId).filter(Boolean)
  );
  for (const sid of subIds) {
    const subTickets = tickets.filter((t) => t.subscriptionId === sid);
    let won = 0;
    for (const t of subTickets) {
      const a = ticketAssignments.find((x) => x.ticketId === t.ticketId);
      if (a) won += a.payoutAmount || 0;
    }
    if (won > 0) {
      await client.lotterySubscriptionsCollection?.updateOne(
        { subscriptionId: sid },
        { $inc: { totalWon: won } }
      );
    }
  }

  // 結算 draw doc
  const rolledOverAmount = prizes.rolledOver?.amount || 0;
  // 通用組裝：複製所有獎項層級（6/49 有 jackpot~fourth，威力彩有 jackpot~ninth），
  // 再補 rolledOver / bonus，並保留 third/fourth 的 null 後備（圖卡相容）。
  const payoutDoc = {};
  for (const [k, v] of Object.entries(prizes)) {
    if (k !== "rolledOver") payoutDoc[k] = v;
  }
  if (payoutDoc.third === undefined) payoutDoc.third = null;
  if (payoutDoc.fourth === undefined) payoutDoc.fourth = null;
  payoutDoc.rolledOver = { amount: rolledOverAmount, toDrawId: null };
  payoutDoc.bonus =
    bonusBall != null || bonusSummary.totalBonusPaid > 0 ? bonusSummary : null;

  await client.lotteryDrawsCollection.updateOne(
    { _id: draw._id },
    {
      $set: {
        status: "settled",
        drawnAt: new Date(),
        winningNumbers,
        specialNumber: winningSpecial,
        bonusBall,
        payout: payoutDoc,
        updatedAt: new Date(),
      },
    }
  );

  console.log(
    `[LOTTERY] ${draw.drawId} 開獎完成。中獎號碼 [${winningNumbers.join(",")}],滾池 ${rolledOverAmount}`.green
  );

  // 開新期
  const newDraw = await ensureNextDraw(client, lotteryType, {
    rolledOverAmount,
    rolledOverFromDrawId: draw.drawId,
  });
  if (newDraw && rolledOverAmount > 0) {
    await client.lotteryDrawsCollection.updateOne(
      { _id: draw._id },
      { $set: { "payout.rolledOver.toDrawId": newDraw.drawId } }
    );
  }

  return {
    draw: {
      ...draw,
      winningNumbers,
      specialNumber: winningSpecial,
      bonusBall,
      payout: payoutDoc,
      status: "settled",
      drawnAt: new Date(),
    },
    nextDraw: newDraw,
    tickets,
    ticketAssignments,
  };
}

module.exports = {
  getCurrentOpenDraw,
  ensureNextDraw,
  runDraw,
};
