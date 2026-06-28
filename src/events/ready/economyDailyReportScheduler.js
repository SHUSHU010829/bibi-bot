require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { DateTime } = require("luxon");

const { coinSystem } = require("../../config");
const { scanAllPairs } = require("../../features/economy/suspiciousTransferDetector");
const { gameShortLabel } = require("../../features/casino/gameLabels");

// 每天 08:00 Asia/Taipei 在指定頻道播報：
// 1) 過去 N 天每日淨發幣量（流入 / 還款回流 / 流出 / 淨），股票買賣與手續費已併入
// 2) 過去 N 天賭場 RTP / House Edge
// 3) 過去 24h 雙向轉帳異常列表

const REAL_INFLOW = [
  "message",
  "voice",
  "reaction",
  "daily",
  "quest_daily",
  "quest_weekly",
  "quest_event",
  "welfare",
  "transfer_in",
  "admin",
  "levelup",
  "milestone",
  "boost",
  "subscription",
  "wheeling",
  "manual",
  "stock_dividend",
  "mining_sell",
  "work",
  "dungeon",
  "deposit_interest",
];
const REPAY_INFLOW = ["deposit_release", "payout", "stock_sell", "auction_payout", "auction_refund", "duel_payout", "duel_refund"];
const OUTFLOW = ["bet", "deposit_lock", "transfer_out", "transfer_fee", "deposit_penalty", "shop_buy", "wealth_tax", "stock_buy", "stock_fee", "auction_bid", "duel_stake", "quest_reroll", "quest_skip"];

const fmt = (n) => Math.round(n).toLocaleString();

// 計算字串在等寬字體下的「顯示寬度」：CJK / 全形符號 / emoji 視為 2，
// 變體選擇符 / ZWJ 視為 0，其餘 ASCII 視為 1。
function displayWidth(str) {
  const s = String(str);
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // 零寬字元（變體選擇符、ZWJ、tag chars）
    if (
      cp === 0x200d ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0xe0020 && cp <= 0xe007f)
    ) {
      continue;
    }
    // 雙寬字元：CJK、Hangul、全形符號、各種 emoji / 圖案符號
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x1f000 && cp <= 0x1ffff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}

const padLeft = (s, w) => {
  const str = String(s);
  const pad = Math.max(0, w - displayWidth(str));
  return " ".repeat(pad) + str;
};
const padRight = (s, w) => {
  const str = String(s);
  const pad = Math.max(0, w - displayWidth(str));
  return str + " ".repeat(pad);
};
const cellWidth = (s) => displayWidth(String(s));

// 把 luxon DateTime → "YYYY-MM-DD"
const isoDate = (dt) => dt.toISODate();

// ===== Task 1：每日淨發幣量 =====
async function buildDailyNetSection(client, guildId, opts) {
  const tz = opts.timezone;
  const days = opts.lookbackDays;

  const today = DateTime.now().setZone(tz);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(isoDate(today.minus({ days: i })));
  }
  const startDate = dates[0];

  const txAgg = await client.coinTransactionsCollection
    .aggregate([
      { $match: { guildId, date: { $gte: startDate } } },
      {
        $group: {
          _id: { date: "$date", source: "$source" },
          total: { $sum: "$amount" },
        },
      },
    ])
    .toArray();

  // date → { realIn, repayIn, out }
  const byDate = new Map();
  for (const d of dates) byDate.set(d, { realIn: 0, repayIn: 0, out: 0 });

  for (const row of txAgg) {
    const { date, source } = row._id;
    const slot = byDate.get(date);
    if (!slot) continue;
    const total = row.total || 0;
    if (REAL_INFLOW.includes(source)) {
      if (total > 0) slot.realIn += total;
    } else if (REPAY_INFLOW.includes(source)) {
      if (total > 0) slot.repayIn += total;
    } else if (OUTFLOW.includes(source)) {
      // outflow 紀錄是負值
      if (total < 0) slot.out += -total;
    }
  }

  // 同期間 snapshot（拿 totalCirculation 算 1% 線）
  const snapAgg = client.economySnapshotsCollection
    ? await client.economySnapshotsCollection
        .find({ guildId, date: { $gte: startDate } })
        .toArray()
    : [];
  const circByDate = new Map();
  for (const s of snapAgg) circByDate.set(s.date, s.totalCirculation || 0);

  // 表格
  const rows = [];
  rows.push(["日期", "流入", "還款", "流出", "淨", "標記"]);
  let sumIn = 0;
  let sumRepay = 0;
  let sumOut = 0;
  for (const d of dates) {
    const { realIn, repayIn, out } = byDate.get(d);
    const net = realIn + repayIn - out;
    sumIn += realIn;
    sumRepay += repayIn;
    sumOut += out;
    const circ = circByDate.get(d) || 0;
    const onePct = circ * 0.01;
    let mark = net > 0 ? "📈" : net < 0 ? "📉" : "•";
    if (circ > 0 && Math.abs(net) > onePct) mark += "⚠️";
    rows.push([
      d.slice(5),
      fmt(realIn),
      fmt(repayIn),
      fmt(out),
      (net >= 0 ? "+" : "") + fmt(net),
      mark,
    ]);
  }
  const totalNet = sumIn + sumRepay - sumOut;
  rows.push([
    "總計",
    fmt(sumIn),
    fmt(sumRepay),
    fmt(sumOut),
    (totalNet >= 0 ? "+" : "") + fmt(totalNet),
    totalNet >= 0 ? "📈" : "📉",
  ]);

  // 自動寬度
  const widths = rows[0].map((_, c) =>
    Math.max(...rows.map((r) => cellWidth(r[c])))
  );
  const lines = rows.map((r) =>
    r.map((cell, c) => (c === 0 ? padRight(cell, widths[c]) : padLeft(cell, widths[c]))).join("  ")
  );

  const header = `📊 **每日淨發幣量（過去 ${days} 天）**\n流入＝真實發幣（聊天/任務/福利/Twitch/admin/股息…），還款＝存款贖回+賭場派彩+賣股入帳，流出＝下注/存款鎖定/轉出/商店/財富稅/買股/股票手續費`;
  return `${header}\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

// ===== Task 2：賭場 RTP / HE =====
async function buildCasinoSection(client, guildId, opts) {
  const days = opts.casinoLookbackDays;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const agg = await client.coinTransactionsCollection
    .aggregate([
      {
        $match: {
          guildId,
          source: { $in: ["bet", "payout"] },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: { game: "$meta.game", source: "$source" },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const games = new Map(); // game → {bet, payout, rounds}
  for (const row of agg) {
    const game = row._id.game || "unknown";
    if (!games.has(game))
      games.set(game, { bet: 0, payout: 0, betCount: 0, payoutCount: 0 });
    const g = games.get(game);
    if (row._id.source === "bet") {
      g.bet += -1 * (row.total || 0); // bet 紀錄為負
      g.betCount += row.count || 0;
    } else {
      g.payout += row.total || 0;
      g.payoutCount += row.count || 0;
    }
  }

  if (games.size === 0) {
    return `🎰 **賭場 House Edge（過去 ${days} 天）**\n\`\`\`\n（期間內沒有賭場交易）\n\`\`\``;
  }

  const rows = [];
  rows.push(["遊戲", "下注", "派彩", "RTP%", "HE%", "局數", "標記"]);
  let totalBet = 0;
  let totalPayout = 0;
  let totalRounds = 0;
  // 排序：下注量大到小
  const sorted = [...games.entries()].sort((a, b) => b[1].bet - a[1].bet);
  for (const [game, g] of sorted) {
    totalBet += g.bet;
    totalPayout += g.payout;
    totalRounds += g.betCount;
    const rtp = g.bet > 0 ? (g.payout / g.bet) * 100 : 0;
    const he = 100 - rtp;
    const mark = rtp > 100 ? "⚠️" : "";
    rows.push([
      gameShortLabel(game),
      fmt(g.bet),
      fmt(g.payout),
      rtp.toFixed(2),
      he.toFixed(2),
      String(g.betCount),
      mark,
    ]);
  }
  const totalRtp = totalBet > 0 ? (totalPayout / totalBet) * 100 : 0;
  rows.push([
    "合計",
    fmt(totalBet),
    fmt(totalPayout),
    totalRtp.toFixed(2),
    (100 - totalRtp).toFixed(2),
    String(totalRounds),
    totalRtp > 100 ? "⚠️" : "",
  ]);

  const widths = rows[0].map((_, c) =>
    Math.max(...rows.map((r) => cellWidth(r[c])))
  );
  const lines = rows.map((r) =>
    r.map((cell, c) => (c === 0 ? padRight(cell, widths[c]) : padLeft(cell, widths[c]))).join("  ")
  );
  return `🎰 **賭場 House Edge（過去 ${days} 天）**\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

// ===== Task 3：雙向轉帳異常 =====
async function buildSuspiciousSection(client, guildId, opts) {
  const hours = opts.suspiciousLookbackHours;
  const pairs = await scanAllPairs(client, { guildId, hours });
  if (pairs.length === 0) {
    return `🛡️ **雙向轉帳異常（過去 ${hours}h）**\n✅ 無達閾值的可疑配對。`;
  }
  const threshold = pairs[0].threshold;
  const head = `🛡️ **雙向轉帳異常（過去 ${hours}h，閾值 ${threshold.toLocaleString()}）**`;
  const lines = pairs.slice(0, 10).map((p, i) => {
    return (
      `${i + 1}. <@${p.userA}> ↔ <@${p.userB}>\n` +
      `   ${fmt(p.aToB)} + ${fmt(p.bToA)} = **${fmt(p.total)}** credits（${p.docCount} 筆）`
    );
  });
  const tail = pairs.length > 10 ? `\n…還有 ${pairs.length - 10} 組未列出` : "";
  return `${head}\n${lines.join("\n")}${tail}`;
}

// ===== 主流程 =====
async function runReport(client) {
  const cfg = coinSystem?.dailyEconomyReport;
  if (!cfg?.enabled) return { sent: 0 };
  if (!client.coinTransactionsCollection) return { sent: 0 };
  const channelId = cfg.channelId;
  if (!channelId) {
    console.log(`[ECON-REPORT] 未設定 channelId，跳過`.yellow);
    return { sent: 0 };
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.log(`[ECON-REPORT] 找不到頻道 ${channelId}`.red);
    return { sent: 0 };
  }

  const opts = {
    timezone: cfg.timezone || "Asia/Taipei",
    lookbackDays: cfg.lookbackDays ?? 7,
    casinoLookbackDays: cfg.casinoLookbackDays ?? cfg.lookbackDays ?? 7,
    suspiciousLookbackHours: cfg.suspiciousLookbackHours ?? 24,
  };

  const guilds = client.guilds.cache;
  if (!guilds || guilds.size === 0) return { sent: 0 };

  const today = DateTime.now().setZone(opts.timezone).toFormat("yyyy-MM-dd");

  let sent = 0;
  for (const [guildId, guild] of guilds) {
    try {
      const sections = [];
      sections.push(`🌅 **${guild.name} ｜ ${today} 經濟日報**`);
      sections.push(await buildDailyNetSection(client, guildId, opts));
      sections.push(await buildCasinoSection(client, guildId, opts));
      sections.push(await buildSuspiciousSection(client, guildId, opts));

      // Discord 訊息上限 2000 字，分段送
      const combined = sections.join("\n\n");
      if (combined.length <= 1900) {
        await channel.send({
          content: combined,
          allowedMentions: { parse: [] },
        });
      } else {
        for (const part of sections) {
          await channel.send({
            content: part,
            allowedMentions: { parse: [] },
          });
        }
      }
      sent += 1;
      console.log(`[ECON-REPORT] ${guild.name} 日報已送出`.cyan);
    } catch (e) {
      console.log(
        `[ECON-REPORT] guild=${guildId} 失敗：${e?.stack || e?.message || e}`.red
      );
    }
  }
  return { sent };
}

module.exports = async (client) => {
  const cfg = coinSystem?.dailyEconomyReport;
  if (!cfg?.enabled) {
    console.log(`[ECON-REPORT] 未啟用，略過排程`.gray);
    return;
  }

  registerCron(client, {
    name: "economy.dailyReport",
    label: "經濟日報",
    schedule: cfg.cronSchedule || "0 8 * * *",
    timezone: cfg.timezone || "Asia/Taipei",
    runner: () => runReport(client),
  });
};

module.exports.runReport = runReport;
