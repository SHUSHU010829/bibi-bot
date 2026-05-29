const {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { fold, shoot } = require("../../features/casino/dragonGate/engine");
const { renderMessage } = require("../../features/casino/dragonGate/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

function getDragonGateConfig() {
  return casino?.dragonGate || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    if (!interaction.customId?.startsWith("dg_")) return;
    if (!client.dragonGateGamesCollection) return;

    // customId 格式：dg_<action>_<gameId>，gameId 是 uuid 含 "-"
    const rest = interaction.customId.slice("dg_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return;
    const action = rest.slice(0, splitIdx);
    const gameId = rest.slice(splitIdx + 1);

    if (!["bet", "fold", "modal"].includes(action)) return;

    // 速率限制
    const rl = consume(interaction.user.id, "btn:dragonGate", {
      windowMs: 1000,
      max: 1,
    });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    if (interaction.isButton() && action === "bet") {
      return openBetModal(client, interaction, gameId);
    }

    if (interaction.isModalSubmit() && action === "modal") {
      return submitBet(client, interaction, gameId);
    }

    if (interaction.isButton() && action === "fold") {
      return handleFold(client, interaction, gameId);
    }
  } catch (error) {
    logger.error(
      { source: "dragonGate-button", userId: interaction.user?.id, customId: interaction.customId, err: error.message, stack: error.stack },
      "射龍門按鈕處理失敗"
    );
    trackError("dragonGate-button", error, { userId: interaction.user?.id, customId: interaction.customId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 射龍門按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 射龍門按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};

async function loadGameForUser(client, interaction, gameId, replyEphemeral) {
  const state = await client.dragonGateGamesCollection.findOne({ gameId });
  const reply = async (content) => {
    if (replyEphemeral) {
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  };
  if (!state) {
    await reply("🐉 這局已過期或找不到了。");
    return null;
  }
  if (state.userId !== interaction.user.id) {
    await reply("🚫 這不是你的局！別亂按 ㄎㄎ");
    return null;
  }
  if (state.status !== "awaitingChoice") {
    await reply("🐉 這局已結束或無法操作。");
    return null;
  }
  return state;
}

async function openBetModal(client, interaction, gameId) {
  const state = await loadGameForUser(client, interaction, gameId, true);
  if (!state) return;

  const cfg = getDragonGateConfig();
  const minBet = cfg.minBet ?? 50;
  const maxBet = cfg.maxBet ?? 1000;

  const modal = new ModalBuilder()
    .setCustomId(`dg_modal_${gameId}`)
    .setTitle(`補注射龍門 ×${(state.multiplier || 0).toFixed(2)}`);
  const input = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel(`下注金額（${minBet.toLocaleString()} ~ ${maxBet.toLocaleString()}）`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(`例如 ${Math.min(100, maxBet)}`)
    .setMinLength(1)
    .setMaxLength(10);
  modal.addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function handleFold(client, interaction, gameId) {
  try {
    await interaction.deferUpdate();
  } catch (deferErr) {
    if (deferErr?.code === 10062) {
      logger.warn(
        { source: "dragonGate-button", gameId },
        "互動已逾期,無法 defer"
      );
      trackError("dragonGate-button", deferErr, { gameId, reason: "expired" });
      return;
    }
    throw deferErr;
  }

  const state = await loadGameForUser(client, interaction, gameId, false);
  if (!state) return;

  const next = fold(state);
  const cfg = getDragonGateConfig();
  const ttlSec = cfg.gameTtlSeconds ?? 300;
  const now = new Date();

  await client.dragonGateGamesCollection.updateOne(
    { _id: state._id, status: "awaitingChoice" },
    {
      $set: {
        status: next.status,
        result: next.result,
        payout: next.payout,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      },
    }
  );

  const after = await client.userCoinsCollection.findOne({
    userId: state.userId,
    guildId: state.guildId,
  });
  const balanceAfter = after?.totalCoins || 0;

  const payload = await renderMessage(
    { ...next, gameId, userId: state.userId },
    {
      username: state.username,
      balance: balanceAfter,
      userId: state.userId,
      avatarURL: interaction.user.displayAvatarURL(),
    }
  );
  await interaction.editReply({ ...payload, attachments: [] });
  trackSuccess("dragonGate-button");
}

async function submitBet(client, interaction, gameId) {
  const raw = interaction.fields.getTextInputValue("amount").trim();
  const bet = Number.parseInt(raw.replace(/[^\d]/g, ""), 10);

  const cfg = getDragonGateConfig();
  const minBet = cfg.minBet ?? 50;
  const maxBet = cfg.maxBet ?? 1000;
  if (!Number.isFinite(bet) || bet < minBet) {
    return interaction.reply({
      content: `❌ 至少下注 ${minBet.toLocaleString()} credits`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (bet > maxBet) {
    return interaction.reply({
      content: `❌ 單筆最高 ${maxBet.toLocaleString()} credits`,
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await interaction.deferUpdate();
  } catch (deferErr) {
    if (deferErr?.code === 10062) {
      logger.warn(
        { source: "dragonGate-button", gameId },
        "modal 互動已逾期"
      );
      return;
    }
    throw deferErr;
  }

  const state = await loadGameForUser(client, interaction, gameId, false);
  if (!state) return;

  const lock = bet * 2;

  // 檢查餘額足夠鎖倉
  const before = await client.userCoinsCollection.findOne({
    userId: state.userId,
    guildId: state.guildId,
  });
  const balance = before?.totalCoins || 0;
  if (balance < lock) {
    return interaction.followUp({
      content: `${MONEY_EMOJI} 餘額不足以鎖倉 ${lock.toLocaleString()}（下注 2×），目前 ${balance.toLocaleString()}。請改下小一點或按「不補」棄權。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const lockResult = await grantCoins(client, {
    userId: state.userId,
    guildId: state.guildId,
    username: state.username,
    amount: -lock,
    source: "bet",
    member: interaction.member,
    meta: {
      game: "dragonGate",
      gameId,
      ante: state.ante,
      bet,
      lock,
      stage: "lock",
    },
  });
  if (!lockResult) {
    return interaction.followUp({
      content: "🔧 鎖倉失敗，請稍後再試。",
      flags: MessageFlags.Ephemeral,
    });
  }
  let balanceAfter = lockResult.doc?.totalCoins ?? balance - lock;

  const next = shoot(state, bet);

  const ttlSec = cfg.gameTtlSeconds ?? 300;
  const now = new Date();
  await client.dragonGateGamesCollection.updateOne(
    { _id: state._id, status: "awaitingChoice" },
    {
      $set: {
        bet: next.bet,
        lock: next.lock,
        deck: next.deck,
        thirdCard: next.thirdCard,
        status: next.status,
        result: next.result,
        payout: next.payout,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      },
    }
  );

  if (next.status === "settled" && next.payout > 0) {
    const payoutResult = await grantCoins(client, {
      userId: state.userId,
      guildId: state.guildId,
      username: state.username,
      amount: next.payout,
      source: "payout",
      member: interaction.member,
      meta: {
        game: "dragonGate",
        result: next.result,
        gameId,
        ante: state.ante,
        bet: next.bet,
        lock: next.lock,
        multiplier: next.multiplier,
      },
    });
    balanceAfter = payoutResult?.doc?.totalCoins ?? balanceAfter;
  }

  const payload = await renderMessage(
    { ...next, gameId, userId: state.userId },
    {
      username: state.username,
      balance: balanceAfter,
      userId: state.userId,
      avatarURL: interaction.user.displayAvatarURL(),
    }
  );
  await interaction.editReply({ ...payload, attachments: [] });
  trackSuccess("dragonGate-button");
}
