// /紅包 — 在頻道發一包紅包，大家限時搶，未搶完自動退回發包人。
//
// 流程：
//   1) 發包人下指令 → 立即扣款（escrow）→ 預先算好每包金額 → 頻道貼出搶紅包面板
//   2) 任何人（發包人除外）點 🧧 搶一次 → atomic 分配一包 → grantCoins 入帳
//   3) 搶光 or 到期 → closeRedPacket 收尾，退回未搶金額

require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, casino } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../../features/economy/grantCoins");
const { buildShares } = require("../../features/casino/redPacket/split");
const { buildOpenPayload } = require("../../features/casino/redPacket/render");
const { closeRedPacket } = require("../../features/casino/redPacket/service");

function getCfg() {
  return casino?.redPacket || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("紅包")
    .setDescription("🧧 發一包紅包讓大家搶！未搶完自動退回")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("金額")
        .setDescription("紅包總金額")
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("包數")
        .setDescription("拆成幾包")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption((opt) =>
      opt
        .setName("手氣")
        .setDescription("拚手氣（隨機）或均分")
        .setRequired(false)
        .addChoices(
          { name: "拚手氣（隨機）", value: "lucky" },
          { name: "均分", value: "even" }
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }
      if (!client.redPacketGamesCollection) {
        return interaction.editReply("🔧 紅包系統未啟動，請聯絡舒舒！");
      }

      const cfg = getCfg();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 紅包暫時關閉中！");
      }

      const minTotal = cfg.minTotal ?? 100;
      const maxCount = cfg.maxCount ?? 20;
      const windowSec = cfg.grabWindowSeconds ?? 600;

      const total = interaction.options.getInteger("金額");
      const count = interaction.options.getInteger("包數");
      const mode = interaction.options.getString("手氣") || "lucky";

      if (total < minTotal) {
        return interaction.editReply(
          `🧧 紅包至少要 **${minTotal.toLocaleString()}** ${MONEY_EMOJI}（目前填 ${total.toLocaleString()}）。`
        );
      }
      if (count > maxCount) {
        return interaction.editReply(
          `🧧 最多拆成 **${maxCount}** 包（目前填 ${count}）。`
        );
      }
      if (total < count) {
        return interaction.editReply(
          `🧧 金額要 ≥ 包數，每包至少 1 ${MONEY_EMOJI}（${total.toLocaleString()} 元拆 ${count} 包不夠分）。`
        );
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      if (balance < total) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}**，發這包要 **${total.toLocaleString()}**。`
        );
      }

      const gameId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -total,
        source: "bet",
        member: interaction.member,
        meta: { game: "redPacket", gameId, kind: "fund" },
      });
      if (!betResult) {
        return interaction.editReply("🔧 扣款失敗，請稍後再試。");
      }

      const shares = buildShares(total, count, mode);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + windowSec * 1000);

      const state = {
        gameId,
        guildId,
        channelId: interaction.channelId,
        messageId: null,
        hostUserId: userId,
        hostUsername: username,
        mode,
        totalAmount: total,
        totalCount: count,
        shares,
        grabbers: [],
        status: "open",
        refunded: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      };

      await client.redPacketGamesCollection.insertOne(state);

      const message = await interaction.channel.send(buildOpenPayload(state));
      await client.redPacketGamesCollection.updateOne(
        { gameId },
        { $set: { messageId: message.id, updatedAt: new Date() } }
      );

      await interaction.editReply(
        `🧧 紅包已發出！共 ${total.toLocaleString()} ${MONEY_EMOJI} / ${count} 包，` +
          `${windowSec >= 60 ? `${Math.round(windowSec / 60)} 分鐘` : `${windowSec} 秒`}內沒搶完會退回給你。`
      );

      const delayMs = expiresAt.getTime() - Date.now();
      if (delayMs > 0) {
        setTimeout(() => {
          closeRedPacket(client, gameId, { reason: "expired" }).catch((e) =>
            console.log(`[REDPACKET] auto-close failed: ${e}`.yellow)
          );
        }, delayMs).unref?.();
      }
    } catch (error) {
      console.log(`[ERROR] /紅包:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 發紅包失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
