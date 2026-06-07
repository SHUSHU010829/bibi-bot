require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { coinHistory } = require("../../config");
const {
  aggregateFlow,
  getTopHolders,
  getCirculationNow,
  getRecentSnapshots,
  isoDaysAgo,
  todayIso,
  classifySource,
  aggregateCasinoEdge,
  aggregateOreCirculation,
  aggregateStoneAppraisal,
  aggregateFishCirculation,
  aggregateCropFlow,
  aggregateMarketActivity,
  aggregateDeposits,
  aggregateWealthMetrics,
  countActivePlayers,
  getMarketPricesForDate,
} = require("../../features/economy/economyDashboard");

const RANGE_CHOICES = [
  { name: "今日（即時）", value: 1 },
  { name: "近 7 天", value: 7 },
  { name: "近 30 天", value: 30 },
];

const GAME_LABELS = {
  slot: "🎰 拉霸",
  sicbo: "🎲 骰寶",
  blackjack: "🃏 21 點",
  hilo: "🔼 HI-LO",
  keno: "🗺️ 尋寶",
  dragonGate: "🐉 射龍門",
  roulette: "🎡 輪盤",
  poker: "🃏 德州撲克",
  lottery: "🎟️ 樂透",
  horseRacing: "🐎 賽馬",
  crash: "🚀 火箭",
  unknown: "❓ 未分類",
};

function fmt(n) {
  return Number(n || 0).toLocaleString();
}
function pct(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}
function signed(n) {
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `−${fmt(-n)}`;
  return "0";
}
function sourceLabel(source) {
  return coinHistory?.sourceLabels?.[source] || `❓ ${source}`;
}

function topNSources(bySource, n = 5) {
  return Object.entries(bySource)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n);
}

function formatSourceList(bySource, totalForPct, n = 5) {
  const top = topNSources(bySource, n);
  if (top.length === 0) return "（無）";
  return top
    .map(([src, v]) => {
      const share = totalForPct > 0 ? ` ・ ${pct(v / totalForPct)}` : "";
      return `${sourceLabel(src)}　**${fmt(v)}**${share}`;
    })
    .join("\n");
}

function formatHolder(h) {
  const tag = `<@${h.userId}>`;
  const fallback = h.username ? ` (${h.username})` : "";
  return `${tag}${fallback}`;
}

function trendLine(snapshots) {
  if (!snapshots || snapshots.length === 0) return "（暫無快照資料）";
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const delta = (last.totalCirculation || 0) - (first.totalCirculation || 0);
  const ratio = first.totalCirculation > 0 ? delta / first.totalCirculation : 0;
  const arrow = delta > 0 ? "📈" : delta < 0 ? "📉" : "➡️";
  return `${arrow} ${first.date} → ${last.date}：${fmt(first.totalCirculation)} → ${fmt(last.totalCirculation)}（${signed(delta)} ・ ${pct(ratio)}）`;
}

function formatCasinoGame(g, days) {
  const label = GAME_LABELS[g.game] || `❓ ${g.game}`;
  const theo = g.theoreticalEdge !== null
    ? pct(g.theoreticalEdge, 2)
    : "—（PvP 或池抽）";
  const emp = g.empiricalEdge !== null ? pct(g.empiricalEdge, 2) : "—";
  const dailyAvgBet = g.wagered / Math.max(days, 1);
  const houseTake = g.netHouse;
  const houseArrow = houseTake >= 0 ? "🏦" : "👤";
  return (
    `${label}\n` +
    `-# 設計 Edge **${theo}**　・　實際 Edge **${emp}**　・　RTP ${pct(g.rtp, 1)}\n` +
    `-# 下注 ${fmt(g.wagered)}（${fmt(g.betCount)} 注）・派彩 ${fmt(g.payout)}　・日均下注 ${fmt(Math.round(dailyAvgBet))}\n` +
    `-# 莊家結算 ${houseArrow} **${signed(houseTake)}**　・玩家 ${fmt(g.uniqueBettors)} 人（${fmt(g.uniqueWinners)} 中過獎）`
  );
}

function formatOreLine(o, days) {
  const name = `${o.emoji || ""} ${o.name}`.trim();
  return (
    `${name}　**${fmt(o.qty)}** 顆　・日均 ${fmt(Math.round(o.dailyAvgQty))}\n` +
    `-# 場次 ${fmt(o.sessions)}　・礦工 ${fmt(o.uniqueMiners)} 人　・基準價 ${fmt(o.basePrice)}　・估值 ${fmt(o.estValue)}`
  );
}

function formatFishLine(f, days) {
  const name = `${f.emoji || ""} ${f.name}`.trim();
  return (
    `${name}　**${fmt(f.count)}** 尾　・日均 ${(f.dailyAvg).toFixed(1)}\n` +
    `-# 漁夫 ${fmt(f.uniqueAnglers)} 人　・基準價 ${fmt(f.basePrice)}　・估值 ${fmt(f.estValue)}`
  );
}

function formatCropLine(c, days) {
  const name = `${c.emoji || ""} ${c.name}`.trim();
  const success = c.successRate !== null ? pct(c.successRate, 0) : "—";
  const net = c.harvestPayout + c.sellValue - c.plantCost;
  return (
    `${name}　淨收益 **${signed(net)}**\n` +
    `-# 種 ${fmt(c.plantCount)}（花 ${fmt(c.plantCost)}）→ 收 ${fmt(c.harvestCount)}（領 ${fmt(c.harvestPayout)}）成功率 ${success}\n` +
    `-# 賣作物 ${fmt(c.sellCount)} 筆　・賣價 ${fmt(c.sellValue)}`
  );
}

function formatMarketLine(label, m) {
  if (!m || m.count === 0) return null;
  return `${label}　筆數 ${fmt(m.count)}　・流入 +${fmt(m.inflow)}　・流出 −${fmt(m.outflow)}　・總量 ${fmt(m.volume)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("economy-dashboard")
    .setDescription("[ADMIN] 經濟健康度儀表板：流通／賭場 Edge／礦魚作物流通量／集中度 📊")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("range")
        .setDescription("查詢範圍")
        .setRequired(false)
        .addChoices(...RANGE_CHOICES.map((c) => ({ name: c.name, value: c.value }))),
    )
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!client.coinTransactionsCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }

      const days = interaction.options.getInteger("range") || 7;
      const guildId = interaction.guildId;
      const fromIso = days === 1 ? todayIso() : isoDaysAgo(days - 1);
      const toIso = todayIso();

      const [
        circulation,
        flow,
        holders,
        snapshots,
        casinoEdge,
        ore,
        appraisal,
        fishStats,
        crops,
        market,
        deposits,
        wealth,
        activePlayers,
        marketPrices,
      ] = await Promise.all([
        getCirculationNow(client, guildId),
        aggregateFlow(client, guildId, fromIso, toIso),
        getTopHolders(client, guildId, 10),
        getRecentSnapshots(client, guildId, Math.max(days, 7)),
        aggregateCasinoEdge(client, guildId, fromIso, toIso),
        aggregateOreCirculation(client, guildId, fromIso, toIso),
        aggregateStoneAppraisal(client, guildId, fromIso, toIso),
        aggregateFishCirculation(client, guildId, fromIso, toIso),
        aggregateCropFlow(client, guildId, fromIso, toIso),
        aggregateMarketActivity(client, guildId, fromIso, toIso),
        aggregateDeposits(client, guildId),
        aggregateWealthMetrics(client, guildId),
        countActivePlayers(client, guildId, fromIso, toIso),
        getMarketPricesForDate(client, toIso),
      ]);

      const { totals } = flow;
      const dailyAvgMinted = totals.mintedTotal / days;
      const dailyAvgBurned = totals.burnedTotal / days;
      const dailyAvgNet = totals.netFlow / days;

      const peerSources = Object.entries(totals.mintedBySource)
        .concat(Object.entries(totals.burnedBySource))
        .filter(([s]) => classifySource(s) === "peer")
        .reduce((set, [s]) => set.add(s), new Set());
      const peerNet = [...peerSources].map((s) => {
        const m = totals.mintedBySource[s] || 0;
        const b = totals.burnedBySource[s] || 0;
        return { source: s, net: m - b };
      });

      const rangeLabel = days === 1 ? "今日（即時）" : `近 ${days} 天`;

      // ─── Container 1：流通量 + 淨流動 + 集中度（核心） ──────────
      const c1 = new ContainerBuilder()
        .setAccentColor(totals.netFlow > 0 ? 0xe67e22 : 0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${MONEY_EMOJI} 經濟健康度儀表板\n` +
              `**範圍**：${rangeLabel}（${fromIso} ~ ${toIso}）\n` +
              `-# 用於追蹤通膨／集中度／賭場 Edge／物資流通量`,
          ),
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 💰 當下流通量\n` +
              `**${fmt(circulation.totalCirculation)}**\n` +
              `・👛 錢包 ${fmt(circulation.totalWalletCoins)}　・🏦 存款 ${fmt(circulation.totalDepositPrincipal)}\n` +
              `・有金幣玩家 ${fmt(circulation.activeUsers)} / ${fmt(circulation.userCount)}　・期間活躍 ${fmt(activePlayers)} 人\n` +
              `${trendLine(snapshots)}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🔄 ${rangeLabel} 淨流動\n` +
              `**淨變動：${signed(totals.netFlow)}**　（日均 ${signed(Math.round(dailyAvgNet))}）\n` +
              `・🟢 玩家收到合計：**+${fmt(totals.mintedTotal)}**（日均 +${fmt(Math.round(dailyAvgMinted))}）\n` +
              `・🔴 玩家支付合計：**−${fmt(totals.burnedTotal)}**（日均 −${fmt(Math.round(dailyAvgBurned))}）\n` +
              `-# 淨流動 = 收到 − 支付。為正代表系統淨印幣，為負代表系統淨吸幣。`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🟢 主要印幣來源（Top 5）\n` +
              `${formatSourceList(totals.mintedBySource, totals.mintedTotal, 5)}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🔴 主要銷幣出口（Top 5）\n` +
              `${formatSourceList(totals.burnedBySource, totals.burnedTotal, 5)}`,
          ),
        );

      if (peerNet.length > 0) {
        const peerLines = peerNet
          .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
          .slice(0, 5)
          .map((p) => `${sourceLabel(p.source)}　${signed(p.net)}`)
          .join("\n");
        c1.addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## ⚪ 對沖類淨額（含賭場 / 拍賣 / 對決 / 轉帳 / 存款 / 市集）\n${peerLines}\n` +
                `-# 對沖類同 source 內進出抵消，淨值代表系統實際吸收 / 釋出。`,
            ),
          );
      }

      const top10 = holders.rows.slice(0, 10);
      const top10Lines = top10
        .map(
          (h, i) =>
            `${i + 1}. ${formatHolder(h)}　${fmt(h.totalCoins)}　・ ${pct(h.share)}`,
        )
        .join("\n");
      c1.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🏆 持幣集中度（Top 10）\n` +
              `**Top 10 合計：${fmt(holders.top10Coins)}　占錢包總量 ${pct(holders.top10Share)}**\n` +
              `${top10Lines || "（無資料）"}`,
          ),
        );

      // ─── Container 2：賭場各遊戲 House Edge ──────────
      const c2 = new ContainerBuilder()
        .setAccentColor(casinoEdge.totals.netHouse >= 0 ? 0x9b59b6 : 0xe74c3c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🎰 賭場各遊戲 House Edge（${rangeLabel}）\n` +
              `總下注 **${fmt(casinoEdge.totals.wagered)}**　・總派彩 **${fmt(casinoEdge.totals.payout)}**\n` +
              `莊家整體結算 **${signed(casinoEdge.totals.netHouse)}**　・全賭場 Edge ${pct(casinoEdge.totals.wagered > 0 ? casinoEdge.totals.netHouse / casinoEdge.totals.wagered : 0, 2)}\n` +
              `-# 設計 Edge = config / 數學期望；實際 Edge = 1 − 期間實測 RTP。`,
          ),
        );

      if (casinoEdge.games.length === 0) {
        c2.addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `-# 期間內無賭場交易紀錄。`,
            ),
          );
      } else {
        const chunks = [];
        let buf = [];
        let bufLen = 0;
        for (const g of casinoEdge.games) {
          const line = formatCasinoGame(g, days);
          if (bufLen + line.length > 3500 && buf.length > 0) {
            chunks.push(buf.join("\n\n"));
            buf = [];
            bufLen = 0;
          }
          buf.push(line);
          bufLen += line.length + 2;
        }
        if (buf.length > 0) chunks.push(buf.join("\n\n"));
        for (const ch of chunks) {
          c2.addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(ch));
        }
      }

      // ─── Container 3：礦石 / 漁獲 / 作物 流通量 ──────────
      const c3 = new ContainerBuilder().setAccentColor(0x1abc9c);

      // 礦石
      const oreLines = ore.ores.map((o) => formatOreLine(o, ore.days)).join("\n\n");
      const orePriceLine =
        Object.keys(marketPrices.ore).length > 0
          ? `-# 當日市價：${Object.entries(marketPrices.ore)
              .map(([k, v]) => `${k} ${fmt(v)}`)
              .join("・")}`
          : "";
      c3.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## ⛏️ 礦石每日流通量（${rangeLabel}）\n` +
            `總產出 **${fmt(ore.totalQty)}** 顆　・場次 ${fmt(ore.totalSessions)}　・礦工 ${fmt(ore.uniqueMiners)} 人\n` +
            `日均產出 ${fmt(Math.round(ore.totalQty / ore.days))} 顆　・基準價估值 ${fmt(ore.totalValue)}\n` +
            (orePriceLine ? `${orePriceLine}\n` : "") +
            `\n${oreLines || "（期間內無挖礦紀錄）"}`,
        ),
      );

      // 賭石鑑定
      if (appraisal.sessions > 0 || appraisal.stones > 0) {
        const netHouse = appraisal.fee - appraisal.gainedValue - appraisal.overflowCoins;
        const houseEdge = appraisal.fee > 0 ? netHouse / appraisal.fee : 0;
        const perOreLines = appraisal.perOre.length
          ? appraisal.perOre
              .map(
                (o) =>
                  `${o.emoji || ""} ${o.name}　開出 ${fmt(o.qty)} 顆　・命中 ${fmt(o.sessions)} 顆石頭（${pct(o.hitRate, 1)}）　・估值 ${fmt(o.value)}`,
              )
              .join("\n")
          : "（期間內無任何礦石產出）";
        c3.addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## 💎 賭石鑑定（${rangeLabel}）\n` +
                `鑑定場次 **${fmt(appraisal.sessions)}**　・鑑定石頭 **${fmt(appraisal.stones)}** 顆　・賭石玩家 ${fmt(appraisal.uniqueAppraisers)} 人\n` +
                `總費用 **${fmt(appraisal.fee)}**　・基準價估值 **${fmt(appraisal.gainedValue)}**　・折金幣補償 ${fmt(appraisal.overflowCoins)}\n` +
                `碎掉 ${fmt(appraisal.brokenCount)} 顆（${pct(appraisal.brokenRate, 1)}）　・玩家 RTP ${pct(appraisal.rtp, 1)}　・莊家 Edge ${pct(houseEdge, 1)}\n` +
                `\n${perOreLines}\n` +
                `-# RTP = 開出礦估值 / 鑑定費；莊家 Edge = 1 − RTP，賭場標準約 5~10%。`,
            ),
          );
      }

      // 漁獲
      const fishLines = fishStats.fish.map((f) => formatFishLine(f, fishStats.days)).join("\n\n");
      const locLines = fishStats.locations
        .map((l) => `${l.emoji || ""} ${l.name}　${fmt(l.count)} 尾`)
        .join("　・　");
      const fishPriceLine =
        Object.keys(marketPrices.fish).length > 0
          ? `-# 當日市價：${Object.entries(marketPrices.fish)
              .map(([k, v]) => `${k} ${fmt(v)}`)
              .join("・")}`
          : "";
      c3.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🎣 漁獲每日流通量（${rangeLabel}）\n` +
              `總漁獲 **${fmt(fishStats.totalCatches)}** 尾　・漁夫 ${fmt(fishStats.uniqueAnglers)} 人　・基準價估值 ${fmt(fishStats.totalValue)}\n` +
              (locLines ? `-# 釣點分布：${locLines}\n` : "") +
              (fishPriceLine ? `${fishPriceLine}\n` : "") +
              `\n${fishLines || "（期間內無釣魚紀錄）"}`,
          ),
        );

      // 作物
      const cropLines = crops.crops.map((c) => formatCropLine(c, crops.days)).join("\n\n");
      const cropTotals = crops.totals;
      c3.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🌾 作物每日流通量（${rangeLabel}）\n` +
              `農場淨收益 **${signed(cropTotals.netFarmIncome)}**　・農夫 ${fmt(cropTotals.uniqueFarmers)} 人\n` +
              `-# 種子成本 ${fmt(cropTotals.plantCost)}　・收成發幣 ${fmt(cropTotals.harvestPayout)}　・賣作物 ${fmt(cropTotals.sellValue)}\n` +
              `-# 擴建支出 ${fmt(cropTotals.expandCost)}　・掠奪損失 ${fmt(cropTotals.raidLoss)}　・陷阱收益 ${fmt(cropTotals.raidPayout)}\n` +
              `\n${cropLines || "（期間內無農場交易）"}`,
          ),
        );

      // ─── Container 4：經濟相關活動量 + 財富分布 + 定存 ──────────
      const c4 = new ContainerBuilder().setAccentColor(0x3498db);

      const marketBlocks = [
        ["🛒 商店", market.shop],
        ["📈 股市", market.stock],
        ["🔨 拍賣行", market.auction],
        ["🏪 市集", market.market],
        ["🔀 交易所手續費", market.barter],
        ["💸 玩家轉帳", market.transfer],
        ["💸 轉帳手續費", market.transferFee],
        ["🏦 定存進出", market.deposit],
        ["🏦 定存利息發放", market.depositInterest],
        ["🏦 定存違約金", market.depositPenalty],
        ["⚔️ 對決", market.duel],
        ["🐲 BOSS", market.boss],
        ["🗡️ 地下城", market.dungeon],
        ["📜 任務", market.quest],
        ["📜 任務重抽/跳過", market.questManage],
        ["🎲 隨機事件", market.encounter],
        ["🎉 自辦活動", market.event],
        ["🏰 公會", market.guild],
        ["🎟️ 邀請", market.invite],
        ["💬 聊天獎勵", market.chat],
        ["🏛️ 福利金", market.welfare],
        ["🏛️ 財富稅", market.wealthTax],
        ["⛏️ 打工", market.work],
        ["⛏️ 挖礦相關（賣礦+鑑定）", market.mining],
        ["🎣 漁獲販售", market.fishing],
      ]
        .map(([label, m]) => formatMarketLine(label, m))
        .filter(Boolean);

      const half = Math.ceil(marketBlocks.length / 2);
      const leftBlock = marketBlocks.slice(0, half).join("\n");
      const rightBlock = marketBlocks.slice(half).join("\n");

      c4.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## 📊 經濟活動量（${rangeLabel}）\n` +
            `${leftBlock || "（無資料）"}`,
        ),
      );
      if (rightBlock) {
        c4.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(rightBlock),
        );
      }

      // 定存
      const planLines = deposits.plans
        .map((p) => {
          const label = p.days ? `${p.days} 天` : "未分類";
          return `・${label}：${fmt(p.count)} 筆 / 本金 ${fmt(p.principal)} / 未到期利息 ${fmt(p.interest)}（${fmt(p.uniqueUsers)} 人）`;
        })
        .join("\n");
      c4.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🏦 定存狀態（即時）\n` +
              `啟用中 **${fmt(deposits.active)}** 筆　・總本金 **${fmt(deposits.principal)}**　・待付利息 ${fmt(deposits.totalInterest)}　・平均本金 ${fmt(Math.round(deposits.avgPrincipal))}\n` +
              `${planLines || "-# 目前無啟用定存。"}`,
          ),
        );

      // 財富分布
      if (wealth) {
        c4.addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## 📐 財富分布指標（即時）\n` +
                `**Gini 係數 ${wealth.gini.toFixed(3)}**　-# 0 = 完全平均、1 = 完全集中\n` +
                `・Top 1% 占 ${pct(wealth.top1Share)}　・Top 10% 占 ${pct(wealth.top10Share)}　・Top 50% 占 ${pct(wealth.top50Share)}\n` +
                `・持幣玩家 ${fmt(wealth.holders)} 人　・首富 ${fmt(wealth.richestWallet)}\n` +
                `・中位錢包 ${fmt(wealth.medianWallet)}　・平均錢包 ${fmt(Math.round(wealth.meanWallet))}`,
            ),
          );
      }

      // 流通速度 / 通膨率
      const velocity =
        circulation.totalCirculation > 0
          ? (totals.mintedTotal + totals.burnedTotal) / circulation.totalCirculation
          : 0;
      const inflation =
        snapshots.length >= 2 && snapshots[0].totalCirculation > 0
          ? (snapshots[snapshots.length - 1].totalCirculation - snapshots[0].totalCirculation) /
            snapshots[0].totalCirculation
          : null;
      const casinoShare =
        totals.mintedTotal + totals.burnedTotal > 0
          ? (casinoEdge.totals.wagered + casinoEdge.totals.payout) /
            (totals.mintedTotal + totals.burnedTotal)
          : 0;
      c4.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🧪 經濟健康衍生指標\n` +
              `・💨 **金幣流通速度**：${velocity.toFixed(2)}　-# 期間總流動 / 當前流通量\n` +
              `・📈 **通膨率**：${inflation !== null ? pct(inflation, 2) : "—"}　-# 期間流通量變化%\n` +
              `・🎰 **賭場活動占比**：${pct(casinoShare, 1)}　-# (下注+派彩) / 總流動\n` +
              `・👛 **人均錢包**：${fmt(circulation.activeUsers > 0 ? Math.round(circulation.totalWalletCoins / circulation.activeUsers) : 0)}　-# 限有金幣玩家\n` +
              `・🟢 **印 / 銷比**：${totals.burnedTotal > 0 ? (totals.mintedTotal / totals.burnedTotal).toFixed(2) : "∞"}　-# >1 通膨、<1 通縮`,
          ),
        );

      c4.addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 資料源：CoinTransactions（TTL 30 天）・MineLogs / FishLogs（TTL 90 天）・EconomySnapshots（每日 00:05 凍結）・OreMarketPrices\n` +
              `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      // V2 messages 限 4000 字總長，分四則訊息送，避免被截斷。
      await interaction.editReply({
        components: [c1],
        flags: MessageFlags.IsComponentsV2,
      });
      await interaction.followUp({
        components: [c2],
        flags: MessageFlags.IsComponentsV2,
      });
      await interaction.followUp({
        components: [c3],
        flags: MessageFlags.IsComponentsV2,
      });
      await interaction.followUp({
        components: [c4],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /economy-dashboard:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 計算經濟儀表板失敗，看 console")
        .catch(() => {});
    }
  },
};
