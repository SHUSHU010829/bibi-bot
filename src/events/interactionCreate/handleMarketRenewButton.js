require("colors");
const { ContainerBuilder, TextDisplayBuilder, MessageFlags } = require("discord.js");
const marketplaceService = require("../../features/marketplace/marketplaceService");
const { RENEW_PREFIX } = require("../../features/marketplace/marketplaceView");
const { COIN_EMOJI } = require("../../constants/coin");

// customId：market_renew_<ownerId>_<guildId>_<listingId>_<days>
// 續租按鈕會出現在到期 DM 中，DM 沒有 guildId，故把 guildId 一併編進 customId。

function card(color, text) {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const cid = interaction.customId || "";
  if (!cid.startsWith(RENEW_PREFIX)) return;

  try {
    const [ownerId, guildId, listingId, daysRaw] = cid.slice(RENEW_PREFIX.length).split("_");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "這不是你的掛單！", flags: MessageFlags.Ephemeral });
    }
    const days = parseInt(daysRaw, 10);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await marketplaceService.renewListing(client, {
      listingId,
      guildId,
      userId: ownerId,
      username: interaction.member?.displayName || interaction.user.username,
      days,
      member: interaction.member,
    });

    if (!result.ok) {
      const msgs = {
        not_found: "❌ 這張掛單已結算或不存在，無法續租。",
        not_owner: "❌ 這不是你的掛單。",
        insufficient_fee: `💰 續租費不足！需要 **${(result.need || 0).toLocaleString()}** ${COIN_EMOJI}，你目前 **${(result.balance || 0).toLocaleString()}** ${COIN_EMOJI}。\n-# 補足金幣後再點續租。`,
        bad_days: "❌ 續租天數無效。",
        grant_failed: "🔧 扣費失敗，請稍後再試。",
        race: "⚡ 掛單狀態剛好改變，請重試。",
        disabled: "🔧 市集暫時無法使用。",
      };
      return interaction.editReply({
        components: [card(0xe74c3c, `# ❌ 續租失敗\n${msgs[result.reason] || "🔧 續租失敗，請稍後再試。"}`)],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    const expiresEpoch = Math.floor(new Date(result.expiresAt).getTime() / 1000);
    return interaction.editReply({
      components: [
        card(
          0x2ecc71,
          `# ♻️ 續租成功\n` +
            `掛單 **#${result.listing.listing_id}** 已延長 **${result.days}** 天\n` +
            `費用 **${result.fee.toLocaleString()}** ${COIN_EMOJI}\n` +
            `新截止：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）`,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    console.log(`[ERROR] handleMarketRenewButton:\n${error}\n${error.stack}`.red);
    const payload = { content: "🔧 續租失敗，請呼叫舒舒！" };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
};
