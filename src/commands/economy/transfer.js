require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { DateTime } = require("luxon");

const { coinSystem, bank } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { checkServerTenure } = require("../../features/economy/eligibility");
const creditService = require("../../features/bank/creditService");
const { errorContainer } = require("../../features/bank/bankView");
const {
  fireImmediateCheck: fireSuspiciousTransferCheck,
} = require("../../features/economy/suspiciousTransferDetector");

function computeTransferFee(amount, cfg, discount = 0) {
  const baseRate = cfg?.feeRate ?? 0.02;
  const highRate = cfg?.feeRateHigh ?? 0.05;
  const threshold = cfg?.highFeeThreshold ?? 1000;
  const rate = amount > threshold ? highRate : baseRate;
  const raw = Math.floor(amount * rate);
  const fee = Math.max(0, Math.floor(raw * (1 - discount)));
  return { fee, rate };
}

async function getTodayTransferCount(client, userId, guildId) {
  if (!client.coinTransactionsCollection) return 0;
  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();
  return client.coinTransactionsCollection.countDocuments({
    userId,
    guildId,
    source: "transfer_out",
    date: today,
  });
}

async function getTodayTransferOut(client, userId, guildId) {
  if (!client.coinTransactionsCollection) return 0;
  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();
  // 只統計本金（meta.amount），不含手續費；transfer_out 的 amount 為負且含手續費。
  const agg = await client.coinTransactionsCollection
    .aggregate([
      {
        $match: {
          userId,
          guildId,
          source: "transfer_out",
          date: today,
        },
      },
      { $group: { _id: null, total: { $sum: "$meta.amount" } } },
    ])
    .toArray();
  return agg[0]?.total || 0;
}

module.exports = {
  channelBuckets: ["general", "marketplace"],
  data: new SlashCommandBuilder()
    .setName("轉帳")
    .setDescription("把金幣轉給其他玩家 💸")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName("對象")
        .setDescription("收款人")
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("金額")
        .setDescription("轉帳金額（手續費另計：>1000 額外 5%，否則 2%）")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption((opt) =>
      opt
        .setName("備註")
        .setDescription("給對方的備註（選填）")
        .setRequired(false)
        .setMaxLength(80)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const cfg = coinSystem?.transfer;
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!cfg?.enabled) {
        return interaction.editReply("🔧 玩家轉帳功能尚未開放。");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const tenure = checkServerTenure(interaction.member);
      if (!tenure.ok) {
        return interaction.editReply(tenure.message);
      }

      const target = interaction.options.getUser("對象");
      const amount = interaction.options.getInteger("金額");
      const note = (interaction.options.getString("備註") || "").trim();

      if (target.bot) {
        return interaction.editReply("❌ 不能轉給 bot 啦。");
      }
      if (target.id === interaction.user.id) {
        return interaction.editReply("❌ 不能轉給自己。");
      }

      const senderId = interaction.user.id;
      const guildId = interaction.guildId;
      const senderName = interaction.member?.displayName || interaction.user.username;

      const creditEnabled = bank?.credit?.enabled;
      const limits = creditEnabled
        ? await creditService.getLimits(client, senderId, guildId, interaction.member)
        : null;
      const maxAmount = limits ? limits.transferMax : cfg.maxAmount ?? 20000;
      const dailyCap = limits ? limits.dailyCap : cfg.dailyCapPerSender ?? 20000;
      const dailyCount = limits ? limits.dailyCount : cfg.dailyCountFallback ?? 5;
      const feeDiscount = limits ? limits.feeDiscount : 0;

      const minAmount = cfg.minAmount ?? 10;
      if (amount < minAmount || amount > maxAmount) {
        const tierLine = limits
          ? `\n-# 你的信用評等：${limits.tier.emoji} ${limits.tier.name}（信用分 ${limits.score}）`
          : "";
        return interaction.editReply({
          components: [
            errorContainer({
              title: "❌ 超過轉帳上限",
              detail:
                `單筆金額需在 **${minAmount.toLocaleString()}** ~ **${maxAmount.toLocaleString()}** 之間，你輸入了 **${amount.toLocaleString()}**。` +
                tierLine,
              hint: "提升信用分可解鎖更高的轉帳上限（用 /銀行 查詢）",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const before = await client.userCoinsCollection.findOne({
        userId: senderId,
        guildId,
      });
      const balance = before?.totalCoins || 0;
      const { fee, rate: feeRate } = computeTransferFee(amount, cfg, feeDiscount);
      const totalDeduct = amount + fee;

      if (balance < totalDeduct) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！本次需要 **${totalDeduct.toLocaleString()}**（金額 ${amount.toLocaleString()} + 手續費 ${fee.toLocaleString()}），目前 ${balance.toLocaleString()}。`
        );
      }

      const countToday = await getTodayTransferCount(client, senderId, guildId);
      if (countToday >= dailyCount) {
        return interaction.editReply({
          components: [
            errorContainer({
              title: "🔁 今日轉帳次數已用完",
              detail:
                `今日已轉帳 **${countToday} / ${dailyCount}** 次。` +
                (limits ? `\n信用評等：${limits.tier.emoji} ${limits.tier.name}（信用分 ${limits.score}）` : ""),
              hint: "次數每日 00:00 重置；提升信用分可增加每日次數（用 /銀行 查詢）",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const usedToday = await getTodayTransferOut(client, senderId, guildId);
      if (usedToday + amount > dailyCap) {
        const remain = Math.max(0, dailyCap - usedToday);
        return interaction.editReply({
          components: [
            errorContainer({
              title: "📈 今日轉帳額度已達上限",
              detail: `今日已轉 **${usedToday.toLocaleString()}** / ${dailyCap.toLocaleString()}，剩 **${remain.toLocaleString()}**。`,
              hint: "額度每日 00:00 重置；提升信用分可提高每日額度（防洗幣機制）",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const targetMember = await interaction.guild.members
        .fetch(target.id)
        .catch(() => null);
      if (!targetMember) {
        return interaction.editReply("❌ 找不到該成員，可能已退出伺服器。");
      }

      const recipientTenure = checkServerTenure(targetMember);
      if (!recipientTenure.ok) {
        const tail = recipientTenure.eligibleEpoch
          ? `\n可收款時間：<t:${recipientTenure.eligibleEpoch}:R>（<t:${recipientTenure.eligibleEpoch}:f>）`
          : "";
        return interaction.editReply(
          `❌ 對方加入伺服器尚未滿 **${recipientTenure.minDays}** 天，無法收款（防小帳洗幣）。${tail}`
        );
      }

      const transferId = `xfer-${Date.now()}-${senderId}-${target.id}`;

      // 扣本金（不含手續費，保持 transfer_in / transfer_out 對稱可審計）
      const debit = await grantCoins(client, {
        userId: senderId,
        guildId,
        username: senderName,
        avatarHash: interaction.user.avatar,
        amount: -amount,
        source: "transfer_out",
        member: interaction.member,
        meta: {
          transferId,
          counterparty: target.id,
          amount,
          fee,
          note: note || null,
        },
      });
      if (!debit) {
        return interaction.editReply("🔧 轉帳扣款失敗，請稍後再試。");
      }

      // 扣手續費（獨立 sink，方便活動量統計顯示）
      let feeDebit = null;
      if (fee > 0) {
        feeDebit = await grantCoins(client, {
          userId: senderId,
          guildId,
          username: senderName,
          avatarHash: interaction.user.avatar,
          amount: -fee,
          source: "transfer_fee",
          member: interaction.member,
          meta: { transferId, counterparty: target.id, amount, feeRate },
        });
        if (!feeDebit) {
          await grantCoins(client, {
            userId: senderId,
            guildId,
            username: senderName,
            amount,
            source: "admin",
            meta: { reason: `transfer fee debit failed: ${transferId}`, operatorId: "system" },
          }).catch(() => {});
          return interaction.editReply("🔧 轉帳手續費扣款失敗，已退本金。請稍後再試。");
        }
      }

      // 入款
      const credit = await grantCoins(client, {
        userId: target.id,
        guildId,
        username: target.username,
        avatarHash: target.avatar,
        amount,
        source: "transfer_in",
        member: targetMember,
        meta: {
          transferId,
          counterparty: senderId,
          amount,
          note: note || null,
        },
      });
      if (!credit) {
        // 回滾本金 + 手續費
        await grantCoins(client, {
          userId: senderId,
          guildId,
          username: senderName,
          amount: totalDeduct,
          source: "admin",
          meta: {
            reason: `transfer rollback: ${transferId}`,
            operatorId: "system",
          },
        }).catch(() => {});
        return interaction.editReply("🔧 對方入帳失敗，已退款。請稍後再試。");
      }

      const senderAfter =
        feeDebit?.doc?.totalCoins ?? debit.doc?.totalCoins ?? balance - totalDeduct;
      const noteLine = note ? `\n📝 備註：${note}` : "";

      // 非阻塞：偵測雙向轉帳異常，超過閾值寫入告警頻道
      fireSuspiciousTransferCheck(client, {
        guildId,
        senderId,
        recipientId: target.id,
      });

      // 完成正常轉帳 → 累積信用分（非阻塞）
      if (creditEnabled) {
        creditService
          .award(client, senderId, guildId, "transfer_complete", { member: interaction.member })
          .catch(() => {});
      }

      const discountLine =
        feeDiscount > 0 ? `（已折 ${Math.round(feeDiscount * 100)}%）` : "";
      await interaction.editReply(
        `✅ 已轉帳 <@${target.id}> **${amount.toLocaleString()}** credits（手續費 ${fee.toLocaleString()}・${(feeRate * 100).toFixed(0)}%${discountLine}）\n` +
          `・你的餘額：**${senderAfter.toLocaleString()}**\n` +
          `・今日累計轉出：${(usedToday + amount).toLocaleString()} / ${dailyCap.toLocaleString()}\n` +
          `・今日轉帳次數：${countToday + 1} / ${dailyCount}` +
          noteLine
      );
    } catch (error) {
      console.log(`[ERROR] /轉帳:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 轉帳失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
