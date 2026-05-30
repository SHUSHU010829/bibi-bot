require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { mining, marketplace } = require("../../config");
const marketplaceService = require("../../features/marketplace/marketplaceService");
const {
  buildBrowseView,
  buildMyStallView,
  oreLabel,
} = require("../../features/marketplace/marketplaceView");
const { COIN_EMOJI } = require("../../constants/coin");

function oreChoices() {
  return Object.entries(mining?.ores || {}).map(([key, def]) => ({
    name: def.name || key,
    value: key,
  }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("市集")
    .setDescription("礦石市集：賣礦、換礦、徵求、競標 🏪")
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
    )
    // 換礦
    .addSubcommand((s) =>
      s
        .setName("換礦")
        .setDescription("以物易物：給出某礦，換取另一種礦")
        .addStringOption((o) =>
          o.setName("給的礦石").setDescription("你要給出的礦石").setRequired(true).addChoices(...oreChoices())
        )
        .addIntegerOption((o) =>
          o.setName("給的數量").setDescription("你給出的數量").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName("想要礦石").setDescription("你想換到的礦石").setRequired(true).addChoices(...oreChoices())
        )
        .addIntegerOption((o) =>
          o.setName("想要數量").setDescription("你想換到的數量").setRequired(true).setMinValue(1)
        )
    )
    // 徵求
    .addSubcommand((s) =>
      s
        .setName("徵求")
        .setDescription("貼出收購單：我要某礦，付金幣或礦石")
        .addStringOption((o) =>
          o.setName("想要礦石").setDescription("你想收購的礦石").setRequired(true).addChoices(...oreChoices())
        )
        .addIntegerOption((o) =>
          o.setName("想要數量").setDescription("你想收購的數量").setRequired(true).setMinValue(1)
        )
        .addStringOption((o) =>
          o
            .setName("付款方式")
            .setDescription("用金幣還是礦石來付款")
            .setRequired(true)
            .addChoices({ name: "金幣", value: "coin" }, { name: "礦石", value: "ore" })
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
            .setName("付的礦石")
            .setDescription("付礦石時：你用什麼礦石來付（選填，付礦石時填）")
            .setRequired(false)
            .addChoices(...oreChoices())
        )
        .addIntegerOption((o) =>
          o
            .setName("付的數量")
            .setDescription("付礦石時：你付多少顆（選填，付礦石時填）")
            .setRequired(false)
            .setMinValue(1)
        )
    )
    // 競標
    .addSubcommand((s) =>
      s
        .setName("競標")
        .setDescription("掛競標品，玩家出價競標，到期最高出價者得標")
        .addStringOption((o) =>
          o.setName("礦石").setDescription("要競標的礦石").setRequired(true).addChoices(...oreChoices())
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
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !marketplace?.enabled || !client.marketListingsCollection) {
        return interaction.editReply("🔧 市集尚未啟動！");
      }

      const sub = interaction.options.getSubcommand();
      if (sub === "逛攤") return await handleBrowse(client, interaction);
      if (sub === "我的攤位") return await handleMyStall(client, interaction);
      if (sub === "賣礦") return await handleSell(client, interaction);
      if (sub === "換礦") return await handleBarter(client, interaction);
      if (sub === "徵求") return await handleWant(client, interaction);
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

// ─── 賣礦 ───────────────────────────────────────────────────────────────────
async function handleSell(client, interaction) {
  const ore = interaction.options.getString("礦石");
  const qty = interaction.options.getInteger("數量");
  const price = interaction.options.getInteger("總價");

  const result = await marketplaceService.createSellListing(client, {
    sellerId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    ore,
    qty,
    price,
  });

  if (!result.ok) {
    if (result.reason === "no_ore") return interaction.editReply("❌ 找不到這種礦石。");
    if (result.reason === "low_price") {
      return interaction.editReply(
        `❌ ${result.oreDef.name} ×${qty} 的最低售價為 **${result.minPrice.toLocaleString()}** ${COIN_EMOJI}（系統收購價的 80%）。`
      );
    }
    if (result.reason === "too_many") {
      return interaction.editReply(`📦 你同時最多只能掛 **${result.max}** 件掛單。`);
    }
    if (result.reason === "insufficient") {
      return interaction.editReply(
        `🎒 你只有 **${result.have}** 顆 ${result.oreDef.name}，無法掛 ${qty} 顆。`
      );
    }
    return interaction.editReply("🔧 掛牌失敗，請稍後再試。");
  }

  const l = result.listing;
  const feeRate = Math.round((marketplace.sellFeeRate ?? 0.05) * 100);
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💰 賣礦掛牌成功\n` +
          `**#${l.listing_id}** ・ ${oreLabel(l.ore)} ×${l.qty}\n` +
          `一口價：**${l.price.toLocaleString()}** ${COIN_EMOJI}\n` +
          `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
          `-# 成交將收取 ${feeRate}% 手續費；無人購買將自動退回礦石。`
      )
    );
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ─── 換礦 ───────────────────────────────────────────────────────────────────
async function handleBarter(client, interaction) {
  const giveOre = interaction.options.getString("給的礦石");
  const giveQty = interaction.options.getInteger("給的數量");
  const wantOre = interaction.options.getString("想要礦石");
  const wantQty = interaction.options.getInteger("想要數量");

  const result = await marketplaceService.createBarterListing(client, {
    sellerId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    giveOre,
    giveQty,
    wantOre,
    wantQty,
  });

  if (!result.ok) {
    if (result.reason === "no_give_ore" || result.reason === "no_want_ore")
      return interaction.editReply("❌ 找不到這種礦石。");
    if (result.reason === "same_ore")
      return interaction.editReply("❌ 給出和想要的礦石不能相同！");
    if (result.reason === "too_many")
      return interaction.editReply(`📦 你同時最多只能掛 **${result.max}** 件掛單。`);
    if (result.reason === "insufficient")
      return interaction.editReply(
        `🎒 你只有 **${result.have}** 顆 ${result.oreDef.name}，無法掛 ${giveQty} 顆。`
      );
    return interaction.editReply("🔧 掛牌失敗，請稍後再試。");
  }

  const l = result.listing;
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔄 換礦掛牌成功\n` +
          `**#${l.listing_id}**\n` +
          `你給出 ${oreLabel(l.ore)} ×${l.qty}，換取 ${oreLabel(l.want_ore)} ×${l.want_qty}\n` +
          `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
          `-# 無人接受將自動退回礦石。`
      )
    );
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ─── 徵求 ───────────────────────────────────────────────────────────────────
async function handleWant(client, interaction) {
  const wantOre = interaction.options.getString("想要礦石");
  const wantQty = interaction.options.getInteger("想要數量");
  const payKind = interaction.options.getString("付款方式");
  const coinAmount = interaction.options.getInteger("金幣總額");
  const payOre = interaction.options.getString("付的礦石");
  const payQty = interaction.options.getInteger("付的數量");

  // 驗證互斥參數
  if (payKind === "coin" && !coinAmount) {
    return interaction.editReply("❌ 付款方式為金幣時，請填寫「金幣總額」。");
  }
  if (payKind === "ore" && (!payOre || !payQty)) {
    return interaction.editReply("❌ 付款方式為礦石時，請填寫「付的礦石」和「付的數量」。");
  }

  const result = await marketplaceService.createWantListing(client, {
    sellerId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    wantOre,
    wantQty,
    payKind,
    coinAmount,
    payOre,
    payQty,
    member: interaction.member,
  });

  if (!result.ok) {
    if (result.reason === "no_ore" || result.reason === "no_pay_ore")
      return interaction.editReply("❌ 找不到這種礦石。");
    if (result.reason === "same_ore")
      return interaction.editReply("❌ 想要的礦石和付的礦石不能相同！");
    if (result.reason === "too_many")
      return interaction.editReply(`📦 你同時最多只能掛 **${result.max}** 件掛單。`);
    if (result.reason === "insufficient_coins")
      return interaction.editReply(
        `💰 餘額不足！你目前 **${result.balance.toLocaleString()}** ${COIN_EMOJI}。`
      );
    if (result.reason === "insufficient")
      return interaction.editReply(
        `🎒 你只有 **${result.have}** 顆 ${result.oreDef.name}，無法託管 ${payQty} 顆。`
      );
    if (result.reason === "grant_failed")
      return interaction.editReply("🔧 金幣託管失敗，請稍後再試。");
    return interaction.editReply("🔧 掛牌失敗，請稍後再試。");
  }

  const l = result.listing;
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const payStr = payKind === "coin"
    ? `**${coinAmount.toLocaleString()}** ${COIN_EMOJI}（已從你帳戶託管）`
    : `${oreLabel(payOre)} ×${payQty}（已從你背包託管）`;
  const container = new ContainerBuilder()
    .setAccentColor(0x8e44ad)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📋 徵求掛牌成功\n` +
          `**#${l.listing_id}**\n` +
          `徵求 ${oreLabel(l.ore)} ×${l.qty}，付出 ${payStr}\n` +
          `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
          `-# 無人賣出則取消時退回付款。`
      )
    );
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ─── 競標 ───────────────────────────────────────────────────────────────────
async function handleAuction(client, interaction) {
  const ore = interaction.options.getString("礦石");
  const qty = interaction.options.getInteger("數量");
  const startPrice = interaction.options.getInteger("起標價");
  const buyoutPrice = interaction.options.getInteger("一口價");

  const result = await marketplaceService.createAuctionListing(client, {
    sellerId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    ore,
    qty,
    startPrice,
    buyoutPrice,
  });

  if (!result.ok) {
    if (result.reason === "no_ore") return interaction.editReply("❌ 找不到這種礦石。");
    if (result.reason === "low_start") {
      return interaction.editReply(
        `❌ ${result.oreDef.name} 的起標價至少要 **${result.minStart.toLocaleString()}** ${COIN_EMOJI}（系統收購價的 80%）。`
      );
    }
    if (result.reason === "low_buyout") {
      return interaction.editReply(
        `❌ 一口價不能低於起標價 **${result.startPrice.toLocaleString()}** ${COIN_EMOJI}。`
      );
    }
    if (result.reason === "too_many") {
      return interaction.editReply(`📦 你同時最多只能掛 **${result.max}** 件掛單。`);
    }
    if (result.reason === "insufficient") {
      return interaction.editReply(
        `🎒 你只有 **${result.have}** 顆 ${result.oreDef.name}，無法掛 ${qty} 顆。`
      );
    }
    return interaction.editReply("🔧 掛牌失敗，請稍後再試。");
  }

  const l = result.listing;
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const buyoutLine = l.buyout_price
    ? `\n💰 一口價：**${l.buyout_price.toLocaleString()}** ${COIN_EMOJI}（出到這價立即成交）`
    : "";
  const feeRate = Math.round(((marketplace.auction || {}).feeRate ?? 0.05) * 100);
  const container = new ContainerBuilder()
    .setAccentColor(0xe1b12c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏷️ 競標掛牌成功\n` +
          `**#${l.listing_id}** ・ ${oreLabel(l.ore)} ×${l.qty}\n` +
          `起標價：**${l.start_price.toLocaleString()}** ${COIN_EMOJI}${buyoutLine}\n` +
          `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
          `-# 成交將收取 ${feeRate}% 手續費；無人出價會自動退回礦石。`
      )
    );
  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}
