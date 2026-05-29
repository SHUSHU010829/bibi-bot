const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

const {
  findActiveGameInChannel,
  joinTable,
  leaveDuringWaiting,
  startNextHand,
  closeTable,
  refreshTableMessage,
  resendTableMessage,
  applyPlayerAction,
  persistEngineState,
  announceHandStart,
  postThreadAnnouncement,
} = require("../../features/casino/poker/service");
const engine = require("../../features/casino/poker/engine");
const {
  renderEphemeralHand,
  renderHelp,
} = require("../../features/casino/poker/renderer");

// 抑制未使用警告
void findActiveGameInChannel;

function parseId(customId, prefix) {
  if (!customId.startsWith(prefix)) return null;
  const rest = customId.slice(prefix.length);
  const splitIdx = rest.indexOf("_");
  if (splitIdx < 0) return null;
  return { action: rest.slice(0, splitIdx), gameId: rest.slice(splitIdx + 1) };
}

async function fetchByGameId(client, gameId) {
  return client.pokerGamesCollection.findOne({ gameId });
}

// embed 身分以「開桌者」為準；只有當按按鈕的人就是開桌者時，
// 才把他的頭像帶給 renderer（避免拿到別人的頭像配開桌者名字）。
function hostAvatarFor(interaction, doc) {
  return doc && interaction.user.id === doc.creatorId
    ? { avatarURL: interaction.user.displayAvatarURL() }
    : {};
}

// 行為分類：決定要先 deferUpdate / deferReply / 或保留（showModal 不能 defer）
const POKER_ACTIONS_DEFER_UPDATE = new Set([
  "raiseto",
  "start",
  "next",
  "fold",
  "callcheck",
  "allin",
]);
const POKER_ACTIONS_DEFER_REPLY = new Set([
  "help",
  "hand",
  "resend",
  "join",
  "close",
  "leave",
]);
// "raise" 會 showModal，不能事先 defer

async function handleButton(client, interaction) {
  if (!interaction.customId?.startsWith("pk_")) return false;
  if (!client.pokerGamesCollection) return true;

  // pk_raiseto_<amount>_<gameId> 特殊處理（含兩個 _ 分隔）
  let action;
  let gameId;
  let raiseToAmount = null;
  if (interaction.customId.startsWith("pk_raiseto_")) {
    const rest = interaction.customId.slice("pk_raiseto_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return true;
    raiseToAmount = parseInt(rest.slice(0, splitIdx), 10);
    gameId = rest.slice(splitIdx + 1);
    action = "raiseto";
  } else {
    const parsed = parseId(interaction.customId, "pk_");
    if (!parsed) return true;
    action = parsed.action;
    gameId = parsed.gameId;
  }

  // 在 DB 查詢之前先 defer，避免 3 秒 token 過期觸發 10062。
  // raise 必須留給 showModal（modal 不能在 defer 後出現）。
  if (POKER_ACTIONS_DEFER_UPDATE.has(action)) {
    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "poker-interaction", action, gameId },
          "互動已逾期,無法 defer"
        );
        trackError("poker-interaction", deferErr, { action, reason: "expired" });
        return true;
      }
      throw deferErr;
    }
  } else if (POKER_ACTIONS_DEFER_REPLY.has(action)) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "poker-interaction", action, gameId },
          "互動已逾期,無法 defer"
        );
        trackError("poker-interaction", deferErr, { action, reason: "expired" });
        return true;
      }
      throw deferErr;
    }
  }

  const doc = await fetchByGameId(client, gameId);
  if (!doc) {
    await pokerSafeReply(interaction, "🃏 找不到這張桌（可能已結束）。");
    return true;
  }

  // 玩法說明：所有狀態都允許
  if (action === "help") {
    return interaction.editReply(renderHelp());
  }

  // 查看手牌：所有狀態都允許
  if (action === "hand") {
    return interaction.editReply(renderEphemeralHand(doc, interaction.user.id));
  }

  // 快速加注：pk_raiseto_<amount>_<gameId>
  if (action === "raiseto") {
    if (doc.status !== "playing") {
      await pokerFollowUpEphemeral(interaction, "現在不需要行動。");
      return true;
    }
    const idx = doc.players.findIndex((p) => p.userId === interaction.user.id);
    if (idx < 0) {
      await pokerFollowUpEphemeral(interaction, "你不在這桌上。");
      return true;
    }
    if (doc.toActIdx !== idx) {
      await pokerFollowUpEphemeral(interaction, "🕒 還沒輪到你。");
      return true;
    }
    if (!Number.isFinite(raiseToAmount) || raiseToAmount <= 0) {
      await pokerFollowUpEphemeral(interaction, "❌ 加注金額無效。");
      return true;
    }
    const r = await applyPlayerAction(
      client,
      doc,
      interaction.user.id,
      "raise",
      { raiseTo: raiseToAmount }
    );
    if (r.error) {
      await pokerFollowUpEphemeral(interaction, `❌ 加注失敗：${r.error}`);
      return true;
    }
    const updated = await fetchByGameId(client, gameId);
    await refreshTableMessage(client, updated, hostAvatarFor(interaction, updated));
    return true;
  }

  // 重貼桌面：把舊訊息刪掉重發一張
  if (action === "resend") {
    const msg = await resendTableMessage(client, doc, hostAvatarFor(interaction, doc));
    if (!msg) return interaction.editReply("🔧 重貼失敗，可能執行緒被封存或權限不足。");
    return interaction.editReply("🔄 桌面已重貼，往下找新訊息。");
  }

  // 加入：waiting 才行
  if (action === "join") {
    const r = await joinTable(client, interaction);
    if (r.error) return interaction.editReply(r.error);
    const username =
      interaction.member?.displayName || interaction.user.username;
    await postThreadAnnouncement(
      client,
      r.doc,
      `🪑 **${username}** 入座了（${r.doc.players.length}/${r.doc.maxPlayers} 人）`,
      []
    );
    return interaction.editReply(
      `🪑 已入座，已扣進桌費 **${r.doc.buyIn.toLocaleString()}** credits。`
    );
  }

  // 開始下一局（waiting → preflop）
  if (action === "start") {
    if (doc.creatorId !== interaction.user.id) {
      await pokerFollowUpEphemeral(interaction, "🚫 只有開桌者能開局。");
      return true;
    }
    if (doc.status !== "waiting") {
      await pokerFollowUpEphemeral(interaction, "現在不能開新局。");
      return true;
    }
    if (doc.players.length < doc.minPlayers) {
      try {
        await interaction.followUp({
          content: `🚫 人數不足，至少需 ${doc.minPlayers} 人，目前 ${doc.players.length} 人。請先邀請其他人按「🪑 加入」入座。`,
        });
      } catch (_) { /* noop */ }
      return true;
    }
    const next = engine.startHand(doc);
    await persistEngineState(client, doc, next);
    const updated = await fetchByGameId(client, gameId);
    await refreshTableMessage(client, updated, hostAvatarFor(interaction, updated));
    await announceHandStart(client, updated);
    return true;
  }

  // 下一局（settled → preflop）
  if (action === "next") {
    if (doc.creatorId !== interaction.user.id) {
      await pokerFollowUpEphemeral(interaction, "🚫 只有開桌者能開新局。");
      return true;
    }
    if (doc.status !== "settled") {
      await pokerFollowUpEphemeral(interaction, "牌局尚未結束。");
      return true;
    }
    const r = await startNextHand(client, doc);
    if (r.closed) {
      await closeTable(client, doc, { reason: "underpopulated" });
      return true;
    }
    const updated = await fetchByGameId(client, gameId);
    await refreshTableMessage(client, updated, hostAvatarFor(interaction, updated));
    await announceHandStart(client, updated);
    return true;
  }

  // 解散
  if (action === "close") {
    if (doc.creatorId !== interaction.user.id) {
      return interaction.editReply("🚫 只有開桌者能解散。");
    }
    await closeTable(client, doc, { reason: "creator_close" });
    return interaction.editReply("🛑 牌桌已解散，籌碼已退回各位錢包。");
  }

  // 離桌
  if (action === "leave") {
    const userId = interaction.user.id;
    const me = doc.players.find((p) => p.userId === userId);
    if (!me) return interaction.editReply("你不在這張桌上。");
    if (doc.status === "waiting") {
      const r = await leaveDuringWaiting(client, doc, userId);
      if (r.error) return interaction.editReply(r.error);
      if (r.closed) {
        await closeTable(client, doc, { reason: "everyone_left" });
        return interaction.editReply("👋 已退回進桌費，牌桌已解散。");
      }
      await refreshTableMessage(client, r.doc, hostAvatarFor(interaction, r.doc));
      return interaction.editReply(
        `👋 已退回進桌費 **${doc.buyIn.toLocaleString()}** credits。`
      );
    }
    // playing/settled：標 leaving，等結算才退
    await client.pokerGamesCollection.updateOne(
      { _id: doc._id, "players.userId": userId },
      { $set: { "players.$.leaving": true, updatedAt: new Date() } }
    );
    if (doc.status === "playing" && !me.folded) {
      const idx = doc.players.findIndex((p) => p.userId === userId);
      if (doc.toActIdx === idx) {
        const r = engine.applyAction(doc, idx, "fold");
        if (!r.error) await persistEngineState(client, doc, r.state);
      } else {
        await client.pokerGamesCollection.updateOne(
          { _id: doc._id, "players.userId": userId },
          {
            $set: {
              "players.$.folded": true,
              "players.$.hasActed": true,
              updatedAt: new Date(),
            },
          }
        );
      }
      const refreshed = await fetchByGameId(client, gameId);
      await refreshTableMessage(client, refreshed, hostAvatarFor(interaction, refreshed));
    }
    return interaction.editReply("👋 已標記離桌，本局結束後退回剩餘籌碼。");
  }

  // 行動：fold / callcheck / allin / raise(modal)
  if (["fold", "callcheck", "allin", "raise"].includes(action)) {
    if (doc.status !== "playing") {
      // raise 沒事先 defer；其他都 deferUpdate 過了
      if (action === "raise") {
        return interaction.reply({ content: "現在不需要行動。", flags: MessageFlags.Ephemeral });
      }
      await pokerFollowUpEphemeral(interaction, "現在不需要行動。");
      return true;
    }
    const idx = doc.players.findIndex((p) => p.userId === interaction.user.id);
    if (idx < 0) {
      if (action === "raise") {
        return interaction.reply({ content: "你不在這桌上。", flags: MessageFlags.Ephemeral });
      }
      await pokerFollowUpEphemeral(interaction, "你不在這桌上。");
      return true;
    }
    if (doc.toActIdx !== idx) {
      if (action === "raise") {
        return interaction.reply({ content: "🕒 還沒輪到你。", flags: MessageFlags.Ephemeral });
      }
      await pokerFollowUpEphemeral(interaction, "🕒 還沒輪到你。");
      return true;
    }

    if (action === "raise") {
      // 開 modal 收金額（modal 必須是初始 response，不能在 defer 後出現）
      const me = doc.players[idx];
      const minRaiseTo = Math.max(
        doc.currentBet + doc.minRaise,
        doc.bigBlind
      );
      const maxRaiseTo = me.bet + me.chips;
      const modal = new ModalBuilder()
        .setCustomId(`pk_raisemodal_${gameId}`)
        .setTitle("加注金額");
      const input = new TextInputBuilder()
        .setCustomId("amount")
        .setLabel(`下注到（總額，含已下） ${minRaiseTo}–${maxRaiseTo}`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(String(minRaiseTo))
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(10);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    let actEngine;
    if (action === "fold") actEngine = "fold";
    else if (action === "allin") actEngine = "allin";
    else {
      // callcheck
      const me = doc.players[idx];
      actEngine = me.bet >= doc.currentBet ? "check" : "call";
    }
    const r = await applyPlayerAction(client, doc, interaction.user.id, actEngine);
    if (r.error) {
      await pokerFollowUpEphemeral(interaction, r.error);
      return true;
    }
    const updated = await fetchByGameId(client, gameId);
    if (updated.status === "settled") {
      await onSettled(client, updated);
    }
    await refreshTableMessage(client, updated, hostAvatarFor(interaction, updated));
    return true;
  }

  return true;
}

async function pokerFollowUpEphemeral(interaction, content) {
  try {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } catch (_) { /* noop */ }
}

async function pokerSafeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) { /* noop */ }
}

async function handleModal(client, interaction) {
  if (!interaction.customId?.startsWith("pk_raisemodal_")) return false;
  if (!client.pokerGamesCollection) return true;
  const gameId = interaction.customId.slice("pk_raisemodal_".length);

  // 先 deferUpdate，避免 DB 查詢讓 3 秒 token 過期觸發 10062
  try {
    await interaction.deferUpdate();
  } catch (deferErr) {
    if (deferErr?.code === 10062) {
      logger.warn(
        { source: "poker-interaction", gameId, kind: "raisemodal" },
        "互動已逾期,無法 defer"
      );
      trackError("poker-interaction", deferErr, { kind: "raisemodal", reason: "expired" });
      return true;
    }
    throw deferErr;
  }

  const doc = await fetchByGameId(client, gameId);
  if (!doc) {
    await pokerFollowUpEphemeral(interaction, "🃏 找不到這張桌。");
    return true;
  }
  const idx = doc.players.findIndex((p) => p.userId === interaction.user.id);
  if (idx < 0 || doc.toActIdx !== idx) {
    await pokerFollowUpEphemeral(interaction, "🕒 還沒輪到你。");
    return true;
  }
  const raw = interaction.fields.getTextInputValue("amount");
  const raiseTo = parseInt(raw, 10);
  if (!Number.isFinite(raiseTo) || raiseTo <= 0) {
    await pokerFollowUpEphemeral(interaction, "❌ 請輸入正整數。");
    return true;
  }
  const r = await applyPlayerAction(client, doc, interaction.user.id, "raise", { raiseTo });
  if (r.error) {
    await pokerFollowUpEphemeral(interaction, `❌ 加注失敗：${r.error}`);
    return true;
  }
  const updated = await fetchByGameId(client, gameId);
  if (updated.status === "settled") {
    await onSettled(client, updated);
  }
  await refreshTableMessage(client, updated, hostAvatarFor(interaction, updated));
  return true;
}

// 攤牌結算後處理：把 leaving 玩家在下一局開始前就退完？這裡不處理，留給 startNextHand。
async function onSettled(client, doc) {
  // hook: 之後可加自動下一局倒數、busted 玩家自動退款等。MVP 不做。
  void client;
  void doc;
}

module.exports = async (client, interaction) => {
  try {
    if (interaction.isButton()) {
      if (!interaction.customId?.startsWith("pk_")) return;
      // 速率限制：擋連點，避免製造 10062
      const rl = consume(interaction.user.id, "btn:poker", {
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
      await handleButton(client, interaction);
      trackSuccess("poker-interaction");
      return;
    }
    if (interaction.isModalSubmit?.()) {
      if (!interaction.customId?.startsWith("pk_raisemodal_")) return;
      await handleModal(client, interaction);
      trackSuccess("poker-interaction");
      return;
    }
  } catch (error) {
    logger.error(
      { source: "poker-interaction", userId: interaction.user?.id, customId: interaction.customId, err: error.message, stack: error.stack },
      "撲克互動處理失敗"
    );
    trackError("poker-interaction", error, { userId: interaction.user?.id, customId: interaction.customId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 撲克處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 撲克處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
