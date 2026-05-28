// /檔案 持股分頁的「<symbol> 走勢」按鈕。
//
// customId 格式:`pf_stkchart_<symbol>_<ownerUid>`(見 features/profile/views/stockHoldings.js)。
// 流程:本人按下 → 用共用 buildChartContainer 渲染走勢圖 → ephemeral 回覆,不動原訊息。

require("colors");
const { MessageFlags } = require("discord.js");

const { stockSystem } = require("../../config");
const { buildChartContainer } = require("../../features/stock/chartView");
const {
  CHART_BUTTON_PREFIX,
} = require("../../features/profile/views/stockHoldings");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

function parseChartButtonId(customId) {
  if (!customId || !customId.startsWith(CHART_BUTTON_PREFIX)) return null;
  const rest = customId.slice(CHART_BUTTON_PREFIX.length);
  const sep = rest.lastIndexOf("_");
  if (sep <= 0) return null;
  return { symbol: rest.slice(0, sep), ownerUid: rest.slice(sep + 1) };
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const parsed = parseChartButtonId(interaction.customId);
  if (!parsed) return;

  const { symbol, ownerUid } = parsed;

  if (interaction.user.id !== ownerUid) {
    return interaction
      .reply({
        content: "🔒 這是別人的按鈕,請用 `/檔案` 看自己的持股。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  const rl = consume(interaction.user.id, "btn:profileStockChart", {
    windowMs: 2000,
    max: 1,
  });
  if (!rl.allowed) {
    return interaction
      .reply({
        content: `⏳ 點太快了,${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!stockSystem?.enabled) {
      return interaction.editReply("🔧 股市系統未啟用。");
    }
    if (!client.stockMarketCollection || !client.stockPricesCollection) {
      return interaction.editReply("🔧 股市系統尚未就緒。");
    }

    const { container, attachment } = await buildChartContainer(client, {
      guildId: interaction.guildId,
      symbol,
      period: "1w",
    });
    if (!container) {
      return interaction.editReply(attachment); // 此時 attachment 是錯誤訊息字串
    }

    await interaction.editReply({
      components: [container],
      files: attachment ? [attachment] : [],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    trackSuccess("profile-stock-chart");
  } catch (err) {
    logger.error(
      {
        source: "profile-stock-chart",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "/檔案 持股走勢查詢失敗"
    );
    trackError("profile-stock-chart", err, {
      customId: interaction?.customId,
    });
    await interaction
      .editReply("🔧 查詢走勢失敗,請稍後再試。")
      .catch(() => {});
  }
};
