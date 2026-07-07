// /股市 持股 的「回補 <symbol>」按鈕（融券平倉）。
//
// customId 格式:`pf_stkcover_<symbol>_<ownerUid>`(見 features/profile/views/stockHoldings.js)。
// 流程:本人按下 → 彈 Modal 輸入回補股數(可填 all)→ 用 shortService.coverShort 直接成交。

require("colors");
const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const { stockSystem } = require("../../config");
const { checkServerTenure } = require("../../features/economy/eligibility");
const { isMarketOpen } = require("../../features/stock/tradeService");
const shortService = require("../../features/stock/shortService");
const { COVER_BUTTON_PREFIX } = require("../../features/profile/views/stockHoldings");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

function parseCoverButtonId(customId) {
  if (!customId || !customId.startsWith(COVER_BUTTON_PREFIX)) return null;
  const rest = customId.slice(COVER_BUTTON_PREFIX.length);
  const sep = rest.lastIndexOf("_");
  if (sep <= 0) return null;
  return { symbol: rest.slice(0, sep), ownerUid: rest.slice(sep + 1) };
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const parsed = parseCoverButtonId(interaction.customId);
  if (!parsed) return;

  const { symbol, ownerUid } = parsed;

  if (interaction.user.id !== ownerUid) {
    return interaction
      .reply({
        content: "🔒 這是別人的回補按鈕,請用 `/股市 持股` 看自己的部位。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  const rl = consume(interaction.user.id, "btn:profileStockCover", {
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

  if (!stockSystem?.enabled) {
    return interaction
      .reply({ content: "🔧 股市系統未啟用。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }

  try {
    const modal = new ModalBuilder()
      .setCustomId(`${COVER_BUTTON_PREFIX}modal_${symbol}_${ownerUid}`)
      .setTitle(`回補 ${symbol}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("shares")
            .setLabel("回補股數(可填 all 全部回補)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(6)
            .setPlaceholder("例如 10 或 all")
        )
      );
    await interaction.showModal(modal);

    const submitted = await interaction
      .awaitModalSubmit({
        time: 60 * 1000,
        filter: (m) =>
          m.user.id === interaction.user.id &&
          m.customId === `${COVER_BUTTON_PREFIX}modal_${symbol}_${ownerUid}`,
      })
      .catch(() => null);
    if (!submitted) return;

    if (!isMarketOpen()) {
      return submitted.reply({
        content: "🌙 目前非開盤時間(09:00–21:00 Asia/Taipei),沒辦法回補。",
        flags: MessageFlags.Ephemeral,
      });
    }
    const tenure = checkServerTenure(interaction.member);
    if (!tenure.ok)
      return submitted.reply({
        content: tenure.message,
        flags: MessageFlags.Ephemeral,
      });

    const rawShares = submitted.fields.getTextInputValue("shares").trim();
    let shares;
    if (rawShares.toLowerCase() === "all") {
      shares = "all";
    } else {
      shares = parseInt(rawShares, 10);
      if (!Number.isInteger(shares) || shares <= 0) {
        return submitted.reply({
          content: "❌ 股數需為正整數或 `all`。",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    await submitted.deferReply();

    const result = await shortService.coverShort(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.member?.displayName || interaction.user.username,
      member: interaction.member,
      symbol,
      shares,
    });
    if (!result.ok) return submitted.editReply(result.message);

    const pnlSign = result.pnl >= 0 ? "+" : "";
    const pnlPct =
      result.avgShort > 0
        ? ((result.avgShort - result.coverPrice) / result.avgShort) * 100
        : 0;

    const container = new ContainerBuilder()
      .setAccentColor(result.pnl >= 0 ? 0x2ecc71 : 0xe74c3c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🔄 融券回補｜${result.symbol} ${result.name}`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**回補價**\n**${result.coverPrice.toFixed(1)}** × ${result.shares} 股`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**結算入帳**\n**${result.settlement.toLocaleString()}**(手續費 ${result.fee.toLocaleString()})`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**本筆損益**\n**${pnlSign}${result.pnl.toLocaleString()}**(${pnlSign}${pnlPct.toFixed(2)}%)`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**剩餘放空**\n${result.remainingShares} 股 ・ 餘額 ${result.balanceAfter.toLocaleString()}\n-# 重新 \`/股市 持股\` 可看到最新數字`
        )
      );

    await submitted.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    trackSuccess("profile-stock-cover");
  } catch (err) {
    logger.error(
      {
        source: "profile-stock-cover",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "/檔案 持股回補失敗"
    );
    trackError("profile-stock-cover", err, {
      customId: interaction?.customId,
    });
  }
};
