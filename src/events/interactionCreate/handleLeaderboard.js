// /排行榜 互動：類別下拉選單 + 期間切換按鈕
require("colors");

const {
  parseSelectCustomId,
  parsePeriodCustomId,
  renderLeaderboard,
  SELECT_PREFIX,
  PERIOD_PREFIX,
} = require("../../features/leaderboard/render");
const logger = require("../../utils/logger");
const { trackError } = require("../../utils/errorTracker");
const { deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  const cid = interaction.customId;
  if (!cid) return;

  let categoryKey = null;
  let period = null;

  if (interaction.isStringSelectMenu?.() && cid.startsWith(SELECT_PREFIX)) {
    const parsed = parseSelectCustomId(cid);
    if (!parsed) return;
    categoryKey = interaction.values?.[0];
    period = parsed.period;
  } else if (interaction.isButton?.() && cid.startsWith(PERIOD_PREFIX)) {
    const parsed = parsePeriodCustomId(cid);
    if (!parsed) return;
    categoryKey = parsed.categoryKey;
    period = parsed.period;
  } else {
    return;
  }

  if (!(await deferUpdateSafe(interaction))) return;

  try {
    const payload = await renderLeaderboard(client, {
      categoryKey,
      period,
      interaction,
    });
    await interaction.editReply(payload);
  } catch (error) {
    logger.error(
      {
        source: "leaderboard-interaction",
        customId: cid,
        err: error.message,
        stack: error.stack,
      },
      "切換排行榜失敗"
    );
    trackError("leaderboard-interaction", error, { customId: cid });
    await interaction
      .editReply({ content: "🔧 切換排行榜失敗，請重試或重新呼叫 `/排行榜`" })
      .catch(() => {});
  }
};
