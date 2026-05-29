// /donation-admin — 抖內人工補發 / 查詢工具（dev only）
//
//   /donation-admin list                  列出未處理的 unmatched_donations
//   /donation-admin grant <trade_no> <user>  把一筆 unmatched 補發給指定使用者
//   /donation-admin info <trade_no>       查詢 donation_records / unmatched 紀錄

require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");
const { DateTime } = require("luxon");

const grantDonationPerks = require("../../features/donation/grantDonationPerks");
const { tierForAmount, coinsForAmount } = require("../../features/donation/code");

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("donation-admin")
    .setDescription("[DEV ONLY] 抖內管理工具")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("列出未處理的對應失敗紀錄"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("grant")
        .setDescription("把一筆 unmatched 補發給指定使用者")
        .addStringOption((o) =>
          o
            .setName("trade_no")
            .setDescription("平台交易編號（TradeNo）")
            .setRequired(true),
        )
        .addUserOption((o) =>
          o.setName("user").setDescription("要補發給誰").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("查一筆抖內紀錄")
        .addStringOption((o) =>
          o
            .setName("trade_no")
            .setDescription("平台交易編號")
            .setRequired(true),
        ),
    ),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "list") return runList(client, interaction);
    if (sub === "grant") return runGrant(client, interaction);
    if (sub === "info") return runInfo(client, interaction);
  },
};

async function runList(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const unmatched = client.unmatchedDonationsCollection;
  if (!unmatched) return interaction.editReply("DB 未連線");

  const docs = await unmatched
    .find({ resolved: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(15)
    .toArray();

  if (!docs.length) {
    return interaction.editReply("沒有待處理的對應失敗紀錄 ✨");
  }

  const lines = docs.map((d, i) => {
    const ts = DateTime.fromJSDate(d.createdAt)
      .setZone("Asia/Taipei")
      .toFormat("MM/dd HH:mm");
    return [
      `**${i + 1}.** \`${d.tradeNo}\` · NT$${d.amountNtd} · ${d.platform}`,
      `　└ 留言：${d.patronNote || "(空)"}`,
      `　└ donor：${d.patronName || "(匿名)"} · code 嘗試：${d.codeAttempt || "(無)"} · ${ts}`,
    ].join("\n");
  });

  await interaction.editReply(
    `**未對應抖內（最新 ${docs.length} 筆）**\n\n${lines.join("\n\n")}\n\n` +
      `用 \`/donation-admin grant <trade_no> <user>\` 補發。`,
  );
}

async function runGrant(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tradeNo = interaction.options.getString("trade_no");
  const user = interaction.options.getUser("user");
  const guildId = interaction.guildId;

  const records = client.donationRecordsCollection;
  const unmatched = client.unmatchedDonationsCollection;
  if (!records || !unmatched) return interaction.editReply("DB 未連線");

  // 1. 確認沒重複發
  const existing = await records.findOne({ tradeNo });
  if (existing) {
    return interaction.editReply(
      `這筆交易已經發放過了（user=<@${existing.userId}>）。`,
    );
  }

  // 2. 找 unmatched 紀錄拿金額 / 平台 / patron 資訊
  const unmatchedDoc = await unmatched.findOne({ tradeNo });
  if (!unmatchedDoc) {
    return interaction.editReply(
      `找不到 unmatched 紀錄 \`${tradeNo}\`。確認交易編號對嗎？`,
    );
  }
  if (unmatchedDoc.resolved) {
    return interaction.editReply("這筆 unmatched 紀錄已經標記為已處理。");
  }

  const tier = tierForAmount(unmatchedDoc.amountNtd);
  const record = {
    tradeNo,
    sessionId: null, // 補發沒有 session
    userId: user.id,
    guildId,
    amountNtd: unmatchedDoc.amountNtd,
    tierId: tier?.id || null,
    platform: unmatchedDoc.platform,
    patronName: unmatchedDoc.patronName || "",
    patronNote: unmatchedDoc.patronNote || "",
    perks: tier ? summaryFromTier(tier, unmatchedDoc.amountNtd) : null,
    grantedAt: new Date(),
    coinsGranted: false,
    roleGranted: false,
    itemsGranted: false,
    buffGranted: false,
    themeGranted: false,
    titleGranted: false,
    announced: false,
    dmSent: false,
    manualGrantBy: interaction.user.id,
  };

  // 3. insert record（unique tradeNo 防 race）
  try {
    await records.insertOne(record);
  } catch (err) {
    if (err && err.code === 11000) {
      return interaction.editReply("這筆交易剛剛被別處發放了，請重新查詢。");
    }
    throw err;
  }

  // 4. 真實發放
  let updates = {};
  try {
    updates = await grantDonationPerks(client, { record, tier });
  } catch (err) {
    console.log(`[ERROR] manual grant perks: ${err.message}`.red);
  }

  if (Object.keys(updates).length > 0) {
    await records.updateOne(
      { tradeNo },
      { $set: { ...updates, updatedAt: new Date() } },
    );
  }

  // 5. 標 unmatched 為已處理
  await unmatched.updateOne(
    { tradeNo },
    {
      $set: {
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: interaction.user.id,
        resolvedTo: user.id,
      },
    },
  );

  const grantSummary = Object.entries(updates)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .join(", ");

  await interaction.editReply(
    `✅ 已補發 NT$${unmatchedDoc.amountNtd}（${tier?.name || "未達門檻"}）給 <@${user.id}>。\n` +
      `成功項目：${grantSummary || "(無)"}\n` +
      `tradeNo \`${tradeNo}\``,
  );
}

async function runInfo(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tradeNo = interaction.options.getString("trade_no");
  const records = client.donationRecordsCollection;
  const unmatched = client.unmatchedDonationsCollection;

  const record = await records?.findOne({ tradeNo });
  if (record) {
    const tz = "Asia/Taipei";
    const grantedAt = DateTime.fromJSDate(record.grantedAt).setZone(tz).toFormat("yyyy/MM/dd HH:mm:ss");
    const tier = record.tierId
      ? (require("../../config").donation?.tiers || []).find((t) => t.id === record.tierId)
      : null;
    // 欄位名對齊 grantDonationPerks 真實寫入：dmSent / announced 是無 "Granted" 尾巴的特例
    // not-applicable（這個 tier 本來就沒這項 perk）顯示 — 而不是 ❌
    const FLAGS = [
      { key: "coins",     field: "coinsGranted",  applies: () => !!tier?.coins },
      { key: "role",      field: "roleGranted",   applies: () => !!tier?.role },
      { key: "items",     field: "itemsGranted",  applies: () => tier?.items && Object.values(tier.items).some(Boolean) },
      { key: "buff",      field: "buffGranted",   applies: () => tier?.luckBonus > 0 },
      { key: "theme",     field: "themeGranted",  applies: () => !!tier?.themeId },
      { key: "title",     field: "titleGranted",  applies: () => !!tier?.titleId },
      { key: "dm",        field: "dmSent",        applies: () => true },
      { key: "announced", field: "announced",     applies: () => true },
    ];
    const flags = FLAGS.map((f) => {
      if (!f.applies()) return `— ${f.key}`;
      return `${record[f.field] ? "✅" : "❌"} ${f.key}`;
    }).join("　");
    return interaction.editReply(
      [
        `**Donation Record \`${tradeNo}\`**`,
        `User：<@${record.userId}>　Guild：${record.guildId}`,
        `Amount：NT$${record.amountNtd}　Platform：${record.platform}　Tier：${record.tierId || "(未達門檻)"}`,
        `granted at ${grantedAt}` + (record.manualGrantBy ? `（人工補發 by <@${record.manualGrantBy}>）` : ""),
        `留言：${record.patronNote || "(空)"}`,
        ``,
        flags,
      ].join("\n"),
    );
  }

  const u = await unmatched?.findOne({ tradeNo });
  if (u) {
    return interaction.editReply(
      [
        `**Unmatched \`${tradeNo}\`** ${u.resolved ? "（已處理）" : "（待處理）"}`,
        `Amount：NT$${u.amountNtd}　Platform：${u.platform}`,
        `Patron：${u.patronName || "(匿名)"}　留言：${u.patronNote || "(空)"}`,
        `code 嘗試：${u.codeAttempt || "(無)"}`,
        u.resolvedTo ? `補發給：<@${u.resolvedTo}>` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return interaction.editReply(`找不到 trade_no \`${tradeNo}\` 對應紀錄。`);
}

function summaryFromTier(tier, amountNtd) {
  const list = [];
  const coins = amountNtd != null ? coinsForAmount(amountNtd) : tier.coins;
  if (coins) list.push(`${coins.toLocaleString()} 金幣`);
  return list;
}
