// 釣魚結果訊息上「自動吃稀有魚餌」開關按鈕處理器。
//
// 按鈕 customId = fish_bait_auto_<ownerId>（見 commands/fishing/fish.js）。
// 開關狀態存在 MiningProfiles.rare_bait_auto（預設 false），每次釣魚時才依當下庫存換算要不要吃餌。
// 切換後不重建整個結果訊息（會洗掉 Components V2 內容），只就地改這顆按鈕的 label / style。

const { MessageFlags, ButtonStyle } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const fishService = require("../../features/fishing/fishService");
const { parseFishBaitAutoId, rareBaitToggleLabel } = require("../../commands/fishing/fish");

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

// 在原訊息的 component JSON 裡找到這顆開關按鈕（可能在 ActionRow 或 Section accessory 內），
// 換掉 label / style，其餘內容原樣送回。
function repaintToggleButton(message, customId, enabled) {
  let changed = false;
  const paint = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === 2 && node.custom_id === customId) {
      node.label = rareBaitToggleLabel(enabled);
      node.style = enabled ? ButtonStyle.Success : ButtonStyle.Secondary;
      changed = true;
      return;
    }
    if (Array.isArray(node.components)) node.components.forEach(paint);
    if (node.accessory) paint(node.accessory);
  };
  const components = message.components.map((top) => {
    const json = top.toJSON();
    paint(json);
    return json;
  });
  return { changed, components };
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const parsed = parseFishBaitAutoId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:fishBaitAuto", {
      windowMs: 1500,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
      );
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的魚餌開關，請呼叫自己的 /釣魚～",
      );
      return;
    }

    if (!(await deferUpdateSafe(interaction))) return;

    const result = await fishService.toggleRareBaitAuto(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    if (!result.ok) {
      await replyEphemeral(interaction, "🔧 魚餌開關暫時無法使用，請稍後再試。");
      return;
    }

    const { changed, components } = repaintToggleButton(
      interaction.message,
      interaction.customId,
      result.enabled,
    );
    if (changed) {
      await interaction
        .editReply({ components, flags: MessageFlags.IsComponentsV2 })
        .catch(() => {});
    }

    if (result.enabled) {
      await replyEphemeral(
        interaction,
        result.owned > 0
          ? `🎏 已開啟自動吃稀有魚餌！下次上鉤會吃掉 1 個（目前有 ${result.owned} 個）。`
          : "🎏 已開啟自動吃稀有魚餌，不過你現在沒有魚餌，收成黑玫瑰有機率掉。",
      );
    } else {
      await replyEphemeral(
        interaction,
        `🎏 已關閉自動吃稀有魚餌，之後釣魚不會消耗（庫存 ${result.owned} 個）。`,
      );
    }
    trackSuccess("fish-bait-auto");
  } catch (err) {
    logger.error(
      {
        source: "fish-bait-auto",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "切換自動吃稀有魚餌時出錯",
    );
    trackError("fish-bait-auto", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 切換魚餌開關失敗，請呼叫舒舒！");
  }
};
