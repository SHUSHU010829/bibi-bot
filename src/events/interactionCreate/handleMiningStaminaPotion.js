// 精力藥水「使用」按鈕處理器：customId = mining_use_stamina_potion_<ownerId>
//
// 從 /背包 點擊「使用」→ 扣 1 罐 + 補體力。體力滿時用 Container 提示，不扣藥水。

const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const {
  parseUseStaminaPotionId,
} = require("../../features/shop/backpackView");
const dungeonService = require("../../features/mining/dungeonService");

async function replyEphemeral(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;

    const parsed = parseUseStaminaPotionId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:miningUseStaminaPotion", {
      windowMs: 2000,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(interaction, {
        content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
      });
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyEphemeral(interaction, {
        content: "🚫 這是別人的背包按鈕，請用 /背包 開自己的～",
      });
      return;
    }

    const result = await dungeonService.useStaminaPotion(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
    });

    if (!result.ok) {
      if (result.reason === "no_potion") {
        const c = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🧪 沒有精力藥水")
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "你目前持有 0 瓶精力藥水。\n-# 到 /商店 → 挖礦道具 購買（每日上限 3 瓶）"
            )
          );
        await interaction.reply({
          components: [c],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      if (result.reason === "full") {
        const c = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🧪 體力已滿")
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `目前體力：**${result.staminaBefore} / ${result.max}**\n-# 體力滿了用藥水會浪費，先去 /地下城 探險吧！`
            )
          );
        await interaction.reply({
          components: [c],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      if (result.reason === "retry") {
        await replyEphemeral(interaction, { content: "⏳ 操作衝突，請再試一次。" });
        return;
      }
      await replyEphemeral(interaction, { content: "🔧 使用失敗，請稍後再試。" });
      return;
    }

    const tail = result.nextRegenAt
      ? `\n-# 下一點自然回復：<t:${Math.floor(result.nextRegenAt / 1000)}:R>`
      : "";
    const c = new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## 🧪 精力藥水使用成功！")
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🔋 體力：${result.staminaBefore} → **${result.staminaAfter}** / ${result.max}（+${result.restored}）\n🧪 剩餘藥水：×${result.potionLeft}${tail}\n-# 立刻去 /地下城 探險吧！`
        )
      );
    await interaction.reply({
      components: [c],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    trackSuccess("mining-use-stamina-potion");
  } catch (err) {
    logger.error(
      {
        source: "mining-use-stamina-potion",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "精力藥水按鈕出錯"
    );
    trackError("mining-use-stamina-potion", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, { content: "🔧 操作失敗，請呼叫舒舒！" });
  }
};
