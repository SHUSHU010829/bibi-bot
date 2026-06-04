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
} = require("../../features/economy/economyDashboard");

const RANGE_CHOICES = [
  { name: "今日（即時）", value: 1 },
  { name: "近 7 天", value: 7 },
  { name: "近 30 天", value: 30 },
  { name: "近 90 天", value: 90 },
];

function fmt(n) {
  return Number(n || 0).toLocaleString();
}
function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
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
  const arrow = delta > 0 ? "📈" : delta < 0 ? "📉" : "➡️";
  return `${arrow} ${first.date} → ${last.date}：${fmt(first.totalCirculation)} → ${fmt(last.totalCirculation)}（${signed(delta)}）`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("economy-dashboard")
    .setDescription("[ADMIN] 查看金幣健康度：流通、印幣 / 銷幣、集中度 📊")
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.coinTransactionsCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }

      const days = interaction.options.getInteger("range") || 7;
      const guildId = interaction.guildId;
      const fromIso = days === 1 ? todayIso() : isoDaysAgo(days - 1);
      const toIso = todayIso();

      const [circulation, flow, holders, snapshots] = await Promise.all([
        getCirculationNow(client, guildId),
        aggregateFlow(client, guildId, fromIso, toIso),
        getTopHolders(client, guildId, 10),
        getRecentSnapshots(client, guildId, Math.max(days, 7)),
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

      const container = new ContainerBuilder()
        .setAccentColor(totals.netFlow > 0 ? 0xe67e22 : 0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${MONEY_EMOJI} 經濟健康度儀表板\n` +
              `**範圍**：${rangeLabel}（${fromIso} ~ ${toIso}）\n` +
              `-# 用於追蹤通膨／集中度／玩法平衡`,
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
              `・有金幣玩家 ${fmt(circulation.activeUsers)} / ${fmt(circulation.userCount)}\n` +
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
        container
          .addSeparatorComponents(new SeparatorBuilder())
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
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🏆 持幣集中度（Top 10）\n` +
              `**Top 10 合計：${fmt(holders.top10Coins)}　占錢包總量 ${pct(holders.top10Share)}**\n` +
              `${top10Lines || "（無資料）"}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 資料源：CoinTransactions（TTL 90 天）・EconomySnapshots（每日 00:05 凍結）\n` +
              `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.editReply({
        components: [container],
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
