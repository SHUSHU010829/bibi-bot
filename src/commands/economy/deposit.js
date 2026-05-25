require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");

function getDepositCfg() {
  return coinSystem?.deposit || {};
}

function getTermRate(days) {
  const cfg = getDepositCfg();
  const term = (cfg.terms || []).find((t) => t.days === days);
  return term ? term.rate : null;
}

function buildTermChoices() {
  const cfg = getDepositCfg();
  return (cfg.terms || []).map((t) => ({
    name: `${t.days} 天（年化 ${(t.rate * (365 / t.days) * 100).toFixed(1)}%，到期 +${(t.rate * 100).toFixed(1)}%）`,
    value: t.days,
  }));
}

const TERM_CHOICES = buildTermChoices();

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("存款")
    .setDescription("把金幣鎖進定期存款，到期領回本金 + 利息 🏦")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("開戶")
        .setDescription("開一筆新的定期存款")
        .addIntegerOption((opt) =>
          opt
            .setName("金額")
            .setDescription("存款金額")
            .setRequired(true)
            .setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("天數")
            .setDescription("存款期間")
            .setRequired(true)
            .addChoices(...(TERM_CHOICES.length ? TERM_CHOICES : [{ name: "7 天", value: 7 }]))
        )
    )
    .addSubcommand((sub) =>
      sub.setName("查詢").setDescription("查詢你目前所有定期存款")
    )
    .addSubcommand((sub) =>
      sub
        .setName("提款")
        .setDescription("領回到期存款（未到期會被扣違約金）")
        .addStringOption((opt) =>
          opt
            .setName("存單")
            .setDescription("存單 ID（從 /存款 查詢取得）")
            .setRequired(true)
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const cfg = getDepositCfg();
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!cfg?.enabled) {
        return interaction.editReply("🔧 存款功能尚未開放。");
      }
      if (!client.coinDepositsCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 存款資料庫尚未啟動，請聯絡舒舒！");
      }

      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;

      if (sub === "開戶") {
        return openDeposit(client, interaction, { userId, guildId, username });
      }
      if (sub === "查詢") {
        return listDeposits(client, interaction, { userId, guildId });
      }
      if (sub === "提款") {
        return claimDeposit(client, interaction, { userId, guildId, username });
      }
    } catch (error) {
      console.log(`[ERROR] /存款:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 存款指令執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};

async function openDeposit(client, interaction, { userId, guildId, username }) {
  const cfg = getDepositCfg();
  const amount = interaction.options.getInteger("金額");
  const days = interaction.options.getInteger("天數");

  const minAmount = cfg.minAmount ?? 100;
  const maxAmount = cfg.maxAmount ?? 100000;
  if (amount < minAmount || amount > maxAmount) {
    return interaction.editReply(
      `❌ 單筆存款金額需在 **${minAmount.toLocaleString()}** ~ **${maxAmount.toLocaleString()}** 之間。`
    );
  }

  const rate = getTermRate(days);
  if (rate == null) {
    return interaction.editReply("❌ 無此存款期間。");
  }

  const maxActive = cfg.maxActivePerUser ?? 5;
  const activeCount = await client.coinDepositsCollection.countDocuments({
    userId,
    guildId,
    status: "active",
  });
  if (activeCount >= maxActive) {
    return interaction.editReply(
      `📈 同時最多 **${maxActive}** 筆存款，目前已有 ${activeCount} 筆。請先把到期的領回。`
    );
  }

  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = before?.totalCoins || 0;
  if (balance < amount) {
    return interaction.editReply(
      `💰 餘額不足！目前 **${balance.toLocaleString()}**，無法存入 ${amount.toLocaleString()}。`
    );
  }

  const depositId = `dep_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date();
  const maturesAt = new Date(now.getTime() + days * 86400_000);
  const interest = Math.floor(amount * rate);

  // 鎖款（從錢包扣出）
  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash: interaction.user.avatar,
    amount: -amount,
    source: "deposit_lock",
    member: interaction.member,
    meta: { depositId, days, rate, action: "open" },
  });
  if (!debit) {
    return interaction.editReply("🔧 存款扣款失敗，請稍後再試。");
  }

  await client.coinDepositsCollection.insertOne({
    depositId,
    userId,
    guildId,
    username,
    principal: amount,
    days,
    rate,
    interest,
    status: "active",
    createdAt: now,
    maturesAt,
  });

  const balanceAfter = debit.doc?.totalCoins ?? balance - amount;
  const maturesUnix = Math.floor(maturesAt.getTime() / 1000);

  return interaction.editReply(
    `🏦 **定期存款開戶成功**\n` +
      `・存單：\`${depositId}\`\n` +
      `・本金：**${amount.toLocaleString()}**\n` +
      `・期間：**${days} 天**（利率 ${(rate * 100).toFixed(2)}%）\n` +
      `・到期可領：**${(amount + interest).toLocaleString()}**（利息 +${interest.toLocaleString()}）\n` +
      `・到期時間：<t:${maturesUnix}:F>（<t:${maturesUnix}:R>）\n` +
      `・目前錢包餘額：${balanceAfter.toLocaleString()}`
  );
}

async function listDeposits(client, interaction, { userId, guildId }) {
  const docs = await client.coinDepositsCollection
    .find({ userId, guildId, status: "active" })
    .sort({ maturesAt: 1 })
    .limit(20)
    .toArray();

  if (!docs.length) {
    return interaction.editReply("📭 你目前沒有任何定期存款。試試 `/存款 開戶`！");
  }

  const now = Date.now();
  const lines = docs.map((d) => {
    const maturesUnix = Math.floor(new Date(d.maturesAt).getTime() / 1000);
    const matured = new Date(d.maturesAt).getTime() <= now;
    const status = matured ? "✅ 已到期" : "⏳ 鎖定中";
    return (
      `\`${d.depositId}\` ・ ${status}\n` +
      `　本金 ${d.principal.toLocaleString()} ・ ${d.days} 天 ・ 到期領 **${(d.principal + d.interest).toLocaleString()}**\n` +
      `　到期：<t:${maturesUnix}:R>`
    );
  });

  const totalPrincipal = docs.reduce((s, d) => s + d.principal, 0);
  const totalAtMaturity = docs.reduce((s, d) => s + d.principal + d.interest, 0);

  return interaction.editReply(
    `🏦 **目前存款（${docs.length} 筆）**\n\n${lines.join("\n\n")}\n\n` +
      `總本金：**${totalPrincipal.toLocaleString()}**　到期總額：**${totalAtMaturity.toLocaleString()}**\n` +
      `領回請用：\`/存款 提款 存單:<id>\``
  );
}

async function claimDeposit(client, interaction, { userId, guildId, username }) {
  const cfg = getDepositCfg();
  const depositId = interaction.options.getString("存單").trim();

  const doc = await client.coinDepositsCollection.findOne({
    depositId,
    userId,
    guildId,
  });
  if (!doc) {
    return interaction.editReply("❌ 找不到此存單。");
  }
  if (doc.status !== "active") {
    return interaction.editReply("❌ 此存單已經領過或已關閉。");
  }

  const now = new Date();
  const matured = new Date(doc.maturesAt).getTime() <= now.getTime();
  let payout;
  let kind;
  let penaltyAmount = 0;

  if (matured) {
    payout = doc.principal + doc.interest;
    kind = "matured";
  } else {
    const penaltyRate = cfg.earlyWithdrawPenaltyRate ?? 0.1;
    penaltyAmount = Math.floor(doc.principal * penaltyRate);
    payout = Math.max(0, doc.principal - penaltyAmount);
    kind = "early";
  }

  const claimResult = await client.coinDepositsCollection.findOneAndUpdate(
    { depositId, userId, guildId, status: "active" },
    {
      $set: {
        status: kind === "matured" ? "claimed" : "early_claimed",
        claimedAt: now,
        payout,
        penaltyAmount,
      },
    },
    { returnDocument: "after" }
  );
  const claimed = claimResult?.value || claimResult;
  if (!claimed) {
    return interaction.editReply("⚠️ 存單狀態已變更，請重新查詢。");
  }

  // 釋放金幣
  if (payout > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash: interaction.user.avatar,
      amount: payout,
      source: "deposit_release",
      member: interaction.member,
      meta: {
        depositId,
        principal: doc.principal,
        interest: kind === "matured" ? doc.interest : 0,
        penaltyAmount,
        early: kind === "early",
      },
    });
  }

  if (kind === "matured") {
    return interaction.editReply(
      `✅ 已領回到期存款 \`${depositId}\`：本金 ${doc.principal.toLocaleString()} + 利息 ${doc.interest.toLocaleString()} = **${payout.toLocaleString()}** credits`
    );
  }
  return interaction.editReply(
    `⚠️ 提早領回 \`${depositId}\`：扣違約金 ${penaltyAmount.toLocaleString()}，實領 **${payout.toLocaleString()}** credits（本金 ${doc.principal.toLocaleString()}）`
  );
}
