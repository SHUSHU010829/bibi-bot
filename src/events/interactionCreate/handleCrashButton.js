const { MessageFlags } = require("discord.js");

const { settleCashout } = require("../../features/casino/crash/engine");
const {
  buildSettledPayload,
} = require("../../features/casino/crash/renderer");
const tickManager = require("../../features/casino/crash/tick");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("cr_cash_")) return;
    if (!client.crashGamesCollection) return;

    const gameId = interaction.customId.slice("cr_cash_".length);
    if (!gameId) return;

    // 速率限制：擋連點
    const rl = consume(interaction.user.id, "btn:crash", {
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

    // 先 defer
    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "crash-button", gameId },
          "互動已逾期，無法 defer",
        );
        trackError("crash-button", deferErr, { gameId, reason: "expired" });
        return;
      }
      throw deferErr;
    }

    const state = await client.crashGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "🚀 這局已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的局！別亂按 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "playing") {
      return interaction.followUp({
        content: "🚀 火箭已落地，這局已結束。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const now = Date.now();
    const bustAtMs =
      state.bustAt instanceof Date ? state.bustAt.getTime() : state.bustAt;

    // 已經過 bust 時間 → 嘗試把它推到 crashed（搶在 tick 之前讓玩家立刻看到結果）
    if (now >= bustAtMs) {
      const res = await tickManager.commitCrashed(client, state);
      // 不管搶到沒搶到，都讓 tick 收尾畫面，這裡只給玩家一個提示
      try {
        await interaction.followUp({
          content: "💥 慢了一步！火箭已經爆炸。",
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      if (res) {
        // 我們搶到了，就由我們負責畫結算
        tickManager.stop(gameId);
        const balance = await tickManager.resolveBalance(client, state);
        const payload = await buildSettledPayload(res.committed, {
          username: state.username,
          balance,
          userId: state.userId,
          avatarURL: interaction.user.displayAvatarURL(),
        });
        await tickManager.editMessage(
          client,
          { channelId: state.channelId, messageId: state.messageId },
          payload,
        );
      }
      return;
    }

    // 還在飛 → 計算當下倍率，atomic CAS 結算
    const stateForEngine = {
      ...state,
      startedAt:
        state.startedAt instanceof Date
          ? state.startedAt.getTime()
          : state.startedAt,
      bustAt: bustAtMs,
    };
    const settled = settleCashout(stateForEngine, now);
    if (!settled) {
      try {
        await interaction.followUp({
          content: "💥 慢了一步！火箭已經爆炸。",
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    const res = await tickManager.commitCashout(client, state, settled);
    if (!res) {
      // 被 tick 搶先（多半是 bust）
      try {
        await interaction.followUp({
          content: "💥 慢了一步！火箭已經爆炸。",
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    tickManager.stop(gameId);
    const balance = await tickManager.resolveBalance(
      client,
      state,
      res.balanceAfter,
    );
    const payload = await buildSettledPayload(res.committed, {
      username: state.username,
      balance,
      userId: state.userId,
      avatarURL: interaction.user.displayAvatarURL(),
    });
    await tickManager.editMessage(
      client,
      { channelId: state.channelId, messageId: state.messageId },
      payload,
    );
    trackSuccess("crash-button");
  } catch (error) {
    logger.error(
      {
        source: "crash-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "火箭收手按鈕處理失敗",
    );
    trackError("crash-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 收手失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 收手失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
