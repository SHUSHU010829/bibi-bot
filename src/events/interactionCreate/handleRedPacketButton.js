// 搶紅包按鈕：customId = rp_grab_<gameId>。
// 用單一文件 aggregation-pipeline update 原子地分配一包，避免併發重複搶 / 超發。

const { MessageFlags } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../../features/economy/grantCoins");
const { buildOpenPayload } = require("../../features/casino/redPacket/render");
const { closeRedPacket } = require("../../features/casino/redPacket/service");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

async function ephemeral(interaction, content) {
  try {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("rp_grab_")) return;
    if (!client.redPacketGamesCollection) return;

    const gameId = interaction.customId.slice("rp_grab_".length);
    const userId = interaction.user.id;
    const username = interaction.member?.displayName || interaction.user.username;

    const rl = consume(userId, "btn:redPacket", { windowMs: 800, max: 1 });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 手別抖，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) return;
      throw deferErr;
    }

    const state = await client.redPacketGamesCollection.findOne({ gameId });
    if (!state) {
      return ephemeral(interaction, "🧧 這包紅包找不到了。");
    }
    if (state.status !== "open") {
      return ephemeral(interaction, "🧧 手慢了，紅包已經結束囉～");
    }
    if (state.hostUserId === userId) {
      return ephemeral(interaction, "🧧 自己發的紅包不能自己搶啦 ㄎㄎ");
    }
    if ((state.grabbers || []).some((g) => g.userId === userId)) {
      return ephemeral(interaction, "🧧 你已經搶過這包了，把機會留給別人～");
    }

    const updated = await client.redPacketGamesCollection.findOneAndUpdate(
      {
        gameId,
        status: "open",
        "grabbers.userId": { $ne: userId },
        $expr: { $lt: [{ $size: "$grabbers" }, "$totalCount"] },
      },
      [
        {
          $set: {
            grabbers: {
              $concatArrays: [
                "$grabbers",
                [
                  {
                    userId,
                    username,
                    amount: { $arrayElemAt: ["$shares", { $size: "$grabbers" }] },
                    at: "$$NOW",
                  },
                ],
              ],
            },
            updatedAt: "$$NOW",
          },
        },
      ],
      { returnDocument: "after" }
    );

    const next = updated?.value || updated;
    if (!next) {
      return ephemeral(interaction, "🧧 手慢了，紅包剛被搶光！");
    }

    const mine = next.grabbers.find((g) => g.userId === userId);
    const amount = mine?.amount || 0;

    if (amount > 0) {
      await grantCoins(client, {
        userId,
        guildId: next.guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount,
        source: "payout",
        member: interaction.member,
        meta: { game: "redPacket", gameId, kind: "grab" },
      });
    }

    const isFull = next.grabbers.length >= next.totalCount;
    if (isFull) {
      await closeRedPacket(client, gameId, { reason: "emptied" });
    } else {
      await interaction.editReply(buildOpenPayload(next)).catch(() => {});
    }

    if (next.kind === "prank") {
      await ephemeral(
        interaction,
        "🤡 你被騙啦！這是**傻瓜紅包**，根本是空的什麼都沒有 ㄎㄎㄎ"
      );
    } else {
      await ephemeral(
        interaction,
        `🧧 你搶到 **${amount.toLocaleString()}** ${MONEY_EMOJI}！`
      );
    }
    trackSuccess("redpacket-button");
  } catch (error) {
    logger.error(
      {
        source: "redpacket-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "搶紅包按鈕處理失敗"
    );
    trackError("redpacket-button", error, { customId: interaction.customId });
    await ephemeral(interaction, "🔧 搶紅包失敗，請呼叫舒舒！");
  }
};
