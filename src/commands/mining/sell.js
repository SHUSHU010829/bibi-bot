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

      // 決定要賣的清單 [{ ore, qty, price, value }]
      const toSell = [];
      if (oreArg) {
        const def = mining.ores[oreArg];
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
        toSell.push({ ore: oreArg, qty, price: def.price, value: def.price * qty });
      } else {
        for (const [key, def] of Object.entries(mining.ores)) {
          const have = backpack[key] || 0;
          if (have > 0) {
            toSell.push({ ore: key, qty: have, price: def.price, value: def.price * have });
          }
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
        const def = mining.ores[x.ore];
        return `${def.emoji || "⛏️"} ${def.name} ×${x.qty} → ${x.value.toLocaleString()} ${COIN_EMOJI}`;
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
