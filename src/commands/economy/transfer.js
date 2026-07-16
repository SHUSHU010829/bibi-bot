require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { errorContainer } = require("../../features/bank/bankView");
const pendingTransferService = require("../../features/economy/pendingTransferService");
const { buildOfferContainer } = require("../../features/economy/pendingTransferView");

function errPayload(opts) {
  return {
    components: [errorContainer(opts)],
    flags: MessageFlags.IsComponentsV2,
  };
}

module.exports = {
  channelBuckets: ["general", "marketplace"],
  data: new SlashCommandBuilder()
    .setName("轉帳")
    .setDescription("把金幣轉給其他玩家 💸")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) => opt.setName("對象").setDescription("收款人").setRequired(true))
    .addIntegerOption((opt) =>
      opt
        .setName("金額")
        .setDescription("轉帳金額（手續費另計：>1000 收 3%，否則 1%）")
        .setRequired(true)
        .setMinValue(1),
    )
    .addStringOption((opt) =>
      opt.setName("備註").setDescription("給對方的備註（選填）").setRequired(false).setMaxLength(80),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const target = interaction.options.getUser("對象");
      const amount = interaction.options.getInteger("金額");
      const note = interaction.options.getString("備註") || "";

      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      const res = await pendingTransferService.createCoinOffer(client, {
        senderMember: interaction.member,
        targetMember,
        amount,
        note,
      });

      if (!res.ok) return interaction.editReply(renderError(res));

      const { offer, held } = res;
      await interaction.editReply({
        components: [buildOfferContainer(offer)],
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
            `💸 已預扣 **${(held.amount + held.fee).toLocaleString()}** ${MONEY_EMOJI}（本金 ${held.amount.toLocaleString()} + 手續費 ${held.fee.toLocaleString()}），等待 <@${offer.recipient_id}> 收下。\n` +
            `・你的餘額：**${held.senderAfter.toLocaleString()}**\n` +
            `・對方 24 小時內未回覆、或按下拒收，會全額退回給你；你也可以按「寄件方取消」立即取回。`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /轉帳:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 轉帳失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

function renderError(res) {
  switch (res.reason) {
    case "disabled_system":
      return "🔧 金幣系統尚未啟動！";
    case "disabled_feature":
      return "🔧 玩家轉帳功能尚未開放。";
    case "no_db":
      return "🔧 金幣系統尚未啟動，請聯絡舒舒！";
    case "tenure_sender":
      return res.message;
    case "no_member":
      return "❌ 找不到該成員，可能已退出伺服器。";
    case "bot":
      return "❌ 不能轉給 bot 啦。";
    case "self":
      return "❌ 不能轉給自己。";
    case "too_many_pending":
      return errPayload({
        title: "📮 待收轉帳太多",
        detail: `你目前有太多筆「等待對方收下」的轉帳（上限 **${res.max}** 筆）。`,
        hint: "等對方收下 / 拒收，或到原訊息按「寄件方取消」取回後再送。",
      });
    case "range": {
      const tierLine = res.limits ? `\n-# 你的信用評等：${res.limits.tier.emoji} ${res.limits.tier.name}（信用分 ${res.limits.score}）` : "";
      return errPayload({
        title: "❌ 超過轉帳上限",
        detail: `單筆金額需在 **${res.min.toLocaleString()}** ~ **${res.max.toLocaleString()}** 之間，你輸入了 **${res.amount.toLocaleString()}**。${tierLine}`,
        hint: "提升信用分可解鎖更高的轉帳上限（用 /銀行 信用 查詢）",
      });
    }
    case "balance":
      return `${MONEY_EMOJI} 餘額不足！本次需要 **${res.need.toLocaleString()}**（金額 ${res.amount.toLocaleString()} + 手續費 ${res.fee.toLocaleString()}），目前 ${res.balance.toLocaleString()}。`;
    case "count":
      return errPayload({
        title: "🔁 今日轉帳次數已用完",
        detail: `今日已轉帳 **${res.countToday} / ${res.dailyCount}** 次。` + (res.limits ? `\n信用評等：${res.limits.tier.emoji} ${res.limits.tier.name}（信用分 ${res.limits.score}）` : ""),
        hint: "次數每日 00:00 重置；提升信用分可增加每日次數（用 /銀行 信用）",
      });
    case "cap": {
      const remain = Math.max(0, res.dailyCap - res.usedToday);
      return errPayload({
        title: "📈 今日轉帳額度已達上限",
        detail: `今日已轉 **${res.usedToday.toLocaleString()}** / ${res.dailyCap.toLocaleString()}，剩 **${remain.toLocaleString()}**。`,
        hint: "額度每日 00:00 重置；提升信用分可提高每日額度（防洗幣機制）",
      });
    }
    case "tenure_recipient": {
      const tail = res.eligibleEpoch ? `\n可收款時間：<t:${res.eligibleEpoch}:R>（<t:${res.eligibleEpoch}:f>）` : "";
      return `❌ 對方加入伺服器尚未滿 **${res.minDays}** 天，無法收款（防小帳洗幣）。${tail}`;
    }
    case "debit":
      return "🔧 轉帳扣款失敗，請稍後再試。";
    case "fee_debit":
      return "🔧 轉帳手續費扣款失敗，已退本金。請稍後再試。";
    case "credit_fail":
      return "🔧 對方入帳失敗，已退款。請稍後再試。";
    default:
      return "🔧 轉帳失敗，請稍後再試。";
  }
}
