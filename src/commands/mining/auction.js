require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining, auction } = require("../../config");
const auctionService = require("../../features/auction/auctionService");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");

function oreChoices() {
  return Object.entries(mining?.ores || {}).map(([key, def]) => ({
    name: def.name || key,
    value: key,
  }));
}

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("拍賣")
    .setDescription("拍賣行：掛牌賣礦石、出價競標 🏷️")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName("清單").setDescription("查看目前拍賣中的物品")
    )
    .addSubcommand((s) =>
      s
        .setName("掛牌")
        .setDescription("把礦石掛上拍賣行")
        .addStringOption((o) =>
          o
            .setName("礦石")
            .setDescription("要拍賣的礦石")
            .setRequired(true)
            .addChoices(...oreChoices())
        )
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("數量").setRequired(true).setMinValue(1)
        )
        .addIntegerOption((o) =>
          o
            .setName("起標價")
            .setDescription("起標總價（不是每顆）")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("出價")
        .setDescription("對拍賣品出價")
        .addStringOption((o) =>
          o.setName("編號").setDescription("拍賣編號（從 /拍賣 清單 查看）").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("金額").setDescription("出價總額").setRequired(true).setMinValue(1)
        )
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !auction?.enabled || !client.auctionListingsCollection) {
        return interaction.editReply("🔧 拍賣行尚未啟動！");
      }

      const sub = interaction.options.getSubcommand();
      if (sub === "清單") return await handleList(client, interaction);
      if (sub === "掛牌") return await handleSell(client, interaction);
      if (sub === "出價") return await handleBid(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /拍賣:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 拍賣行操作失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

async function handleList(client, interaction) {
  const listings = await auctionService.listActive(client, interaction.guildId, 15);
  if (!listings.length) {
    return interaction.editReply("🏷️ 目前沒有拍賣中的物品，用 `/拍賣 掛牌` 來掛第一件吧！");
  }

  const embed = new EmbedBuilder()
    .setColor(0xe1b12c)
    .setTitle("🏷️ 拍賣行")
    .setDescription("出價請用 `/拍賣 出價 編號 金額`");

  for (const l of listings) {
    const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
    const bidLine = l.current_bid
      ? `目前最高：**${l.current_bid.toLocaleString()}** ${COIN_EMOJI}（${l.bidder_name || "匿名"}）`
      : `起標：**${l.start_price.toLocaleString()}** ${COIN_EMOJI}（尚無人出價）`;
    embed.addFields({
      name: `#${l.listing_id} ・ ${oreLabel(l.ore)} ×${l.qty}`,
      value: `${bidLine}\n賣家：${l.seller_name || "?"} ・ 截止 <t:${expiresEpoch}:R>`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleSell(client, interaction) {
  const ore = interaction.options.getString("礦石");
  const qty = interaction.options.getInteger("數量");
  const startPrice = interaction.options.getInteger("起標價");

  const result = await auctionService.createListing(client, {
    sellerId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    ore,
    qty,
    startPrice,
  });

  if (!result.ok) {
    if (result.reason === "no_ore") return interaction.editReply("❌ 找不到這種礦石。");
    if (result.reason === "low_start") {
      return interaction.editReply(
        `❌ ${result.oreDef.name} 的起標價至少要 **${result.minStart.toLocaleString()}** ${COIN_EMOJI}（系統收購價的 80%）。`
      );
    }
    if (result.reason === "too_many") {
      return interaction.editReply(
        `📦 你同時最多只能掛 **${result.maxActive}** 件拍賣品，先等幾件結標吧。`
      );
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
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🏷️ 掛牌成功")
    .setDescription(
      `**#${l.listing_id}** ・ ${oreLabel(l.ore)} ×${l.qty}\n` +
        `起標價：**${l.start_price.toLocaleString()}** ${COIN_EMOJI}\n` +
        `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）`
    )
    .setFooter({
      text: `成交將收取 ${Math.round((auction.feeRate ?? 0.05) * 100)}% 手續費；無人出價會自動退回礦石。`,
    });

  await interaction.editReply({ embeds: [embed] });
}

async function handleBid(client, interaction) {
  const listingId = (interaction.options.getString("編號") || "").trim().toUpperCase().replace(/^#/, "");
  const amount = interaction.options.getInteger("金額");

  const result = await auctionService.placeBid(client, {
    listingId,
    bidderId: interaction.user.id,
    guildId: interaction.guildId,
    bidderName: interaction.member?.displayName || interaction.user.username,
    member: interaction.member,
    amount,
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return interaction.editReply("❌ 找不到這個拍賣編號（可能已結標）。");
    }
    if (result.reason === "ended") {
      return interaction.editReply("⌛ 這件拍賣品已經結標了。");
    }
    if (result.reason === "own_listing") {
      return interaction.editReply("❌ 不能對自己的拍賣品出價。");
    }
    if (result.reason === "too_low") {
      return interaction.editReply(
        `❌ 出價太低，至少要 **${result.required.toLocaleString()}** ${COIN_EMOJI}。`
      );
    }
    if (result.reason === "insufficient") {
      return interaction.editReply(
        `${MONEY_EMOJI} 餘額不足！你目前 **${result.balance.toLocaleString()}** ${COIN_EMOJI}。`
      );
    }
    if (result.reason === "race") {
      return interaction.editReply("⚡ 剛好有人同時出價，請查看最新價格後再試一次。");
    }
    return interaction.editReply("🔧 出價失敗，請稍後再試。");
  }

  const l = result.listing;
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("✅ 出價成功")
    .setDescription(
      `你對 **#${l.listing_id}** ${oreLabel(l.ore)} ×${l.qty} 出價 **${l.current_bid.toLocaleString()}** ${COIN_EMOJI}，目前最高！\n` +
        `截止 <t:${expiresEpoch}:R>，若被超越會自動退款。`
    );

  await interaction.editReply({ embeds: [embed] });
}
