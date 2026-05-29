// 決鬥按鈕：
//   duel_accept_<duelId>   對手接受 → 判定勝負、發放彩池
//   duel_decline_<duelId>  對手拒絕 / 挑戰者取消 → 退回賭注

const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const duelService = require("../../features/mining/duelService");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId || "";
    if (!id.startsWith("duel_accept_") && !id.startsWith("duel_decline_")) return;
    if (!client.duelGamesCollection) return;

    const rl = consume(interaction.user.id, "btn:duel", { windowMs: 1500, max: 1 });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) {
        /* noop */
      }
      return;
    }

    // 先 ack，避免 DB / 發幣耗時超過 3 秒 token 效期
    await interaction.deferUpdate();

    if (id.startsWith("duel_decline_")) {
      const duelId = id.slice("duel_decline_".length);
      const res = await duelService.declineDuel(client, {
        duelId,
        byUserId: interaction.user.id,
      });
      if (!res.ok) {
        if (res.reason === "not_participant") {
          return interaction.followUp({
            content: "🚫 只有決鬥雙方可以取消這場決鬥。",
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.followUp({
          content: "⚔️ 這場決鬥已經結束或不存在了。",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cancelledBySelf = res.byUserId === res.duel.challenger_id;
      const container = new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ⚔️ 決鬥取消\n` +
              (cancelledBySelf
                ? `<@${res.duel.challenger_id}> 取消了對 <@${res.duel.opponent_id}> 的決鬥，賭注已退回。`
                : `<@${res.duel.opponent_id}> 拒絕了 <@${res.duel.challenger_id}> 的決鬥，賭注已退回。`),
          ),
        );
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("duel-decline");
      return;
    }

    // 接受
    const duelId = id.slice("duel_accept_".length);
    const res = await duelService.acceptDuel(client, {
      duelId,
      opponentId: interaction.user.id,
      opponentName: interaction.member?.displayName || interaction.user.username,
      member: interaction.member,
    });

    if (!res.ok) {
      if (res.reason === "not_opponent") {
        return interaction.followUp({
          content: "🚫 這場決鬥不是邀請你的，無法接受。",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (res.reason === "insufficient") {
        return interaction.followUp({
          content: `${MONEY_EMOJI} 你的餘額不足，無法接受這場決鬥（需要 ${(
            res.balance ?? 0
          ).toLocaleString()} 以上）。`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (res.reason === "expired") {
        return interaction.followUp({
          content: "⌛ 這場決鬥已逾時，賭注將自動退回。",
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.followUp({
        content: "⚔️ 這場決鬥已經結束或不存在了。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const rakeNote =
      res.rakeAmount > 0
        ? `（已扣系統手續費 ${res.rakeAmount.toLocaleString()} ${COIN_EMOJI}）`
        : "";
    const container = new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ⚔️ 決鬥結果\n` +
            `**勝者 🏆 <@${res.winnerId}>** 贏走了 **${res.pot.toLocaleString()}** ${COIN_EMOJI}！${rakeNote}\n\n` +
            `挑戰者 <@${res.duel.challenger_id}>（攻擊 ${res.atkChallenger} → 分數 **${res.scoreChallenger}**）\n` +
            `對手 <@${res.duel.opponent_id}>（攻擊 ${res.atkOpponent} → 分數 **${res.scoreOpponent}**）`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 分數 = 攻擊力 + 隨機值；用 /合成 打造更強的鎬子提高底分！",
        ),
      );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    trackSuccess("duel-accept");
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) {
      logger.warn(
        { source: "duel-button", code: error.code, customId: interaction.customId },
        "決鬥互動已過期或已被回應，略過"
      );
      return;
    }
    logger.error(
      {
        source: "duel-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "決鬥按鈕處理失敗"
    );
    trackError("duel-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      await interaction.followUp({
        content: "🔧 決鬥處理失敗，請呼叫舒舒！",
        flags: MessageFlags.Ephemeral,
      });
    } catch (_) {
      /* noop */
    }
  }
};
