require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const logger = require("../../utils/logger");
const { trackError } = require("../../utils/errorTracker");
const grantCoins = require("../economy/grantCoins");
const { donation } = require("../../config");

const ITEM_NAMES = {
  luck_potion: "幸運藥水",
  cd_ticket: "CD 縮短券",
};

const MINING_ITEM_FIELD = {
  luck_potion: "luck_potion_uses",
  cd_ticket: "cd_ticket_count",
};

/**
 * 真實發放抖內權益 — 每一項獨立 try/catch，失敗 log + 跳過，不阻塞其他項目。
 * 回傳 record updates（哪些欄位翻 true）。
 *
 * 呼叫端負責：donation_records 已 insert（外層 tradeNo 冪等保證）、session 已翻 completed。
 */
module.exports = async function grantDonationPerks(client, { record, tier }) {
  const updates = {};
  const userId = record.userId;
  const guildId = record.guildId;

  // 1. 金幣
  if (tier?.coins && coinsEnabled()) {
    try {
      await grantCoins(client, {
        userId,
        guildId,
        amount: tier.coins,
        source: "donation",
        meta: {
          tradeNo: record.tradeNo,
          tierId: tier.id,
          amountNtd: record.amountNtd,
          platform: record.platform,
        },
      });
      updates.coinsGranted = true;
    } catch (err) {
      logger.error(
        { source: "donation-grant", phase: "coins", tradeNo: record.tradeNo, err: err.message },
        "grantCoins failed",
      );
      trackError("donation-grant", err, { phase: "coins", tradeNo: record.tradeNo });
    }
  }

  // 2. 道具（挖礦類：寫進 MiningProfiles）
  let itemsLog = null;
  if (tier?.items && client.miningProfilesCollection) {
    const inc = {};
    for (const [itemId, qty] of Object.entries(tier.items)) {
      const field = MINING_ITEM_FIELD[itemId];
      if (!field || !qty) continue;
      inc[field] = (inc[field] || 0) + qty;
    }
    if (Object.keys(inc).length > 0) {
      try {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId },
          { $inc: inc, $set: { updatedAt: new Date() } },
          { upsert: true },
        );
        updates.itemsGranted = true;
        itemsLog = inc;
      } catch (err) {
        logger.error(
          { source: "donation-grant", phase: "items", tradeNo: record.tradeNo, err: err.message },
          "items grant failed",
        );
        trackError("donation-grant", err, { phase: "items", tradeNo: record.tradeNo });
      }
    } else {
      updates.itemsGranted = true; // 此 tier 無道具，視為完成
    }
  }

  // 3. 身分組
  let roleExpiresAt = null;
  if (tier?.role) {
    const roleKey = tier.role; // "donor" | "vipDonor"
    const roleId = donation?.roleIds?.[roleKey];
    if (!roleId) {
      logger.warn(
        { source: "donation-grant", roleKey },
        "role ID not configured in donation.roleIds",
      );
    } else {
      try {
        const guild =
          client.guilds.cache.get(guildId) ||
          (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) throw new Error(`guild ${guildId} not fetchable`);
        const member =
          guild.members.cache.get(userId) ||
          (await guild.members.fetch(userId).catch(() => null));
        if (!member) throw new Error(`member ${userId} not in guild`);
        await member.roles.add(roleId, `donation tier=${tier.id} trade=${record.tradeNo}`);
        if (!tier.permanentRole && tier.roleDurationDays) {
          roleExpiresAt = new Date(
            Date.now() + tier.roleDurationDays * 24 * 60 * 60 * 1000,
          );
        }
        updates.roleGranted = true;
        updates.roleId = roleId;
        if (roleExpiresAt) updates.roleExpiresAt = roleExpiresAt;
      } catch (err) {
        logger.error(
          { source: "donation-grant", phase: "role", tradeNo: record.tradeNo, err: err.message },
          "role grant failed",
        );
        trackError("donation-grant", err, { phase: "role", tradeNo: record.tradeNo });
      }
    }
  }

  // 4. 挖礦 luck buff（永久 > 限時，bonus 高 > 低）
  if (tier?.luckBonus && tier.luckBonus > 0 && client.miningProfilesCollection) {
    try {
      const profile =
        (await client.miningProfilesCollection.findOne({ userId, guildId })) || {};
      const existingBonus = Number(profile.donation_luck_bonus || 0);
      const existingExpiry = profile.donation_luck_expires_at || null; // Date | null
      const newBonus = tier.luckBonus;
      const newExpiry =
        tier.luckDurationDays === null
          ? null
          : new Date(Date.now() + tier.luckDurationDays * 24 * 60 * 60 * 1000);

      // 規則：
      // - 既有永久（null）→ 只有「新永久 + 新 bonus 更高」才覆蓋
      // - 新永久 → 一定覆蓋（永久優於限時）
      // - 兩個都限時 → 新 bonus 嚴格高 或 同 bonus 但新 expiry 較晚 → 覆蓋
      let shouldUpdate = false;
      if (existingExpiry === null) {
        shouldUpdate = newExpiry === null && newBonus > existingBonus;
      } else if (newExpiry === null) {
        shouldUpdate = true;
      } else {
        shouldUpdate =
          newBonus > existingBonus ||
          (newBonus === existingBonus && newExpiry > existingExpiry);
      }

      if (shouldUpdate) {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId },
          {
            $set: {
              donation_luck_bonus: newBonus,
              donation_luck_expires_at: newExpiry,
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
      }
      updates.buffGranted = true;
    } catch (err) {
      logger.error(
        { source: "donation-grant", phase: "buff", tradeNo: record.tradeNo, err: err.message },
        "luck buff grant failed",
      );
      trackError("donation-grant", err, { phase: "buff", tradeNo: record.tradeNo });
    }
  }

  // 5. 限定卡面（永久寫進 UserInventory）
  if (tier?.themeId && client.userInventoryCollection) {
    try {
      const existing = await client.userInventoryCollection.findOne({
        userId,
        guildId,
        itemId: tier.themeId,
        type: "wallet_theme",
      });
      if (!existing) {
        const now = new Date();
        await client.userInventoryCollection.insertOne({
          userId,
          guildId,
          itemId: tier.themeId,
          name: "贊助限定卡面",
          type: "wallet_theme",
          payload: { themeId: tier.themeId.replace(/^theme_/, "") },
          equipped: false,
          expiresAt: null, // 永久
          acquiredAt: now,
          updatedAt: now,
          source: "donation",
          freeGrant: true,
        });
      }
      updates.themeGranted = true;
    } catch (err) {
      logger.error(
        { source: "donation-grant", phase: "theme", tradeNo: record.tradeNo, err: err.message },
        "theme grant failed",
      );
      trackError("donation-grant", err, { phase: "theme", tradeNo: record.tradeNo });
    }
  }

  // 6. 自訂稱號（限時或永久）
  if (tier?.titleId && client.userInventoryCollection) {
    try {
      const now = new Date();
      const expiresAt =
        tier.titleDurationDays === null || tier.titleDurationDays === undefined
          ? null
          : new Date(now.getTime() + tier.titleDurationDays * 24 * 60 * 60 * 1000);
      await client.userInventoryCollection.insertOne({
        userId,
        guildId,
        itemId: tier.titleId,
        name: tier.id === "vip" ? "自訂稱號（90 天）" : "自訂稱號（30 天）",
        type: "custom_title",
        payload: {},
        equipped: false,
        expiresAt,
        acquiredAt: now,
        updatedAt: now,
        source: "donation",
        freeGrant: true,
      });
      updates.titleGranted = true;
    } catch (err) {
      logger.error(
        { source: "donation-grant", phase: "title", tradeNo: record.tradeNo, err: err.message },
        "title grant failed",
      );
      trackError("donation-grant", err, { phase: "title", tradeNo: record.tradeNo });
    }
  }

  // 7. DM 收據
  try {
    await sendDonationDm(client, record, tier, { itemsLog, roleExpiresAt });
    updates.dmSent = true;
  } catch (err) {
    logger.warn(
      { source: "donation-grant", phase: "dm", tradeNo: record.tradeNo, err: err.message },
      "DM failed (user may have DMs off)",
    );
  }

  // 8. 公告
  if (donation?.announceChannelId) {
    try {
      await announceDonation(client, record, tier);
      updates.announced = true;
    } catch (err) {
      logger.warn(
        { source: "donation-grant", phase: "announce", tradeNo: record.tradeNo, err: err.message },
        "announce failed",
      );
    }
  }

  return updates;
};

function coinsEnabled() {
  // grantCoins 內部自己會檢查 coinSystem.enabled，這裡只是早期跳過
  return true;
}

async function sendDonationDm(client, record, tier, extras) {
  const user =
    client.users.cache.get(record.userId) ||
    (await client.users.fetch(record.userId).catch(() => null));
  if (!user) throw new Error(`user ${record.userId} not fetchable`);

  const COIN_EMOJI = "<a:golden_spin_coin:1509128878881247293>";
  const THANKFUL_EMOJI = "<:thankful:1509781026761736282>";

  const lines = [
    `# ${THANKFUL_EMOJI} 你讓逼逼機器人吃上一頓飯啦！`,
    `## 十分感謝你的贊助！`,
    "",
    `金額：**NT$${record.amountNtd}**　·　平台：${record.platform === "ecpay" ? "綠界" : "歐付寶"}`,
    `交易編號：\`${record.tradeNo}\``,
    "",
  ];
  if (tier) {
    lines.push(`## ${tier.emoji} ${tier.name}`);
    lines.push("");
    if (tier.coins) lines.push(`- ${COIN_EMOJI} ${tier.coins.toLocaleString()} 金幣`);
    if (extras?.itemsLog) {
      for (const [field, qty] of Object.entries(extras.itemsLog)) {
        const label =
          field === "luck_potion_uses"
            ? "幸運藥水"
            : field === "cd_ticket_count"
              ? "CD 縮短券"
              : field;
        lines.push(`- 🎒 ${label} ×${qty}`);
      }
    }
    if (tier.role) {
      const roleName = tier.role === "vipDonor" ? "大恩讀舒人" : "贈舒人";
      const dur =
        tier.permanentRole || tier.roleDurationDays === null
          ? "永久"
          : `${tier.roleDurationDays} 天`;
      lines.push(`- 🎭 身分組：${roleName}（${dur}）`);
    }
    if (tier.luckBonus > 0) {
      const dur = tier.luckDurationDays === null ? "永久" : `${tier.luckDurationDays} 天`;
      lines.push(`- ⛏️ 挖礦 luck +${Math.round(tier.luckBonus * 100)}%（${dur}）`);
    }
    if (tier.themeId) lines.push(`- 🎴 限定卡面（永久）`);
    if (tier.titleId) {
      const dur = tier.titleDurationDays ? `${tier.titleDurationDays} 天` : "永久";
      lines.push(`- 🪪 自訂稱號（${dur}）— 到 \`/商店\` 背包選單設定`);
    }
    if (tier.canNominateTitle) lines.push(`- 🌟 可提名限定稱號`);

    lines.push("");
    lines.push("以上獎勵已全數發送至你的帳號 ✨ — 金幣可在 `/錢包` 查看，道具與卡面在 `/商店` 背包選單。");
  } else {
    lines.push("（金額未達方案門檻，未發放回饋。如有疑問請聯絡管理員。）");
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xd8e3c4)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n")),
    );

  await user.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function announceDonation(client, record, tier) {
  const channelId = donation.announceChannelId;
  const channel =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased?.()) {
    throw new Error(`announce channel ${channelId} not text-based`);
  }
  const tierLabel = tier ? `${tier.emoji} ${tier.name}` : "未達門檻贊助";
  const content = `🎉 <@${record.userId}> 抖內 **NT$${record.amountNtd}** 解鎖 **${tierLabel}**，讓逼逼機器人吃上一頓飯啦！十分感謝你！`;
  await channel.send({
    content,
    allowedMentions: { users: [record.userId] },
  });
}
