require("colors");
const { MessageFlags } = require("discord.js");

const {
  setAnswer,
  lockQuiz,
  settleQuiz,
  setCorrectAnswerAndSettle,
  cancelQuiz,
  isPrediction,
  refreshQuizMessage,
  OPTION_EMOJIS,
} = require("../../features/quiz/quizGame");
const { deferReplySafe } = require("../../utils/safeAck");
const { consume } = require("../../utils/rateLimiter");

function isQuizInteraction(customId) {
  return (
    typeof customId === "string" &&
    (customId.startsWith("quiz_ans_") ||
      customId.startsWith("quiz_lock_") ||
      customId.startsWith("quiz_reveal_") ||
      customId.startsWith("quiz_end_") ||
      customId.startsWith("quiz_setans_") ||
      customId.startsWith("quiz_cancel_"))
  );
}

async function loadQuiz(client, quizId) {
  return client.quizGamesCollection.findOne({ quizId });
}

function labelOf(doc) {
  return isPrediction(doc) ? "預測" : "問答";
}

async function handleAnswerButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  // customId: quiz_ans_{quizId}_{key}
  const rest = interaction.customId.slice("quiz_ans_".length);
  const lastUnderscore = rest.lastIndexOf("_");
  const quizId = rest.slice(0, lastUnderscore);
  const key = rest.slice(lastUnderscore + 1);

  const doc = await loadQuiz(client, quizId);
  if (!doc) {
    return interaction.editReply("❌ 找不到這場活動。");
  }
  if (doc.status === "LOCKED") {
    return interaction.editReply("🔒 作答已截止，等待主辦人公布答案。");
  }
  if (doc.status !== "ACTIVE") {
    return interaction.editReply(`❌ ${labelOf(doc)}已結束。`);
  }
  if (interaction.user.id === doc.hostId) {
    return interaction.editReply(`❌ 主辦人不能參加自己的${labelOf(doc)}。`);
  }
  if (doc.endsAt && new Date(doc.endsAt).getTime() <= Date.now()) {
    return interaction.editReply("⏰ 作答時間已截止。");
  }

  const previous = doc.answers?.[interaction.user.id]?.key || null;

  const result = await setAnswer(
    client,
    doc,
    interaction.user.id,
    key,
    interaction.member?.displayName || interaction.user.username
  );

  if (result.action === "closed") {
    return interaction.editReply("❌ 已結束，無法作答。");
  }
  if (result.action === "invalid") {
    return interaction.editReply("❌ 這個選項不存在。");
  }
  if (result.action === "too_late") {
    return interaction.editReply(
      "💨 你也答對了，但已經有人比你早一步搶答完畢！下次手再快一點～"
    );
  }
  if (result.action === "solo_won") {
    const emoji = OPTION_EMOJIS[key] || "";
    return interaction.editReply(
      `🏆 搶答成功！你選了 ${emoji} **${key}**，獨得 **${result.doc.prizePool.toLocaleString()}** credits！`
    );
  }

  if (!previous) {
    refreshQuizMessage(client, result.doc).catch(() => {});
  }

  const emoji = OPTION_EMOJIS[key] || "";
  if (previous && previous !== key) {
    return interaction.editReply(
      `✏️ 已將你的答案從 **${previous}** 改成 ${emoji} **${key}**。`
    );
  }
  if (previous === key) {
    return interaction.editReply(`👍 你已經選了 ${emoji} **${key}**。`);
  }
  return interaction.editReply(
    `✅ 你的答案是 ${emoji} **${key}**。時間到或主辦人結束後公布結果。`
  );
}

async function handleLockButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const quizId = interaction.customId.slice("quiz_lock_".length);
  const doc = await loadQuiz(client, quizId);
  if (!doc) return interaction.editReply("❌ 找不到活動。");
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply("❌ 只有主辦人能截止作答。");
  }
  if (doc.status === "LOCKED") {
    return interaction.editReply("ℹ️ 作答已經截止了，請按「公布 A/B/C/D」其中一個公布答案並結算。");
  }
  if (doc.status !== "ACTIVE") {
    return interaction.editReply(`❌ ${labelOf(doc)}已結束。`);
  }
  if (!isPrediction(doc)) {
    return interaction.editReply(
      "ℹ️ 問答不需要分兩步——請直接按「立即公布答案並發獎金」結算。"
    );
  }

  try {
    await lockQuiz(client, doc, "manual");
    await interaction.editReply(
      `🔒 已截止作答。請按訊息上的「公布 A/B/C/D」公布正確答案並結算。`
    );
  } catch (err) {
    console.log(`[ERROR] quiz lock: ${err}\n${err.stack || ""}`.red);
    await interaction.editReply(`❌ ${err.message || err}`).catch(() => {});
  }
}

async function handleRevealButton(client, interaction) {
  // 問答（kind=quiz）：從 ACTIVE 直接結算
  // 舊版資料（沒有 kind 欄位 / 仍在 LOCKED 的問答）也走這條路徑
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const prefix = interaction.customId.startsWith("quiz_reveal_")
    ? "quiz_reveal_"
    : "quiz_end_";
  const quizId = interaction.customId.slice(prefix.length);
  const doc = await loadQuiz(client, quizId);
  if (!doc) return interaction.editReply("❌ 找不到問答。");
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply("❌ 只有主辦人能公布答案。");
  }
  if (doc.status === "SETTLED" || doc.status === "CANCELLED") {
    return interaction.editReply("❌ 問答已結束。");
  }
  if (isPrediction(doc)) {
    return interaction.editReply(
      "ℹ️ 這是預測，請按「公布 A/B/C/D」其中一個來宣告正確答案。"
    );
  }

  try {
    const settled = await settleQuiz(client, doc, "manual");
    const winners = settled.winners?.length || 0;
    if (winners === 0) {
      const fee = settled.refundFee || 0;
      const net = settled.refundNet ?? settled.prizePool;
      const feeNote =
        fee > 0
          ? `系統抽成 ${fee.toLocaleString()}，退還 ${net.toLocaleString()} credits 給你。`
          : `獎金 ${net.toLocaleString()} 已退還給你。`;
      await interaction.editReply(`🏁 結算完成。沒有人答對，${feeNote}`);
    } else {
      const fee = settled.refundFee || 0;
      const net = settled.refundNet || 0;
      const leftoverNote =
        fee > 0
          ? `\n（餘數系統抽成 ${fee.toLocaleString()}，退回給你 ${net.toLocaleString()}）`
          : net > 0
          ? `\n（餘數 ${net.toLocaleString()} 已退回給你）`
          : "";
      await interaction.editReply(
        `🏁 結算完成！${winners} 人答對，每人 ${settled.perWinnerPrize.toLocaleString()} credits。${leftoverNote}`
      );
    }
  } catch (err) {
    console.log(`[ERROR] quiz reveal: ${err}\n${err.stack || ""}`.red);
    await interaction.editReply(`❌ ${err.message || err}`).catch(() => {});
  }
}

async function handleSetAnswerButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  // customId: quiz_setans_{quizId}_{key}
  const rest = interaction.customId.slice("quiz_setans_".length);
  const lastUnderscore = rest.lastIndexOf("_");
  const quizId = rest.slice(0, lastUnderscore);
  const key = rest.slice(lastUnderscore + 1);

  const doc = await loadQuiz(client, quizId);
  if (!doc) return interaction.editReply("❌ 找不到預測。");
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply("❌ 只有主辦人能公布答案。");
  }
  if (!isPrediction(doc)) {
    return interaction.editReply("❌ 這不是預測。");
  }
  if (doc.status === "ACTIVE") {
    return interaction.editReply(
      "ℹ️ 還在作答中，請先按「提早截止作答」或等時間到自動截止後再公布答案。"
    );
  }
  if (doc.status !== "LOCKED") {
    return interaction.editReply("❌ 預測已結束。");
  }

  try {
    const settled = await setCorrectAnswerAndSettle(client, doc, key, "manual");
    const winners = settled.winners?.length || 0;
    if (winners === 0) {
      const fee = settled.refundFee || 0;
      const net = settled.refundNet ?? settled.prizePool;
      const feeNote =
        fee > 0
          ? `系統抽成 ${fee.toLocaleString()}，退還 ${net.toLocaleString()} credits 給你。`
          : `獎金 ${net.toLocaleString()} 已退還給你。`;
      await interaction.editReply(
        `🏁 已公布答案 **${key}** 並結算。沒有人答對，${feeNote}`
      );
    } else {
      const fee = settled.refundFee || 0;
      const net = settled.refundNet || 0;
      const leftoverNote =
        fee > 0
          ? `\n（餘數系統抽成 ${fee.toLocaleString()}，退回給你 ${net.toLocaleString()}）`
          : net > 0
          ? `\n（餘數 ${net.toLocaleString()} 已退回給你）`
          : "";
      await interaction.editReply(
        `🏁 已公布答案 **${key}** 並結算！${winners} 人答對，每人 ${settled.perWinnerPrize.toLocaleString()} credits。${leftoverNote}`
      );
    }
  } catch (err) {
    console.log(`[ERROR] prediction setans: ${err}\n${err.stack || ""}`.red);
    await interaction.editReply(`❌ ${err.message || err}`).catch(() => {});
  }
}

async function handleCancelButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const quizId = interaction.customId.slice("quiz_cancel_".length);
  const doc = await loadQuiz(client, quizId);
  if (!doc) return interaction.editReply("❌ 找不到活動。");
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply(`❌ 只有主辦人能取消${labelOf(doc)}。`);
  }
  if (doc.status !== "ACTIVE" && doc.status !== "LOCKED") {
    return interaction.editReply(`❌ ${labelOf(doc)}已結束，無法取消。`);
  }

  try {
    const cancelled = await cancelQuiz(client, doc, interaction.user);
    const fee = cancelled.refundFee || 0;
    const net = cancelled.refundNet ?? cancelled.prizePool;
    const feeLine =
      fee > 0
        ? `（系統抽成 ${fee.toLocaleString()} credits，實退 ${net.toLocaleString()}）`
        : "";
    await interaction.editReply(
      `🚫 ${labelOf(cancelled)}已取消，獎金 ${net.toLocaleString()} credits 已退還。${feeLine}`
    );
  } catch (err) {
    console.log(`[ERROR] quiz cancel: ${err}\n${err.stack || ""}`.red);
    await interaction.editReply(`❌ ${err.message || err}`).catch(() => {});
  }
}

module.exports = async (client, interaction) => {
  const customId = interaction.customId;
  if (!customId || !isQuizInteraction(customId)) return;
  if (!interaction.isButton()) return;
  if (!client.quizGamesCollection) return;

  const rl = consume(interaction.user.id, "btn:quiz", { windowMs: 1500, max: 1 });
  if (!rl.allowed) {
    try {
      await interaction.reply({
        content: `⏳ 操作太頻繁，請 ${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (_) {
      /* noop */
    }
    return;
  }

  try {
    if (customId.startsWith("quiz_ans_")) return handleAnswerButton(client, interaction);
    if (customId.startsWith("quiz_setans_")) return handleSetAnswerButton(client, interaction);
    if (customId.startsWith("quiz_lock_")) return handleLockButton(client, interaction);
    if (customId.startsWith("quiz_reveal_")) return handleRevealButton(client, interaction);
    if (customId.startsWith("quiz_end_")) return handleRevealButton(client, interaction);
    if (customId.startsWith("quiz_cancel_")) return handleCancelButton(client, interaction);
  } catch (error) {
    console.log(`[ERROR] handleQuizInteraction (${customId}): ${error}\n${error.stack || ""}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "❌ 處理互動時發生錯誤。" });
      } else {
        await interaction.reply({
          content: "❌ 處理互動時發生錯誤。",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
