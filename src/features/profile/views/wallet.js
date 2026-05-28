require("colors");
const { AttachmentBuilder } = require("discord.js");

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
  if (client.userLevelsCollection) {
    const lv = await client.userLevelsCollection
      .findOne({ userId, guildId }, { projection: { walletTheme: 1 } })
      .catch(() => null);
    if (lv?.walletTheme) {
      const themeMeta = getTheme(lv.walletTheme);
      styleId = themeMeta?.styleId || lv.walletTheme;
    }
  }

  const buf = await generateWalletCard({
    userId,
    guildId,
    username: member?.displayName || target.username,
    totalCoins: doc.totalCoins || 0,
    lifetimeCoins: lifetime,
    cardNo: userId.slice(-4),
    tier,
    styleId,
  });

  const attachment = new AttachmentBuilder(buf, {
    name: `wallet-${userId}.png`,
  });

  return {
    content: `${MONEY_EMOJI} **目前金幣：${(doc.totalCoins || 0).toLocaleString()}**`,
    files: [attachment],
  };
}

module.exports = { buildWalletView };
