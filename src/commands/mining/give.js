require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const giftService = require("../../features/mining/giftService");
const { buildOverflowConfirmView } = require("../../features/mining/overflowConfirm");
const { listAllChoices, parseChoice } = require("../../features/barter/itemCatalog");
const { COIN_EMOJI } = require("../../constants/coin");

const GIFT_OVERFLOW_CONFIRM_PREFIX = "gift_overflow_confirm_";
const GIFT_OVERFLOW_CANCEL_PREFIX = "gift_overflow_cancel_";

module.exports = {
  channelBuckets: ["mining", "marketplace"],

  data: new SlashCommandBuilder()
    .setName("贈送")
    .setDescription("把背包裡的礦石 / 作物 / 魚送給其他玩家 🎁（每日次數有限、免手續費）")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("收禮的玩家").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("物品")
        .setDescription("要送的物品")
        .setRequired(true)
        .addChoices(...listAllChoices())
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
    const itemValue = interaction.options.getString("物品");
    const qty = interaction.options.getInteger("數量");

    if (target.bot) {
      return interaction.editReply({
        components: [buildErrorContainer("❌ 不能送禮給 bot", "請選擇真人玩家作為收禮對象。")],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    if (target.id === interaction.user.id) {
      return interaction.editReply({
        components: [buildErrorContainer("❌ 不能送給自己", "想換禮物的話請找其他玩家。")],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    const choice = parseChoice(itemValue);
    if (!choice) {
      return interaction.editReply({
        components: [buildErrorContainer("❌ 找不到這個物品", "請從清單重新選擇。")],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    return executeGift(client, interaction, {
      target,
      type: choice.type,
      key: choice.key,
      qty,
      allowOverflow: false,
    });
  },

  executeGift,
  GIFT_OVERFLOW_CONFIRM_PREFIX,
  GIFT_OVERFLOW_CANCEL_PREFIX,
};

function buildErrorContainer(title, body, hint) {
  const lines = [`# ${title}`, body];
  if (hint) lines.push("", `-# ${hint}`);
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
}

async function executeGift(client, interaction, { target, type, key, qty, allowOverflow }) {
  try {
    const result = await giftService.giveItem(client, {
      giverId: interaction.user.id,
      guildId: interaction.guildId,
      recipientId: target.id,
      recipientName: target.username,
      type,
      key,
      qty,
      allowOverflow,
    });

    if (!result.ok) {
      if (result.reason === "disabled") {
        return interaction.editReply({
          components: [buildErrorContainer("🔧 贈送功能尚未開放", "請稍後再試或聯絡管理員。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "no_item") {
        return interaction.editReply({
          components: [buildErrorContainer("❌ 找不到這個物品", "請從清單重新選擇。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "daily_limit") {
        return interaction.editReply({
          components: [
            buildErrorContainer(
              "🎁 今日贈送次數已用完",
              `今天已經送出 **${result.usedToday}/${result.dailyMax}** 次。`,
              `明天再來：<t:${result.resetEpoch}:R>`,
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "insufficient") {
        const def = result.itemDef;
        return interaction.editReply({
          components: [
            buildErrorContainer(
              "🎒 數量不足",
              `你只有 **${result.have}** 個 ${def.emoji} ${def.name}，無法送出 ${qty} 個。`,
              `用 \`/背包\`、\`/菜園\`、\`/魚袋\` 確認庫存。`,
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "recipient_full") {
        const confirm = buildOverflowConfirmView({
          title: "對方背包已滿",
          body:
            `${target} 的背包目前裝不下 **${qty}** 顆礦石。\n` +
            `繼續贈送的話，能塞背包的會直接收下，剩下的會折成系統收購價金幣存入對方錢包。`,
          used: result.used,
          cap: result.cap,
          confirmCustomId: `${GIFT_OVERFLOW_CONFIRM_PREFIX}${interaction.user.id}_${target.id}_${type}_${key}_${qty}`,
          cancelCustomId: `${GIFT_OVERFLOW_CANCEL_PREFIX}${interaction.user.id}`,
          confirmLabel: "繼續贈送（溢出折金幣）",
        });
        return interaction.editReply({
          components: [confirm],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [] },
        });
      }
      return interaction.editReply({
        components: [buildErrorContainer("🔧 贈送失敗", "請稍後再試或聯絡管理員。")],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    const def = result.itemDef;
    const lines = [
      `${target}`,
      `# 🎁 贈送成功`,
      `${interaction.user} 送給 ${target} **${def.emoji} ${def.name} ×${result.qty}**！`,
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
