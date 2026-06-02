require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const giftService = require("../../features/mining/giftService");
const { buildOverflowConfirmView } = require("../../features/mining/overflowConfirm");
const { COIN_EMOJI } = require("../../constants/coin");

const GIFT_OVERFLOW_CONFIRM_PREFIX = "gift_overflow_confirm_";
const GIFT_OVERFLOW_CANCEL_PREFIX = "gift_overflow_cancel_";

function oreChoices() {
  return Object.entries(mining?.ores || {}).map(([key, def]) => ({
    name: def.name || key,
    value: key,
  }));
}

module.exports = {
  channelBuckets: ["mining", "marketplace"],

  data: new SlashCommandBuilder()
    .setName("贈送")
    .setDescription("把背包裡的礦石送給其他玩家 🎁（每日次數有限、免手續費）")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("收禮的玩家").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("礦石")
        .setDescription("要送的礦石種類")
        .setRequired(true)
        .addChoices(...oreChoices())
    )
    .addIntegerOption((o) =>
      o
        .setName("數量")
        .setDescription("要送的數量")
        .setRequired(true)
        .setMinValue(1)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();
    const target = interaction.options.getUser("對象");
    const ore = interaction.options.getString("礦石");
    const qty = interaction.options.getInteger("數量");

    if (target.bot) return interaction.editReply("❌ 不能送禮給 bot 啦。");
    if (target.id === interaction.user.id) {
      return interaction.editReply("❌ 不能送給自己。");
    }

    return executeGift(client, interaction, {
      target,
      ore,
      qty,
      allowOverflow: false,
    });
  },

  executeGift,
  GIFT_OVERFLOW_CONFIRM_PREFIX,
  GIFT_OVERFLOW_CANCEL_PREFIX,
};

async function executeGift(client, interaction, { target, ore, qty, allowOverflow }) {
  try {
    const result = await giftService.giveOre(client, {
      giverId: interaction.user.id,
      guildId: interaction.guildId,
      recipientId: target.id,
      recipientName: target.username,
      ore,
      qty,
      allowOverflow,
    });

    if (!result.ok) {
      if (result.reason === "disabled") {
        return interaction.editReply("🔧 贈送功能尚未開放！");
      }
      if (result.reason === "no_ore") {
        return interaction.editReply("❌ 找不到這種礦石。");
      }
      if (result.reason === "daily_limit") {
        return interaction.editReply(
          `🎁 今天已經送出 ${result.usedToday}/${result.dailyMax} 次，達上限了！\n` +
            `明天再來：<t:${result.resetEpoch}:R>`
        );
      }
      if (result.reason === "insufficient") {
        return interaction.editReply(
          `🎒 你只有 **${result.have}** 顆 ${result.oreDef.name}，無法送出 ${qty} 顆。`
        );
      }
      if (result.reason === "recipient_full") {
        const confirm = buildOverflowConfirmView({
          title: "對方背包已滿",
          body:
            `${target} 的背包目前裝不下 **${qty}** 顆礦石。\n` +
            `繼續贈送的話，能塞背包的會直接收下，剩下的會折成系統收購價金幣存入對方錢包。`,
          used: result.used,
          cap: result.cap,
          confirmCustomId: `${GIFT_OVERFLOW_CONFIRM_PREFIX}${interaction.user.id}_${target.id}_${ore}_${qty}`,
          cancelCustomId: `${GIFT_OVERFLOW_CANCEL_PREFIX}${interaction.user.id}`,
          confirmLabel: "繼續贈送（溢出折金幣）",
        });
        return interaction.editReply({
          components: [confirm],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [] },
        });
      }
      return interaction.editReply("🔧 贈送失敗，請稍後再試。");
    }

    const def = result.oreDef;
    const lines = [
      `${target}`,
      `# 🎁 贈送成功`,
      `${interaction.user} 送給 ${target} **${def.emoji || "⛏️"} ${def.name} ×${result.qty}**！`,
    ];
    if (result.overflowQty > 0) {
      lines.push("");
      if (result.deliveredQty > 0) {
        lines.push(
          `🎒 對方背包只放得下 **${result.deliveredQty}** 顆，剩下 **${result.overflowQty}** 顆折成 **+${result.overflowCoins.toLocaleString()}** ${COIN_EMOJI} 存入對方錢包。`,
        );
      } else {
        lines.push(
          `🎒 對方背包已滿，全部折成 **+${result.overflowCoins.toLocaleString()}** ${COIN_EMOJI} 存入對方錢包。`,
        );
      }
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x1abc9c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n")),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 今日贈送次數：${result.usedToday}/${result.dailyMax}`,
        ),
      );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [target.id] },
    });
  } catch (error) {
    console.log(`[ERROR] /贈送:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 贈送失敗，請呼叫舒舒！").catch(() => {});
  }
}
