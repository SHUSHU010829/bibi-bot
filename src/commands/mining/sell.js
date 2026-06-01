require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, fishing } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const orePriceEngine = require("../../features/market/orePriceEngine");
const eventEngine = require("../../features/event/eventEngine");
const grantCoins = require("../../features/economy/grantCoins");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const { COIN_EMOJI } = require("../../constants/coin");

// 統一選項：礦石 + 魚類，value 格式 "ore:<key>" / "fish:<key>"
function sellChoices() {
  const choices = [];
  for (const [key, def] of Object.entries(mining?.ores || {})) {
    choices.push({ name: `${def.name}（礦石）`, value: `ore:${key}` });
  }
  for (const [key, def] of Object.entries(fishing?.fish || {})) {
    choices.push({ name: `${def.name}（魚類）`, value: `fish:${key}` });
  }
  return choices;
}

function trendLabel(price, base) {
  if (!base) return "";
  const pct = Math.round((price / base - 1) * 100);
  return pct > 0 ? ` ▲+${pct}%` : pct < 0 ? ` ▼${pct}%` : " ▬";
}

module.exports = {
  channelBuckets: ["mining", "fishing", "marketplace"],
  data: new SlashCommandBuilder()
    .setName("賣出")
    .setDescription("把礦石或魚賣給系統換金幣，依當日行情計價 🪙")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("物品")
        .setDescription("要賣的礦石或魚種")
        .setRequired(true)
        .addChoices(...sellChoices())
    )
    .addIntegerOption((o) =>
      o
        .setName("數量")
        .setDescription("要賣的數量（不填則賣出全部）")
        .setRequired(false)
        .setMinValue(1)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!client.miningProfilesCollection) {
        return interaction.editReply("🔧 系統尚未啟動！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const itemArg = interaction.options.getString("物品");
      const qtyArg = interaction.options.getInteger("數量");

      const [itemType, itemKey] = itemArg.split(":");

      if (itemType === "ore") {
        return await handleSellOre(client, interaction, { userId, guildId, itemKey, qtyArg });
      }
      if (itemType === "fish") {
        return await handleSellFish(client, interaction, { userId, guildId, itemKey, qtyArg });
      }
      return interaction.editReply("❌ 未知物品類型。");
    } catch (error) {
      console.log(`[ERROR] /賣出:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 賣出失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

// ─── 賣礦 ────────────────────────────────────────────────────────────────────
async function handleSellOre(client, interaction, { userId, guildId, itemKey, qtyArg }) {
  if (!mining?.enabled) {
    return interaction.editReply("🔧 挖礦系統尚未啟動！");
  }

  const profile = await getOrCreate(client, userId, guildId);
  const backpack = profile.backpack || {};

  const def = eventEngine.resolveOreDef(itemKey) || mining.ores[itemKey];
  if (!def) return interaction.editReply("❌ 找不到這種礦石。");

  const have = backpack[itemKey] || 0;
  if (have <= 0) {
    return interaction.editReply(`你的背包裡沒有 **${def.name}**。`);
  }

  const qty = qtyArg ? Math.min(qtyArg, have) : have;
  if (qtyArg && qtyArg > have) {
    return interaction.editReply(`你只有 **${have}** 顆 ${def.name}，無法賣出 ${qtyArg} 顆。`);
  }

  const market = await orePriceEngine.getDailyPrices(client);
  const priceMap = market.prices || {};
  const price = typeof priceMap[itemKey] === "number" ? priceMap[itemKey] : def.price;
  const total = price * qty;
  const trend = trendLabel(price, def.price);

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [`backpack.${itemKey}`]: -qty }, $set: { updatedAt: new Date() } }
  );

  const grant = await grantCoins(client, {
    userId, guildId,
    username: interaction.user.username,
    amount: total,
    source: "mining_sell",
    member: interaction.member,
    meta: { ores: [{ ore: itemKey, qty }] },
  });

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${COIN_EMOJI} 賣出成功\n` +
        `${def.emoji || "⛏️"} **${def.name}** ×${qty} ＠${price.toLocaleString()}${trend}\n` +
        `→ **+${total.toLocaleString()} ${COIN_EMOJI}**`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前餘額**　${(grant?.doc?.totalCoins ?? 0).toLocaleString()} ${COIN_EMOJI}\n` +
        `-# 依今日行情計價・用 /行情 查看當日收購價`
      )
    );

  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });

  await applyQuestHooks(
    client,
    { interaction, user: interaction.user, userId, guildId, member: interaction.member, username: interaction.user.username },
    [
      { questId: "daily_sell_ore" },
      { questId: "weekly_sell_value", type: "meta", key: "sellValue", delta: total },
    ]
  );
}

// ─── 賣魚 ────────────────────────────────────────────────────────────────────
async function handleSellFish(client, interaction, { userId, guildId, itemKey, qtyArg }) {
  if (!fishing?.enabled) {
    return interaction.editReply("🔧 釣魚系統尚未啟動！");
  }

  const def = fishing.fish?.[itemKey];
  if (!def) return interaction.editReply("❌ 找不到這種魚。");

  const profile = await getOrCreate(client, userId, guildId);
  const fishBag = profile.fish_bag || {};
  const have = fishBag[itemKey] || 0;

  if (have <= 0) {
    return interaction.editReply(`你的魚袋裡沒有 **${def.name}**。`);
  }

  const qty = qtyArg ? Math.min(qtyArg, have) : have;
  if (qtyArg && qtyArg > have) {
    return interaction.editReply(`你只有 **${have}** 條 ${def.name}，無法賣出 ${qtyArg} 條。`);
  }

  const market = await orePriceEngine.getDailyFishPrices(client);
  const priceMap = market.prices || {};
  const price = typeof priceMap[itemKey] === "number" ? priceMap[itemKey] : def.price;
  const total = price * qty;
  const trend = trendLabel(price, def.price);

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [`fish_bag.${itemKey}`]: -qty }, $set: { updatedAt: new Date() } }
  );

  const grant = await grantCoins(client, {
    userId, guildId,
    username: interaction.user.username,
    amount: total,
    source: "fish_sell",
    member: interaction.member,
    meta: { fish: itemKey, qty },
  });

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${COIN_EMOJI} 賣出成功\n` +
        `${def.emoji} **${def.name}** ×${qty} ＠${price.toLocaleString()}${trend}\n` +
        `→ **+${total.toLocaleString()} ${COIN_EMOJI}**`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前餘額**　${(grant?.doc?.totalCoins ?? 0).toLocaleString()} ${COIN_EMOJI}\n` +
        `-# 依今日行情計價・魚價每日波動`
      )
    );

  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });

  applyQuestHooks(client, {
    userId, guildId, type: "fish_sell_coins", value: total,
  }).catch(() => {});
}
