// 賓果大廳買卡互動：
//   按鈕 bh_buy_<roundId>        → 跳出輸入框讓玩家填張數
//   modal  bh_buymodal_<roundId> → 依輸入張數買卡，ephemeral 回覆
// roundId 為 uuid（含 "-" 不含 "_"），直接取前綴後的字串即是 roundId。

const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { casino } = require("../../config");
const {
  buyCards,
  getOpenRound,
} = require("../../features/casino/bingoHall/service");
const { buildBuyReply } = require("../../features/casino/bingoHall/render");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");

function maxPerRound() {
  return casino?.bingoHall?.maxCardsPerRound ?? 20;
}

async function ephemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) { /* noop */ }
}

async function openBuyModal(interaction) {
  const roundId = interaction.customId.slice("bh_buy_".length);
  if (!roundId) return;

  const rl = consume(interaction.user.id, "btn:bingoHall", { windowMs: 1000, max: 1 });
  if (!rl.allowed) {
    return ephemeral(interaction, `⏳ 慢一點，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
  }

  const modal = new ModalBuilder()
    .setCustomId(`bh_buymodal_${roundId}`)
    .setTitle("買賓果卡");
  const input = new TextInputBuilder()
    .setCustomId("count")
    .setLabel("要買幾張？")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`1 ~ ${maxPerRound()}`)
    .setRequired(true)
    .setMaxLength(3);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleBuySubmit(client, interaction) {
  const roundId = interaction.customId.slice("bh_buymodal_".length);
  const raw = (interaction.fields.getTextInputValue("count") || "").trim();
  const count = parseInt(raw, 10);

  if (!Number.isInteger(count) || count <= 0) {
    return ephemeral(interaction, "請輸入正整數張數（例如 5）。");
  }
  if (count > maxPerRound()) {
    return ephemeral(interaction, `每場最多 ${maxPerRound()} 張，請輸入 1 ~ ${maxPerRound()}。`);
  }

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const open = await getOpenRound(client);
  if (!open || open.roundId !== roundId) {
    return ephemeral(interaction, "🎱 這場已經開球囉，往上看最新一場買卡吧！");
  }

  const res = await buyCards(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.member?.displayName || interaction.user.username,
    count,
    member: interaction.member,
  });

  if (!res.ok) {
    if (res.reason === "max") {
      return ephemeral(
        interaction,
        `🎱 每場最多 ${res.maxPer} 張，你已有 ${res.owned} 張，這次買不下 ${count} 張。`
      );
    }
    if (res.reason === "balance") {
      return ephemeral(
        interaction,
        `${MONEY_EMOJI} 餘額不足！買 ${count} 張要 **${res.cost.toLocaleString()}**，你只有 **${res.balance.toLocaleString()}**。`
      );
    }
    if (res.reason === "closed") {
      return ephemeral(interaction, "🎱 目前沒有開放中的場次，稍候下一場～");
    }
    return ephemeral(interaction, "🔧 買卡失敗，請稍後再試。");
  }

  await interaction.editReply(buildBuyReply(res));
  trackSuccess("bingohall-button");
}

module.exports = async (client, interaction) => {
  try {
    if (!client.bingoHallRoundsCollection) return;
    if (interaction.isButton() && interaction.customId?.startsWith("bh_buy_")) {
      await openBuyModal(interaction);
      return;
    }
    if (
      interaction.isModalSubmit?.() &&
      interaction.customId?.startsWith("bh_buymodal_")
    ) {
      await handleBuySubmit(client, interaction);
    }
  } catch (error) {
    logger.error(
      {
        source: "bingohall-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "賓果大廳買卡互動失敗"
    );
    trackError("bingohall-button", error, { customId: interaction.customId });
    await ephemeral(interaction, "🔧 買卡失敗，請呼叫舒舒！");
  }
};
