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

const { coinSystem, bank } = require("../../config");
const goldService = require("../../features/bank/goldService");
const { COLOR, fmt, errorContainer } = require("../../features/bank/bankView");

function termChoices() {
  const terms = bank?.gold?.term?.terms || [];
  return terms.map((t) => ({
    name: `${t.days} 天（到期 +${(t.rate * 100).toFixed(1)}%）`,
    value: t.days,
  }));
}

const TERM_CHOICES = termChoices();

function unit() {
  return bank?.gold?.unitLabel || "克";
}

function replyError(interaction, opts) {
  return interaction.editReply({
    components: [errorContainer(opts)],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("黃金")
    .setDescription("黃金存摺：跟著金價低買高賣、存黃金保值 🪙")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName("查詢").setDescription("查看金價、金庫持有量與黃金定存"))
    .addSubcommand((sub) =>
      sub
        .setName("買進")
        .setDescription("用金幣向銀行買黃金存進金庫")
        .addIntegerOption((o) =>
          o.setName("數量").setDescription(`買進克數`).setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("賣出")
        .setDescription("把金庫黃金賣回銀行換金幣")
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("賣出克數").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("熔金")
        .setDescription("把挖礦背包的黃金礦熔進金庫")
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("熔化的黃金礦數量").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("定存")
        .setDescription("把金庫黃金鎖倉，到期領回更多黃金")
        .addIntegerOption((o) =>
          o.setName("數量").setDescription("鎖倉克數").setRequired(true).setMinValue(1),
        )
        .addIntegerOption((o) =>
          o
            .setName("天數")
            .setDescription("鎖倉期間")
            .setRequired(true)
            .addChoices(...(TERM_CHOICES.length ? TERM_CHOICES : [{ name: "7 天", value: 7 }])),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("提領")
        .setDescription("領回黃金定存（未到期扣違約金）")
        .addStringOption((o) =>
          o.setName("存單").setDescription("黃金存單 ID（從 /黃金 查詢取得）").setRequired(true),
        ),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) return interaction.editReply("🔧 金幣系統尚未啟動！");
      if (!bank?.gold?.enabled) return interaction.editReply("🔧 黃金存摺尚未開放。");
      if (!client.goldHoldingsCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 黃金存摺資料庫尚未啟動，請聯絡舒舒！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const avatarHash = interaction.user.avatar;
      const member = interaction.member;
      const sub = interaction.options.getSubcommand();
      const U = unit();

      if (sub === "查詢") return renderQuery(client, interaction, { userId, guildId, U });

      if (sub === "買進") {
        const units = interaction.options.getInteger("數量");
        const res = await goldService.buy(client, { userId, guildId, username, member, avatarHash, units });
        if (!res.ok) {
          if (res.reason === "range") {
            return replyError(interaction, {
              title: "❌ 買進數量超出範圍",
              detail: `單次買進需在 **${fmt(res.min)}** ~ **${fmt(res.max)}** ${U} 之間。`,
            });
          }
          if (res.reason === "balance") {
            return replyError(interaction, {
              title: "💰 餘額不足",
              detail: `買 ${fmt(units)} ${U} 需要 **${fmt(res.cost)}**（買進價 ${fmt(res.prices.buy)}/${U}），錢包只有 ${fmt(res.balance)}。`,
            });
          }
          return interaction.editReply("🔧 黃金買進失敗，請稍後再試。");
        }
        return interaction.editReply(
          `🪙 **買進成功**\n` +
            `・買進 **${fmt(res.units)}** ${U}（單價 ${fmt(res.prices.buy)}／共 ${fmt(res.cost)} 幣）\n` +
            `・金庫持有：**${fmt(res.holding)}** ${U}\n` +
            `・錢包餘額：**${fmt(res.balanceAfter)}**\n` +
            `-# 金價每日浮動，賣出價現為 ${fmt(res.prices.sell)}/${U}`,
        );
      }

      if (sub === "賣出") {
        const units = interaction.options.getInteger("數量");
        const res = await goldService.sell(client, { userId, guildId, username, member, avatarHash, units });
        if (!res.ok) {
          if (res.reason === "holding") {
            return replyError(interaction, {
              title: "❌ 金庫黃金不足",
              detail: `你金庫只有 **${fmt(res.holding)}** ${U}，無法賣出 ${fmt(units)} ${U}。`,
              hint: "可用 /黃金 買進 或 /黃金 熔金 累積黃金",
            });
          }
          if (res.reason === "min") {
            return replyError(interaction, {
              title: "❌ 賣出數量太少",
              detail: `單次至少賣 **${fmt(res.min)}** ${U}。`,
            });
          }
          return interaction.editReply("🔧 黃金賣出失敗，請稍後再試。");
        }
        return interaction.editReply(
          `🪙 **賣出成功**\n` +
            `・賣出 **${fmt(res.units)}** ${U}（單價 ${fmt(res.prices.sell)}／共 +${fmt(res.gain)} 幣）\n` +
            `・金庫剩餘：**${fmt(res.holding)}** ${U}\n` +
            `・錢包餘額：**${fmt(res.balanceAfter)}**`,
        );
      }

      if (sub === "熔金") {
        const oreQty = interaction.options.getInteger("數量");
        const res = await goldService.refine(client, { userId, guildId, oreQty });
        if (!res.ok) {
          if (res.reason === "ore") {
            return replyError(interaction, {
              title: "❌ 黃金礦不足",
              detail: `你背包只有 **${fmt(res.have)}** 個黃金礦，無法熔 ${fmt(oreQty)} 個。`,
              hint: "去 /挖礦 挖黃金，或 /黃金 買進",
            });
          }
          if (res.reason === "disabled") return interaction.editReply("🔧 熔金功能未開放。");
          return interaction.editReply("🔧 熔金失敗，請稍後再試。");
        }
        return interaction.editReply(
          `🔥 **熔金成功**\n` +
            `・熔化 **${fmt(res.oreQty)}** 個黃金礦 → 金庫 +**${fmt(res.units)}** ${U}\n` +
            `・金庫持有：**${fmt(res.holding)}** ${U}`,
        );
      }

      if (sub === "定存") {
        const units = interaction.options.getInteger("數量");
        const days = interaction.options.getInteger("天數");
        const res = await goldService.openTerm(client, { userId, guildId, member, units, days });
        if (!res.ok) {
          if (res.reason === "disabled") return interaction.editReply("🔧 黃金定存未開放。");
          if (res.reason === "min") {
            return replyError(interaction, {
              title: "❌ 鎖倉數量太少",
              detail: `黃金定存最少 **${fmt(res.minUnits)}** ${U}。`,
            });
          }
          if (res.reason === "term") return interaction.editReply("❌ 無此定存期間。");
          if (res.reason === "slots") {
            return replyError(interaction, {
              title: "📈 黃金定存已滿",
              detail: `同時最多 **${res.maxActive}** 筆，目前已有 ${res.active} 筆。`,
              hint: "先領回到期的黃金定存",
            });
          }
          if (res.reason === "holding") {
            return replyError(interaction, {
              title: "❌ 金庫黃金不足",
              detail: `金庫只有 **${fmt(res.holding)}** ${U}，無法鎖倉 ${fmt(units)} ${U}。`,
            });
          }
          return interaction.editReply("🔧 黃金定存失敗，請稍後再試。");
        }
        const maturesUnix = Math.floor(new Date(res.maturesAt).getTime() / 1000);
        return interaction.editReply(
          `🪙 **黃金定存開立** \`${res.depositId}\`\n` +
            `・鎖倉：**${fmt(res.units)}** ${U}（${res.days} 天・利率 ${(res.rate * 100).toFixed(1)}%）\n` +
            `・到期可領：**${fmt(res.units + res.interestUnits)}** ${U}（+${fmt(res.interestUnits)} ${U}）\n` +
            `・到期：<t:${maturesUnix}:F>（<t:${maturesUnix}:R>）`,
        );
      }

      if (sub === "提領") {
        const depositId = interaction.options.getString("存單").trim();
        const res = await goldService.claimTerm(client, { userId, guildId, member, depositId });
        if (!res.ok) {
          if (res.reason === "notfound") return interaction.editReply("❌ 找不到此黃金存單。");
          if (res.reason === "claimed") return interaction.editReply("❌ 此存單已領過。");
          return interaction.editReply("🔧 黃金定存提領失敗，請稍後再試。");
        }
        if (res.matured) {
          return interaction.editReply(
            `✅ 黃金定存 \`${depositId}\` 到期領回：本金 ${fmt(res.units)} + 利息 ${fmt(res.interestUnits)} = **${fmt(res.payoutUnits)}** ${U}\n` +
              `・金庫持有：**${fmt(res.holding)}** ${U}`,
          );
        }
        return interaction.editReply(
          `⚠️ 提早領回 \`${depositId}\`：扣違約金 ${fmt(res.penaltyUnits)} ${U}，實領 **${fmt(res.payoutUnits)}** ${U}\n` +
            `・金庫持有：**${fmt(res.holding)}** ${U}`,
        );
      }
    } catch (error) {
      console.log(`[ERROR] /黃金:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 黃金指令執行失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

async function renderQuery(client, interaction, { userId, guildId, U }) {
  const [prices, holding, terms] = await Promise.all([
    goldService.getPrices(client),
    goldService.getHolding(client, userId, guildId),
    goldService.listTerms(client, userId, guildId),
  ]);

  const value = holding * prices.sell;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR.gold)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🪙 黃金存摺\n-# 現貨價 **${fmt(prices.spot)}** 幣/${U}（每日浮動）`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**銀行報價**\n` +
          `🟢 買進 **${fmt(prices.buy)}** 幣/${U}　　🔴 賣出 **${fmt(prices.sell)}** 幣/${U}\n` +
          `-# 買賣價差即為銀行手續，低買高賣賺價差`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**你的金庫**\n持有 **${fmt(holding)}** ${U}　≈ **${fmt(value)}** 幣（以賣出價估）`,
      ),
    );

  if (terms.length) {
    const now = Date.now();
    const lines = terms.map((d) => {
      const maturesUnix = Math.floor(new Date(d.maturesAt).getTime() / 1000);
      const matured = new Date(d.maturesAt).getTime() <= now;
      const status = matured ? "✅ 已到期" : "⏳ 鎖定中";
      return `\`${d.depositId}\` ${status}　${fmt(d.units)}${U} → 到期 **${fmt(d.units + d.interestUnits)}**${U}　<t:${maturesUnix}:R>`;
    });
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**黃金定存（${terms.length} 筆）**\n${lines.join("\n")}`),
      );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# /黃金 買進・賣出・熔金・定存　·　金價沿用礦石行情每日 00:00 更新",
    ),
  );

  const components = [container];
  if (holding > 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_${userId}_goldsellall`)
        .setLabel(`賣出全部（+${fmt(value)}）`)
        .setEmoji("🪙")
        .setStyle(ButtonStyle.Success),
    );
    container.addActionRowComponents(row);
  }

  return interaction.editReply({
    components,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}
