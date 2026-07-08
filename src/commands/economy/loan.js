require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, bank } = require("../../config");
const loanService = require("../../features/bank/loanService");
const creditService = require("../../features/bank/creditService");
const { errorContainer, fmt } = require("../../features/bank/bankView");

function replyError(interaction, opts) {
  return interaction.editReply({
    components: [errorContainer(opts)],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("貸款")
    .setDescription("向銀行借款，憑信用分決定額度；到期一次還本息 💳")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("借款")
        .setDescription("申請一筆貸款")
        .addIntegerOption((o) =>
          o.setName("金額").setDescription("借款金額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("還款")
        .setDescription("償還貸款（不填金額則全額還清）")
        .addIntegerOption((o) =>
          o.setName("金額").setDescription("償還金額（可部分還款）").setRequired(false).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName("查詢").setDescription("查看你目前的貸款"))
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) return interaction.editReply("🔧 金幣系統尚未啟動！");
      if (!bank?.loan?.enabled) return interaction.editReply("🔧 貸款功能尚未開放。");
      if (!client.loansCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 貸款資料庫尚未啟動，請聯絡舒舒！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const avatarHash = interaction.user.avatar;
      const member = interaction.member;
      const sub = interaction.options.getSubcommand();

      if (sub === "查詢") {
        const loans = await loanService.listActive(client, userId, guildId);
        if (!loans.length) {
          const limits = await creditService.getLimits(client, userId, guildId, member);
          return interaction.editReply(
            `📭 你目前沒有任何貸款。\n` +
              `・你的信用額度：**${limits.loanCap > 0 ? fmt(limits.loanCap) : "尚未開放（需提升信用分）"}**\n` +
              `-# 借款用 \`/貸款 借款\``,
          );
        }
        const lines = loans.map((l) => {
          const dueUnix = Math.floor(new Date(l.dueAt).getTime() / 1000);
          const outstanding = l.dueAmount - (l.paid || 0);
          const tag = l.status === "defaulted" ? "🔴 已違約" : new Date(l.dueAt) < new Date() ? "⚠️ 逾期中" : "⏳ 進行中";
          return (
            `\`${l.loanId}\` ・ ${tag}\n` +
            `　待還 **${fmt(outstanding)}**（本金 ${fmt(l.principal)}＋息 ${fmt(l.interest)}${l.overdueDays ? `＋逾期罰款` : ""}）\n` +
            `　到期：<t:${dueUnix}:R>`
          );
        });
        return interaction.editReply(
          `💳 **你的貸款**\n\n${lines.join("\n\n")}\n\n還款請用：\`/貸款 還款\``,
        );
      }

      if (sub === "借款") {
        const amount = interaction.options.getInteger("金額");
        const res = await loanService.take(client, {
          userId,
          guildId,
          member,
          username,
          avatarHash,
          amount,
        });
        if (!res.ok) {
          if (res.reason === "min") {
            return replyError(interaction, {
              title: "❌ 借款金額太小",
              detail: `貸款最少 **${fmt(res.minAmount)}**，你輸入了 ${fmt(amount)}。`,
            });
          }
          if (res.reason === "tier") {
            const nxt = res.next ? `\n下一級 ${res.next.emoji} ${res.next.name}（信用分 ${res.next.min}）起可貸款` : "";
            return replyError(interaction, {
              title: "🔒 尚未開放貸款",
              detail: `你目前的信用評等 **${res.tier.emoji} ${res.tier.name}** 還沒有貸款額度。${nxt}`,
              hint: "完成轉帳、定存到期可累積信用分（用 /銀行 查詢）",
            });
          }
          if (res.reason === "cap") {
            return replyError(interaction, {
              title: "❌ 超過信用額度",
              detail: `你的信用額度上限 **${fmt(res.loanCap)}**（${res.tier.emoji} ${res.tier.name}），無法借 ${fmt(amount)}。`,
              hint: "提升信用分可提高貸款額度",
            });
          }
          if (res.reason === "default_block") {
            return replyError(interaction, {
              title: "🔴 你有違約貸款未清償",
              detail: "請先還清違約貸款，才能申請新的貸款。",
              hint: "用 /貸款 還款 清償",
            });
          }
          if (res.reason === "active") {
            return replyError(interaction, {
              title: "❌ 已有貸款在身",
              detail: `同時最多 **${res.maxActive}** 筆貸款，你已有 ${res.active} 筆。`,
              hint: "先還清現有貸款再借（/貸款 還款）",
            });
          }
          return interaction.editReply("🔧 貸款申請失敗，請稍後再試。");
        }
        const dueUnix = Math.floor(new Date(res.dueAt).getTime() / 1000);
        return interaction.editReply(
          `✅ **貸款核准** \`${res.loanId}\`\n` +
            `・撥款：**${fmt(res.amount)}** credits（已入錢包）\n` +
            `・到期需還：**${fmt(res.dueAmount)}**（本金 ${fmt(res.amount)}＋利息 ${fmt(res.interest)}）\n` +
            `・到期日：<t:${dueUnix}:F>（<t:${dueUnix}:R>）\n` +
            `・錢包餘額：**${fmt(res.walletAfter)}**\n` +
            `-# 逾期每日加罰並扣信用分，準時還清可累積信用分`,
        );
      }

      if (sub === "還款") {
        const amount = interaction.options.getInteger("金額");
        const res = await loanService.repay(client, {
          userId,
          guildId,
          member,
          username,
          avatarHash,
          amount,
        });
        if (!res.ok) {
          if (res.reason === "notfound") {
            return interaction.editReply("📭 你目前沒有需要償還的貸款。");
          }
          if (res.reason === "wallet") {
            return replyError(interaction, {
              title: "💰 餘額不足",
              detail: `本次需要 **${fmt(res.outstanding)}**（可部分還款），錢包只有 ${fmt(res.wallet)}。`,
              hint: "可指定金額部分還款：/貸款 還款 金額:<數字>",
            });
          }
          return interaction.editReply("🔧 還款失敗，請稍後再試。");
        }
        if (res.cleared) {
          return interaction.editReply(
            `✅ 貸款 \`${res.loan.loanId}\` **已全部還清**！還款 ${fmt(res.pay)}，錢包剩 **${fmt(res.walletAfter)}**\n` +
              `-# 準時還清已累積你的信用分 📈`,
          );
        }
        return interaction.editReply(
          `✅ 已還款 **${fmt(res.pay)}**，貸款 \`${res.loan.loanId}\` 尚欠 **${fmt(res.remaining)}**\n` +
            `・錢包餘額：**${fmt(res.walletAfter)}**`,
        );
      }
    } catch (error) {
      console.log(`[ERROR] /貸款:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 貸款指令執行失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
