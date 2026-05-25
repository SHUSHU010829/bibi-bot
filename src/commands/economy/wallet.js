require("colors");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem } = require("../../config");
const generateWalletCard = require("../../utils/generateWalletCard");
const { getTheme } = require("../../features/shop/catalog");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("錢包")
    .setDescription("查看你的金幣錢包 💰")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const doc =
        (await client.userCoinsCollection.findOne({ userId, guildId })) || {};

      const lifetime = doc.lifetimeCoins || 0;
      const tier =
        lifetime >= 20000 ? "platinum" : lifetime >= 5000 ? "premium" : "standard";

      // 讀取使用者裝備的卡面風格（以 walletTheme 欄位儲存 styleId）
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
        username:
          interaction.member?.displayName || interaction.user.username,
        totalCoins: doc.totalCoins || 0,
        lifetimeCoins: lifetime,
        cardNo: userId.slice(-4),
        tier,
        styleId,
      });

      const attachment = new AttachmentBuilder(buf, {
        name: `wallet-${userId}.png`,
      });

      await interaction.editReply({
        content: `💰 **目前金幣：${(doc.totalCoins || 0).toLocaleString()}**`,
        files: [attachment],
      });
    } catch (error) {
      console.log(`[ERROR] /錢包:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 錢包讀取失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
