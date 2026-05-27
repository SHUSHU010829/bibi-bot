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
  custom_title: "🪪 自訂稱號",
  casino_token: "🎲 賭場道具",
};

const EQUIPPABLE_TYPES = ["role_color", "wallet_theme", "custom_title"];

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

function buildSelectMenu(type, items) {
  const usable = items.filter(isUsable).slice(0, 25);
  if (usable.length === 0) return null;

  const customId =
    type === "custom_title" ? "shop_title_select" : `shop_equip_select_${type}`;
  const placeholder =
    type === "custom_title"
      ? "✏️ 選擇要設定文字的自訂稱號…"
      : `選擇要裝備的${TYPE_LABEL[type]?.replace(/^[^\s]+\s/, "") || type}…`;

  const options = usable.map((it) => ({
    label: `${it.equipped ? "✅ " : ""}${it.name}`.slice(0, 100),
    description: fmtExpiryPlain(it.expiresAt).slice(0, 100),
    value: String(it._id),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

// 統一背包：挖礦（礦石／挖礦道具）＋ 商店（購買道具／生效 buff／裝備選單）合在同一張卡片。
// 回傳 { components, flags }，以 IsComponentsV2 + Ephemeral 私訊送出。
async function buildBackpackView(client, { userId, guildId, displayName }) {
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
      new TextDisplayBuilder().setContent(`### ✨ 生效中的 buff\n${buffText}`)
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

    for (const type of EQUIPPABLE_TYPES) {
      const list = grouped.get(type);
      if (!list || list.length === 0) continue;
      const row = buildSelectMenu(type, list);
      if (row) equipRows.push(row);
      if (equipRows.length >= 3) break;
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

module.exports = { buildBackpackView, USE_TICKET_PREFIX, parseUseTicketId };
