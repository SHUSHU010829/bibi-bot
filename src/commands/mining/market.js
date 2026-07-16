require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { mining, marketplace, fishing, farming } = require("../../config");
const marketplaceService = require("../../features/marketplace/marketplaceService");
const listingConfirm = require("../../features/marketplace/listingConfirm");
const itemAccess = require("../../features/marketplace/itemAccess");
const {
  buildBrowseView,
  buildMyStallView,
  FULFILL_PREFIX,
} = require("../../features/marketplace/marketplaceView");
const { COIN_EMOJI } = require("../../constants/coin");

function oreChoices() {
  return Object.entries(mining?.ores || {})
    .filter(([, def]) => def.price)
    .map(([key, def]) => ({ name: def.name || key, value: key }));
}

function fishChoices() {
  return Object.entries(fishing?.fish || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}（${def.price} 幣/條）`,
    value: key,
  }));
}

function veggieChoices() {
  return Object.entries(farming?.crops || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}（${itemAccess.basePrice("veggie", key)} 幣/個）`,
    value: key,
  }));
}

const ITEM_CHOICES = itemAccess.allChoices();

module.exports = {
  channelBuckets: ["marketplace"],
  data: new SlashCommandBuilder()
    .setName("市集")
    .setDescription("礦石市集：賣礦、徵求、大量收購、競標 🏪")
    .setContexts(InteractionContextType.Guild)
    // 逛攤
    .addSubcommand((s) =>
      s.setName("逛攤").setDescription("瀏覽市集所有掛單（每筆附按鈕可直接成交）")
    )
    // 我的攤位
    .addSubcommand((s) =>
      s.setName("我的攤位").setDescription("查看自己的掛單，可點按鈕下架")
    )
    // 賣礦
    .addSubcommand((s) =>
      s
        .setName("賣礦")
        .setDescription("以一口價掛牌賣礦石，收金幣")
        .addStringOption((o) =>
          o.setName("礦石").setDescription("要賣的礦石").setRequired(true).addChoices(...oreChoices())
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("數量").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o.setName("總價").setDescription("你要賣多少金幣（一口價總額）").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在掛單前（例：佛心給鑽、保留給某人）").setMaxLength(30)
        )
    )
    // 徵求
    .addSubcommand((s) =>
      s
        .setName("徵求")
        .setDescription("貼出收購單：我要某物，付金幣或物品")
        .addStringOption((o) =>
          o.setName("想要物品").setDescription("你想收購的物品").setRequired(true).addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o.setName("想要數量").setDescription("你想收購的數量").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o
            .setName("付款方式")
            .setDescription("用金幣還是物品來付款")
            .setRequired(true)
            .addChoices({ name: "金幣", value: "coin" }, { name: "物品", value: "item" })
        )
        .addIntegerOption((o) =>
          o
            .setName("金幣總額")
            .setDescription("付金幣時：你願意付多少金幣（選填，付金幣時填）")
            .setRequired(false)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o
            .setName("付的物品")
            .setDescription("付物品時：你用什麼物品來付（選填，付物品時填）")
            .setRequired(false)
            .addChoices(...ITEM_CHOICES)
        )
        .addIntegerOption((o) =>
          o
            .setName("付的數量")
            .setDescription("付物品時：你付多少個（選填，付物品時填）")
            .setRequired(false)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在掛單前").setMaxLength(30)
        )
    )
    // 大量收購
    .addSubcommand((s) =>
      s
        .setName("大量收購")
        .setDescription("一次收購大量素材，多位玩家可分批賣給你 🛒")
        .addStringOption((o) =>
          o.setName("物品").setDescription("你要大量收購的物品").setRequired(true).addChoices(...ITEM_CHOICES)
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
    )
    // 賣魚
    .addSubcommand((s) =>
      s
        .setName("賣魚")
        .setDescription("以一口價在市集掛牌賣魚，收金幣")
        .addStringOption((o) =>
          o.setName("魚").setDescription("要賣的魚種").setRequired(true).addChoices(...fishChoices())
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("數量").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o.setName("總價").setDescription("你要賣多少金幣（一口價總額）").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在掛單前").setMaxLength(30)
        )
    )
    // 賣菜
    .addSubcommand((s) =>
      s
        .setName("賣菜")
        .setDescription("以一口價在市集掛牌賣農產品，收金幣")
        .addStringOption((o) =>
          o.setName("農產品").setDescription("要賣的農產品").setRequired(true).addChoices(...veggieChoices())
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("數量").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o.setName("總價").setDescription("你要賣多少金幣（一口價總額）").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("標題").setDescription("選填：自訂標題顯示在掛單前").setMaxLength(30)
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
    // 物品換金錢的上架先走 ephemeral 預覽確認（含行情中位數＋洗幣警示）；查詢類也 ephemeral。
    // 徵求付物品不涉及金錢，維持公開直接上架。
    const wantPayKind = sub === "徵求" ? interaction.options.getString("付款方式") : null;
    const previewSubs = new Set(["賣礦", "賣魚", "賣菜", "競標", "大量收購"]);
    const isPreview = previewSubs.has(sub) || (sub === "徵求" && wantPayKind === "coin");
    const ephemeral = isPreview || ["逛攤", "我的攤位"].includes(sub);
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    try {
      if (!mining?.enabled || !marketplace?.enabled || !client.marketListingsCollection) {
        return interaction.editReply("🔧 市集尚未啟動！");
      }

      if (sub === "逛攤") return await handleBrowse(client, interaction);
      if (sub === "我的攤位") return await handleMyStall(client, interaction);
      if (sub === "賣礦") return await handleSell(client, interaction);
      if (sub === "徵求") return await handleWant(client, interaction);
      if (sub === "大量收購") return await handleBulk(client, interaction);
      if (sub === "競標") return await handleAuction(client, interaction);
      if (sub === "賣魚") return await handleFishSell(client, interaction);
      if (sub === "賣菜") return await handleVeggieSell(client, interaction);
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

// 物品換金錢的上架：先 stash pending，秀 ephemeral 預覽（含中位數行情＋洗幣警示）。
async function presentPreview(client, interaction, pendingData) {
  const pending = listingConfirm.stash({
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    ...pendingData,
  });
  const { container } = await listingConfirm.buildPreview(client, pending);
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ─── 賣礦 ───────────────────────────────────────────────────────────────────
async function handleSell(client, interaction) {
  const ore = interaction.options.getString("礦石");
  const qty = interaction.options.getInteger("數量");
  const price = interaction.options.getInteger("總價");
  const title = interaction.options.getString("標題");

  if (!mining?.ores?.[ore]) return interaction.editReply("❌ 找不到這種礦石。");

  await presentPreview(client, interaction, {
    kind: "sell",
    title,
    itemType: "ore",
    itemKey: ore,
    qty,
    totalPrice: price,
    unitPrice: price / qty,
    priceLabel: "總價",
    params: {
      subtype: "ore",
      sellerId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      ore,
      qty,
      price,
      title,
    },
  });
}

// ─── 徵求 ───────────────────────────────────────────────────────────────────
async function handleWant(client, interaction) {
  const wantArg = interaction.options.getString("想要物品");
  const wantQty = interaction.options.getInteger("想要數量");
  const payKind = interaction.options.getString("付款方式");
  const coinAmount = interaction.options.getInteger("金幣總額");
  const payArg = interaction.options.getString("付的物品");
  const payQty = interaction.options.getInteger("付的數量");

  if (payKind === "coin" && !coinAmount) {
    return interaction.editReply("❌ 付款方式為金幣時，請填寫「金幣總額」。");
  }
  if (payKind === "item" && (!payArg || !payQty)) {
    return interaction.editReply("❌ 付款方式為物品時，請填寫「付的物品」和「付的數量」。");
  }

  const wantChoice = itemAccess.parseChoice(wantArg);
  const payChoice = payKind === "item" ? itemAccess.parseChoice(payArg) : null;
  if (!wantChoice) return interaction.editReply("❌ 找不到「想要物品」。");
  if (payKind === "item" && !payChoice) return interaction.editReply("❌ 找不到「付的物品」。");

  const title = interaction.options.getString("標題");

  // 付金幣＝物品換金錢 → 先走預覽確認（含行情中位數＋洗幣警示）
  if (payKind === "coin") {
    return presentPreview(client, interaction, {
      kind: "want",
      title,
      itemType: wantChoice.type,
      itemKey: wantChoice.key,
      qty: wantQty,
      totalPrice: coinAmount,
      unitPrice: coinAmount / wantQty,
      priceLabel: "金幣總額",
      params: {
        sellerId: interaction.user.id,
        guildId: interaction.guildId,
        sellerName: interaction.member?.displayName || interaction.user.username,
        wantItemType: wantChoice.type,
        wantItemKey: wantChoice.key,
        wantQty,
        payKind: "coin",
        coinAmount,
        member: interaction.member,
        title,
      },
    });
  }

  const result = await marketplaceService.createWantListing(client, {
    sellerId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    wantItemType: wantChoice.type,
    wantItemKey: wantChoice.key,
    wantQty,
    payKind,
    coinAmount,
    payItemType: payChoice?.type,
    payItemKey: payChoice?.key,
    payQty,
    member: interaction.member,
    title: interaction.options.getString("標題"),
  });

  if (!result.ok) {
    if (result.reason === "no_want_item" || result.reason === "no_pay_item")
      return interaction.editReply("❌ 找不到這種物品。");
    if (result.reason === "same_item")
      return interaction.editReply("❌ 想要與付的物品不能相同！");
    if (result.reason === "too_many")
      return interaction.editReply(`📦 你同時最多只能掛 **${result.max}** 件掛單。`);
    if (result.reason === "insufficient_coins")
      return interaction.editReply(
        `💰 餘額不足！你目前 **${result.balance.toLocaleString()}** ${COIN_EMOJI}。`
      );
    if (result.reason === "insufficient")
      return interaction.editReply(
        `🎒 你只有 **${result.have}** 個 ${result.payDef?.name || "物品"}，無法託管 ${payQty} 個。`
      );
    if (result.reason === "grant_failed")
      return interaction.editReply("🔧 金幣託管失敗，請稍後再試。");
    return interaction.editReply("🔧 掛牌失敗，請稍後再試。");
  }

  const l = result.listing;
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const wantLabel = itemAccess.itemLabel(wantChoice.type, wantChoice.key, wantQty);
  const payStr = payKind === "coin"
    ? `**${coinAmount.toLocaleString()}** ${COIN_EMOJI}（已從你帳戶託管）`
    : `${itemAccess.itemLabel(payChoice.type, payChoice.key, payQty)}（已從你${itemAccess.bagName(payChoice.type)}託管）`;
  const container = new ContainerBuilder()
    .setAccentColor(0x8e44ad)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📋 徵求掛牌成功\n` +
          (l.title ? `📌 ${l.title}\n` : "") +
          `**#${l.listing_id}**\n` +
          `徵求 ${wantLabel}，付出 ${payStr}\n` +
          `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
          `-# 有貨的玩家可直接點下方「賣給他」成交；無人賣出則取消時退回付款。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${FULFILL_PREFIX}${l.listing_id}`)
          .setLabel("賣給他")
          .setEmoji("📋")
          .setStyle(ButtonStyle.Primary)
      )
    );
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ─── 大量收購 ────────────────────────────────────────────────────────────────
async function handleBulk(client, interaction) {
  const itemArg = interaction.options.getString("物品");
  const qty = interaction.options.getInteger("數量");
  const unitPrice = interaction.options.getInteger("單價");

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

// ─── 賣魚 ────────────────────────────────────────────────────────────────────
async function handleFishSell(client, interaction) {
  const fishKey = interaction.options.getString("魚");
  const qty = interaction.options.getInteger("數量");
  const price = interaction.options.getInteger("總價");
  const title = interaction.options.getString("標題");

  if (!fishing?.fish?.[fishKey]) return interaction.editReply("❌ 找不到這種魚。");

  await presentPreview(client, interaction, {
    kind: "sell",
    title,
    itemType: "fish",
    itemKey: fishKey,
    qty,
    totalPrice: price,
    unitPrice: price / qty,
    priceLabel: "總價",
    params: {
      subtype: "fish",
      sellerId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      fishKey,
      qty,
      price,
      title,
    },
  });
}

// ─── 賣菜 ────────────────────────────────────────────────────────────────────
async function handleVeggieSell(client, interaction) {
  const veggieKey = interaction.options.getString("農產品");
  const qty = interaction.options.getInteger("數量");
  const price = interaction.options.getInteger("總價");
  const title = interaction.options.getString("標題");

  if (!farming?.crops?.[veggieKey]) return interaction.editReply("❌ 找不到這種農產品。");

  await presentPreview(client, interaction, {
    kind: "sell",
    title,
    itemType: "veggie",
    itemKey: veggieKey,
    qty,
    totalPrice: price,
    unitPrice: price / qty,
    priceLabel: "總價",
    params: {
      subtype: "veggie",
      sellerId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      veggieKey,
      qty,
      price,
      title,
    },
  });
}
