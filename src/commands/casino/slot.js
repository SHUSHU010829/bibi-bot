require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { spin } = require("../../features/casino/slot/slotMachine");
const {
  contribute: contributeJackpot,
  bustPool: bustJackpot,
  getPool: getJackpotPool,
  getCfg: getJackpotCfg,
} = require("../../features/casino/slot/jackpotPool");
const {
  checkAndAnnouncePoolMilestones: checkSlotPoolMilestones,
} = require("../../features/casino/slot/poolAnnouncer");
const generateSlotGif = require("../../utils/generateSlotGif");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");

function getSlotConfig() {
  return casino?.slot || {};
}

function describeMatch(matchType) {
  switch (matchType) {
    case "jackpot":
      return "🎉 JACKPOT！七七七！";
    case "triple":
      return "🎊 三連線！";
    case "double_cherry":
      return "🍒🍒 兩個櫻桃！";
    case "double":
      return "✨ 兩個一樣！";
    default:
      return "💸 沒中，下次再來！";
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("拉霸")
    .setDescription("拉霸試手氣！🎰")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注 credits（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(getSlotConfig().minBet ?? 5)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("梭哈")
        .setDescription("一次押上目前全部餘額")
        .setRequired(false)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getSlotConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 拉霸暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 5;

      const betInput = interaction.options.getInteger("下注");
      const allIn = interaction.options.getBoolean("梭哈") === true;
      if (!allIn && (!Number.isInteger(betInput) || betInput < minBet)) {
        return interaction.editReply(
          `下注金額至少需 ${minBet.toLocaleString()} credits（或勾選梭哈）。`
        );
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      const bet = allIn ? balance : betInput;
      if (allIn && balance < minBet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足以梭哈！目前 **${balance.toLocaleString()}** credits，至少需 ${minBet.toLocaleString()}。`
        );
      }
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const roundId = crypto.randomUUID();

      // 扣下注
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "slot", roundId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }

      // 累積彩池：先把這筆下注的 3% 灌進池
      const jackpotCfg = getJackpotCfg();
      const jackpotEnabled = jackpotCfg?.enabled !== false;
      if (jackpotEnabled) {
        await contributeJackpot(client, guildId, bet).catch((e) =>
          console.log(`[SLOT] jackpot contribute failed: ${e}`.yellow)
        );
      }

      // 跑抽獎
      const result = spin({ bet });
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;
      let jackpotBust = 0;

      // 中 jackpot：把整池額外送給玩家、並重置回 seed
      if (jackpotEnabled && result.matchType === "jackpot") {
        jackpotBust = await bustJackpot(client, guildId).catch((e) => {
          console.log(`[SLOT] jackpot bust failed: ${e}`.red);
          return 0;
        });
      }

      const totalPayout = result.payout + jackpotBust;

      // 派彩（base + jackpot bust 一起發）
      if (totalPayout > 0) {
        const payoutResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: totalPayout,
          source: "payout",
          member,
          meta: {
            game: "slot",
            matchType: result.matchType,
            matchKey: result.matchKey,
            multiplier: result.multiplier,
            basePayout: result.payout,
            jackpotBust,
            bet,
            roundId,
          },
        });
        balanceAfter = payoutResult?.doc?.totalCoins ?? balanceAfter + totalPayout;
      }

      // 取得目前 pool 顯示在卡片上
      let jackpotPool = null;
      if (jackpotEnabled) {
        const poolDoc = await getJackpotPool(client, guildId).catch(() => null);
        jackpotPool = poolDoc?.amount ?? null;
      }

      // 出圖（GIF 一鏡到底，含轉軸動畫）
      const buf = await generateSlotGif({
        userId,
        username,
        reels: result.reels,
        matchType: result.matchType,
        matchedSymbol: result.matchedSymbol,
        bet,
        payout: totalPayout,
        multiplier: result.multiplier,
        balance: balanceAfter,
        jackpotPool,
        jackpotBust,
      });

      const attachment = new AttachmentBuilder(buf, {
        name: `slot-${roundId}.gif`,
      });

      const jackpotLine =
        result.matchType === "jackpot" && jackpotBust > 0
          ? `\n💥 **爆池啦！** 你獨得 jackpot pool **+${jackpotBust.toLocaleString()}** credits！（基礎賠率 ${result.payout.toLocaleString()} + 累積池 ${jackpotBust.toLocaleString()}）`
          : "";
      const poolLine =
        jackpotEnabled && jackpotPool != null
          ? `\n${MONEY_EMOJI} 目前 Jackpot Pool：**${jackpotPool.toLocaleString()}** credits`
          : "";

      const headline =
        result.matchType === "jackpot"
          ? `🎉 **JACKPOT！** ＋${totalPayout.toLocaleString()} credits！`
          : totalPayout > 0
          ? `${describeMatch(result.matchType)} ＋${totalPayout.toLocaleString()} credits`
          : `💸 沒中，下次再來！`;

      const bankruptLine =
        balanceAfter <= 0
          ? `\n🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！`
          : "";

      await saveLastBet(client, {
        userId,
        guildId,
        game: "slot",
        payload: { options: { 下注: bet, 梭哈: false } },
      });

      await interaction.editReply({
        content: `${headline}${jackpotLine}\n・下注：**${bet.toLocaleString()}**　・餘額：**${balanceAfter.toLocaleString()}**${poolLine}${bankruptLine}`,
        files: [attachment],
        components: [buildReplayRow("slot", userId, { name: username })],
      });

      // 爆池公告
      const announceChannelId = jackpotCfg?.announceChannelId;
      if (jackpotBust > 0 && announceChannelId) {
        try {
          const ch = await client.channels.fetch(announceChannelId).catch(() => null);
          if (ch?.isTextBased?.()) {
            ch.send(
              `💥💥💥 **拉霸 JACKPOT 爆池！** <@${userId}> 中了 **+${jackpotBust.toLocaleString()}** credits 累積彩池（七七七！）`
            ).catch(() => {});
          }
        } catch (_) { /* ignore */ }
      }

      // 彩池里程碑播報（沒爆池才檢查；爆池後 pool 已歸 seed）
      if (jackpotEnabled && jackpotBust === 0) {
        checkSlotPoolMilestones(client, guildId).catch((e) =>
          console.log(`[SLOT] milestone check failed: ${e}`.yellow)
        );
      }
    } catch (error) {
      console.log(`[ERROR] /拉霸:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 拉霸執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
