require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");

const grantCoins = require("../economy/grantCoins");
const { computeRefundFee } = require("../economy/refundFee");
const { hostedEvents: hostedEventsConfig } = require("../../config");

const EVENT_CHANNEL_ID = hostedEventsConfig?.publishChannelId || "1174352640210124877";
const MAX_RANK_COUNT = hostedEventsConfig?.maxRankCount || 5;
const EMBED_COLOR_ACTIVE = 0x57f287;
const EMBED_COLOR_SETTLED = 0xfee75c;
const EMBED_COLOR_CANCELLED = 0xed4245;

function newEventId(hostId) {
  return `evt-${Date.now().toString(36)}-${hostId.slice(-5)}`;
}

function buildActiveContainer(eventDoc) {
  const {
    name,
    description,
    hostId,
    prizePool,
    rankCount,
    minParticipants,
    maxParticipants,
    participants,
    recruitmentClosed,
  } = eventDoc;

  const participantLine = participants.length
    ? participants.map((id) => `<@${id}>`).join(" ")
    : "（尚無人報名）";

  const capacityLabel = maxParticipants
    ? `${participants.length} / ${maxParticipants}（最少 ${minParticipants}）`
    : `${participants.length}（最少 ${minParticipants}）`;

  const isFull = maxParticipants && participants.length >= maxParticipants;
  let statusLabel;
  if (recruitmentClosed) statusLabel = "報名已截止";
  else if (isFull) statusLabel = "報名中（已滿）";
  else statusLabel = "報名中";

  const createdEpoch = Math.floor(
    (eventDoc.createdAt ? new Date(eventDoc.createdAt).getTime() : Date.now()) / 1000,
  );

  return new ContainerBuilder()
    .setAccentColor(recruitmentClosed ? 0x95a5a6 : EMBED_COLOR_ACTIVE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎉 ${name}\n${description || "（沒有描述）"}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**主辦人**：<@${hostId}>\n` +
          `**獎金池**：${prizePool.toLocaleString()} credits\n` +
          `**名次**：${rankCount} 名\n` +
          `**報名人數**：${capacityLabel}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${statusLabel}**\n${participantLine.slice(0, 3500)}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 活動 ID：${eventDoc.eventId} ・ <t:${createdEpoch}:f>`,
      ),
    );
}

function buildSettledContainer(eventDoc) {
  const { name, description, hostId, prizePool, winners = [], totalPaid = 0 } = eventDoc;
  const unpaid = prizePool - totalPaid;
  const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];

  const winnerLines = winners
    .sort((a, b) => a.rank - b.rank)
    .map((w) => `${medals[w.rank - 1] || "🏅"} 第 ${w.rank} 名 <@${w.userId}> — ${w.prize.toLocaleString()} credits`)
    .join("\n");

  const refundFee = eventDoc.refundFee || 0;
  const refundNet = eventDoc.refundNet !== undefined ? eventDoc.refundNet : Math.max(unpaid - refundFee, 0);

  const settledEpoch = Math.floor(
    (eventDoc.settledAt ? new Date(eventDoc.settledAt).getTime() : Date.now()) / 1000,
  );

  const container = new ContainerBuilder()
    .setAccentColor(EMBED_COLOR_SETTLED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏆 ${name}（已結算）\n${description || "（沒有描述）"}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**主辦人**：<@${hostId}>\n**原始獎金池**：${prizePool.toLocaleString()} credits`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**得獎名單**\n${winnerLines || "（無）"}`,
      ),
    );

  if (unpaid > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**未發出退回主辦人**：${refundNet.toLocaleString()} credits` +
          (refundFee > 0
            ? `\n**系統抽成（防洗錢）**：${refundFee.toLocaleString()} credits`
            : ""),
      ),
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 活動 ID：${eventDoc.eventId} ・ <t:${settledEpoch}:f>`,
    ),
  );

  return container;
}

function buildCancelledContainer(eventDoc) {
  const refundFee = eventDoc.refundFee || 0;
  const refundNet =
    eventDoc.refundNet !== undefined ? eventDoc.refundNet : Math.max(eventDoc.prizePool - refundFee, 0);

  const lines = [
    `**主辦人**：<@${eventDoc.hostId}>`,
    `**獎金已退還**：${refundNet.toLocaleString()} credits`,
  ];
  if (refundFee > 0) {
    lines.push(`**系統抽成（防洗錢）**：${refundFee.toLocaleString()} credits`);
  }

  const cancelledEpoch = Math.floor(
    (eventDoc.cancelledAt ? new Date(eventDoc.cancelledAt).getTime() : Date.now()) / 1000,
  );

  return new ContainerBuilder()
    .setAccentColor(EMBED_COLOR_CANCELLED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🚫 ${eventDoc.name}（已取消）\n${eventDoc.description || "（沒有描述）"}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n")),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 活動 ID：${eventDoc.eventId} ・ <t:${cancelledEpoch}:f>`,
      ),
    );
}

function buildActionRow(eventId, opts = {}) {
  const { recruitmentClosed = false } = opts;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`event_join_${eventId}`)
      .setLabel(recruitmentClosed ? "報名已截止" : "參與")
      .setEmoji("🎟️")
      .setStyle(recruitmentClosed ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(recruitmentClosed),
    new ButtonBuilder()
      .setCustomId(`event_manage_${eventId}`)
      .setLabel("管理（限主辦人）")
      .setEmoji("⚙️")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildManagePanel(eventDoc) {
  const participantCount = eventDoc.participants.length;
  const canSettle = participantCount >= eventDoc.minParticipants && participantCount >= 1;
  const isClosed = !!eventDoc.recruitmentClosed;
  const effectiveRanks = Math.min(eventDoc.rankCount, participantCount);

  const settleBtn = new ButtonBuilder()
    .setCustomId(`event_settle_${eventDoc.eventId}`)
    .setLabel(
      canSettle
        ? effectiveRanks < eventDoc.rankCount
          ? `結算（${effectiveRanks} 名）`
          : "結算名次"
        : `結算（需 ≥ ${Math.max(eventDoc.minParticipants, 1)} 人）`
    )
    .setEmoji("🏆")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!canSettle);

  const toggleBtn = new ButtonBuilder()
    .setCustomId(`event_toggleopen_${eventDoc.eventId}`)
    .setLabel(isClosed ? "重新開放報名" : "結束報名")
    .setEmoji(isClosed ? "🔓" : "🔒")
    .setStyle(isClosed ? ButtonStyle.Success : ButtonStyle.Secondary);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`event_cancel_${eventDoc.eventId}`)
    .setLabel("取消活動")
    .setEmoji("🚫")
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(settleBtn, toggleBtn, cancelBtn);
}

function buildPickSelect(eventDoc, rank, alreadyPicked, participantMembers) {
  const available = eventDoc.participants.filter((id) => !alreadyPicked.includes(id));
  const options = available.slice(0, 25).map((id) => {
    const member = participantMembers.get(id);
    const label = member?.displayName || member?.user?.username || id;
    return { label: label.slice(0, 100), value: id };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`event_pick_${eventDoc.eventId}_${rank}`)
      .setPlaceholder(`選擇第 ${rank} 名得獎者`)
      .addOptions(options)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

function buildAmountModal(eventDoc, picks, participantMembers) {
  const modal = new ModalBuilder()
    .setCustomId(`event_amounts_${eventDoc.eventId}`)
    .setTitle(`填入各名次獎金（≤ ${eventDoc.prizePool}）`);

  picks.forEach((userId, idx) => {
    const rank = idx + 1;
    const member = participantMembers.get(userId);
    const name = member?.displayName || member?.user?.username || userId;
    const input = new TextInputBuilder()
      .setCustomId(`prize_${rank}`)
      .setLabel(`第 ${rank} 名：${name}`.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10)
      .setPlaceholder("輸入正整數金額");
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });

  return modal;
}

async function createEvent(client, opts) {
  const {
    guild,
    host,
    member,
    name,
    description,
    prizePool,
    rankCount,
    minParticipants,
    maxParticipants,
  } = opts;

  if (!client.hostedEventsCollection) {
    throw new Error("活動系統尚未啟動（資料庫未連線）");
  }

  if (rankCount < 1 || rankCount > MAX_RANK_COUNT) {
    throw new Error(`名次數需在 1 ~ ${MAX_RANK_COUNT} 之間。`);
  }
  if (prizePool < rankCount) {
    throw new Error("獎金池必須 ≥ 名次數（每名至少 1 credit）。");
  }
  if (minParticipants < 1) {
    throw new Error("最少人數需 ≥ 1。");
  }
  if (maxParticipants && maxParticipants < minParticipants) {
    throw new Error("最多人數不能小於最少人數。");
  }

  const before = await client.userCoinsCollection.findOne({
    userId: host.id,
    guildId: guild.id,
  });
  const balance = before?.totalCoins || 0;
  if (balance < prizePool) {
    throw new Error(
      `餘額不足！活動需鎖定 ${prizePool.toLocaleString()} credits，目前 ${balance.toLocaleString()}。`
    );
  }

  const channel = await guild.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased?.()) {
    throw new Error(`找不到活動發布頻道（${EVENT_CHANNEL_ID}），請聯絡舒舒。`);
  }

  const eventId = newEventId(host.id);

  const debit = await grantCoins(client, {
    userId: host.id,
    guildId: guild.id,
    username: member?.displayName || host.username,
    avatarHash: host.avatar,
    amount: -prizePool,
    source: "event_host_lock",
    member,
    meta: { eventId, name },
  });
  if (!debit) {
    throw new Error("扣款失敗，活動未建立。");
  }

  const eventDoc = {
    eventId,
    guildId: guild.id,
    channelId: channel.id,
    messageId: null,
    hostId: host.id,
    hostName: member?.displayName || host.username,
    name,
    description: description || null,
    prizePool,
    rankCount,
    minParticipants,
    maxParticipants: maxParticipants || null,
    participants: [],
    status: "RECRUITING",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const container = buildActiveContainer(eventDoc).addActionRowComponents(
      buildActionRow(eventId),
    );
    const msg = await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    eventDoc.messageId = msg.id;
    await client.hostedEventsCollection.insertOne(eventDoc);
    return { eventDoc, channel, message: msg };
  } catch (err) {
    await grantCoins(client, {
      userId: host.id,
      guildId: guild.id,
      amount: prizePool,
      source: "admin",
      meta: { reason: `event create rollback: ${eventId}`, operatorId: "system" },
    }).catch(() => {});
    throw err;
  }
}

async function refreshEventMessage(client, eventDoc) {
  const channel = await client.channels.fetch(eventDoc.channelId).catch(() => null);
  if (!channel) return null;
  const msg = await channel.messages.fetch(eventDoc.messageId).catch(() => null);
  if (!msg) return null;

  let container;
  if (eventDoc.status === "RECRUITING") {
    container = buildActiveContainer(eventDoc).addActionRowComponents(
      buildActionRow(eventDoc.eventId, {
        recruitmentClosed: !!eventDoc.recruitmentClosed,
      }),
    );
  } else if (eventDoc.status === "SETTLED") {
    container = buildSettledContainer(eventDoc);
  } else {
    container = buildCancelledContainer(eventDoc);
  }

  await msg.edit({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
  return msg;
}

function unwrap(res) {
  if (!res) return null;
  return res.value !== undefined ? res.value : res;
}

async function toggleJoin(client, eventDoc, userId) {
  if (eventDoc.recruitmentClosed) {
    return { action: "closed", doc: eventDoc };
  }
  const isJoined = eventDoc.participants.includes(userId);
  if (isJoined) {
    const updated = await client.hostedEventsCollection.findOneAndUpdate(
      { _id: eventDoc._id, status: "RECRUITING" },
      { $pull: { participants: userId }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    const doc = unwrap(updated);
    if (!doc) return { action: "stale", doc: eventDoc };
    return { action: "leave", doc };
  }

  if (eventDoc.maxParticipants && eventDoc.participants.length >= eventDoc.maxParticipants) {
    return { action: "full", doc: eventDoc };
  }

  const filter = { _id: eventDoc._id, status: "RECRUITING" };
  if (eventDoc.maxParticipants) {
    filter[`participants.${eventDoc.maxParticipants - 1}`] = { $exists: false };
  }

  const updated = await client.hostedEventsCollection.findOneAndUpdate(
    filter,
    { $addToSet: { participants: userId }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) return { action: "full", doc: eventDoc };
  return { action: "join", doc };
}

async function setRecruitmentClosed(client, eventDoc, closed) {
  const updated = await client.hostedEventsCollection.findOneAndUpdate(
    { _id: eventDoc._id, status: "RECRUITING" },
    { $set: { recruitmentClosed: !!closed, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) {
    throw new Error("活動已不在報名階段。");
  }
  await refreshEventMessage(client, doc).catch(() => {});
  return doc;
}

async function cancelEvent(client, eventDoc, actor, channel) {
  const { fee, net, rate } = computeRefundFee(eventDoc.prizePool);

  const updated = await client.hostedEventsCollection.findOneAndUpdate(
    { _id: eventDoc._id, status: "RECRUITING" },
    {
      $set: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        updatedAt: new Date(),
        cancelledBy: actor.id,
        refundFee: fee,
        refundNet: net,
        refundFeeRate: rate,
      },
    },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) {
    throw new Error("活動已不在報名階段，無法取消。");
  }

  if (net > 0) {
    await grantCoins(client, {
      userId: eventDoc.hostId,
      guildId: eventDoc.guildId,
      amount: net,
      source: "event_refund",
      meta: {
        eventId: eventDoc.eventId,
        reason: "host_cancelled",
        gross: eventDoc.prizePool,
        fee,
        feeRate: rate,
      },
    }).catch((e) => {
      console.log(`[ERROR] event refund failed for ${eventDoc.eventId}: ${e}`.red);
    });
  }

  const msg = await refreshEventMessage(client, doc);

  if (msg && doc.participants.length > 0) {
    const mentions = doc.participants.map((id) => `<@${id}>`).join(" ");
    const feeNote =
      fee > 0
        ? `（系統抽成 ${fee.toLocaleString()} credits，實際退還 ${net.toLocaleString()}）`
        : "";
    await msg
      .reply({
        content: `🚫 活動「${doc.name}」已由主辦人取消，獎金已退還。${feeNote}\n${mentions}`,
        allowedMentions: { users: doc.participants },
      })
      .catch(() => {});
  }

  return doc;
}

async function settleEvent(client, eventDoc, picks, prizes) {
  const effectiveRanks = Math.min(eventDoc.rankCount, eventDoc.participants.length);
  if (picks.length === 0 || picks.length !== effectiveRanks) {
    throw new Error("名次選擇不完整。");
  }
  if (prizes.length !== effectiveRanks) {
    throw new Error("獎金數量與名次不符。");
  }
  for (const p of prizes) {
    if (!Number.isInteger(p) || p < 1) {
      throw new Error("每個獎金需為 ≥ 1 的整數。");
    }
  }
  const total = prizes.reduce((a, b) => a + b, 0);
  if (total > eventDoc.prizePool) {
    throw new Error(
      `獎金總和 ${total.toLocaleString()} 超過鎖定獎金池 ${eventDoc.prizePool.toLocaleString()}。`
    );
  }

  const winners = picks.map((userId, idx) => ({
    userId,
    rank: idx + 1,
    prize: prizes[idx],
  }));

  const unpaid = eventDoc.prizePool - total;
  const { fee, net, rate } = computeRefundFee(unpaid);

  const updated = await client.hostedEventsCollection.findOneAndUpdate(
    { _id: eventDoc._id, status: "RECRUITING" },
    {
      $set: {
        status: "SETTLED",
        settledAt: new Date(),
        updatedAt: new Date(),
        winners,
        totalPaid: total,
        refundFee: fee,
        refundNet: net,
        refundFeeRate: rate,
      },
    },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) {
    throw new Error("活動狀態已改變，無法結算。");
  }

  for (const w of winners) {
    await grantCoins(client, {
      userId: w.userId,
      guildId: eventDoc.guildId,
      amount: w.prize,
      source: "event_prize",
      meta: { eventId: eventDoc.eventId, rank: w.rank, hostId: eventDoc.hostId },
    }).catch((e) => {
      console.log(`[ERROR] event prize payout failed (${eventDoc.eventId} rank ${w.rank}): ${e}`.red);
    });
  }

  if (net > 0) {
    await grantCoins(client, {
      userId: eventDoc.hostId,
      guildId: eventDoc.guildId,
      amount: net,
      source: "event_refund",
      meta: {
        eventId: eventDoc.eventId,
        reason: "leftover",
        gross: unpaid,
        fee,
        feeRate: rate,
      },
    }).catch((e) => {
      console.log(`[ERROR] event leftover refund failed: ${e}`.red);
    });
  }

  const msg = await refreshEventMessage(client, doc);

  if (msg) {
    const medals = ["🥇", "🥈", "🥉", "🏅", "🏅"];
    const lines = winners.map(
      (w) =>
        `${medals[w.rank - 1] || "🏅"} 第 ${w.rank} 名 <@${w.userId}> — ${w.prize.toLocaleString()} credits`
    );
    let tail = "";
    if (unpaid > 0) {
      tail = `\n（剩餘 ${unpaid.toLocaleString()} 未發出`;
      if (fee > 0) {
        tail += `，系統抽成 ${fee.toLocaleString()}，退回主辦人 ${net.toLocaleString()}`;
      } else {
        tail += `，已退回主辦人 ${net.toLocaleString()}`;
      }
      tail += "）";
    }
    const winnerIds = winners.map((w) => w.userId);
    await msg
      .reply({
        content: `🏆 活動「${doc.name}」結算完成\n${lines.join("\n")}${tail}`,
        allowedMentions: { users: winnerIds },
      })
      .catch(() => {});
  }

  return doc;
}

module.exports = {
  EVENT_CHANNEL_ID,
  MAX_RANK_COUNT,
  createEvent,
  toggleJoin,
  cancelEvent,
  settleEvent,
  setRecruitmentClosed,
  refreshEventMessage,
  buildActiveContainer,
  buildSettledContainer,
  buildCancelledContainer,
  buildActionRow,
  buildManagePanel,
  buildPickSelect,
  buildAmountModal,
};
