require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const pendingTransferService = require("../../features/economy/pendingTransferService");
const { buildOfferContainer } = require("../../features/economy/pendingTransferView");
const { listAllChoices, parseChoice } = require("../../features/barter/itemCatalog");

module.exports = {
  channelBuckets: ["mining", "marketplace"],

  data: new SlashCommandBuilder()
    .setName("贈送")
    .setDescription("把背包裡的礦石 / 作物 / 魚送給其他玩家 🎁（對方需在 24 小時內收下，免手續費）")
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
    try {
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

      const recipientMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      const result = await pendingTransferService.createItemOffer(client, {
        giverMember: interaction.member,
        recipientUser: target,
        recipientMember,
        type: choice.type,
        key: choice.key,
        qty,
      });

      if (!result.ok) return interaction.editReply(renderError(result, qty));

      const { offer, itemDef, usedToday, dailyMax } = result;
      await interaction.editReply({
        components: [buildOfferContainer(offer, { itemDef })],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: [offer.recipient_id] },
      });
      const reply = await interaction.fetchReply().catch(() => null);
      if (reply) {
        await pendingTransferService.setOfferMessage(client, offer.offer_id, reply.channelId, reply.id);
      }

      await interaction
        .followUp({
          content:
            `🎁 已預扣 **${itemDef.emoji} ${itemDef.name} ×${qty}**，等待 <@${offer.recipient_id}> 收下。\n` +
            `・今日贈送次數：${usedToday}/${dailyMax}\n` +
            `・對方 24 小時內未回覆、或按下拒收，物品與次數都會退還；你也可以按「寄件方取消」立即取回。`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /贈送:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 贈送失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

function buildErrorContainer(title, body, hint) {
  const lines = [`# ${title}`, body];
  if (hint) lines.push("", `-# ${hint}`);
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
}

function renderError(result, qty) {
  if (result.reason === "disabled") {
    return {
      components: [buildErrorContainer("🔧 贈送功能尚未開放", "請稍後再試或聯絡管理員。")],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  if (result.reason === "no_item") {
    return {
      components: [buildErrorContainer("❌ 找不到這個物品", "請從清單重新選擇。")],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  if (result.reason === "bad_qty") {
    return {
      components: [buildErrorContainer("❌ 數量不正確", "請輸入正整數的數量。")],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  if (result.reason === "daily_limit") {
    return {
      components: [
        buildErrorContainer(
          "🎁 今日贈送次數已用完",
          `今天已經送出 **${result.usedToday}/${result.dailyMax}** 次。`,
          `明天再來：<t:${result.resetEpoch}:R>`
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  if (result.reason === "insufficient") {
    const def = result.itemDef;
    return {
      components: [
        buildErrorContainer(
          "🎒 數量不足",
          `你只有 **${result.have}** 個 ${def.emoji} ${def.name}，無法送出 ${qty} 個。`,
          "用 `/背包`、`/菜園`、`/魚袋` 確認庫存。"
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  if (result.reason === "too_many_pending") {
    return {
      components: [
        buildErrorContainer(
          "📮 待收贈送太多",
          `你目前有太多筆「等待對方收下」的贈送（上限 **${result.max}** 筆）。`,
          "等對方收下 / 拒收，或到原訊息按「寄件方取消」取回後再送。"
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  return {
    components: [buildErrorContainer("🔧 贈送失敗", "請稍後再試或聯絡管理員。")],
    flags: MessageFlags.IsComponentsV2,
  };
}
