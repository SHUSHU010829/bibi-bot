const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");
const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { MONEY_EMOJI } = require("../../constants/coin");
const {
  resolveFold,
  resolveCall,
} = require("../../features/casino/casinoHoldem/engine");
const { renderMessage } = require("../../features/casino/casinoHoldem/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

function getConfig() {
  return casino?.casinoHoldem || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("ch_")) return;
    if (!client.casinoHoldemGamesCollection) return;

    // customId 格式：ch_<action>_<gameId>，gameId 是 uuid 含 "-"
    const rest = interaction.customId.slice("ch_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return;
    const action = rest.slice(0, splitIdx);
    const gameId = rest.slice(splitIdx + 1);

    if (!["call", "fold"].includes(action)) return;

    const rl = consume(interaction.user.id, "btn:casinoHoldem", {
      windowMs: 1000,
      max: 1,
    });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "casinoHoldem-button", gameId },
          "互動已逾期,無法 defer"
        );
        trackError("casinoHoldem-button", deferErr, { gameId, reason: "expired" });
        return;
      }
      throw deferErr;
    }

    const state = await client.casinoHoldemGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "🃏 這局已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的牌局！別亂按 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "playing") {
      return interaction.followUp({
        content: "🃏 這局已結束。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = state.userId;
    const guildId = state.guildId;
    const username = state.username || interaction.user.username;
    const member = interaction.member;
    const ante = state.ante;
    const cfg = getConfig();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const now = new Date();

    let next;

    if (action === "fold") {
      next = resolveFold(state);
    } else {
      // 跟注：需再押 2×ante。
      const callBet = ante * 2;
      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      if (balance < callBet) {
        const container = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `### ${MONEY_EMOJI} 餘額不足，無法跟注\n` +
                `跟注需再押 **${callBet.toLocaleString()}** credits（底注的 2 倍）\n` +
                `目前餘額：**${balance.toLocaleString()}** credits`
            )
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `-# 餘額不夠跟注時，你仍可按「蓋牌」結束牌局（只損失底注）。`
            )
          );
        return interaction.followUp({
          flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          components: [container],
        });
      }

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        amount: -callBet,
        source: "bet",
        member,
        meta: { game: "casinoHoldem", gameId, stage: "call" },
      });
      if (!betResult) {
        return interaction.followUp({
          content: "🔧 跟注扣款失敗，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
      }

      next = resolveCall(state);
    }

    await client.casinoHoldemGamesCollection.updateOne(
      { _id: state._id },
      {
        $set: {
          status: "settled",
          stage: next.stage,
          result: next.result,
          folded: next.folded,
          callBet: next.callBet || 0,
          dealerQualified: next.dealerQualified ?? null,
          payout: next.payout,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + ttlSec * 1000),
        },
        $unset: { deck: "" },
      }
    );

    // 派彩
    let balanceAfter;
    if (next.payout > 0) {
      const payoutResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        amount: next.payout,
        source: "payout",
        member,
        meta: {
          game: "casinoHoldem",
          result: next.result,
          gameId,
          ante,
          callBet: next.callBet || 0,
          dealerQualified: next.dealerQualified ?? null,
        },
      });
      balanceAfter = payoutResult?.doc?.totalCoins;
    }
    if (balanceAfter === undefined) {
      const after = await client.userCoinsCollection.findOne({ userId, guildId });
      balanceAfter = after?.totalCoins || 0;
    }

    const payload = renderMessage(
      { ...next, gameId, userId },
      {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      }
    );
    await interaction.editReply({ ...payload, attachments: [] });
    trackSuccess("casinoHoldem-button");
  } catch (error) {
    logger.error(
      {
        source: "casinoHoldem-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "賭場德州撲克按鈕處理失敗"
    );
    trackError("casinoHoldem-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 賭場德州撲克按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 賭場德州撲克按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
