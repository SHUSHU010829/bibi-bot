const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { getItemDef } = require("./itemCatalog");
const { computeFee, cfg } = require("./barterService");

function lineForItem(def, qty) {
  return `${def.emoji} **${def.name}** ×${qty}`;
}

function listingLine(listing) {
  const offerDef = getItemDef(listing.offer.type, listing.offer.key);
  const wantDef = getItemDef(listing.want.type, listing.want.key);
  if (!offerDef || !wantDef) return null;
  const fee = computeFee(offerDef, listing.offer.qty, wantDef, listing.want.qty);
  const expiresEpoch = Math.floor(new Date(listing.expires_at).getTime() / 1000);
  const titleLine = listing.title ? `📌 ${listing.title}\n` : "";
  return {
    text:
      `${titleLine}**#${listing.listing_id}** ・ <@${listing.seller_id}>\n` +
      `🎁 給出：${lineForItem(offerDef, listing.offer.qty)}\n` +
      `🎯 想要：${lineForItem(wantDef, listing.want.qty)}\n` +
      `-# 手續費（接受方付）：**${fee}** 🪙 ・ 截止：<t:${expiresEpoch}:R>`,
    fee,
  };
}

function buildBoardContainer({ listings, viewerId, total, page = 1, pageSize }) {
  const c = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔁 交易所\n目前有 **${total}** 筆活躍交易`,
      ),
    );

  if (listings.length === 0) {
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("🪹 沒有人在掛單，用 `/交易所 上架` 開第一筆吧！"),
      );
    return c;
  }

  for (const listing of listings) {
    const built = listingLine(listing);
    if (!built) continue;
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(built.text));
    if (listing.seller_id !== viewerId) {
      c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`barter_accept_${viewerId}_${listing.listing_id}`)
            .setLabel(`接受交易（-${built.fee} 🪙）`)
            .setStyle(ButtonStyle.Success)
            .setEmoji("🤝"),
        ),
      );
    } else {
      c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`barter_cancel_${viewerId}_${listing.listing_id}`)
            .setLabel("下架（我的攤位）")
            .setStyle(ButtonStyle.Secondary)
            .setEmoji("🗑️"),
        ),
      );
    }
  }

  const size = pageSize ?? cfg().pageSize ?? 5;
  const totalPages = Math.max(1, Math.ceil(total / size));
  if (totalPages > 1) {
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 第 ${page} / ${totalPages} 頁`),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`barter_page_${viewerId}_${page - 1}`)
            .setLabel("上一頁")
            .setStyle(ButtonStyle.Secondary)
            .setEmoji("⬅️")
            .setDisabled(page <= 1),
          new ButtonBuilder()
            .setCustomId(`barter_page_${viewerId}_${page + 1}`)
            .setLabel("下一頁")
            .setStyle(ButtonStyle.Secondary)
            .setEmoji("➡️")
            .setDisabled(page >= totalPages),
        ),
      );
  }
  return c;
}

function buildOwnerContainer({ listings, viewerId }) {
  const c = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 📦 我的攤位\n目前掛單：**${listings.length}** 筆`),
    );
  if (listings.length === 0) {
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("沒有掛單。用 `/交易所 上架` 開一筆。"),
      );
    return c;
  }
  for (const listing of listings) {
    const built = listingLine(listing);
    if (!built) continue;
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(built.text))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`barter_cancel_${viewerId}_${listing.listing_id}`)
            .setLabel("下架")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("🗑️"),
        ),
      );
  }
  return c;
}

function buildSoldDmMessage({ listing, offerDef, wantDef, acceptorName }) {
  const settledEpoch = Math.floor(
    new Date(listing.settled_at || Date.now()).getTime() / 1000,
  );
  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🤝 交易所成交通知\n-# 掛單 **#${listing.listing_id}** ・ <t:${settledEpoch}:R>`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 📤 你給出\n${offerDef.emoji} **${offerDef.name}** ×${listing.offer.qty}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 📥 你收到\n${wantDef.emoji} **${wantDef.name}** ×${listing.want.qty}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🙋 接受者：**${acceptorName}**`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 用 `/魚袋` 或 `/背包` 查看新到手的物品",
      ),
    );
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

function errorContainer(title, body, hint) {
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
}

module.exports = {
  buildBoardContainer,
  buildOwnerContainer,
  buildSoldDmMessage,
  errorContainer,
  listingLine,
};
