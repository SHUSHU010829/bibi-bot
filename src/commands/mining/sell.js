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

const { mining, fishing, farming } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const orePriceEngine = require("../../features/market/orePriceEngine");
const eventEngine = require("../../features/event/eventEngine");
const grantCoins = require("../../features/economy/grantCoins");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const { COIN_EMOJI } = require("../../constants/coin");

const SELL_CONFIRM_PREFIX = "sellc_ok_";
const SELL_CANCEL_PREFIX = "sellc_no_";

const TYPE_UNIT = { ore: "顆", fish: "條", veggie: "個" };

function sellChoices() {
  const choices = [];
  for (const [key, def] of Object.entries(mining?.ores || {})) {
    if (!def.price) continue;
    choices.push({ name: `${def.name}（礦石）`, value: `ore:${key}` });
  }
  for (const [key, def] of Object.entries(fishing?.fish || {})) {
    choices.push({ name: `${def.name}（魚類）`, value: `fish:${key}` });
  }
  for (const [key, def] of Object.entries(farming?.crops || {})) {
    choices.push({ name: `${def.name}（農產品）`, value: `veggie:${key}` });
  }
  return choices.slice(0, 25);
}

function trendLabel(price, base) {
  if (!base) return "";
  const pct = Math.round((price / base - 1) * 100);
  return pct > 0 ? ` ▲+${pct}%` : pct < 0 ? ` ▼${pct}%` : " ▬";
}

function errorContainer(title, detail, hint) {
  const c = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`));
  if (detail) {
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(detail));
  }
  if (hint) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return c;
}

async function previewSell(client, { userId, guildId, itemType, itemKey, qtyArg }) {
  if (itemType === "ore") {
    if (!mining?.enabled) {
      return { ok: false, error: errorContainer("🔧 挖礦系統尚未啟動", null, "請稍後再試或聯絡管理員") };
    }
    const def = eventEngine.resolveOreDef(itemKey) || mining.ores[itemKey];
    if (!def) {
      return { ok: false, error: errorContainer("❌ 找不到這種礦石", `key=${itemKey}`, "請從選單重新選擇") };
    }
    const profile = await getOrCreate(client, userId, guildId);
    const have = (profile.backpack || {})[itemKey] || 0;
    if (have <= 0) {
      return {
        ok: false,
        error: errorContainer(
          `📭 背包裡沒有 ${def.name}`,
          `目前持有：**0** ${TYPE_UNIT.ore}`,
          "用 /挖礦 取得礦石後再來"
        ),
      };
    }
    if (qtyArg && qtyArg > have) {
      return {
        ok: false,
        error: errorContainer(
          `❌ 數量不足`,
          `想賣：**${qtyArg}** ${TYPE_UNIT.ore}\n持有：**${have}** ${TYPE_UNIT.ore} ${def.name}`,
          "不填數量即可賣出全部"
        ),
      };
    }
    const qty = qtyArg ? Math.min(qtyArg, have) : have;
    const market = await orePriceEngine.getDailyPrices(client);
    const price = typeof market.prices?.[itemKey] === "number" ? market.prices[itemKey] : def.price;
    return {
      ok: true,
      def, qty, have, price,
      total: price * qty,
      trend: trendLabel(price, def.price),
      emoji: def.emoji || "⛏️",
      unit: TYPE_UNIT.ore,
    };
  }

  if (itemType === "fish") {
    if (!fishing?.enabled) {
      return { ok: false, error: errorContainer("🔧 釣魚系統尚未啟動", null, "請稍後再試或聯絡管理員") };
    }
    const def = fishing.fish?.[itemKey];
    if (!def) {
      return { ok: false, error: errorContainer("❌ 找不到這種魚", `key=${itemKey}`, "請從選單重新選擇") };
    }
    const profile = await getOrCreate(client, userId, guildId);
    const have = (profile.fish_bag || {})[itemKey] || 0;
    if (have <= 0) {
      return {
        ok: false,
        error: errorContainer(
          `📭 魚袋裡沒有 ${def.name}`,
          `目前持有：**0** ${TYPE_UNIT.fish}`,
          "用 /釣魚 取得魚類後再來"
        ),
      };
    }
    if (qtyArg && qtyArg > have) {
      return {
        ok: false,
        error: errorContainer(
          `❌ 數量不足`,
          `想賣：**${qtyArg}** ${TYPE_UNIT.fish}\n持有：**${have}** ${TYPE_UNIT.fish} ${def.name}`,
          "不填數量即可賣出全部"
        ),
      };
    }
    const qty = qtyArg ? Math.min(qtyArg, have) : have;
    const market = await orePriceEngine.getDailyFishPrices(client);
    const price = typeof market.prices?.[itemKey] === "number" ? market.prices[itemKey] : def.price;
    return {
      ok: true,
      def, qty, have, price,
      total: price * qty,
      trend: trendLabel(price, def.price),
      emoji: def.emoji || "🐟",
      unit: TYPE_UNIT.fish,
    };
  }

  if (itemType === "veggie") {
    if (!farming?.enabled) {
      return { ok: false, error: errorContainer("🔧 農場系統尚未啟動", null, "請稍後再試或聯絡管理員") };
    }
    const def = farming.crops?.[itemKey];
    if (!def) {
      return { ok: false, error: errorContainer("❌ 找不到這種農產品", `key=${itemKey}`, "請從選單重新選擇") };
    }
    const profile = await getOrCreate(client, userId, guildId);
    const have = (profile.veggie_bag || {})[itemKey] || 0;
    if (have <= 0) {
      return {
        ok: false,
        error: errorContainer(
          `📭 菜籃裡沒有 ${def.name}`,
          `目前持有：**0** ${TYPE_UNIT.veggie}`,
          "用 /採收 取得蔬菜後再來"
        ),
      };
    }
    if (qtyArg && qtyArg > have) {
      return {
        ok: false,
        error: errorContainer(
          `❌ 數量不足`,
          `想賣：**${qtyArg}** ${TYPE_UNIT.veggie}\n持有：**${have}** ${TYPE_UNIT.veggie} ${def.name}`,
          "不填數量即可賣出全部"
        ),
      };
    }
    const qty = qtyArg ? Math.min(qtyArg, have) : have;
    const market = await orePriceEngine.getDailyCropPrices(client);
    const base = orePriceEngine.cropBasePrice(itemKey);
    const price = typeof market.prices?.[itemKey] === "number" ? market.prices[itemKey] : base;
    return {
      ok: true,
      def, qty, have, price,
      total: price * qty,
      trend: trendLabel(price, base),
      emoji: def.emoji || "🥕",
      unit: TYPE_UNIT.veggie,
    };
  }

  return { ok: false, error: errorContainer("❌ 未知物品類型", `itemType=${itemType}`, "請從選單重新選擇") };
}

function buildConfirmContainer({ userId, itemType, itemKey, preview, qtyArg }) {
  const { def, qty, have, price, total, trend, emoji, unit } = preview;
  const qtyToken = qtyArg ? String(qty) : "all";

  const intentLine = qtyArg
    ? `-# 你指定賣出 **${qty}** ${unit}（共持有 ${have} ${unit}）`
    : `-# 未指定數量 → 將賣出**全部 ${qty}** ${unit}`;

  return new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🤔 確認賣給系統？\n` +
        `${emoji} **${def.name}** ×${qty} ＠${price.toLocaleString()}${trend}\n` +
        `→ 預估收益 **${total.toLocaleString()} ${COIN_EMOJI}**（系統收購）`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${intentLine}\n` +
        `-# 💡 想賣給玩家更高價？用 \`/市集 賣礦\` 或 \`/市集 賣魚\` 上架\n` +
        `-# 點下方紅色按鈕確認，否則本次不會扣物品也不會給錢`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${SELL_CONFIRM_PREFIX}${userId}_${itemType}_${qtyToken}_${itemKey}`)
          .setLabel(`確認賣給系統 ×${qty}（+${total.toLocaleString()}）`)
          .setStyle(ButtonStyle.Danger),
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${SELL_CANCEL_PREFIX}${userId}`)
          .setLabel("取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );
}

async function executeSell(client, interaction, { userId, guildId, itemType, itemKey, qtyArg }) {
  const preview = await previewSell(client, { userId, guildId, itemType, itemKey, qtyArg });
  if (!preview.ok) {
    return interaction.editReply({ components: [preview.error], flags: MessageFlags.IsComponentsV2 });
  }

  if (itemType === "ore") {
    return finalizeOreSell(client, interaction, { userId, guildId, itemKey, preview });
  }
  if (itemType === "fish") {
    return finalizeFishSell(client, interaction, { userId, guildId, itemKey, preview });
  }
  if (itemType === "veggie") {
    return finalizeVeggieSell(client, interaction, { userId, guildId, itemKey, preview });
  }
}

async function finalizeOreSell(client, interaction, { userId, guildId, itemKey, preview }) {
  const { def, qty, price, total, trend } = preview;

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

  const granted = grant?.granted ?? total;
  const bonusLine = granted > total
    ? `\n-# 含倍率加成（基礎 ${total.toLocaleString()} → 實得 ${granted.toLocaleString()}）`
    : "";

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${COIN_EMOJI} 賣出成功\n` +
        `${def.emoji || "⛏️"} **${def.name}** ×${qty} ＠${price.toLocaleString()}${trend}\n` +
        `→ **+${granted.toLocaleString()} ${COIN_EMOJI}**${bonusLine}`
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

async function finalizeFishSell(client, interaction, { userId, guildId, itemKey, preview }) {
  const { def, qty, price, total, trend } = preview;

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

  const granted = grant?.granted ?? total;
  const bonusLine = granted > total
    ? `\n-# 含倍率加成（基礎 ${total.toLocaleString()} → 實得 ${granted.toLocaleString()}）`
    : "";

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${COIN_EMOJI} 賣出成功\n` +
        `${def.emoji} **${def.name}** ×${qty} ＠${price.toLocaleString()}${trend}\n` +
        `→ **+${granted.toLocaleString()} ${COIN_EMOJI}**${bonusLine}`
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

async function finalizeVeggieSell(client, interaction, { userId, guildId, itemKey, preview }) {
  const { def, qty, price, total, trend } = preview;

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [`veggie_bag.${itemKey}`]: -qty }, $set: { updatedAt: new Date() } },
  );

  const grant = await grantCoins(client, {
    userId, guildId,
    username: interaction.user.username,
    amount: total,
    source: "farm_sell",
    member: interaction.member,
    meta: { veggie: itemKey, qty },
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
        `-# 依今日行情計價・用 /行情 查看當日收購價`
      )
    );

  await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

module.exports = {
  channelBuckets: ["mining", "fishing", "marketplace", "farm"],
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

  SELL_CONFIRM_PREFIX,
  SELL_CANCEL_PREFIX,
  executeSell,

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!client.miningProfilesCollection) {
        return interaction.editReply({
          components: [errorContainer("🔧 系統尚未啟動", null, "請稍後再試或聯絡管理員")],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const itemArg = interaction.options.getString("物品");
      const qtyArg = interaction.options.getInteger("數量");

      const [itemType, itemKey] = itemArg.split(":");

      const preview = await previewSell(client, { userId, guildId, itemType, itemKey, qtyArg });
      if (!preview.ok) {
        return interaction.editReply({ components: [preview.error], flags: MessageFlags.IsComponentsV2 });
      }

      const container = buildConfirmContainer({ userId, itemType, itemKey, preview, qtyArg });
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      console.log(`[ERROR] /賣出:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 賣出失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
