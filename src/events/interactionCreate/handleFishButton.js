// 釣魚系統按鈕處理器（Phase S4）
//
// 支援的 customId：
//   fish_sell_<ownerId>_<fishKey>   — 從 /釣魚 或 /魚袋 的結果直接賣掉一種魚（全部）
//   fish_bag_<ownerId>              — 顯示目前魚袋（ephemeral follow-up）

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { fishing } = require("../../config");
const { getFishingProfile } = require("../../features/fishing/fishService");
const { buildBackpackView } = require("../../features/shop/backpackView");
const grantCoins = require("../../features/economy/grantCoins");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const { COIN_EMOJI } = require("../../constants/coin");
const SELL_PREFIX = "fish_sell_";
const BAG_PREFIX  = "fish_bag_";

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;

  // ── 賣魚按鈕 ─────────────────────────────────────────────
  if (customId.startsWith(SELL_PREFIX)) {
    const rest = customId.slice(SELL_PREFIX.length);
    const sepIdx = rest.indexOf("_");
    if (sepIdx < 0) return;
    const ownerId = rest.slice(0, sepIdx);
    const fishKey = rest.slice(sepIdx + 1);

    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的魚袋！",
        flags: MessageFlags.Ephemeral,
      });
    }

    const fishDef = fishing?.fish?.[fishKey];
    if (!fishDef) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const profile = await getFishingProfile(client, userId, guildId);
      const fishBag = profile.fish_bag || {};
      const have = fishBag[fishKey] || 0;

      if (have <= 0) {
        return interaction.editReply(
          `❌ 魚袋裡已經沒有 ${fishDef.emoji} **${fishDef.name}** 了！`
        );
      }

      const total = fishDef.price * have;

      await client.miningProfilesCollection.updateOne(
        { userId, guildId },
        {
          $inc: { [`fish_bag.${fishKey}`]: -have },
          $set: { updatedAt: new Date() },
        }
      );

      const grant = await grantCoins(client, {
        userId,
        guildId,
        username: interaction.user.username,
        amount: total,
        source: "fish_sell",
        member: interaction.member,
        meta: { fish: fishKey, qty: have },
      });

      const balance = grant?.doc?.totalCoins ?? 0;
      const granted = grant?.granted ?? total;
      const bonusLine = granted > total
        ? `\n-# 含倍率加成（基礎 ${total.toLocaleString()} → 實得 ${granted.toLocaleString()}）`
        : "";

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${fishDef.emoji} **${fishDef.name}** ×${have} 賣出！\n` +
            `${COIN_EMOJI} **+${granted.toLocaleString()} 幣**（單價 ${fishDef.price} 幣）${bonusLine}\n` +
            `餘額：${balance.toLocaleString()} 幣`
          )
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      applyQuestHooks(client, { userId, guildId, type: "fish_sell_coins", value: total }).catch(() => {});
    } catch (err) {
      console.log(`[ERROR] fish_sell button:\n${err}`.red);
      await interaction.editReply("🔧 賣魚失敗，請稍後再試。").catch(() => {});
    }
    return;
  }

  // ── 查看背包（釣魚分類）按鈕 ──────────────────────────────
  if (customId.startsWith(BAG_PREFIX)) {
    const ownerId = customId.slice(BAG_PREFIX.length);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的背包！",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const view = await buildBackpackView(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        displayName:
          interaction.member?.displayName ||
          interaction.user.displayName ||
          interaction.user.username,
        category: "fish",
      });
      await interaction.editReply(view);
    } catch (err) {
      console.log(`[ERROR] fish_bag button:\n${err}`.red);
      await interaction.editReply("🔧 查詢失敗，請稍後再試。").catch(() => {});
    }
    return;
  }
};
