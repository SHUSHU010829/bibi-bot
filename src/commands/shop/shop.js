require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { shop } = require("../../config");
const { getCatalog, getCategories, getItem } = require("../../features/shop/catalog");
const buyItem = require("../../features/shop/buyItem");

function categoryChoices() {
  return getCategories()
    .slice(0, 25)
    .map((c) => ({ name: c, value: c }));
}

function itemChoices() {
  // Discord 限 25 個 choices；超過就只用文字輸入
  const items = getCatalog();
  if (items.length <= 25) {
    return items.map((i) => ({
      name: `${i.name} (${i.price})`.slice(0, 100),
      value: i.id,
    }));
  }
  return null;
}

function fmtPrice(n) {
  return `${n.toLocaleString()} ${shop?.currency || "金幣"}`;
}

async function handleBrowse(client, interaction) {
  const cat = interaction.options.getString("category");
  let items = getCatalog();
  if (cat) items = items.filter((i) => i.category === cat);

  if (items.length === 0) {
    return interaction.editReply("這個分類目前沒有商品");
  }

  const grouped = new Map();
  for (const it of items) {
    if (!grouped.has(it.category)) grouped.set(it.category, []);
    grouped.get(it.category).push(it);
  }

  const embed = new EmbedBuilder()
    .setTitle(cat ? `🛒 商店 — ${cat}` : "🛒 商店")
    .setColor(0xffd166)
    .setDescription("輸入 `/商店 購買 <itemId>` 購買商品");

  for (const [c, list] of grouped.entries()) {
    const text = list
      .map(
        (i) =>
          `**${i.name}** — ${fmtPrice(i.price)}\n\`${i.id}\` ・ ${i.description}`,
      )
      .join("\n\n");
    embed.addFields({
      name: `📂 ${c}（${list.length} 件）`,
      value: text.slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleBuy(client, interaction) {
  const itemId = interaction.options.getString("item");
  const item = getItem(itemId);
  if (!item) return interaction.editReply("找不到該商品 ID");

  const result = await buyItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
    itemId,
  });

  if (!result.ok) return interaction.editReply(`❌ ${result.error}`);

  const lines = [
    `✅ 已購買 **${item.name}**`,
    `・花費：${fmtPrice(item.price)}`,
    `・剩餘餘額：${(result.balanceAfter || 0).toLocaleString()}`,
  ];
  if (result.expiresAt) {
    const ts = Math.floor(new Date(result.expiresAt).getTime() / 1000);
    lines.push(`・有效期限：<t:${ts}:f>（<t:${ts}:R>）`);
  }
  if (item.type === "xp_boost" || item.type === "coin_boost") {
    lines.push(`・效果：已自動套用，請查看 \`/背包\` 查詢剩餘時間`);
  }

  const invId = result.inventoryDoc?.insertedId
    ? String(result.inventoryDoc.insertedId)
    : null;
  const components = [];
  if (invId && (item.type === "role_color" || item.type === "wallet_theme")) {
    const label =
      item.type === "role_color" ? "🎨 立即裝備顏色" : "🎴 立即套用卡面";
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_equip_btn_${invId}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Primary),
      ),
    );
  } else if (invId && item.type === "custom_title") {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_title_open_${invId}`)
          .setLabel("🪪 設定稱號文字")
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  await interaction.editReply({ content: lines.join("\n"), components });
}

const data = new SlashCommandBuilder()
  .setName("商店")
  .setDescription("購買道具、主題、顏色身份組 🛒")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sc) =>
    sc.setName("瀏覽").setDescription("瀏覽商店商品").addStringOption((o) => {
      o.setName("category").setDescription("分類").setRequired(false);
      const choices = categoryChoices();
      if (choices.length > 0) o.addChoices(...choices);
      return o;
    }),
  )
  .addSubcommand((sc) =>
    sc
      .setName("購買")
      .setDescription("購買商品")
      .addStringOption((o) => {
        o.setName("item").setDescription("商品 ID").setRequired(true);
        const choices = itemChoices();
        if (choices) o.addChoices(...choices);
        return o;
      }),
  );

module.exports = {
  ephemeral: true,
  data: data.toJSON(),

  run: async (client, interaction) => {
    if (!shop?.enabled) {
      return interaction.reply({
        content: "🔧 商店系統尚未啟動！",
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const sub = interaction.options.getSubcommand();
      if (sub === "瀏覽") return handleBrowse(client, interaction);
      if (sub === "購買") return handleBuy(client, interaction);
      return interaction.editReply("未知子指令");
    } catch (error) {
      console.log(`[ERROR] /商店:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 商店指令失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
