// 賽馬按鈕 / Modal 處理：
//   hr_pick_<horseId>_<gameId>   按鈕：開 modal 輸入金額
//   hr_modal_<horseId>_<gameId>  modal submit：扣款 + push bet
//   hr_start_<gameId>            按鈕：開盤者提早開賽
//   hr_cancel_<gameId>           按鈕：開盤者取消（退款）

const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { HORSES, getHorse } = require("../../features/casino/horseRacing/engine");
const {
  renderBettingPhase,
} = require("../../features/casino/horseRacing/renderer");
const {
  startRaceIfDue,
  cancelRace,
} = require("../../features/casino/horseRacing/raceRunner");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");

function getCfg() {
  return casino?.horseRacing || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    const id = interaction.customId || "";
    if (!id.startsWith("hr_")) return;
    if (!client.horseRaceGamesCollection) return;

    // customId 格式（gameId 是 uuid，含 "-"）：
    //   hr_pick_<horseId>_<gameId>
    //   hr_modal_<horseId>_<gameId>
    //   hr_start_<gameId>
    //   hr_cancel_<gameId>
    const parts = id.split("_");
    const action = parts[1];
    const gameId = parts[parts.length - 1];

    if (interaction.isButton()) {
      const rl = consume(interaction.user.id, "btn:horse", {
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
    }

    if (action === "pick" && interaction.isButton()) {
      return await openBetModal(interaction, parts[2], gameId);
    }
    if (action === "modal" && interaction.isModalSubmit()) {
      return await submitBet(client, interaction, parts[2], gameId);
    }
    if (action === "start" && interaction.isButton()) {
      return await earlyStart(client, interaction, gameId);
    }
    if (action === "cancel" && interaction.isButton()) {
      return await hostCancel(client, interaction, gameId);
    }
  } catch (error) {
    // 互動已過期 / 已被回應，沒救了，直接丟掉
    if (error?.code === 10062 || error?.code === 40060) {
      logger.warn(
        { source: "horse-button", code: error.code, customId: interaction.customId },
        "賽馬互動已過期或已被回應，略過",
      );
      return;
    }
    logger.error(
      {
        source: "horse-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "賽馬按鈕處理失敗",
    );
    trackError("horse-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 賽馬處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 賽馬處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) { /* noop */ }
  }
};

async function openBetModal(interaction, horseIdStr, gameId) {
  const horseId = Number(horseIdStr);
  const horse = getHorse(horseId);
  if (!horse) {
    return interaction.reply({ content: "❌ 馬匹編號無效", flags: MessageFlags.Ephemeral });
  }

  // 先檢查局還在售票期、否則 modal 跳出來也只是浪費點擊
  const game = await interaction.client.horseRaceGamesCollection.findOne({
    gameId,
  });
  if (!game) {
    return interaction.reply({
      content: "🐎 找不到這場賽馬。",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (game.status !== "betting") {
    return interaction.reply({
      content: "🐎 售票期已結束，無法再下注。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const cfg = getCfg();
  const minBet = cfg.minBet ?? 10;
  const maxBet = cfg.maxBet ?? 1000;

  const modal = new ModalBuilder()
    .setCustomId(`hr_modal_${horseId}_${gameId}`)
    .setTitle(`押 ${horse.emoji} ${horse.name} (×${horse.payout.toFixed(1)})`);
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

async function submitBet(client, interaction, horseIdStr, gameId) {
  const horseId = Number(horseIdStr);
  const horse = getHorse(horseId);
  if (!horse) {
    return interaction.reply({ content: "❌ 馬匹編號無效", flags: MessageFlags.Ephemeral });
  }

  const raw = interaction.fields.getTextInputValue("amount").trim();
  const amount = Number.parseInt(raw.replace(/[^\d]/g, ""), 10);

  const cfg = getCfg();
  const minBet = cfg.minBet ?? 10;
  const maxBet = cfg.maxBet ?? 1000;
  if (!Number.isFinite(amount) || amount < minBet) {
    return interaction.reply({
      content: `❌ 至少下注 ${minBet.toLocaleString()} credits`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (amount > maxBet) {
    return interaction.reply({
      content: `❌ 單筆最高 ${maxBet.toLocaleString()} credits`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) {
    return;
  }

  const coll = client.horseRaceGamesCollection;
  const game = await coll.findOne({ gameId });
  if (!game) {
    return interaction.editReply("🐎 找不到這場賽馬。");
  }
  if (game.status !== "betting") {
    return interaction.editReply("🐎 售票期已結束，無法再下注。");
  }

  // 餘額檢查
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const username =
    interaction.member?.displayName || interaction.user.username;
  const member = interaction.member;

  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = before?.totalCoins || 0;
  if (balance < amount) {
    return interaction.editReply(
      `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${amount.toLocaleString()}。`,
    );
  }

  // 扣款
  const betResult = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash: interaction.user.avatar,
    amount: -amount,
    source: "bet",
    member,
    meta: { game: "horseRacing", gameId, horseId },
  });
  if (!betResult) {
    return interaction.editReply("🔧 下注失敗，請稍後再試。");
  }

  // 寫入 bet：用 atomic findOneAndUpdate，狀態變了就退款
  const newBet = {
    userId,
    username,
    horseId,
    amount,
    createdAt: new Date(),
  };
  const updated = await coll.findOneAndUpdate(
    { gameId, status: "betting" },
    {
      $push: { bets: newBet },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  const doc = updated?.value || updated;
  if (!doc) {
    // 同時間售票期剛結束 → 退款
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount,
      source: "payout",
      member,
      meta: {
        game: "horseRacing",
        gameId,
        kind: "refund",
        reason: "race_started_during_bet",
      },
    }).catch(() => {});
    return interaction.editReply(
      "⏰ 售票期剛剛結束，已將下注金額退回。",
    );
  }

  const balanceAfter = betResult.doc?.totalCoins ?? balance - amount;

  await interaction.editReply(
    `✅ 已押 ${horse.emoji} **${horse.name}** ×${horse.payout.toFixed(1)} ・ 下注 **${amount.toLocaleString()}** credits ・ 餘額 ${balanceAfter.toLocaleString()}`,
  );

  // 更新公開訊息（顯示新的下注數）
  await editPublicMessage(client, doc).catch(() => {});

  trackSuccess("horse-bet");
}

async function earlyStart(client, interaction, gameId) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) {
    return;
  }
  const coll = client.horseRaceGamesCollection;
  const game = await coll.findOne({ gameId });
  if (!game) {
    return interaction.editReply({ content: "🐎 找不到這場賽馬。" });
  }
  if (game.status !== "betting") {
    return interaction.editReply({ content: "🐎 比賽已開始或結束。" });
  }
  if (game.hostUserId !== interaction.user.id) {
    return interaction.editReply({
      content: "🚫 只有開盤者可以提早開賽。",
    });
  }
  if (!game.bets || game.bets.length === 0) {
    return interaction.editReply({
      content: "❌ 還沒有人下注，沒辦法提早開賽。",
    });
  }

  await interaction.editReply({
    content: "🚀 提早開賽！",
  });

  startRaceIfDue(client, gameId).catch((e) =>
    console.log(`[HORSE] early start failed: ${e}`.yellow),
  );
}

async function hostCancel(client, interaction, gameId) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) {
    return;
  }
  const coll = client.horseRaceGamesCollection;
  const game = await coll.findOne({ gameId });
  if (!game) {
    return interaction.editReply({ content: "🐎 找不到這場賽馬。" });
  }
  if (game.status !== "betting") {
    return interaction.editReply({ content: "🐎 已經開賽，沒辦法取消了。" });
  }
  if (game.hostUserId !== interaction.user.id) {
    return interaction.editReply({
      content: "🚫 只有開盤者可以取消這場賽馬。",
    });
  }

  await interaction.editReply({
    content: "❌ 已取消這場賽馬，所有下注已退款。",
  });

  cancelRace(client, gameId, "host_cancelled").catch((e) =>
    console.log(`[HORSE] host cancel failed: ${e}`.yellow),
  );
}

async function editPublicMessage(client, state) {
  if (!state?.channelId || !state?.messageId) return;
  try {
    const channel = await client.channels.fetch(state.channelId);
    if (!channel?.isTextBased?.()) return;
    const message = await channel.messages.fetch(state.messageId);
    if (!message) return;
    await message.edit(renderBettingPhase(state));
  } catch (_) { /* noop */ }
}
