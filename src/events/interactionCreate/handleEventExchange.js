require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const eventExchangeService = require("../../features/event/eventExchangeService");
const {
  buildExchangeView,
  parseExchangeButtonId,
} = require("../../features/event/eventExchangeView");
const { consume } = require("../../utils/rateLimiter");

function errorContainer(title, detail, hint) {
  const c = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`));
  if (detail) {
    c.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(
      new TextDisplayBuilder().setContent(detail),
    );
  }
  if (hint) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return c;
}

function fishLabel(fishDef, fallbackKey) {
  return `${fishDef?.emoji || "🐟"} ${fishDef?.name || fallbackKey}`;
}

// 兌換到限定稱號時，在頻道發個公開小通知（換完不補、值得炫耀一下）。
function limitedTitleNotice(userId, eventName, titleId) {
  return new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎉 限定稱號到手！\n<@${userId}> 在 **${eventName}** 兌換到限定稱號 **${eventExchangeService.titleName(titleId)}**！`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 活動限定・換完不補，用 `/稱號 設定` 掛上錢包卡炫耀一下 🏅",
      ),
    );
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const parsed = parseExchangeButtonId(interaction.customId || "");
  if (!parsed) return;

  const { ownerId, exchangeId } = parsed;

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的兌換所面板！請自己用 `/兌換所` 開啟。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const rl = consume(interaction.user.id, "event:exchange", { windowMs: 2500, max: 1 });
  if (!rl.allowed) {
    return interaction.reply({
      content: "⏳ 手速太快了，稍等一下再兌換。",
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const result = await eventExchangeService.redeem(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.user.username,
      member: interaction.member,
      exchangeId,
    });

    if (!result.ok) {
      let container;
      if (result.reason === "not_found") {
        container = errorContainer(
          "⌛ 兌換活動已結束",
          "這個兌換項目所屬的活動已經結束了。",
          "重新開 `/兌換所` 看看目前有什麼",
        );
      } else if (result.reason === "limit") {
        container = errorContainer(
          "🚫 已達兌換上限",
          `**${result.exchange.name}** 每人上限 ${result.limit} 次，你已換滿。`,
          "把限定魚留著換別的獎勵吧",
        );
      } else if (result.reason === "insufficient") {
        container = errorContainer(
          "🎣 限定魚不足",
          `**${result.exchange.name}**\n需要：${fishLabel(result.fishDef, result.exchange.cost.fish)} ×${result.need}\n持有：**${result.have}**`,
          "活動期間多用 `/釣魚` 撈幾條再回來",
        );
      } else {
        container = errorContainer(
          "🔁 兌換未完成",
          "剛剛兌換沒成功（可能同時操作），請再試一次。",
          "重開 `/兌換所` 查看最新狀態",
        );
      }
      return interaction.reply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // 成功：刷新面板並置頂成功橫幅
    const banner =
      `✅ **兌換成功！** 花費 ${fishLabel(result.fishDef, result.exchange.cost.fish)} ×${result.costQty}` +
      `，獲得 ${result.rewardText}。`;
    const { active, items } = await eventExchangeService.listExchanges(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    const view = buildExchangeView({
      ownerId: interaction.user.id,
      active,
      items,
      banner,
      selectedFish: result.exchange?.cost?.fish || "all",
    });
    await interaction.update(view);

    // 限定稱號初次到手 → 頻道公開小通知（兌換面板本身是 ephemeral，其他人看不到）
    if (result.titleAward?.newlyAdded) {
      await interaction
        .followUp({
          components: [
            limitedTitleNotice(
              interaction.user.id,
              result.exchange.eventName,
              result.titleAward.titleId,
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    }
    return;
  } catch (error) {
    console.log(`[ERROR] 兌換所按鈕:\n${error}\n${error.stack}`.red);
    return interaction
      .reply({ content: "🔧 兌換失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
};
