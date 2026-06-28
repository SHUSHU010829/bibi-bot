require("colors");
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const {
  toggleJoin,
  cancelEvent,
  settleEvent,
  setRecruitmentClosed,
  refreshEventMessage,
  buildManagePanel,
  buildPickSelect,
  buildAmountModal,
} = require("../../features/event/hostedEvent");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe, deferUpdateSafe, isUnknownInteraction } = require("../../utils/safeAck");

// 結算選名次的暫存：key=`${eventId}:${hostId}` → { picks: [userId,...] }
const pendingPicks = new Map();
const PICK_TTL_MS = 10 * 60 * 1000;

function setPicks(eventId, hostId, picks) {
  pendingPicks.set(`${eventId}:${hostId}`, { picks, ts: Date.now() });
}

function getPicks(eventId, hostId) {
  const key = `${eventId}:${hostId}`;
  const entry = pendingPicks.get(key);
  if (!entry) return [];
  if (Date.now() - entry.ts > PICK_TTL_MS) {
    pendingPicks.delete(key);
    return [];
  }
  return entry.picks;
}

function clearPicks(eventId, hostId) {
  pendingPicks.delete(`${eventId}:${hostId}`);
}

function isEventInteraction(customId) {
  return (
    typeof customId === "string" &&
    (customId.startsWith("event_join_") ||
      customId.startsWith("event_manage_") ||
      customId.startsWith("event_settle_") ||
      customId.startsWith("event_cancel_") ||
      customId.startsWith("event_toggleopen_") ||
      customId.startsWith("event_pick_") ||
      customId.startsWith("event_amounts_"))
  );
}

async function loadEventByCustomId(client, customId, prefix) {
  const eventId = customId.slice(prefix.length);
  const doc = await client.hostedEventsCollection.findOne({ eventId });
  return { eventId, doc };
}

async function fetchParticipantMembers(guild, ids) {
  const map = new Map();
  await Promise.all(
    ids.map(async (id) => {
      const m = await guild.members.fetch(id).catch(() => null);
      if (m) map.set(id, m);
    })
  );
  return map;
}

async function handleJoinButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const { doc } = await loadEventByCustomId(client, interaction.customId, "event_join_");
  if (!doc) {
    return interaction.editReply("❌ 找不到活動。");
  }
  if (doc.status !== "RECRUITING") {
    return interaction.editReply("❌ 活動已不在報名階段。");
  }
  if (interaction.user.id === doc.hostId) {
    return interaction.editReply("❌ 主辦人不能報名自己的活動。");
  }

  const result = await toggleJoin(client, doc, interaction.user.id);

  if (result.action === "full") {
    return interaction.editReply("🚫 活動人數已滿，無法報名。");
  }
  if (result.action === "closed") {
    return interaction.editReply("🔒 報名已截止，無法加入。");
  }

  await refreshEventMessage(client, result.doc).catch(() => {});

  if (result.action === "join") {
    return interaction.editReply(`✅ 已報名活動「${doc.name}」。`);
  }
  return interaction.editReply(`↩️ 已取消報名活動「${doc.name}」。`);
}

async function handleManageButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const { doc } = await loadEventByCustomId(client, interaction.customId, "event_manage_");
  if (!doc) {
    return interaction.editReply({ content: "❌ 找不到活動。" });
  }
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply({
      content: "❌ 只有主辦人可以管理這個活動。",
    });
  }
  if (doc.status !== "RECRUITING") {
    return interaction.editReply({
      content: `❌ 活動已經 ${doc.status === "SETTLED" ? "結算" : "取消"}。`,
    });
  }

  await interaction.editReply({
    content:
      `⚙️ 活動「${doc.name}」管理面板\n` +
      `目前報名 **${doc.participants.length}** 人（需 ≥ ${doc.minParticipants} 人才能結算）`,
    components: [buildManagePanel(doc)],
  });
}

async function handleToggleOpenButton(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;

  const { doc } = await loadEventByCustomId(
    client,
    interaction.customId,
    "event_toggleopen_"
  );
  if (!doc) return interaction.editReply({ content: "❌ 找不到活動。", components: [] });
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply({ content: "❌ 只有主辦人能操作。", components: [] });
  }
  if (doc.status !== "RECRUITING") {
    return interaction.editReply({
      content: "❌ 活動已不在報名階段。",
      components: [],
    });
  }

  try {
    const next = !doc.recruitmentClosed;
    const updated = await setRecruitmentClosed(client, doc, next);
    await interaction.editReply({
      content: next
        ? `🔒 已結束「${doc.name}」的報名，原訊息「參與」鈕已禁用。`
        : `🔓 已重新開放「${doc.name}」的報名。`,
      components: [buildManagePanel(updated)],
    });
  } catch (err) {
    console.log(`[ERROR] event toggle recruitment: ${err}`.red);
    await interaction.editReply({ content: `❌ ${err.message || err}`, components: [] });
  }
}

async function handleCancelButton(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;

  const { doc } = await loadEventByCustomId(client, interaction.customId, "event_cancel_");
  if (!doc) return interaction.editReply({ content: "❌ 找不到活動。", components: [] });
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply({ content: "❌ 只有主辦人能取消活動。", components: [] });
  }
  if (doc.status !== "RECRUITING") {
    return interaction.editReply({
      content: "❌ 活動已不在報名階段，無法取消。",
      components: [],
    });
  }

  try {
    const cancelled = await cancelEvent(client, doc, interaction.user);
    clearPicks(doc.eventId, doc.hostId);
    const fee = cancelled.refundFee || 0;
    const net = cancelled.refundNet ?? cancelled.prizePool;
    const feeLine =
      fee > 0
        ? `（系統抽成 ${fee.toLocaleString()} credits，實退 ${net.toLocaleString()}）`
        : "";
    await interaction.editReply({
      content: `🚫 活動「${cancelled.name}」已取消，獎金 ${net.toLocaleString()} credits 已退還。${feeLine}`,
      components: [],
    });
  } catch (err) {
    console.log(`[ERROR] event cancel: ${err}`.red);
    await interaction.editReply({ content: `❌ ${err.message || err}`, components: [] });
  }
}

async function startSettleFlow(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const { doc } = await loadEventByCustomId(client, interaction.customId, "event_settle_");
  if (!doc) {
    return interaction.editReply({ content: "❌ 找不到活動。" });
  }
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply({ content: "❌ 只有主辦人能結算。" });
  }
  if (doc.status !== "RECRUITING") {
    return interaction.editReply({
      content: "❌ 活動已不在報名階段。",
    });
  }
  if (doc.participants.length < doc.minParticipants) {
    return interaction.editReply({
      content: `❌ 報名人數 ${doc.participants.length} 人未達最少 ${doc.minParticipants} 人。`,
    });
  }

  const effectiveRanks = Math.min(doc.rankCount, doc.participants.length);

  clearPicks(doc.eventId, doc.hostId);
  setPicks(doc.eventId, doc.hostId, []);

  const members = await fetchParticipantMembers(interaction.guild, doc.participants);

  const noteShort =
    effectiveRanks < doc.rankCount
      ? `（人數 ${doc.participants.length} < 名次 ${doc.rankCount}，將只發出 ${effectiveRanks} 名，剩餘退回主辦人）\n`
      : "";

  await interaction.editReply({
    content: `🏆 開始結算「${doc.name}」（共 ${effectiveRanks} 名）\n${noteShort}請依序選出第 1 名。`,
    components: [buildPickSelect(doc, 1, [], members)],
  });
}

async function handlePickSelect(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;

  // customId: event_pick_{eventId}_{rank}
  const rest = interaction.customId.slice("event_pick_".length);
  const lastUnderscore = rest.lastIndexOf("_");
  const eventId = rest.slice(0, lastUnderscore);
  const rank = parseInt(rest.slice(lastUnderscore + 1), 10);

  const doc = await client.hostedEventsCollection.findOne({ eventId });
  if (!doc) {
    return interaction.editReply({ content: "❌ 找不到活動。", components: [] });
  }
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply({ content: "❌ 只有主辦人能操作。", components: [] });
  }
  if (doc.status !== "RECRUITING") {
    clearPicks(eventId, doc.hostId);
    return interaction.editReply({ content: "❌ 活動已結束。", components: [] });
  }

  const picked = interaction.values[0];
  const currentPicks = getPicks(eventId, doc.hostId);

  if (currentPicks.length !== rank - 1) {
    clearPicks(eventId, doc.hostId);
    return interaction.editReply({
      content: "❌ 結算狀態已失效，請重新點「管理 → 結算」。",
      components: [],
    });
  }

  if (currentPicks.includes(picked)) {
    return interaction.editReply({
      content: `❌ 此成員已在名次內。請重選第 ${rank} 名。`,
      components: interaction.message.components,
    });
  }

  const nextPicks = [...currentPicks, picked];
  setPicks(eventId, doc.hostId, nextPicks);

  const effectiveRanks = Math.min(doc.rankCount, doc.participants.length);
  const members = await fetchParticipantMembers(interaction.guild, doc.participants);
  const pickedLines = nextPicks
    .map((id, idx) => {
      const m = members.get(id);
      const name = m?.displayName || m?.user?.username || id;
      return `第 ${idx + 1} 名：${name}`;
    })
    .join("\n");

  if (rank < effectiveRanks) {
    await interaction.editReply({
      content: `✅ 已選\n${pickedLines}\n\n請選第 ${rank + 1} 名。`,
      components: [buildPickSelect(doc, rank + 1, nextPicks, members)],
    });
  } else {
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`event_amounts_${eventId}`)
        .setLabel("輸入各名次獎金")
        .setEmoji("💰")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`event_settle_${eventId}`)
        .setLabel("重新選擇")
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({
      content:
        `✅ 名次選擇完成\n${pickedLines}\n\n` +
        `獎金池：**${doc.prizePool.toLocaleString()}** credits\n` +
        `按「輸入各名次獎金」開啟視窗填入金額。`,
      components: [confirmRow],
    });
  }
}

async function handleAmountsButton(client, interaction) {
  const eventId = interaction.customId.slice("event_amounts_".length);
  const doc = await client.hostedEventsCollection.findOne({ eventId });
  if (!doc) {
    return interaction.reply({ content: "❌ 找不到活動。", flags: MessageFlags.Ephemeral });
  }
  if (interaction.user.id !== doc.hostId) {
    return interaction.reply({ content: "❌ 只有主辦人能操作。", flags: MessageFlags.Ephemeral });
  }
  if (doc.status !== "RECRUITING") {
    clearPicks(eventId, doc.hostId);
    return interaction.reply({ content: "❌ 活動已結束。", flags: MessageFlags.Ephemeral });
  }

  const effectiveRanks = Math.min(doc.rankCount, doc.participants.length);
  const picks = getPicks(eventId, doc.hostId);
  if (picks.length !== effectiveRanks) {
    return interaction.reply({
      content: "❌ 名次選擇已失效，請從「管理 → 結算」重新開始。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const members = await fetchParticipantMembers(interaction.guild, picks);
  const modal = buildAmountModal(doc, picks, members);
  await interaction.showModal(modal);
}

async function handleAmountsModal(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const eventId = interaction.customId.slice("event_amounts_".length);
  const doc = await client.hostedEventsCollection.findOne({ eventId });
  if (!doc) return interaction.editReply("❌ 找不到活動。");
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply("❌ 只有主辦人能操作。");
  }
  if (doc.status !== "RECRUITING") {
    clearPicks(eventId, doc.hostId);
    return interaction.editReply("❌ 活動已結束。");
  }

  const effectiveRanks = Math.min(doc.rankCount, doc.participants.length);
  const picks = getPicks(eventId, doc.hostId);
  if (picks.length !== effectiveRanks) {
    return interaction.editReply("❌ 名次選擇已失效，請重新結算。");
  }

  const prizes = [];
  for (let i = 1; i <= effectiveRanks; i += 1) {
    const raw = interaction.fields.getTextInputValue(`prize_${i}`).trim().replace(/[,，\s]/g, "");
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 1) {
      return interaction.editReply(`❌ 第 ${i} 名的獎金「${raw}」不是有效的正整數。`);
    }
    prizes.push(num);
  }

  try {
    const settled = await settleEvent(client, doc, picks, prizes);
    clearPicks(eventId, doc.hostId);
    const total = prizes.reduce((a, b) => a + b, 0);
    const unpaid = doc.prizePool - total;
    const fee = settled.refundFee || 0;
    const net = settled.refundNet ?? unpaid;
    let tail = "。";
    if (unpaid > 0) {
      tail =
        fee > 0
          ? `，剩餘 ${unpaid.toLocaleString()}（系統抽成 ${fee.toLocaleString()}，退回給你 ${net.toLocaleString()}）。`
          : `，剩餘 ${net.toLocaleString()} 退回給你。`;
    }
    await interaction.editReply(
      `🎉 結算完成！已發出 **${total.toLocaleString()}** credits` +
        tail +
        `\n活動訊息：<#${settled.channelId}>`
    );
  } catch (err) {
    console.log(`[ERROR] event settle: ${err}\n${err.stack || ""}`.red);
    await interaction.editReply(`❌ ${err.message || err}`).catch(() => {});
  }
}

module.exports = async (client, interaction) => {
  const customId = interaction.customId;
  if (!customId || !isEventInteraction(customId)) return;
  if (!client.hostedEventsCollection) return;

  // 速率限制
  const rl = consume(interaction.user.id, "btn:event", { windowMs: 1500, max: 1 });
  if (!rl.allowed) {
    const reply = {
      content: `⏳ 操作太頻繁，請 ${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.isModalSubmit()) {
        await interaction.reply(reply);
      } else if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(reply);
      }
    } catch (_) { /* noop */ }
    return;
  }

  try {
    if (interaction.isButton()) {
      if (customId.startsWith("event_join_")) return handleJoinButton(client, interaction);
      if (customId.startsWith("event_manage_")) return handleManageButton(client, interaction);
      if (customId.startsWith("event_settle_")) return startSettleFlow(client, interaction);
      if (customId.startsWith("event_cancel_")) return handleCancelButton(client, interaction);
      if (customId.startsWith("event_toggleopen_")) return handleToggleOpenButton(client, interaction);
      if (customId.startsWith("event_amounts_")) return handleAmountsButton(client, interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (customId.startsWith("event_pick_")) return handlePickSelect(client, interaction);
    } else if (interaction.isModalSubmit()) {
      if (customId.startsWith("event_amounts_")) return handleAmountsModal(client, interaction);
    }
  } catch (error) {
    console.log(`[ERROR] handleEventInteraction (${customId}): ${error}\n${error.stack || ""}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "❌ 處理活動互動時發生錯誤。" });
      } else {
        await interaction.reply({
          content: "❌ 處理活動互動時發生錯誤。",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) { /* noop */ }
  }
};
