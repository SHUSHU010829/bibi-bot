require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { mining, marketplace } = require("../../config");
const marketplaceService = require("../../features/marketplace/marketplaceService");
const listingConfirm = require("../../features/marketplace/listingConfirm");
const itemAccess = require("../../features/marketplace/itemAccess");
const {
  buildBrowseView,
  buildMyStallView,
} = require("../../features/marketplace/marketplaceView");

const ITEM_CHOICES = itemAccess.allChoices();

function durationChoices() {
  const tiers = marketplace?.listingDuration?.tiers || [{ days: 1, fee: 0 }];
  return tiers.map((t) => ({
    name: t.fee > 0 ? `${t.days} 天（上架費 ${t.fee} 幣）` : `${t.days} 天（免費）`,
    value: t.days,
  }));
}
const DURATION_CHOICES = durationChoices();

module.exports = {
  channelBuckets: ["marketplace"],
  data: new SlashCommandBuilder()
    .setName("市集")
    .setDescription("訂單簿市集：收購、賣單、物物交換、競標 🏪")
    .setContexts(InteractionContextType.Guild)
    // 逛攤
    .addSubcommand((s) =>
      s.setName("逛攤").setDescription("瀏覽市集所有掛單（每筆附按鈕可直接成交）")
    )
    // 我的攤位
    .addSubcommand((s) =>
      s.setName("我的攤位").setDescription("查看自己的掛單，可點按鈕下架")
    )
    // 收購（掛買單）
    .addSubcommand((s) =>
      s
        .setName("收購")
        .setDescription("一次收購一批素材，多位玩家可分批賣給你 🛒")
        .addStringOption((o) =>
          o.setName("物品").setDescription("你要收購的物品").setRequired(true).addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("總共要收購多少個").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o
            .setName("單價")
            .setDescription("每個願意付多少金幣（不得低於系統售價）")
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在收購單前").setMaxLength(30)
        )
        .addIntegerOption((o) =>
          o.setName("時長").setDescription("掛單天數（越久上架費越高，預設 1 天）").setRequired(false).addChoices(...DURATION_CHOICES)
        )
    )
    // 賣單（掛賣單）
    .addSubcommand((s) =>
      s
        .setName("賣單")
        .setDescription("一次掛售一批物品，多位玩家可分批向你買 📦")
        .addStringOption((o) =>
          o.setName("物品").setDescription("你要掛售的物品").setRequired(true).addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("總共要賣多少個").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o
            .setName("單價")
            .setDescription("每個賣多少金幣（不得低於系統售價）")
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在賣單前").setMaxLength(30)
        )
        .addIntegerOption((o) =>
          o.setName("時長").setDescription("掛單天數（越久上架費越高，預設 1 天）").setRequired(false).addChoices(...DURATION_CHOICES)
        )
    )
    // 物物交換
    .addSubcommand((s) =>
      s
        .setName("物物交換")
        .setDescription("以物易物：付出 X 收 Y，多位玩家可分批跟你換 🔄")
        .addStringOption((o) =>
          o.setName("付出物品").setDescription("你要付出（託管）的物品").setRequired(true).addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o.setName("付出數量").setDescription("總共付出多少個").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("想要物品").setDescription("你想換到的物品").setRequired(true).addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o.setName("想要數量").setDescription("總共想換多少個").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在交換單前").setMaxLength(30)
        )
        .addIntegerOption((o) =>
          o.setName("時長").setDescription("掛單天數（越久上架費越高，預設 1 天）").setRequired(false).addChoices(...DURATION_CHOICES)
        )
    )
    // 競標
    .addSubcommand((s) =>
      s
        .setName("競標")
        .setDescription("掛競標品，玩家出價競標，到期最高出價者得標（支援礦石/魚/農產品）")
        .addStringOption((o) =>
          o.setName("物品").setDescription("要競標的物品").setRequired(true).addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("數量").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o.setName("起標價").setDescription("起標總價（不是每顆）").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o
            .setName("一口價")
            .setDescription("選填：出價達到此價立即成交（總價，須 ≥ 起標價）")
            .setRequired(false)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在掛單前").setMaxLength(30)
        )
    ),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    // 涉及金幣單價的上架先走 ephemeral 預覽確認（含行情中位數＋洗幣警示）；查詢類也 ephemeral。
    // 物物交換不涉及金幣單價，維持公開直接上架。
    const previewSubs = new Set(["競標", "收購", "賣單", "物物交換"]);
    const isPreview = previewSubs.has(sub);
    const ephemeral = isPreview || ["逛攤", "我的攤位"].includes(sub);
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    try {
      if (!mining?.enabled || !marketplace?.enabled || !client.marketListingsCollection) {
        return interaction.editReply("🔧 市集尚未啟動！");
      }

      if (sub === "逛攤") return await handleBrowse(client, interaction);
      if (sub === "我的攤位") return await handleMyStall(client, interaction);
      if (sub === "收購") return await handleBulk(client, interaction);
      if (sub === "賣單") return await handleBulkSell(client, interaction);
      if (sub === "物物交換") return await handleSwap(client, interaction);
      if (sub === "競標") return await handleAuction(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /市集:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 市集操作失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

// ─── 逛攤 ───────────────────────────────────────────────────────────────────
async function handleBrowse(client, interaction) {
  const PAGE_SIZE = 5;
  const { listings, total } = await marketplaceService.listActive(client, interaction.guildId, {
    page: 0,
    pageSize: PAGE_SIZE,
  });

  const { container, rows } = buildBrowseView(listings, total, 0, PAGE_SIZE);
  await interaction.editReply({
    components: [container, ...rows],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ─── 我的攤位 ───────────────────────────────────────────────────────────────
async function handleMyStall(client, interaction) {
  const listings = await marketplaceService.listByOwner(
    client,
    interaction.guildId,
    interaction.user.id
  );
  const { container, rows } = buildMyStallView(listings);
  await interaction.editReply({
    components: [container, ...rows],
    flags: MessageFlags.IsComponentsV2,
  });
}

// 涉及金幣單價的上架：先 stash pending，秀 ephemeral 預覽（含中位數行情＋洗幣警示）。
async function presentPreview(client, interaction, pendingData) {
  const pending = listingConfirm.stash({
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    ...pendingData,
  });
  const { container } = await listingConfirm.buildPreview(client, pending);
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ─── 收購（掛買單）───────────────────────────────────────────────────────
async function handleBulk(client, interaction) {
  const itemArg = interaction.options.getString("物品");
  const qty = interaction.options.getInteger("數量");
  const unitPrice = interaction.options.getInteger("單價");
  const durationDays = interaction.options.getInteger("時長") || 1;

  const choice = itemAccess.parseChoice(itemArg);
  if (!choice) return interaction.editReply("❌ 找不到這種物品。");
  const title = interaction.options.getString("標題");

  await presentPreview(client, interaction, {
    kind: "bulk",
    title,
    itemType: choice.type,
    itemKey: choice.key,
    qty,
    totalPrice: unitPrice * qty,
    unitPrice,
    priceLabel: "單價",
    params: {
      buyerId: interaction.user.id,
      guildId: interaction.guildId,
      buyerName: interaction.member?.displayName || interaction.user.username,
      itemType: choice.type,
      itemKey: choice.key,
      qty,
      unitPrice,
      member: interaction.member,
      title,
      durationDays,
    },
  });
}

// ─── 賣單（掛賣單）───────────────────────────────────────────────────────
async function handleBulkSell(client, interaction) {
  const itemArg = interaction.options.getString("物品");
  const qty = interaction.options.getInteger("數量");
  const unitPrice = interaction.options.getInteger("單價");
  const durationDays = interaction.options.getInteger("時長") || 1;

  const choice = itemAccess.parseChoice(itemArg);
  if (!choice) return interaction.editReply("❌ 找不到這種物品。");
  const title = interaction.options.getString("標題");

  await presentPreview(client, interaction, {
    kind: "bulk_sell",
    title,
    itemType: choice.type,
    itemKey: choice.key,
    qty,
    totalPrice: unitPrice * qty,
    unitPrice,
    priceLabel: "單價",
    params: {
      sellerId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      itemType: choice.type,
      itemKey: choice.key,
      qty,
      unitPrice,
      member: interaction.member,
      title,
      durationDays,
    },
  });
}

// ─── 物物交換 ────────────────────────────────────────────────────────────────
async function handleSwap(client, interaction) {
  const giveArg = interaction.options.getString("付出物品");
  const giveQty = interaction.options.getInteger("付出數量");
  const wantArg = interaction.options.getString("想要物品");
  const wantQty = interaction.options.getInteger("想要數量");
  const durationDays = interaction.options.getInteger("時長") || 1;
  const title = interaction.options.getString("標題");

  const giveChoice = itemAccess.parseChoice(giveArg);
  const wantChoice = itemAccess.parseChoice(wantArg);
  if (!giveChoice) return interaction.editReply("❌ 找不到「付出物品」。");
  if (!wantChoice) return interaction.editReply("❌ 找不到「想要物品」。");

  await presentPreview(client, interaction, {
    kind: "swap",
    title,
    params: {
      sellerId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      giveType: giveChoice.type,
      giveKey: giveChoice.key,
      giveQty,
      wantType: wantChoice.type,
      wantKey: wantChoice.key,
      wantQty,
      title,
      durationDays,
      member: interaction.member,
    },
  });
}

// ─── 競標 ───────────────────────────────────────────────────────────────────
async function handleAuction(client, interaction) {
  const itemArg = interaction.options.getString("物品");
  const qty = interaction.options.getInteger("數量");
  const startPrice = interaction.options.getInteger("起標價");
  const buyoutPrice = interaction.options.getInteger("一口價");

  const choice = itemAccess.parseChoice(itemArg);
  if (!choice) return interaction.editReply("❌ 找不到這種物品。");
  const title = interaction.options.getString("標題");

  await presentPreview(client, interaction, {
    kind: "auction",
    title,
    itemType: choice.type,
    itemKey: choice.key,
    qty,
    totalPrice: startPrice,
    unitPrice: startPrice / qty,
    priceLabel: "起標價",
    buyoutPrice: buyoutPrice || null,
    params: {
      sellerId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      itemType: choice.type,
      itemKey: choice.key,
      qty,
      startPrice,
      buyoutPrice: buyoutPrice || null,
      title,
    },
  });
}
