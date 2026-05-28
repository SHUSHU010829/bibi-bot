require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

// 計算「全機器人」金幣流通量。
// totalCirculation 定義同 economySnapshotScheduler.js：錢包 + 啟用中存款本金。
// 額外列出 jackpot 池與開盤中樂透彩池（系統內鎖定的金幣，但不計入 circulation 統計值，
// 以維持與每日快照一致的口徑）。

async function sumWallets(client) {
  const result = await client.userCoinsCollection
    .aggregate([
      {
        $group: {
          _id: null,
          totalWalletCoins: { $sum: { $ifNull: ["$totalCoins", 0] } },
          activeUsers: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ["$totalCoins", 0] }, 0] }, 1, 0],
            },
          },
          userCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return (
    result[0] || { totalWalletCoins: 0, activeUsers: 0, userCount: 0 }
  );
}

async function sumActiveDeposits(client) {
  if (!client.coinDepositsCollection) {
    return { totalDepositPrincipal: 0, activeDepositCount: 0 };
  }
  const result = await client.coinDepositsCollection
    .aggregate([
      { $match: { status: "active" } },
      {
        $group: {
          _id: null,
          totalDepositPrincipal: { $sum: { $ifNull: ["$principal", 0] } },
          activeDepositCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return result[0] || { totalDepositPrincipal: 0, activeDepositCount: 0 };
}

async function sumJackpotPools(client) {
  if (!client.jackpotPoolCollection) {
    return { totalJackpot: 0, jackpotCount: 0 };
  }
  const result = await client.jackpotPoolCollection
    .aggregate([
      {
        $group: {
          _id: null,
          totalJackpot: { $sum: { $ifNull: ["$amount", 0] } },
          jackpotCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return result[0] || { totalJackpot: 0, jackpotCount: 0 };
}

async function sumOpenLotteryPools(client) {
  if (!client.lotteryDrawsCollection) {
    return { totalLotteryPool: 0, openDrawCount: 0 };
  }
  const result = await client.lotteryDrawsCollection
    .aggregate([
      { $match: { status: "open" } },
      {
        $group: {
          _id: null,
          totalLotteryPool: { $sum: { $ifNull: ["$pool", 0] } },
          openDrawCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return result[0] || { totalLotteryPool: 0, openDrawCount: 0 };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("circulation")
    .setDescription("[ADMIN] Show total coin circulation across all guilds 💰")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.userCoinsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }

      const [wallets, deposits, jackpot, lottery] = await Promise.all([
        sumWallets(client),
        sumActiveDeposits(client),
        sumJackpotPools(client),
        sumOpenLotteryPools(client),
      ]);

      const totalCirculation =
        wallets.totalWalletCoins + deposits.totalDepositPrincipal;
      const totalLockedInSystem =
        jackpot.totalJackpot + lottery.totalLotteryPool;
      const grandTotal = totalCirculation + totalLockedInSystem;

      const fmt = (n) => Number(n || 0).toLocaleString();

      const container = new ContainerBuilder()
        .setAccentColor(0xf1c40f)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${MONEY_EMOJI} 全機器人金幣流通量\n` +
              `**總流通量：${fmt(totalCirculation)}**\n` +
              `-# 錢包 + 啟用中存款本金，與每日經濟快照同口徑`,
          ),
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**👛 玩家錢包**\n` +
              `${fmt(wallets.totalWalletCoins)}\n` +
              `・有金幣玩家：${fmt(wallets.activeUsers)} / ${fmt(wallets.userCount)}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🏦 定期存款本金**\n` +
              `${fmt(deposits.totalDepositPrincipal)}\n` +
              `・啟用中存單：${fmt(deposits.activeDepositCount)}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🎰 拉霸 Jackpot 累積池**\n` +
              `${fmt(jackpot.totalJackpot)}\n` +
              `・池數：${fmt(jackpot.jackpotCount)}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🎟️ 樂透開盤中彩池**\n` +
              `${fmt(lottery.totalLotteryPool)}\n` +
              `・開盤中：${fmt(lottery.openDrawCount)}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**📊 系統內總金幣（含彩池）**\n${fmt(grandTotal)}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 口徑：UserCoins + CoinDeposits(active) + JackpotPool + LotteryDraws(open) ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /circulation:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 計算流通量失敗，看 console")
        .catch(() => {});
    }
  },
};
