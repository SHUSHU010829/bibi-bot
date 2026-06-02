require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { barter } = require("../../config");
const barterService = require("../../features/barter/barterService");
const { listAllChoices, parseChoice, getItemDef } = require("../../features/barter/itemCatalog");
const {
  buildBoardContainer,
  buildOwnerContainer,
  errorContainer,
} = require("../../features/barter/barterView");

const ITEM_CHOICES = listAllChoices();

function channelGuard(interaction) {
  const allowed = barter?.allowedChannelId;
  if (!allowed) return true;
  return interaction.channelId === allowed;
}

function notAllowedHere(allowedId) {
  return errorContainer(
    "🚫 這裡不能用交易所",
    `請到 <#${allowedId}> 使用 \`/交易所\` 指令。`,
    "限定頻道是為了讓交易資訊集中、避免洗版",
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("交易所")
    .setDescription("玩家之間的物物交換告示板 🔁")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("上架")
        .setDescription("掛一筆交易（給出 X 換 Y）")
        .addStringOption((o) =>
          o
            .setName("給出物品")
            .setDescription("你要給出什麼")
            .setRequired(true)
            .addChoices(...ITEM_CHOICES),
        )
        .addIntegerOption((o) =>
          o.setName("給出數量").setDescription("給出的數量").setRequired(true).setMinValue(1),
        )
        .addStringOption((o) =>
          o
            .setName("想要物品")
            .setDescription("你想換到什麼")
            .setRequired(true)
            .addChoices(...ITEM_CHOICES),
        )
        .addIntegerOption((o) =>
          o.setName("想要數量").setDescription("想要的數量").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("列表")
        .setDescription("瀏覽所有掛單")
        .addIntegerOption((o) =>
          o.setName("頁碼").setDescription("從 1 開始").setMinValue(1).setRequired(false),
        ),
    )
    .addSubcommand((s) => s.setName("我的").setDescription("查看 / 下架自己的掛單"))
    .addSubcommand((s) =>
      s
        .setName("取消")
        .setDescription("用編號取消自己的掛單")
        .addIntegerOption((o) =>
          o.setName("編號").setDescription("掛單編號").setRequired(true).setMinValue(1),
        ),
    ),

  run: async (client, interaction) => {
    if (!barter?.enabled) {
      return interaction.reply({ content: "🔧 交易所尚未啟動", flags: MessageFlags.Ephemeral });
    }
    if (!channelGuard(interaction)) {
      return interaction.reply({
        components: [notAllowedHere(barter.allowedChannelId)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "上架") return runCreate(client, interaction);
      if (sub === "列表") return runList(client, interaction);
      if (sub === "我的") return runMine(client, interaction);
      if (sub === "取消") return runCancel(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /交易所 ${sub}:\n${error}\n${error.stack}`.red);
      const reply = {
        content: "🔧 操作失敗，請呼叫舒舒！",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
  channelBuckets: ["marketplace"],
};

async function runCreate(client, interaction) {
  await interaction.deferReply();
  const offer = parseChoice(interaction.options.getString("給出物品"));
  const want = parseChoice(interaction.options.getString("想要物品"));
  const offerQty = interaction.options.getInteger("給出數量");
  const wantQty = interaction.options.getInteger("想要數量");

  if (!offer || !want) {
    return interaction.editReply({
      components: [errorContainer("❌ 物品錯誤", "找不到指定的物品。", "重新選擇下拉選項")],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const result = await barterService.createListing(client, {
    sellerId: interaction.user.id,
    sellerName: interaction.user.username,
    guildId: interaction.guildId,
    offerType: offer.type, offerKey: offer.key, offerQty,
    wantType: want.type, wantKey: want.key, wantQty,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [createErrorOf(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const { listing, offerDef, wantDef, fee } = result;
  const expiresEpoch = Math.floor(new Date(listing.expires_at).getTime() / 1000);
  const c = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔁 上架成功 #${listing.listing_id}\n` +
          `🎁 給出：${offerDef.emoji} **${offerDef.name}** ×${listing.offer.qty}\n` +
          `🎯 想要：${wantDef.emoji} **${wantDef.name}** ×${listing.want.qty}\n` +
          `-# 接受方需付手續費 **${fee}** 🪙 ・ 截止：<t:${expiresEpoch}:R>`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`barter_accept_${listing.seller_id}_${listing.listing_id}`)
          .setLabel(`接受交易（-${fee} 🪙）`)
          .setStyle(ButtonStyle.Success)
          .setEmoji("🤝"),
      ),
    );
  return interaction.editReply({
    components: [c],
    flags: MessageFlags.IsComponentsV2,
  });
}

function createErrorOf(result) {
  if (result.reason === "disabled") {
    return errorContainer("🔧 交易所尚未啟動", "請稍候。", "");
  }
  if (result.reason === "no_offer_item" || result.reason === "no_want_item") {
    return errorContainer("❌ 物品錯誤", "找不到指定的物品。", "重新選擇下拉選項");
  }
  if (result.reason === "same_item") {
    return errorContainer("❌ 不能同物交換", "給出與想要不能是同一個物品。", "");
  }
  if (result.reason === "untradeable") {
    return errorContainer("❌ 物品不可交易", "其中一方沒有可計算手續費的價格。", "");
  }
  if (result.reason === "too_many") {
    return errorContainer(
      "❌ 掛單已達上限",
      `每人最多同時 **${result.max}** 筆掛單。`,
      "先用 `/交易所 我的` 下架幾筆再來",
    );
  }
  if (result.reason === "insufficient") {
    return errorContainer(
      "❌ 物品不足",
      `你只有 **${result.have}** 個 ${result.offerDef.emoji} ${result.offerDef.name}。`,
      "減少數量或先去蒐集",
    );
  }
  return errorContainer("🔧 上架失敗", `原因：\`${result.reason}\``, "請稍後再試");
}

async function runList(client, interaction) {
  await interaction.deferReply();
  const c = barterService.cfg();
  const page = Math.max(1, interaction.options.getInteger("頁碼") || 1);
  const pageSize = c.pageSize ?? 5;
  const { listings, total } = await barterService.listActive(client, interaction.guildId, {
    limit: pageSize,
    skip: (page - 1) * pageSize,
  });
  const container = buildBoardContainer({
    listings,
    viewerId: interaction.user.id,
    total,
    page,
    pageSize,
  });
  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runMine(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const listings = await barterService.listByOwner(client, interaction.guildId, interaction.user.id);
  const container = buildOwnerContainer({ listings, viewerId: interaction.user.id });
  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function runCancel(client, interaction) {
  await interaction.deferReply();
  const listingId = interaction.options.getInteger("編號");
  const result = await barterService.cancelListing(client, {
    listingId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });
  if (!result.ok) {
    const map = {
      not_found: ["❌ 找不到掛單", `編號 #${listingId} 不存在。`, "用 `/交易所 我的` 看你的掛單"],
      not_owner: ["❌ 不是你的掛單", "你只能下架自己的掛單。", ""],
      not_active: ["❌ 已不在售", "這筆掛單已經成交、過期或取消。", ""],
      race: ["⚠️ 競態", "操作衝突，請再試一次。", ""],
    };
    const [t, b, h] = map[result.reason] || ["🔧 取消失敗", `原因：\`${result.reason}\``, ""];
    return interaction.editReply({
      components: [errorContainer(t, b, h)],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const c = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🗑️ 已下架 #${listingId}\n託管物品已退回你的袋子。`,
      ),
    );
  await interaction.editReply({
    components: [c],
    flags: MessageFlags.IsComponentsV2,
  });
}
