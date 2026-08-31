// 📊 最強操盤手名人堂畫面（/股市 名人堂 與公告按鈕共用）。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const gameTitleService = require("../gameTitles/gameTitleService");
const stockKingService = require("./stockKingService");

const HALL_BUTTON_ID = "stock_king_hall";
const MEDALS = ["🥇", "🥈", "🥉"];
const HISTORY_LIMIT = 8;

function hallButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(HALL_BUTTON_ID)
      .setLabel("歷屆最強操盤手")
      .setEmoji("🏛️")
      .setStyle(ButtonStyle.Secondary)
  );
}

function signed(n) {
  return `${n >= 0 ? "+" : ""}${Number(n || 0).toLocaleString()}`;
}

// 名單一律用 <@id> 顯示（呼叫端記得帶 allowedMentions: { parse: [] }）：
// 歷屆冠軍可能早就不在 cache 裡，用 displayName 轉換會變成「未知玩家」。
async function buildHallContainer(client, { guildId, viewerId }) {
  // 先跑 history（可能會追溯補寫舊週次），次數統計才不會少算
  const records = await stockKingService.history(client, guildId, { limit: HISTORY_LIMIT });
  const [counts, holders, mine] = await Promise.all([
    stockKingService.reignCounts(client, guildId, 5),
    stockKingService.currentHolders(client, guildId),
    stockKingService.myReigns(client, guildId, viewerId),
  ]);

  const label = gameTitleService.label(stockKingService.titleId());
  const nameOf = (id) => `<@${id}>`;

  const container = new ContainerBuilder()
    .setAccentColor(0xffd700)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏛️ 歷屆 ${label}\n` +
          (holders.length
            ? `現任：${holders.map((id) => nameOf(id)).join("、")} 👑`
            : "現任：從缺（上週冠軍沒有正報酬就不頒王）")
      )
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (!records.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "尚無任何頒發紀錄。\n每週一 00:01 結算上週已實現損益，冠軍就會登上這面牆。"
      )
    );
  } else {
    const lines = records.map((r) => {
      const tag = r.source === "backfill" ? " ⏳" : "";
      return (
        `**${stockKingService.weekLabel(r.weekStart)}**${tag}　${nameOf(r.userId)}\n` +
        `　📈 已實現損益 **${signed(r.pnl)}**（${r.trades} 筆）`
      );
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n"))
    );

    if (counts.length) {
      const countLines = counts.map(
        (c, i) =>
          `${i < 3 ? MEDALS[i] : "・"} ${nameOf(c.userId)} — **${c.reigns}** 次（最佳 ${signed(c.bestPnl)}）`
      );
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**封王次數排行**\n${countLines.join("\n")}`)
        );
    }
  }

  const mineLine = mine.reigns
    ? `你封王 **${mine.reigns}** 次，最近一次是 ${stockKingService.weekLabel(mine.lastWeek)} 那週 📊`
    : "你還沒封過王，週冠只看「上週已實現損益」，隨時能翻盤 📈";

  const hasBackfill = records.some((r) => r.source === "backfill");
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(mineLine))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        hasBackfill
          ? "-# ⏳ 為系統依歷史成交追溯計算的週次（當時尚未頒發稱號）；用 `/股市 排行` 看本週戰況"
          : "-# 用 `/股市 排行` 看本週戰況，週冠每週一 00:01 結算"
      )
    );

  return container;
}

module.exports = { HALL_BUTTON_ID, hallButtonRow, buildHallContainer, HISTORY_LIMIT };
