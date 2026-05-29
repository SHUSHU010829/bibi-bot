const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { mining, shop } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("../mining/miningProfile");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");
const {
  DONOR_THEME_ITEM_ID,
  CARDNO_OPEN_ID,
} = require("../donation/customCardNumber");
const { roleBuffSummary } = require("../buff/buffResolver");

// CD 縮短券「使用」按鈕 customId 格式：mining_use_cd_ticket_<ownerId>
// 由 events/interactionCreate/handleMiningTicket.js 處理。
const USE_TICKET_PREFIX = "mining_use_cd_ticket_";

function parseUseTicketId(customId) {
  if (!customId || !customId.startsWith(USE_TICKET_PREFIX)) return null;
  const ownerId = customId.slice(USE_TICKET_PREFIX.length);
  return ownerId ? { ownerId } : null;
}

const TYPE_LABEL = {
  role_color: "🎨 顏色身份組",
  wallet_theme: "🎴 卡面風格",
  card_accent: "🌈 等級卡顏色",
  custom_title: "🪪 自訂稱號",
  casino_token: "🎲 賭場道具",
};

const EQUIPPABLE_TYPES = ["role_color", "wallet_theme", "card_accent", "custom_title"];

// 統一的「裝備／設定道具」下拉選單 customId（見 events/interactionCreate/handleShopInteraction.js）。
// 把四種可裝備道具併進同一個選單，避免每種一排撞到 Discord 動作列上限（導致自訂稱號選單被吃掉）。
const UNIFIED_EQUIP_ID = "shop_equip_unified";

function fmtExpiry(expiresAt) {
  if (!expiresAt) return "永久";
  const ts = Math.floor(new Date(expiresAt).getTime() / 1000);
  return `<t:${ts}:R>`;
}

function isUsable(it) {
  if (it.expired) return false;
  if (it.expiresAt && new Date(it.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function fmtExpiryPlain(expiresAt) {
  if (!expiresAt) return "永久";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "已過期";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `剩 ${days} 天`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `剩 ${hours} 小時`;
  const mins = Math.max(1, Math.floor(ms / 60000));
  return `剩 ${mins} 分鐘`;
}

// 純文字的型別標籤（去掉 emoji 前綴），用於選項描述。
function typeLabelText(type) {
  return (TYPE_LABEL[type] || type).replace(/^[^\s]+\s/, "");
}

// 單一「裝備／設定道具」選單：跨四種可裝備型別合併成同一個下拉。
// 選項 value 編碼成 `<type>:<inventoryId>`，由 handler 依型別決定要直接裝備或開稱號彈窗。
function buildUnifiedEquipMenu(grouped) {
  const options = [];
  for (const type of EQUIPPABLE_TYPES) {
    const list = (grouped.get(type) || []).filter(isUsable);
    for (const it of list) {
      const emoji = (TYPE_LABEL[type] || "").split(" ")[0] || "";
      const detail =
        type === "custom_title"
          ? "點選設定／修改文字"
          : `${it.equipped ? "目前裝備中・" : ""}${fmtExpiryPlain(it.expiresAt)}`;
      options.push({
        label: `${it.equipped ? "✅ " : ""}${emoji ? `${emoji} ` : ""}${it.name}`.slice(0, 100),
        description: `${typeLabelText(type)}・${detail}`.slice(0, 100),
        value: `${type}:${it._id}`,
      });
      if (options.length >= 25) break;
    }
    if (options.length >= 25) break;
  }
  if (options.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(UNIFIED_EQUIP_ID)
    .setPlaceholder("🎁 選擇要裝備／設定的道具…")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

// 統一背包：挖礦（礦石／挖礦道具）＋ 商店（購買道具／生效 buff／裝備選單）合在同一張卡片。
// 回傳 { components, flags }，以 IsComponentsV2 + Ephemeral 私訊送出。
async function buildBackpackView(client, { userId, guildId, member, displayName }) {
  const container = new ContainerBuilder().setAccentColor(0x9b59b6);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🎒 ${displayName} 的背包`)
  );

  // 錢包餘額 + 生效中 buff（同一份文件，一次查回）
  let totalCoins = 0;
  let coinDoc = null;
  if (client.userCoinsCollection) {
    coinDoc = await client.userCoinsCollection.findOne(
      { userId, guildId },
      { projection: { totalCoins: 1, activeBuffs: 1 } }
    );
    totalCoins = coinDoc?.totalCoins || 0;
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `💰 目前金幣：**${totalCoins.toLocaleString()}** ${MONEY_EMOJI}`
    )
  );

  // ── 身分組加成（依 Twitch 訂閱 / 伺服器加成 / 贊助 等身分組彙整）──
  if (member) {
    const roleGroups = await roleBuffSummary(client, userId, guildId, member).catch(
      () => []
    );
    if (roleGroups.length > 0) {
      const roleText = roleGroups
        .map((g) => `${g.header}\n${g.lines.map((l) => `　${l}`).join("\n")}`)
        .join("\n");
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🎖️ 身分組加成\n${roleText}\n-# 這些加成來自你目前持有的身分組，失去身分組即失效`
        )
      );
    }
  }

  // ── 挖礦區 ──
  if (mining?.enabled && client.miningProfilesCollection) {
    const profile = await getOrCreate(client, userId, guildId);
    const cap = backpackCapacity(profile, mining);
    const used = backpackUsed(profile);

    // 礦石：只列出有庫存的，數量為 0 的隱藏
    const oreLines = [];
    let totalValue = 0;
    for (const [key, def] of Object.entries(mining.ores)) {
      const qty = profile.backpack?.[key] || 0;
      if (qty <= 0) continue;
      const value = qty * (def.price || 0);
      totalValue += value;
      oreLines.push(
        `${def.emoji || "⛏️"} **${def.name}** ×${qty} ・ ${value.toLocaleString()} ${COIN_EMOJI}`
      );
    }

    const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
    const durabilityText =
      profile.pickaxe === "wood" || profile.pickaxe_durability == null
        ? "永久"
        : `耐久 ${profile.pickaxe_durability} 次`;

    const now = Date.now();
    const inCooldown = (profile.mine_cooldown_at || 0) > now;
    const cdText = inCooldown
      ? `<t:${Math.floor(profile.mine_cooldown_at / 1000)}:R> 可挖`
      : "✅ 現在可挖礦";

    const luckUses = profile.luck_potion_uses || 0;
    const ticketCount = profile.cd_ticket_count || 0;
    const fragments = profile.legendary_fragments || 0;
    const reductionMin = Math.round((mining?.cdTicketReductionMs || 0) / 60000);

    // ── 礦石 ──
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        oreLines.length > 0
          ? `### ⛏️ 礦石\n${oreLines.join("\n")}\n-# 💰 全部賣出可得 ${totalValue.toLocaleString()} ${COIN_EMOJI}`
          : "### ⛏️ 礦石\n-# 背包裡還沒有礦石，快去 /挖礦 吧！"
      )
    );

    // ── 挖礦狀態 ──
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🪓 挖礦狀態\n` +
          `⛏️ 目前鎬子：${pdef.emoji || "⛏️"} ${pdef.name}（${durabilityText}）\n` +
          `📦 背包容量：${used} / ${cap}\n` +
          `⏳ 挖礦冷卻：${cdText}`
      )
    );

    // ── 挖礦道具 ──
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎁 挖礦道具\n` +
          `🍀 **幸運藥水** ×${luckUses}\n-# 挖礦自動生效，提升幸運`
      )
    );
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `🎫 **CD 縮短券** ×${ticketCount}\n-# 冷卻中使用，立即 -${reductionMin} 分`
          )
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${USE_TICKET_PREFIX}${userId}`)
            .setLabel("使用")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!(ticketCount > 0 && inCooldown))
        )
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✨ **傳說素材碎片** ×${fragments}\n-# 合成傳說裝備材料`
      )
    );
  }

  // ── 商店區 ──
  const equipRows = [];
  if (shop?.enabled && client.userInventoryCollection) {
    const items = await client.userInventoryCollection
      .find({ userId, guildId, expired: { $ne: true } })
      .sort({ acquiredAt: -1 })
      .limit(50)
      .toArray();

    const now = Date.now();
    const activeBuffs = (coinDoc?.activeBuffs || []).filter((b) => {
      const exp = b?.expiresAt ? new Date(b.expiresAt).getTime() : 0;
      return exp > now;
    });

    container.addSeparatorComponents(new SeparatorBuilder());

    const buffText =
      activeBuffs.length > 0
        ? activeBuffs
            .map(
              (b) =>
                `・${b.type === "xp_boost" ? "📈 XP" : `${MONEY_EMOJI} 金幣`} ×${b.multiplier}（${fmtExpiry(b.expiresAt)}）`
            )
            .join("\n")
        : "（沒有）";
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ✨ 生效中的 buff\n${buffText}\n-# 此處僅顯示商店購買的 XP／金幣 buff，贊助等挖礦幸運加成請於 \`/挖礦\` 結果或 \`/buff\` 查看`
      )
    );

    const grouped = new Map();
    for (const it of items) {
      if (!grouped.has(it.type)) grouped.set(it.type, []);
      grouped.get(it.type).push(it);
    }

    container.addSeparatorComponents(new SeparatorBuilder());

    if (items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("### 🛍️ 商店道具\n-# 還沒有任何道具，到 /商店 逛逛吧！")
      );
    } else {
      const sections = [];
      for (const [type, list] of grouped.entries()) {
        const text = list
          .map((it) => {
            const equipped = it.equipped ? " ✅" : "";
            const qty = it.qty ? ` ×${it.qty}` : "";
            const exp = it.expiresAt ? ` — 到期：${fmtExpiry(it.expiresAt)}` : "";
            return `・${it.name}${qty}${equipped}${exp}`;
          })
          .join("\n");
        sections.push(`**${TYPE_LABEL[type] || type}**\n${text}`);
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🛍️ 商店道具\n${sections.join("\n\n")}`.slice(0, 4000)
        )
      );
    }

    // 四種可裝備道具併成單一下拉，徹底避免動作列爆量導致選單被截掉
    const unifiedMenu = buildUnifiedEquipMenu(grouped);
    if (unifiedMenu) equipRows.push(unifiedMenu);

    // 贊助限定卡面持有者：提供「設定卡號」按鈕（自訂浮雕卡號）
    const ownsDonorCard = (grouped.get("wallet_theme") || []).some(
      (it) => it.itemId === DONOR_THEME_ITEM_ID && isUsable(it)
    );
    if (ownsDonorCard) {
      equipRows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CARDNO_OPEN_ID)
            .setLabel("💳 設定卡號")
            .setStyle(ButtonStyle.Secondary)
        )
      );
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 下方選單可直接裝備道具；用 /賣礦 換金幣、/合成 打造鎬子、/商店 逛逛"
    )
  );

  for (const row of equipRows) container.addActionRowComponents(row);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

module.exports = {
  buildBackpackView,
  USE_TICKET_PREFIX,
  parseUseTicketId,
  UNIFIED_EQUIP_ID,
};
