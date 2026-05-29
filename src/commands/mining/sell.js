require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const orePriceEngine = require("../../features/market/orePriceEngine");
const eventEngine = require("../../features/event/eventEngine");
const grantCoins = require("../../features/economy/grantCoins");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const { COIN_EMOJI } = require("../../constants/coin");

// 礦石選項（純文字，避免自訂 emoji 在下拉顯示成原始字串）
function oreChoices() {
  return Object.entries(mining?.ores || {}).map(([key, def]) => ({
    name: def.name || key,
    value: key,
  }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("賣礦")
    .setDescription("把背包裡的礦石賣給系統換金幣 🪙（不指定則賣全部）")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("礦石")
        .setDescription("要賣的礦石種類，不選則賣出全部")
        .setRequired(false)
        .addChoices(...oreChoices())
    )
    .addIntegerOption((o) =>
      o
        .setName("數量")
        .setDescription("要賣的數量，不填則賣出該礦石全部")
        .setRequired(false)
        .setMinValue(1)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const oreArg = interaction.options.getString("礦石");
      const qtyArg = interaction.options.getInteger("數量");

      const profile = await getOrCreate(client, userId, guildId);
      const backpack = profile.backpack || {};

      // 依今日礦石行情計價（找不到行情則 fallback 到基礎價）；
      // 限時活動限定礦石不在行情表內，直接以其 def.price 計價。
      const market = await orePriceEngine.getDailyPrices(client);
      const priceMap = market.prices || {};
      const priceOf = (key, def) =>
        typeof priceMap[key] === "number" ? priceMap[key] : def.price;
      // 解析礦石 def：基礎礦石 + 任一活動（含已結束）限定礦石，確保活動結束後仍賣得掉
      const resolveDef = (key) =>
        eventEngine.resolveOreDef(key) || mining.ores[key];

      // 決定要賣的清單 [{ ore, qty, price, value }]
      const toSell = [];
      if (oreArg) {
        const def = resolveDef(oreArg);
        if (!def) return interaction.editReply("❌ 找不到這種礦石。");
        const have = backpack[oreArg] || 0;
        if (have <= 0) {
          return interaction.editReply(`你的背包裡沒有 **${def.name}**。`);
        }
        let qty = qtyArg ? qtyArg : have;
        if (qty > have) {
          return interaction.editReply(
            `你只有 **${have}** 顆 ${def.name}，無法賣出 ${qty} 顆。`
          );
        }
        const price = priceOf(oreArg, def);
        toSell.push({ ore: oreArg, qty, price, value: price * qty });
      } else {
        // 賣全部：掃背包所有礦石（含限定礦石），略過數量為 0 或無法解析者
        for (const key of Object.keys(backpack)) {
          const have = backpack[key] || 0;
          if (have <= 0) continue;
          const def = resolveDef(key);
          if (!def) continue;
          const price = priceOf(key, def);
          toSell.push({ ore: key, qty: have, price, value: price * have });
        }
      }

      if (toSell.length === 0) {
        return interaction.editReply("🎒 你的背包是空的，先去 `/挖礦` 吧！");
      }

      const total = toSell.reduce((s, x) => s + x.value, 0);

      // 扣背包（單次 updateOne，負 $inc）
      const dec = {};
      for (const x of toSell) dec[`backpack.${x.ore}`] = -x.qty;
      await client.miningProfilesCollection.updateOne(
        { userId, guildId },
        { $inc: dec, $set: { updatedAt: new Date() } }
      );

      const grant = await grantCoins(client, {
        userId,
        guildId,
        username: interaction.user.username,
        amount: total,
        source: "mining_sell",
        member: interaction.member,
        meta: { ores: toSell.map((x) => ({ ore: x.ore, qty: x.qty })) },
      });

      const lines = toSell.map((x) => {
        const def = resolveDef(x.ore) || {};
        const base = def.price || 0;
        const pct = base > 0 ? Math.round((x.price / base - 1) * 100) : 0;
        const trend = pct > 0 ? `▲+${pct}%` : pct < 0 ? `▼${pct}%` : "▬";
        return `${def.emoji || "⛏️"} ${def.name} ×${x.qty} ＠${x.price.toLocaleString()} ${trend} → ${x.value.toLocaleString()} ${COIN_EMOJI}`;
      });

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${COIN_EMOJI} 賣礦成功\n${lines.join("\n")}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**總收入**\n+${total.toLocaleString()} ${COIN_EMOJI}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**目前餘額**\n${(grant?.doc?.totalCoins ?? 0).toLocaleString()} ${COIN_EMOJI}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 依今日行情計價，用 /行情 查看當日礦石收購價",
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      // 賣礦任務進度（非阻塞）：出清 +1、本週累積收入
      await applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId,
          guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        [
          { questId: "daily_sell_ore" },
          { questId: "weekly_sell_value", type: "meta", key: "sellValue", delta: total },
        ]
      );
    } catch (error) {
      console.log(`[ERROR] /賣礦:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 賣礦失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
