const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

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

async function buildInventoryView(client, { userId, guildId, username }) {
  const items = await client.userInventoryCollection
    .find({ userId, guildId, expired: { $ne: true } })
    .sort({ acquiredAt: -1 })
    .limit(50)
    .toArray();

  const coinDoc = await client.userCoinsCollection.findOne(
    { userId, guildId },
    { projection: { activeBuffs: 1, totalCoins: 1 } },
  );

  const now = Date.now();
  const activeBuffs = (coinDoc?.activeBuffs || []).filter((b) => {
    const exp = b?.expiresAt ? new Date(b.expiresAt).getTime() : 0;
    return exp > now;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🎒 ${username} 的背包`)
    .setColor(0x9b59b6)
    .setDescription(
      `目前金幣：**${(coinDoc?.totalCoins || 0).toLocaleString()}**`,
    );

  if (activeBuffs.length > 0) {
    const buffText = activeBuffs
      .map(
        (b) =>
          `・${b.type === "xp_boost" ? "📈 XP" : `${MONEY_EMOJI} 金幣`} ×${b.multiplier}（${fmtExpiry(b.expiresAt)}）`,
      )
      .join("\n");
    embed.addFields({ name: "✨ 生效中的 buff", value: buffText });
  } else {
    embed.addFields({ name: "✨ 生效中的 buff", value: "（沒有）" });
  }

  const grouped = new Map();
  if (items.length === 0) {
    embed.addFields({ name: "📦 道具", value: "（背包是空的）" });
  } else {
    for (const it of items) {
      if (!grouped.has(it.type)) grouped.set(it.type, []);
      grouped.get(it.type).push(it);
    }

    for (const [type, list] of grouped.entries()) {
      const text = list
        .map((it) => {
          const equipped = it.equipped ? " ✅" : "";
          const qty = it.qty ? ` ×${it.qty}` : "";
          const exp = it.expiresAt ? ` — 到期：${fmtExpiry(it.expiresAt)}` : "";
          return `**${it.name}**${qty}${equipped}${exp}`;
        })
        .join("\n");
      embed.addFields({
        name: TYPE_LABEL[type] || type,
        value: text.slice(0, 1024),
      });
    }
  }

  embed.setFooter({
    text: "從下方選單直接裝備道具，無需複製 ID。",
  });

  const components = [];
  for (const type of EQUIPPABLE_TYPES) {
    const list = grouped.get(type);
    if (!list || list.length === 0) continue;
    const row = buildSelectMenu(type, list);
    if (row) components.push(row);
    if (components.length >= 5) break;
  }

  return { embeds: [embed], components };
}

module.exports = { buildInventoryView };
