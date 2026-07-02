// /股市 持股 面板的導覽按鈕：切換「持股 / 融券」分頁、上一頁 / 下一頁、重新整理。
//
// customId 格式:`pf_stknav_<tab>_<page>_<ownerUid>`(見 features/profile/views/stockHoldings.js)。
// 流程:本人按下 → 依 tab/page 重抓持股與最新報價 → 就地更新原訊息。

require("colors");
const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
} = require("discord.js");

const { stockSystem } = require("../../config");
const {
  buildStockHoldingsView,
  parseNavCustomId,
} = require("../../features/profile/views/stockHoldings");
const { consume } = require("../../utils/rateLimiter");

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const parsed = parseNavCustomId(interaction.customId);
  if (!parsed) return;

  const { tab, page, ownerUid } = parsed;

  if (interaction.user.id !== ownerUid) {
    return interaction
      .reply({
        content: "🔒 這是別人的持股面板,請用 `/股市 持股` 看自己的。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  const rl = consume(interaction.user.id, "btn:profileStockNav", {
    windowMs: 1500,
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
    const view = await buildStockHoldingsView(client, {
      target: interaction.user,
      member: interaction.member,
      guildId: interaction.guildId,
      tab,
      page,
    });

    if (!view.components || view.components.length === 0) {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(view.content || "📭 目前沒有任何持股。"),
      );
      return interaction.update({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    await interaction.update({
      components: view.components,
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.log(`[STOCK] 持股面板導覽失敗:${err?.stack || err}`.red);
    await interaction
      .reply({ content: "❌ 操作失敗,請稍後再試。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
};
