require("colors");
const {
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");

const { coinSystem } = require("../../../config");
const generateWalletCard = require("../../../utils/generateWalletCard");
const { getTheme } = require("../../shop/catalog");
const { MONEY_EMOJI } = require("../../../constants/coin");

async function buildWalletView(client, { target, member, guildId }) {
  if (!coinSystem?.enabled) {
    return { content: "🔧 金幣系統尚未啟動！" };
  }
  if (!client.userCoinsCollection) {
    return { content: "🔧 金幣系統尚未啟動，請聯絡舒舒！" };
  }

  const userId = target.id;

  const doc =
    (await client.userCoinsCollection.findOne({ userId, guildId })) || {};

  const lifetime = doc.lifetimeCoins || 0;
  const tier =
    lifetime >= 20000 ? "platinum" : lifetime >= 5000 ? "premium" : "standard";

  let styleId = null;
  let customCardNumber = null;
  if (client.userLevelsCollection) {
    const lv = await client.userLevelsCollection
      .findOne(
        { userId, guildId },
        { projection: { walletTheme: 1, customCardNumber: 1 } }
      )
      .catch(() => null);
    if (lv?.walletTheme) {
      const themeMeta = getTheme(lv.walletTheme);
      styleId = themeMeta?.styleId || lv.walletTheme;
    }
    customCardNumber = lv?.customCardNumber || null;
  }

  const displayName = member?.displayName || target.username;

  let attachment = null;
  let fileName = null;
  try {
    const buf = await generateWalletCard({
      userId,
      guildId,
      username: displayName,
      totalCoins: doc.totalCoins || 0,
      lifetimeCoins: lifetime,
      cardNo: userId.slice(-4),
      tier,
      styleId,
      cardNumber: customCardNumber,
    });
    fileName = `wallet-${userId}.png`;
    attachment = new AttachmentBuilder(buf, { name: fileName });
  } catch (cardErr) {
    console.log(
      `[WARN] wallet card render failed, falling back to text: ${cardErr.message}`.yellow
    );
  }

  const tierLabel =
    tier === "platinum" ? "🌟 Platinum" : tier === "premium" ? "✨ Premium" : "Standard";

  const pending =
    (doc.chatBuffer?.pending?.message || 0) +
    (doc.chatBuffer?.pending?.voice || 0) +
    (doc.chatBuffer?.pending?.reaction || 0);
  const pendingLine = pending > 0 ? ` ・ 待入帳 **+${pending.toLocaleString()}**` : "";

  const container = new ContainerBuilder()
    .setAccentColor(0xffd166)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${MONEY_EMOJI} ${displayName} 的錢包\n-# 目前金幣 **${(doc.totalCoins || 0).toLocaleString()}** ・ 累積 **${lifetime.toLocaleString()}**${pendingLine}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (attachment) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`)
      )
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**卡號**　•••• ${userId.slice(-4)}\n**等級**　${tierLabel}`
      )
    );
  }

  return {
    useV2: true,
    components: [container],
    files: attachment ? [attachment] : [],
  };
}

module.exports = { buildWalletView };
