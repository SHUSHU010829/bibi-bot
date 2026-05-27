require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { startGame } = require("../../features/casino/dragonGate/engine");
const { renderMessage } = require("../../features/casino/dragonGate/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getDragonGateConfig() {
  return casino?.dragonGate || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("射龍門")
    .setDescription("🐉 入場費 50。看完柱牌再決定要不要補注射第三張！")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (
        !client.userCoinsCollection ||
        !client.coinTransactionsCollection ||
        !client.dragonGateGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getDragonGateConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 射龍門暫時關閉中！");
      }

      const ante = cfg.ante ?? 50;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const houseEdge = cfg.houseEdge ?? 0.05;

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 同時只能有一局未結算
      const existing = await client.dragonGateGamesCollection.findOne({
        userId,
        guildId,
        status: { $in: ["awaitingChoice", "playing"] },
      });
      if (existing) {
        return interaction.editReply(
          "🐉 你還有一局射龍門沒收尾！先把上一局打完再開新局。"
        );
      }

      const before = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      const balance = before?.totalCoins || 0;
      if (balance < ante) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！射龍門入場費 **${ante.toLocaleString()}** credits，目前 **${balance.toLocaleString()}**。`
        );
      }

      const gameId = crypto.randomUUID();

      const anteResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -ante,
        source: "bet",
        member,
        meta: { game: "dragonGate", gameId, ante, stage: "ante" },
      });
      if (!anteResult) {
        return interaction.editReply("🔧 入場費扣款失敗，請稍後再試。");
      }
      const balanceAfter = anteResult.doc?.totalCoins ?? balance - ante;

      const initial = startGame({ ante, houseEdge });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        ante: initial.ante,
        bet: initial.bet,
        lock: initial.lock,
        status: initial.status,
        deck: initial.deck,
        gateLow: initial.gateLow,
        gateHigh: initial.gateHigh,
        pushHistory: initial.pushHistory,
        thirdCard: initial.thirdCard,
        houseEdge: initial.houseEdge,
        multiplier: initial.multiplier,
        result: initial.result,
        payout: initial.payout,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.dragonGateGamesCollection.insertOne(doc);

      // 射龍門無下注選項（入場費固定），重玩等於再開一局
      await saveLastBet(client, {
        userId,
        guildId,
        game: "dragonGate",
        payload: { options: {} },
      });

      const payload = await renderMessage(
        { ...doc, gameId },
        { username, balance: balanceAfter }
      );
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /射龍門:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 射龍門執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
