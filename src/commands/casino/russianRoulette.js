// /賭場 左輪 — 開一桌俄羅斯輪盤，大家押相同賭注進池，開轉後隨機一人中彈輸光，其餘平分。

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
const { buildWaitingPayload } = require("../../features/casino/russianRoulette/render");
const { startGame, cancelAndRefund } = require("../../features/casino/russianRoulette/service");

function getCfg() {
  return casino?.russianRoulette || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("左輪")
    .setDescription("🔫 開一桌俄羅斯輪盤！押注進池，中彈者輸光，倖存者平分")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("賭注")
        .setDescription("每人押注金額")
        .setRequired(true)
        .setMinValue(getCfg().minAnte ?? 50)
    )
    .toJSON(),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }
      if (!client.russianRouletteGamesCollection) {
        return interaction.editReply("🔧 左輪系統未啟動，請聯絡舒舒！");
      }

      const cfg = getCfg();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 俄羅斯輪盤暫時關閉中！");
      }

      const minAnte = cfg.minAnte ?? 50;
      const maxAnte = cfg.maxAnte ?? 5000;
      const maxPlayers = cfg.maxPlayers ?? 6;
      const windowSec = cfg.joinWindowSeconds ?? 120;

      const ante = interaction.options.getInteger("賭注");
      if (ante < minAnte) {
        return interaction.editReply(`賭注至少 ${minAnte.toLocaleString()} ${MONEY_EMOJI}。`);
      }
      if (ante > maxAnte) {
        return interaction.editReply(`賭注上限 ${maxAnte.toLocaleString()} ${MONEY_EMOJI}。`);
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const channelId = interaction.channelId;
      const username = interaction.member?.displayName || interaction.user.username;

      // 同頻道一次只能有一桌等候中
      const existing = await client.russianRouletteGamesCollection.findOne({
        channelId,
        status: "waiting",
      });
      if (existing) {
        return interaction.editReply("🔫 這個頻道已經有一桌在等人了，先把那桌打完！");
      }

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      if (balance < ante) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}**，開桌要押 **${ante.toLocaleString()}**。`
        );
      }

      const gameId = crypto.randomUUID();
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -ante,
        source: "bet",
        member: interaction.member,
        meta: { game: "russianRoulette", gameId, kind: "ante" },
      });
      if (!betResult) {
        return interaction.editReply("🔧 扣款失敗，請稍後再試。");
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + windowSec * 1000);
      const state = {
        gameId,
        guildId,
        channelId,
        messageId: null,
        hostUserId: userId,
        ante,
        maxPlayers,
        players: [{ userId, username, ante }],
        status: "waiting",
        createdAt: now,
        updatedAt: now,
        expiresAt,
      };
      await client.russianRouletteGamesCollection.insertOne(state);

      const message = await interaction.channel.send(buildWaitingPayload(state));
      await client.russianRouletteGamesCollection.updateOne(
        { gameId },
        { $set: { messageId: message.id, updatedAt: new Date() } }
      );

      await interaction.editReply(
        `🔫 已開桌！其他人點面板上的「加入」一起玩，${Math.round(windowSec / 60) || 1} 分鐘後自動開轉。`
      );

      const delayMs = expiresAt.getTime() - Date.now();
      if (delayMs > 0) {
        setTimeout(() => {
          startGame(client, gameId).catch((e) =>
            console.log(`[ROULETTE] auto-start failed: ${e}`.yellow)
          );
        }, delayMs).unref?.();
      }
    } catch (error) {
      console.log(`[ERROR] /左輪:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 開桌失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
