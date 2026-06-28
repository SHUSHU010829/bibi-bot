const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { pick, cashOut } = require("../../features/casino/tower/engine");
const { renderMessage } = require("../../features/casino/tower/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const { MessageFlags } = require("discord.js");

function getTowerConfig() {
  return casino?.tower || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("tw_")) return;
    if (!client.towerGamesCollection) return;

    // customId 格式：tw_<action>_<gameId>，gameId 是 uuid 含 "-"
    const rest = interaction.customId.slice("tw_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return;
    const action = rest.slice(0, splitIdx);
    const gameId = rest.slice(splitIdx + 1);

    // action：cash 或 p<index>
    const isCash = action === "cash";
    const isPick = /^p\d+$/.test(action);
    if (!isCash && !isPick) return;

    // 速率限制：擋連點，避免製造 10062
    const rl = consume(interaction.user.id, "btn:tower", {
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

    if (!(await deferUpdateSafe(interaction))) {
      logger.warn({ source: "tower-button", gameId }, "互動已逾期,無法 defer");
      trackError("tower-button", { code: 10062 }, { gameId, reason: "expired" });
      return;
    }

    const state = await client.towerGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "🗼 這局已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的塔！別亂按 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "playing") {
      return interaction.followUp({
        content: "🗼 這局已結束。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = state.userId;
    const guildId = state.guildId;
    const username = state.username || interaction.user.username;
    const member = interaction.member;

    let next;
    if (isCash) {
      if (!state.currentFloor || state.currentFloor <= 0) {
        return interaction.followUp({
          content: "🚫 至少要爬 1 層才能收手！",
          flags: MessageFlags.Ephemeral,
        });
      }
      next = cashOut(state);
    } else {
      const tile = parseInt(action.slice(1), 10);
      next = pick(state, tile);
    }

    const cfg = getTowerConfig();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const now = new Date();

    await client.towerGamesCollection.updateOne(
      { _id: state._id },
      {
        $set: {
          currentFloor: next.currentFloor,
          picks: next.picks,
          hitTile: next.hitTile,
          accMultiplier: next.accMultiplier,
          status: next.status,
          result: next.result,
          payout: next.payout,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + ttlSec * 1000),
        },
      }
    );

    let balanceAfter;
    if (next.status === "settled" && next.payout > 0) {
      const payoutResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        amount: next.payout,
        source: "payout",
        member,
        meta: {
          game: "tower",
          result: next.result,
          gameId,
          bet: next.bet,
          floors: next.currentFloor,
          accMultiplier: next.accMultiplier,
        },
      });
      balanceAfter = payoutResult?.doc?.totalCoins;
    }
    if (balanceAfter === undefined) {
      const after = await client.userCoinsCollection.findOne({ userId, guildId });
      balanceAfter = after?.totalCoins || 0;
    }

    const payload = await renderMessage(
      { ...next, gameId, userId },
      {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      }
    );
    await interaction.editReply({
      ...payload,
      attachments: [],
    });
    trackSuccess("tower-button");
  } catch (error) {
    logger.error(
      {
        source: "tower-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "爬塔按鈕處理失敗"
    );
    trackError("tower-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 爬塔按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 爬塔按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
