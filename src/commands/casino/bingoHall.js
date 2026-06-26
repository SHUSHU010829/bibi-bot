// /賓果大廳 — 排程式群組賓果（免人開房，固定時間自動開球）。
//   買卡：買隨機賓果卡進當前場次
//   資訊：查看當前場次彩池 / 累積大獎 / 開球倒數 / 自己的卡

require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, casino } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const {
  buyCards,
  ensureOpenRound,
} = require("../../features/casino/bingoHall/service");
const {
  buildBuyReply,
  buildInfoReply,
} = require("../../features/casino/bingoHall/render");

function cfg() {
  return casino?.bingoHall || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("賓果大廳")
    .setDescription("🎱 排程群組賓果！買卡等開球，連線分彩池、全餐獨得累積大獎")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("買卡")
        .setDescription("買隨機賓果卡進當前場次")
        .addIntegerOption((o) =>
          o
            .setName("張數")
            .setDescription("買幾張")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(cfg().maxCardsPerRound ?? 20)
        )
    )
    .addSubcommand((s) =>
      s.setName("資訊").setDescription("查看當前賓果大廳場次")
    )
    .toJSON(),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "買卡") return runBuy(client, interaction);
    return runInfo(client, interaction);
  },
};

async function runBuy(client, interaction) {
  await interaction.deferReply();
  try {
    if (!coinSystem?.enabled) return interaction.editReply("🔧 金幣系統尚未啟動！");
    if (!client.userCoinsCollection || !client.bingoHallRoundsCollection) {
      return interaction.editReply("🔧 賓果大廳尚未啟動，請聯絡舒舒！");
    }
    if (cfg().enabled === false) return interaction.editReply("🔧 賓果大廳暫時關閉中！");

    const count = interaction.options.getInteger("張數") || 1;
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const username = interaction.member?.displayName || interaction.user.username;

    const res = await buyCards(client, {
      userId,
      guildId,
      username,
      count,
      member: interaction.member,
    });

    if (!res.ok) {
      if (res.reason === "closed")
        return interaction.editReply("🎱 目前沒有開放中的場次，稍等下一場～");
      if (res.reason === "max")
        return interaction.editReply(
          `🎱 每場最多 ${res.maxPer} 張，你已有 ${res.owned} 張，這次買不下 ${count} 張。`
        );
      if (res.reason === "balance")
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！買 ${count} 張要 **${res.cost.toLocaleString()}**，你只有 **${res.balance.toLocaleString()}**。`
        );
      return interaction.editReply("🔧 買卡失敗，請稍後再試。");
    }

    await interaction.editReply(buildBuyReply(res));
  } catch (err) {
    console.log(`[ERROR] /賓果大廳 買卡:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 賓果大廳買卡失敗，請呼叫舒舒！").catch(() => {});
  }
}

async function runInfo(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!client.bingoHallRoundsCollection) {
      return interaction.editReply("🔧 賓果大廳尚未啟動。");
    }
    const round = await ensureOpenRound(client);
    const userCards = round
      ? await client.bingoHallCardsCollection.countDocuments({
          roundId: round.roundId,
          userId: interaction.user.id,
        })
      : 0;
    await interaction.editReply(
      buildInfoReply({ round, userCards, ticketPrice: cfg().ticketPrice ?? 50 })
    );
  } catch (err) {
    console.log(`[ERROR] /賓果大廳 資訊:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 查詢失敗。").catch(() => {});
  }
}
