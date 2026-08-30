// 樂透開獎流程 + 期數管理。
// - getCurrentOpenDraw: 取得當期 open draw
// - ensureNextDraw: 開新一期(含 rollover、期中提醒排程)
// - runDraw: 執行開獎(鎖期 → 抽號 → 比對 → 派彩 → 滾池 → 開新期)

require("colors");
const { DateTime } = require("luxon");
const pLimit = require("p-limit");

const { casino } = require("../../../config");
const {
  generateWinningNumbers,
  generateSpecialNumber,
  generateBonusBall,
  buildDrawId,
} = require("./draw");
const {
  hasConsecutiveRun,
  hasSecondZone,
  getLotteryConfig: getNumberConfig,
} = require("./numbers");
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
  if (existing) {
    // 補開/亂序開獎時下一期可能已存在:把滾池金額補進既有開期,避免金額落空。
    const add = Math.max(0, Math.floor(options.rolledOverAmount || 0));
    if (
      add > 0 &&
      options.rolledOverFromDrawId &&
      existing.rolledOverFrom !== options.rolledOverFromDrawId
    ) {
      await client.lotteryDrawsCollection.updateOne(
        { _id: existing._id },
        {
          $inc: { pool: add },
          $set: {
            rolledOverFrom: options.rolledOverFromDrawId,
            updatedAt: new Date(),
          },
        }
      );
      return { ...existing, pool: existing.pool + add, rolledOverFrom: options.rolledOverFromDrawId };
    }
    return existing;
  }

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

  // 已被滾池跨過的里程碑直接視為已播報，避免新一期重播相同金額。
  const milestones = casino?.lottery?.poolMilestones?.[lotteryType] || [];
  const announcedMilestones = milestones.filter((m) => initialPool >= m);

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
    announcedMilestones,
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

// 一次 $in 塞太多 ticketId 會讓單筆指令膨脹到 BSON 上限附近，切塊送。
const TICKET_UPDATE_CHUNK = 5000;
// 派彩並行度：同一位玩家的入帳必須序列化（同一個 grantCoins 呼叫內完成），
// 不同玩家之間才並行，避免上百位得主變成上百次序列化 round-trip。
const PAYOUT_CONCURRENCY = 4;

/**
 * 回寫票券結果。resultGroups 已依「結果完全相同」分群，故是數十筆 updateMany 而非每張票一筆。
 */
async function writeTicketResults(client, resultGroups) {
  const ops = [];
  for (const group of resultGroups.values()) {
    for (let i = 0; i < group.ids.length; i += TICKET_UPDATE_CHUNK) {
      ops.push({
        updateMany: {
          filter: { ticketId: { $in: group.ids.slice(i, i + TICKET_UPDATE_CHUNK) } },
          update: { $set: group.set },
        },
      });
    }
  }
  if (ops.length > 0) {
    await client.lotteryTicketsCollection.bulkWrite(ops, { ordered: false });
  }
}

/**
 * 派彩：一位玩家該期最多兩筆入帳（主獎合計 + 側獎合計），不再逐張票發。
 * meta 記錄各獎項的中獎張數，帳目仍可完整還原。
 */
async function payoutWinners(client, { users, lotteryType, drawId }) {
  const limit = pLimit(PAYOUT_CONCURRENCY);
  await Promise.all(
    users.map((u) =>
      limit(async () => {
        if (u.main > 0) {
          await grantCoins(client, {
            userId: u.userId,
            guildId: u.guildId,
            username: u.username,
            amount: u.main,
            source: "payout",
            meta: {
              game: "lottery",
              lotteryType,
              drawId,
              prizeTiers: u.tiers,
              quantity: Object.values(u.tiers).reduce((s, n) => s + n, 0),
              aggregated: true,
            },
          });
        }
        if (u.bonus > 0) {
          await grantCoins(client, {
            userId: u.userId,
            guildId: u.guildId,
            username: u.username,
            amount: u.bonus,
            source: "payout",
            meta: {
              game: "lottery",
              lotteryType,
              drawId,
              prize: "bonus",
              bonusFlags: {
                bonusBall: u.bonusBallTickets > 0,
                consecutive: u.consecutiveTickets > 0,
              },
              bonusBallTickets: u.bonusBallTickets,
              consecutiveTickets: u.consecutiveTickets,
              quantity: Math.max(u.bonusBallTickets, u.consecutiveTickets),
              aggregated: true,
            },
          });
        }
      })
    )
  );
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
  // 只取結算用得到的欄位：票券 3 萬張時完整 doc 會多吃好幾倍記憶體。
  const tickets = await client.lotteryTicketsCollection
    .find(
      { drawId: draw.drawId },
      {
        projection: {
          _id: 0,
          ticketId: 1,
          userId: 1,
          guildId: 1,
          username: 1,
          numbers: 1,
          special: 1,
          quantity: 1,
          subscriptionId: 1,
          wheelingId: 1,
        },
      }
    )
    .toArray();

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
  const consecutiveEnabled = !!(consecutiveCfg.enabled && consecutiveCfg.prize > 0);

  // 單次掃描把「命中數・第二區・側獎」標注回票券物件本身。
  // （分成多個平行 array 再用 .find() 互查會變 O(N²)，3 萬張票就會卡住整個 bot。）
  for (const t of tickets) {
    t.quantity = t.quantity || 1;
    const matchedNumbers = [];
    for (const n of t.numbers) if (winSet.has(n)) matchedNumbers.push(n);
    t.matched = matchedNumbers.length;
    t.specialMatched = winningSpecial != null && t.special === winningSpecial;

    let bonusAmount = 0;
    const bonusFlags = { bonusBall: false, consecutive: false };
    if (bonusBall != null && t.numbers.includes(bonusBall)) {
      bonusAmount += bonusBallCfg.prize;
      bonusFlags.bonusBall = true;
    }
    if (consecutiveEnabled && hasConsecutiveRun(matchedNumbers, consecMinRun)) {
      bonusAmount += consecutiveCfg.prize;
      bonusFlags.consecutive = true;
    }
    t.bonusPayout = bonusAmount;
    t.bonusFlags = bonusFlags;
  }

  const { prizes, ticketAssignments } = calculatePayout({
    lotteryType,
    pool: draw.pool,
    tickets,
    config: typeCfg,
  });
  const assignmentById = new Map(ticketAssignments.map((a) => [a.ticketId, a]));

  // 票券結果完全由（命中數・第二區・獎項・每張金額・側獎旗標）決定，相同結果的票共用
  // 同一份 $set → 不論幾萬張票，回寫都只會是數十筆 updateMany。
  const settledAt = new Date();
  const resultGroups = new Map();
  for (const t of tickets) {
    const a = assignmentById.get(t.ticketId);
    const prize = a?.prize ?? null;
    const payoutAmount = a?.payoutAmount || 0;
    const key =
      `${t.matched}|${t.specialMatched ? 1 : 0}|${prize ?? ""}|${payoutAmount}|` +
      `${t.bonusPayout}|${t.bonusFlags.bonusBall ? 1 : 0}${t.bonusFlags.consecutive ? 1 : 0}`;
    let group = resultGroups.get(key);
    if (!group) {
      group = {
        ids: [],
        set: {
          matched: t.matched,
          specialMatched: t.specialMatched,
          prize,
          payoutAmount,
          bonusPayout: t.bonusPayout,
          bonusFlags: t.bonusFlags,
          settledAt,
        },
      };
      resultGroups.set(key, group);
    }
    group.ids.push(t.ticketId);
  }
  // 先落地票券結果再派彩：中途中斷時 settleStuckDrawInPlace 一定能直接從票券還原，
  // 不必再回頭去解交易紀錄。
  await writeTicketResults(client, resultGroups);

  // 彙總：派彩以「玩家」為單位、包牌以 wheelingId、訂閱以 subscriptionId，同一次掃描完成。
  const bonusSummary = {
    bonusBall,
    bonusBallPrize: bonusBallCfg.prize || 0,
    consecutivePrize: consecutiveCfg.prize || 0,
    consecutiveMinRun: consecMinRun,
    bonusBallWinners: 0,
    consecutiveWinners: 0,
    totalBonusPaid: 0,
  };
  const payoutByUser = new Map();
  const wheelTotals = new Map();
  const subscriptionTotals = new Map();
  const prizeRank = { jackpot: 4, second: 3, third: 2, fourth: 1 };

  for (const t of tickets) {
    const a = assignmentById.get(t.ticketId);
    const mainWon = a?.prize && a.payoutAmount > 0 ? a.payoutAmount * t.quantity : 0;
    const bonusWon = t.bonusPayout * t.quantity;

    if (t.bonusFlags.bonusBall) bonusSummary.bonusBallWinners += t.quantity;
    if (t.bonusFlags.consecutive) bonusSummary.consecutiveWinners += t.quantity;
    bonusSummary.totalBonusPaid += bonusWon;

    if (mainWon > 0 || bonusWon > 0) {
      const key = `${t.userId} ${t.guildId}`;
      let acc = payoutByUser.get(key);
      if (!acc) {
        acc = {
          userId: t.userId,
          guildId: t.guildId,
          username: t.username,
          main: 0,
          bonus: 0,
          tiers: {},
          bonusBallTickets: 0,
          consecutiveTickets: 0,
        };
        payoutByUser.set(key, acc);
      }
      acc.main += mainWon;
      acc.bonus += bonusWon;
      if (mainWon > 0) acc.tiers[a.prize] = (acc.tiers[a.prize] || 0) + t.quantity;
      if (t.bonusFlags.bonusBall) acc.bonusBallTickets += t.quantity;
      if (t.bonusFlags.consecutive) acc.consecutiveTickets += t.quantity;
    }

    if (t.wheelingId) {
      let w = wheelTotals.get(t.wheelingId);
      if (!w) {
        w = { totalWon: 0, bestPrize: null };
        wheelTotals.set(t.wheelingId, w);
      }
      w.totalWon += (a?.payoutAmount || 0) * t.quantity;
      if (a?.prize && (!w.bestPrize || prizeRank[a.prize] > prizeRank[w.bestPrize])) {
        w.bestPrize = a.prize;
      }
    }
    if (t.subscriptionId && mainWon > 0) {
      subscriptionTotals.set(
        t.subscriptionId,
        (subscriptionTotals.get(t.subscriptionId) || 0) + mainWon
      );
    }
  }

  await payoutWinners(client, {
    users: [...payoutByUser.values()],
    lotteryType,
    drawId: draw.drawId,
  });

  if (wheelTotals.size > 0 && client.lotteryWheelsCollection) {
    await client.lotteryWheelsCollection.bulkWrite(
      [...wheelTotals].map(([wheelingId, w]) => ({
        updateOne: {
          filter: { wheelingId },
          update: { $set: { totalWon: w.totalWon, bestPrize: w.bestPrize } },
        },
      })),
      { ordered: false }
    );
  }
  if (subscriptionTotals.size > 0 && client.lotterySubscriptionsCollection) {
    await client.lotterySubscriptionsCollection.bulkWrite(
      [...subscriptionTotals].map(([subscriptionId, won]) => ({
        updateOne: {
          filter: { subscriptionId },
          update: { $inc: { totalWon: won } },
        },
      })),
      { ordered: false }
    );
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

/**
 * 救援卡在 status="drawing" 的期(開獎鎖期後、結算前被中斷,例如維修/重啟)。
 * 開獎的中獎號碼只在結算時才落地,中斷的期沒有結果可續跑,只能重置回 open 由 runDraw 重抽。
 * 為避免重複派彩:若該期已有 payout 交易紀錄,預設拒絕重置(force 才強制)。
 * @returns {Promise<{recovered:boolean, reason?:string, drawId?:string, paidCount?:number}>}
 */
async function recoverStuckDraw(client, lotteryType, { force = false } = {}) {
  if (!client.lotteryDrawsCollection) return { recovered: false, reason: "db_not_ready" };

  const stuck = await client.lotteryDrawsCollection.findOne({
    lotteryType,
    status: "drawing",
  });
  if (!stuck) return { recovered: false, reason: "no_stuck" };

  const paidCount = client.coinTransactionsCollection
    ? await client.coinTransactionsCollection.countDocuments({
        source: "payout",
        "meta.game": "lottery",
        "meta.drawId": stuck.drawId,
      })
    : 0;

  if (paidCount > 0 && !force) {
    return { recovered: false, reason: "already_paid", drawId: stuck.drawId, paidCount };
  }

  await client.lotteryDrawsCollection.updateOne(
    { _id: stuck._id, status: "drawing" },
    { $set: { status: "open", updatedAt: new Date() } }
  );
  return { recovered: true, drawId: stuck.drawId, paidCount };
}

/**
 * 由每張票券已存的命中數(matched)反推中獎號碼。
 * 對每張票:恰有 matched 個號碼落在中獎集合 S 內。用約束傳播推導:
 *   - matched=0 → 該票所有號碼都不在 S
 *   - matched=票數 → 該票所有號碼都在 S
 *   - 已知在/不在的數量湊齊後,剩下的未知號碼也能定死
 * 票量夠大(尤其有大量 matched=0 的落選票)時 S 可被唯一決定;無法決定則回 null。
 * 只會在「被票券證明」時斷定,故重建結果必與所有票券一致,不會給出錯的號碼。
 */
function reconstructWinningNumbers(tickets, range, pickCount) {
  const inS = new Set();
  const notIn = new Set();
  for (const t of tickets) {
    const m = t.matched || 0;
    if (m === 0) t.numbers.forEach((n) => notIn.add(n));
    else if (m === pickCount) t.numbers.forEach((n) => inS.add(n));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tickets) {
      const m = t.matched || 0;
      const unknown = t.numbers.filter((n) => !inS.has(n) && !notIn.has(n));
      if (unknown.length === 0) continue;
      const knownIn = t.numbers.filter((n) => inS.has(n)).length;
      const needIn = m - knownIn;
      if (needIn === 0) {
        unknown.forEach((n) => notIn.add(n));
        changed = true;
      } else if (needIn === unknown.length) {
        unknown.forEach((n) => inS.add(n));
        changed = true;
      }
    }
  }
  if (inS.size === pickCount) return [...inS].sort((a, b) => a - b);
  // 後備:1..range 中未被排除者恰好 pickCount 個,即為 S
  const remaining = [];
  for (let n = 1; n <= range; n++) if (!notIn.has(n)) remaining.push(n);
  if (remaining.length === pickCount) return remaining.sort((a, b) => a - b);
  return null;
}

function combinations(arr, k) {
  const res = [];
  const rec = (start, combo) => {
    if (combo.length === k) {
      res.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      rec(i + 1, combo);
      combo.pop();
    }
  };
  rec(0, []);
  return res;
}

const SOLVER_CANDIDATE_CAP = 800000;

/**
 * 由「中獎票 + 其精確命中數(取自交易紀錄 meta.matched)」反推中獎號碼。
 * 以命中數最高的中獎票為錨:S 含它的 m 個號碼 + (pickCount-m) 個它以外的號碼,枚舉所有
 * 候選,再要求「每張中獎票 ∩ S === 其命中數」且「每張落選票 ∩ S < 最低得獎門檻」。
 * 唯一通過者即 S;否則(資訊不足以決定或候選超上限)回 null。驗證保證不會給出錯號碼。
 */
function solveWinningNumbersFromWinners(winners, losers, range, pickCount) {
  if (!winners.length) return null;
  let anchor = winners[0];
  for (const w of winners) if (w.matched > anchor.matched) anchor = w;
  const m = anchor.matched;
  if (m <= 0 || m > pickCount) return null;
  const minWin = Math.min(...winners.map((w) => w.matched));
  const anchorSet = new Set(anchor.numbers);
  const outPool = [];
  for (let n = 1; n <= range; n++) if (!anchorSet.has(n)) outPool.push(n);
  const inCombos = combinations(anchor.numbers, m);
  const outCombos = combinations(outPool, pickCount - m);
  if (inCombos.length * outCombos.length > SOLVER_CANDIDATE_CAP) return null;

  let found = null;
  let count = 0;
  for (const inPart of inCombos) {
    for (const outPart of outCombos) {
      const S = new Set([...inPart, ...outPart]);
      let ok = true;
      for (const w of winners) {
        let c = 0;
        for (const n of w.numbers) if (S.has(n)) c++;
        if (c !== w.matched) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (const l of losers) {
          let c = 0;
          for (const n of l.numbers) if (S.has(n)) c++;
          if (c >= minWin) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        count++;
        if (count > 1) return null;
        found = [...S];
      }
    }
  }
  return count === 1 ? found.sort((a, b) => a - b) : null;
}

/**
 * 威力彩第二區號碼反推:試 1..specialRange,挑出讓每張中獎票重算獎項層級與交易紀錄
 * (meta.prize)完全一致的那個號碼;不唯一則回 null。
 */
function solveSpecialNumber(lotteryType, tickets, matchedByTicket, mainTxns, typeCfg, pool, specialRange) {
  const prizeByTicket = new Map(mainTxns.map((x) => [x.meta.ticketId, x.meta.prize]));
  let hit = null;
  let count = 0;
  for (let s = 1; s <= specialRange; s++) {
    const tm = tickets.map((t) => ({
      ticketId: t.ticketId,
      quantity: t.quantity || 1,
      matched: matchedByTicket.get(t.ticketId) || 0,
      specialMatched: t.special === s,
    }));
    const { ticketAssignments } = calculatePayout({ lotteryType, pool, tickets: tm, config: typeCfg });
    const assigned = new Map(ticketAssignments.map((a) => [a.ticketId, a.prize]));
    let ok = true;
    for (const [tid, pr] of prizeByTicket) {
      if (assigned.get(tid) !== pr) {
        ok = false;
        break;
      }
    }
    if (ok) {
      count++;
      if (count > 1) return null;
      hit = s;
    }
  }
  return count === 1 ? hit : null;
}

/**
 * 就地結算「已派彩但卡在 drawing」的期:不重抽、不重付,重建開獎結果、補標記 settled、滾池。
 * 兩種資料來源:
 *   A. 票券已寫回 matched/prize(bulkWrite 有跑)→ 直接用票券反推。
 *   B. 票券沒寫回(bulkWrite 前就中斷)→ 用 CoinTransactions 每筆 meta(ticketId/matched/prize)
 *      反推中獎號碼,再用號碼重算全體並回填票券(修好被中斷的 bulkWrite)。
 * 全程不呼叫 grantCoins。
 * @returns {Promise<{ok:boolean, reason?:string, drawId?:string, draw?:object, tickets?:object[], numbersRecovered?:boolean, payoutMatches?:boolean}>}
 */
async function settleStuckDrawInPlace(client, lotteryType, { allowMissingNumbers = false } = {}) {
  if (!client.lotteryDrawsCollection || !client.lotteryTicketsCollection) {
    return { ok: false, reason: "db_not_ready" };
  }
  const draw = await client.lotteryDrawsCollection.findOne({
    lotteryType,
    status: "drawing",
  });
  if (!draw) return { ok: false, reason: "no_stuck" };

  const tickets = await client.lotteryTicketsCollection
    .find({ drawId: draw.drawId })
    .toArray();
  const ticketById = new Map(tickets.map((t) => [t.ticketId, t]));
  const typeCfg = getTypeConfig(lotteryType);
  const numCfg = getNumberConfig(lotteryType) || {};
  const range = numCfg.range;
  const pickCount = numCfg.pickCount;

  // runDraw 一律先回寫票券結果再派彩，所以有 settledAt 就代表結果已落地（即使全部落選、
  // matched 都是 0）。舊資料沒有 settledAt，退回用 matched / prize 判斷。
  const resultsWritten = tickets.some(
    (t) => t.settledAt || (t.matched || 0) > 0 || t.prize != null
  );

  let winningNumbers = null;
  const matchedByTicket = new Map();
  let mainTxns = [];
  let bonusTxns = [];
  let repairTickets = false;

  if (resultsWritten) {
    for (const t of tickets) matchedByTicket.set(t.ticketId, t.matched || 0);
    winningNumbers = reconstructWinningNumbers(tickets, range, pickCount);
  } else {
    // 票券沒寫回結果 → 從交易紀錄反推(每筆派彩 meta 都記了 ticketId/matched/prize)。
    if (!client.coinTransactionsCollection) {
      return { ok: false, reason: "no_ticket_results", drawId: draw.drawId };
    }
    const txns = await client.coinTransactionsCollection
      .find({ source: "payout", "meta.game": "lottery", "meta.drawId": draw.drawId })
      .toArray();
    mainTxns = txns.filter(
      (x) => x.meta && x.meta.prize !== "bonus" && typeof x.meta.matched === "number"
    );
    bonusTxns = txns.filter((x) => x.meta && x.meta.prize === "bonus");
    if (!mainTxns.length) {
      return { ok: false, reason: "no_ticket_results", drawId: draw.drawId };
    }
    const winnerIds = new Set();
    const winners = [];
    for (const x of mainTxns) {
      const tk = ticketById.get(x.meta.ticketId);
      if (!tk) continue;
      winnerIds.add(x.meta.ticketId);
      winners.push({ numbers: tk.numbers, matched: x.meta.matched });
    }
    const losers = tickets
      .filter((t) => !winnerIds.has(t.ticketId))
      .map((t) => ({ numbers: t.numbers }));
    winningNumbers = solveWinningNumbersFromWinners(winners, losers, range, pickCount);
    if (winningNumbers) {
      const Sset = new Set(winningNumbers);
      for (const t of tickets) {
        let c = 0;
        for (const n of t.numbers) if (Sset.has(n)) c++;
        matchedByTicket.set(t.ticketId, c);
      }
    } else {
      // 沒解出號碼:退而用交易紀錄的中獎票命中數,落選票視為 0(獎項仍正確,只缺號碼)。
      for (const t of tickets) matchedByTicket.set(t.ticketId, 0);
      for (const x of mainTxns) matchedByTicket.set(x.meta.ticketId, x.meta.matched);
    }
    repairTickets = true;
  }

  if (!winningNumbers && !allowMissingNumbers) {
    return { ok: false, reason: "numbers_unrecoverable", drawId: draw.drawId };
  }

  // 第二區(威力彩):有號碼且是 txn 來源就重算 special;A 來源沿用票券已寫回的 specialMatched。
  let specialNumber = null;
  if (hasSecondZone(lotteryType)) {
    if (winningNumbers && mainTxns.length) {
      specialNumber = solveSpecialNumber(
        lotteryType,
        tickets,
        matchedByTicket,
        mainTxns,
        typeCfg,
        draw.pool,
        numCfg.special?.range || 8
      );
    } else if (resultsWritten) {
      specialNumber = tickets.find((t) => t.specialMatched)?.special ?? null;
    }
  }

  const specialMatchedOf = (t) =>
    specialNumber != null ? t.special === specialNumber : !!t.specialMatched;

  const ticketMatched = tickets.map((t) => ({
    ticketId: t.ticketId,
    quantity: t.quantity || 1,
    matched: matchedByTicket.get(t.ticketId) || 0,
    specialMatched: specialMatchedOf(t),
  }));
  const { prizes, ticketAssignments } = calculatePayout({
    lotteryType,
    pool: draw.pool,
    tickets: ticketMatched,
    config: typeCfg,
  });

  // 一致性檢查:重算的主獎總額應等於交易紀錄的主獎派彩總額。
  let payoutMatches = true;
  if (mainTxns.length) {
    const qtyOf = new Map(tickets.map((t) => [t.ticketId, t.quantity || 1]));
    const recomputed = ticketAssignments.reduce(
      (s, a) => s + (a.payoutAmount || 0) * (qtyOf.get(a.ticketId) || 1),
      0
    );
    const paid = mainTxns.reduce((s, x) => s + (x.amount || 0), 0);
    payoutMatches = recomputed === paid;
  }

  // 側獎彙總:txn 來源用 bonusTxns;票券來源用票券已寫回欄位。加碼球號碼已遺失,記 null。
  let bonusBallWinners = 0;
  let consecutiveWinners = 0;
  let totalBonusPaid = 0;
  const bonusByTicket = new Map();
  if (bonusTxns.length) {
    for (const x of bonusTxns) {
      const q = x.meta.quantity || 1;
      if (x.meta.bonusFlags?.bonusBall) bonusBallWinners += q;
      if (x.meta.bonusFlags?.consecutive) consecutiveWinners += q;
      totalBonusPaid += x.amount || 0;
      bonusByTicket.set(x.meta.ticketId, {
        amount: Math.round((x.amount || 0) / q),
        flags: {
          bonusBall: !!x.meta.bonusFlags?.bonusBall,
          consecutive: !!x.meta.bonusFlags?.consecutive,
        },
      });
    }
  } else {
    for (const t of tickets) {
      const q = t.quantity || 1;
      if (t.bonusFlags?.bonusBall) bonusBallWinners += q;
      if (t.bonusFlags?.consecutive) consecutiveWinners += q;
      if (t.bonusPayout) totalBonusPaid += t.bonusPayout * q;
    }
  }
  const bonusBallCfg = typeCfg.bonusBall || {};
  const consecutiveCfg = typeCfg.consecutiveBonus || {};
  const bonusSummary =
    totalBonusPaid > 0
      ? {
          bonusBall: null,
          bonusBallPrize: bonusBallCfg.prize || 0,
          consecutivePrize: consecutiveCfg.prize || 0,
          consecutiveMinRun: consecutiveCfg.minRun ?? 3,
          bonusBallWinners,
          consecutiveWinners,
          totalBonusPaid,
        }
      : null;

  // 回填票券結果(修好被中斷的 bulkWrite),讓 /彩券 歷史 顯示正確;不派彩。
  if (repairTickets) {
    const smOf = new Map(ticketMatched.map((tm) => [tm.ticketId, tm.specialMatched]));
    const ops = ticketAssignments.map((a) => {
      const bonus = bonusByTicket.get(a.ticketId);
      return {
        updateOne: {
          filter: { ticketId: a.ticketId },
          update: {
            $set: {
              matched: matchedByTicket.get(a.ticketId) || 0,
              specialMatched: !!smOf.get(a.ticketId),
              prize: a.prize,
              payoutAmount: a.payoutAmount,
              bonusPayout: bonus?.amount || 0,
              bonusFlags: bonus?.flags || { bonusBall: false, consecutive: false },
            },
          },
        },
      };
    });
    if (ops.length > 0) {
      await client.lotteryTicketsCollection.bulkWrite(ops, { ordered: false });
    }
  }

  const rolledOverAmount = prizes.rolledOver?.amount || 0;
  const payoutDoc = {};
  for (const [k, v] of Object.entries(prizes)) {
    if (k !== "rolledOver") payoutDoc[k] = v;
  }
  if (payoutDoc.third === undefined) payoutDoc.third = null;
  if (payoutDoc.fourth === undefined) payoutDoc.fourth = null;
  payoutDoc.rolledOver = { amount: rolledOverAmount, toDrawId: null };
  payoutDoc.bonus = bonusSummary;

  const updateRes = await client.lotteryDrawsCollection.updateOne(
    { _id: draw._id, status: "drawing" },
    {
      $set: {
        status: "settled",
        drawnAt: new Date(),
        winningNumbers,
        specialNumber,
        bonusBall: null,
        payout: payoutDoc,
        reconciled: true,
        updatedAt: new Date(),
      },
    }
  );
  if (updateRes.matchedCount === 0) {
    return { ok: false, reason: "status_changed", drawId: draw.drawId };
  }

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

  const settled = await client.lotteryDrawsCollection.findOne({ _id: draw._id });
  const freshTickets = await client.lotteryTicketsCollection
    .find({ drawId: draw.drawId })
    .toArray();
  console.log(
    `[LOTTERY] 就地結算 ${draw.drawId}(不重付,來源:${resultsWritten ? "票券" : "交易紀錄"})` +
      `${winningNumbers ? "" : ",中獎號碼無法還原"}${payoutMatches ? "" : ",⚠派彩總額對不上"}`.green
  );
  return {
    ok: true,
    drawId: draw.drawId,
    draw: settled,
    tickets: freshTickets,
    numbersRecovered: !!winningNumbers,
    payoutMatches,
  };
}

/**
 * 反轉某一期的所有派彩(主獎 + 側獎),把已發獎金收回,供「反轉後重開」使用。
 * 精確反轉原本 grantCoins 對餘額的影響(totalCoins / coinsFrom_payout / lifetimeCoins),
 * 並寫一筆 payout_reversal 交易留痕。已反轉過(存在 payout_reversal 紀錄)則跳過,避免重複收回。
 * @returns {Promise<{reversed:number, users:number, total:number, alreadyReversed?:boolean}>}
 */
async function reversePayouts(client, drawId) {
  if (!client.coinTransactionsCollection || !client.userCoinsCollection) {
    return { reversed: 0, users: 0, total: 0 };
  }
  const already = await client.coinTransactionsCollection.countDocuments({
    source: "payout_reversal",
    "meta.drawId": drawId,
  });
  if (already > 0) return { reversed: 0, users: 0, total: 0, alreadyReversed: true };

  const payouts = await client.coinTransactionsCollection
    .find({ source: "payout", "meta.game": "lottery", "meta.drawId": drawId })
    .toArray();

  const byUser = new Map();
  for (const p of payouts) {
    const key = `${p.userId} ${p.guildId}`;
    byUser.set(key, (byUser.get(key) || 0) + (p.amount || 0));
  }

  let total = 0;
  for (const [key, amt] of byUser) {
    if (!amt) continue;
    const [userId, guildId] = key.split(" ");
    await client.userCoinsCollection.updateOne(
      { userId, guildId },
      {
        $inc: { totalCoins: -amt, coinsFrom_payout: -amt, lifetimeCoins: -amt },
        $set: { updatedAt: new Date() },
      }
    );
    await client.coinTransactionsCollection.insertOne({
      userId,
      guildId,
      amount: -amt,
      source: "payout_reversal",
      meta: { game: "lottery", drawId, reason: "maintenance_redraw" },
      createdAt: new Date(),
    });
    total += amt;
  }
  return { reversed: payouts.length, users: byUser.size, total };
}

module.exports = {
  getCurrentOpenDraw,
  ensureNextDraw,
  runDraw,
  recoverStuckDraw,
  settleStuckDrawInPlace,
  reversePayouts,
};
