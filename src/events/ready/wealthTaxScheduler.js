require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { DateTime } = require("luxon");

const { coinSystem } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { COIN_EMOJI } = require("../../constants/coin");

async function fetchCasinoWeekly(client, guildId) {
  if (!client?.coinTransactionsCollection) return null;
  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  const since = DateTime.now().setZone(tz).minus({ days: 7 }).toISODate();
  try {
    const rows = await client.coinTransactionsCollection
      .aggregate([
        {
          $match: {
            ...(guildId ? { guildId } : {}),
            source: { $in: ["bet", "payout"] },
            date: { $gte: since },
          },
        },
        {
          $group: {
            _id: "$userId",
            netProfit: { $sum: "$amount" },
            wagered: {
              $sum: {
                $cond: [{ $eq: ["$source", "bet"] }, { $abs: "$amount" }, 0],
              },
            },
          },
        },
      ])
      .toArray();
    if (!rows.length) return { winners: [], losers: [] };
    const sorted = [...rows].sort((a, b) => b.netProfit - a.netProfit);
    return {
      winners: sorted.slice(0, 3).filter((r) => r.netProfit > 0),
      losers: sorted.slice(-3).reverse().filter((r) => r.netProfit < 0),
    };
  } catch (e) {
    console.log(`[WTAX] casino weekly fetch failed: ${e}`.yellow);
    return null;
  }
}

// 每週掃 totalCoins 高於最低級距的帳戶，依累進稅率分段課徵財富稅。
// 預設：每週一 04:00 (Asia/Taipei)，最低門檻 50,000，最高邊際稅率 40%。
// 連續錯誤 3 次自動關閉。

function normalizeBrackets(brackets) {
  if (!Array.isArray(brackets) || brackets.length === 0) return null;
  const cleaned = brackets
    .filter((b) => Number.isFinite(b?.from) && Number.isFinite(b?.rate))
    .map((b) => ({ from: b.from, rate: b.rate }))
    .sort((a, b) => a.from - b.from);
  return cleaned.length > 0 ? cleaned : null;
}

// 計算分級邊際稅。回傳每段切片明細，給回報用。
function computeProgressiveTax(balance, brackets) {
  const slices = [];
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lower = brackets[i].from;
    const upper = brackets[i + 1]?.from ?? Infinity;
    if (balance <= lower) break;
    const portion = Math.min(balance, upper) - lower;
    const sliceTax = portion * brackets[i].rate;
    tax += sliceTax;
    slices.push({
      from: lower,
      to: Number.isFinite(upper) ? upper : null,
      rate: brackets[i].rate,
      portion,
      tax: sliceTax,
    });
  }
  return { tax: Math.floor(tax), slices };
}

async function sweepOnce(client, cfg) {
  if (!client.userCoinsCollection) return null;

  const brackets = normalizeBrackets(cfg.brackets);
  if (!brackets) {
    console.log(`[WTAX] brackets 未設定或無效，跳過`.yellow);
    return null;
  }
  const minDeduction = cfg.minDeduction ?? 1;
  const exemptFloor = brackets[0].from;

  const cursor = client.userCoinsCollection.find({
    totalCoins: { $gt: exemptFloor },
  });

  let affectedUsers = 0;
  let totalTaxed = 0;
  let topAffected = [];
  const affectedDetails = [];

  while (await cursor.hasNext()) {
    const u = await cursor.next();
    const { tax: rawTax, slices } = computeProgressiveTax(
      u.totalCoins,
      brackets,
    );
    let tax = rawTax;
    if (tax < minDeduction) tax = minDeduction;
    if (tax > u.totalCoins) tax = u.totalCoins;
    if (tax <= 0) continue;

    const effectiveRate = tax / u.totalCoins;

    try {
      await grantCoins(client, {
        userId: u.userId,
        guildId: u.guildId,
        username: u.username,
        amount: -tax,
        source: "wealth_tax",
        meta: {
          brackets,
          before: u.totalCoins,
          effectiveRate,
          slices,
        },
      });
      affectedUsers += 1;
      totalTaxed += tax;
      const detail = {
        userId: u.userId,
        username: u.username,
        before: u.totalCoins,
        tax,
        effectiveRate,
        slices,
      };
      topAffected.push(detail);
      affectedDetails.push(detail);
    } catch (e) {
      console.log(`[WTAX] grantCoins failed user=${u.userId}: ${e}`.red);
    }
  }

  topAffected.sort((a, b) => b.tax - a.tax);
  topAffected = topAffected.slice(0, 5);

  return { affectedUsers, totalTaxed, topAffected, brackets, affectedDetails };
}

// 逐一私訊被課稅的用戶，告知扣繳金額與分級明細。
async function sendTaxDMs(client, cfg, affectedDetails) {
  if (cfg.dmEnabled === false) return;
  if (!Array.isArray(affectedDetails) || affectedDetails.length === 0) return;

  let sent = 0;
  let failed = 0;
  for (const d of affectedDetails) {
    const user = await client.users.fetch(d.userId).catch(() => null);
    if (!user) {
      failed += 1;
      continue;
    }

    const sliceLines = (d.slices || [])
      .filter((s) => s.tax > 0)
      .map((s) => {
        const range = s.to
          ? `${s.from.toLocaleString()} ~ ${s.to.toLocaleString()}`
          : `${s.from.toLocaleString()} 以上`;
        return `・${range}（${(s.rate * 100).toFixed(0)}%）：扣 **${Math.floor(s.tax).toLocaleString()}**`;
      });

    const container = new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 💸 每週財富稅扣繳通知\n` +
            [
              `你在本週的累進財富稅結算中被徵收了 **${d.tax.toLocaleString()}** ${COIN_EMOJI}。`,
              "",
              `・稅前餘額：**${d.before.toLocaleString()}**`,
              `・稅後餘額：**${(d.before - d.tax).toLocaleString()}**`,
              `・有效稅率：**${(d.effectiveRate * 100).toFixed(2)}%**`,
            ].join("\n"),
        ),
      );

    if (sliceLines.length > 0) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**分級扣繳明細**\n${sliceLines.join("\n")}`,
          ),
        );
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

    const ok = await user
      .send({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      })
      .then(() => true)
      .catch(() => false);
    if (ok) sent += 1;
    else failed += 1;
  }

  console.log(`[WTAX] DM 通知完成：成功 ${sent}，失敗 ${failed}`.cyan);
}

async function postReport(client, cfg, summary) {
  const channelId = cfg.reportChannelId;
  if (!channelId || !summary) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const bracketLines = summary.brackets.map((b, i) => {
    const next = summary.brackets[i + 1];
    const range = next
      ? `${b.from.toLocaleString()} ~ ${next.from.toLocaleString()}`
      : `${b.from.toLocaleString()} 以上`;
    return `・${range}：**${(b.rate * 100).toFixed(0)}%**`;
  });

  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💸 每週累進財富稅結算\n` +
          [
            `・受影響玩家數：**${summary.affectedUsers}**`,
            `・本次回收金幣：**${summary.totalTaxed.toLocaleString()}**`,
            "",
            "**累進級距（邊際稅率，越富越狠）**",
            ...bracketLines,
          ].join("\n"),
      ),
    );

  if (summary.topAffected.length > 0) {
    const top = summary.topAffected
      .map(
        (t, i) =>
          `${i + 1}. <@${t.userId}> 扣 **${t.tax.toLocaleString()}**（${t.before.toLocaleString()} → ${(t.before - t.tax).toLocaleString()}，有效稅率 ${(t.effectiveRate * 100).toFixed(2)}%）`,
      )
      .join("\n");
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**本次扣最多 Top 5**\n${top}`,
      ),
    );
  }

  // 賭場週報彩蛋
  const guildId = channel.guild?.id;
  const casino = await fetchCasinoWeekly(client, guildId);
  if (casino) {
    if (casino.winners.length > 0) {
      const lines = casino.winners
        .map(
          (r, i) =>
            `${i + 1}. <@${r._id}> 賺 **+${r.netProfit.toLocaleString()}**（下注 ${r.wagered.toLocaleString()}）`,
        )
        .join("\n");
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**🎰 本週賭場大贏家 Top 3**\n${lines}`,
        ),
      );
    }
    if (casino.losers.length > 0) {
      const lines = casino.losers
        .map(
          (r, i) =>
            `${i + 1}. <@${r._id}> 賠 **${r.netProfit.toLocaleString()}**（下注 ${r.wagered.toLocaleString()}）`,
        )
        .join("\n");
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**💸 本週賭場大輸家 Top 3**\n${lines}`,
        ),
      );
    }
    if (casino.winners.length === 0 && casino.losers.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**🎰 本週賭場**\n本週沒人有顯著輸贏，整個賭場很平靜～`,
        ),
      );
    }
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
    ),
  );
  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

async function runSweep(client) {
  const cfg = coinSystem?.wealthTax;
  if (!cfg?.enabled) return;
  console.log(`[WTAX] 開始每週財富稅掃描`.cyan);
  const summary = await sweepOnce(client, cfg);
  if (!summary) return;
  console.log(
    `[WTAX] 完成：${summary.affectedUsers} 人，回收 ${summary.totalTaxed} 金幣`.cyan,
  );
  await postReport(client, cfg, summary);
  await sendTaxDMs(client, cfg, summary.affectedDetails);
}

module.exports = async (client) => {
  const cfg = coinSystem?.wealthTax;
  if (!cfg?.enabled) {
    console.log(`[WTAX] 財富稅未啟用，跳過排程`.gray);
    return;
  }

  registerCron(client, {
    name: "wealthTax.sweep",
    label: "累進財富稅每週結算",
    schedule: cfg.cronSchedule || "0 4 * * 1",
    timezone: cfg.timezone || "Asia/Taipei",
    runner: () => runSweep(client),
  });
};
