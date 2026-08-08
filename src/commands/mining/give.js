require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const pendingTransferService = require("../../features/economy/pendingTransferService");
const { buildOfferContainer } = require("../../features/economy/pendingTransferView");
const itemRegistry = require("../../features/economy/itemRegistry");
const giftService = require("../../features/mining/giftService");
const { buildChoices, respondChoices, resolveChoice } = require("../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../utils/choiceErrorContainer");

// 選單顯示「｜持有 N」，玩家貼整行回來時要剝掉才對得上品名。
const OWNED_TAIL = [/[|｜]?\s*持有\s*[\d,]+/g];

// 選單／錯誤訊息只列可送的材料；解析用完整清單（見 run()）。
function giftableChoices() {
  return buildChoices(giftService.listGiftable(), (r) => ({ name: r.name, value: r.value }));
}

function allItemChoices() {
  return buildChoices(itemRegistry.listAll(), (r) => ({ name: r.name, value: r.value }));
}

function ownedGiftableChoices(profile) {
  const giftable = new Set(giftService.listGiftable().map((r) => r.value));
  return buildChoices(
    itemRegistry.listOwned(profile).filter((r) => giftable.has(r.value)),
    (r) => ({ name: `${r.name}｜持有 ${r.qty}`, value: r.value }),
  );
}

module.exports = {
  channelBuckets: ["mining", "marketplace"],

  data: new SlashCommandBuilder()
    .setName("贈送")
    .setDescription("把背包裡的材料送給其他玩家 🎁（對方需在 24 小時內收下，免手續費）")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("收禮的玩家").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("物品")
        .setDescription("要送的材料：礦石／作物／魚／種子／肥料／合成素材")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("數量")
        .setDescription("要送的數量")
        .setRequired(true)
        .setMinValue(1)
    ),

  // 下拉只列「自己有、且送得出去」的（附持有量），手上沒材料時退回完整材料清單，
  // 讓玩家至少看得到有哪些送得出去。
  autocomplete: async (client, interaction) => {
    let options = [];
    if (client.miningProfilesCollection) {
      const profile = await client.miningProfilesCollection
        .findOne({ userId: interaction.user.id, guildId: interaction.guildId })
        .catch(() => null);
      if (profile) options = ownedGiftableChoices(profile);
    }
    if (options.length === 0) options = giftableChoices();
    await respondChoices(interaction, options, interaction.options.getFocused(), {
      strip: OWNED_TAIL,
    });
  },

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const target = interaction.options.getUser("對象");
      const itemInput = interaction.options.getString("物品");
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

      // 解析用完整清單（含不能送的道具）：沒持有 / 不能送的要講清楚是哪一種，
      // 不能通通回「找不到這個物品」。錯誤訊息裡列出來的則只有送得出去的材料。
      const picked = resolveChoice(itemInput, allItemChoices(), { strip: OWNED_TAIL });
      if (!picked.ok) {
        return interaction.editReply({
          components: [
            buildChoiceErrorContainer(
              { ...picked, options: giftableChoices() },
              {
                what: "材料",
                hint: "-# 等下拉選單跳出來再點選最保險；用 `/背包` 看看自己有什麼可以送。",
              }
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const recipientMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      const result = await pendingTransferService.createItemOffer(client, {
        giverMember: interaction.member,
        recipientUser: target,
        recipientMember,
        value: picked.value,
        qty,
      });

      if (!result.ok) return interaction.editReply(renderError(result, qty));

      const { offer, label, usedToday, dailyMax } = result;
      const notify = await pendingTransferService.notifyRecipient(client, offer);
      const deliveredLine = await deliverOrFallback(client, interaction, offer, notify);

      return interaction.editReply({
        content:
          `🎁 已預扣 **${label} ×${qty}**，等待 <@${offer.recipient_id}> 收下。\n` +
          `${deliveredLine}\n` +
          `・今日贈送次數：${usedToday}/${dailyMax}\n` +
          `・對方 24 小時內未回覆、或按下拒收，物品與次數都會退還。用 \`/待收\` 查看狀態或取消。`,
        allowedMentions: { users: [] },
      });
    } catch (error) {
      console.log(`[ERROR] /贈送:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 贈送失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

// DM 成功 → 提示已私訊；DM 失敗 → 退回頻道公開發訊息（含寄件方取消鈕）並提示。
async function deliverOrFallback(client, interaction, offer, notify) {
  if (notify.via === "dm") return `・已私訊通知 <@${offer.recipient_id}>。`;
  try {
    const msg = await interaction.channel.send({
      components: [buildOfferContainer(offer, { includeCancel: true })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [offer.recipient_id] },
    });
    await pendingTransferService.setOfferMessage(client, offer.offer_id, msg.channelId, msg.id, false);
    return `・對方關閉私訊，已改在此頻道通知 <@${offer.recipient_id}>。`;
  } catch (_) {
    return `・⚠️ 無法私訊也無法在頻道通知對方，請用 \`/待收\` 取消取回。`;
  }
}

function buildErrorContainer(title, body, hint) {
  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return container;
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
      components: [
        buildErrorContainer("❌ 找不到這個物品", "這個物品可能已經下架了。", "請從下拉選單重新選擇。"),
      ],
      flags: MessageFlags.IsComponentsV2,
    };
  }
  if (result.reason === "not_giftable") {
    return {
      components: [
        buildErrorContainer(
          "🚫 這個物品不能贈送",
          `**${result.label}** 屬於道具類，只有材料送得出去。`,
          "可送的是：礦石、作物、魚、種子、肥料、合成素材。"
        ),
      ],
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
    return {
      components: [
        result.have > 0
          ? buildErrorContainer(
              "🎒 數量不足",
              `**${result.label}** 需要 ${qty} 個，你只有 **${result.have}** 個。`,
              "用 `/背包` 看看自己有什麼可以送。"
            )
          : buildErrorContainer(
              "🎒 你還沒有這個物品",
              `**${result.label}** 你目前一個也沒有，送不出去。`,
              "用 `/背包` 看看自己有什麼可以送；下拉選單只會列出你手上有的物品。"
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
