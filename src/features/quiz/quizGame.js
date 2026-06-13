require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const grantCoins = require("../economy/grantCoins");
const { computeRefundFee } = require("../economy/refundFee");
const { hostedEvents: hostedEventsConfig } = require("../../config");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const QUIZ_CHANNEL_ID = hostedEventsConfig?.publishChannelId || "1174352640210124877";
const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const MAX_QUESTION_LEN = 250;
const MAX_OPTION_LEN = 100;
const OPTION_KEYS = ["A", "B", "C", "D"];
const OPTION_EMOJIS = { A: "🇦", B: "🇧", C: "🇨", D: "🇩" };

const KIND_QUIZ = "quiz";
const KIND_PREDICTION = "prediction";

const MODE_SPLIT = "split";
const MODE_SOLO = "solo";

const COLOR_ACTIVE = 0x5865f2;
const COLOR_PREDICTION_ACTIVE = 0x9b59b6;
const COLOR_SOLO_ACTIVE = 0xe67e22;
const COLOR_LOCKED = 0xeb8f34;
const COLOR_SETTLED = 0xfee75c;
const COLOR_CANCELLED = 0xed4245;

function getKind(quizDoc) {
  return quizDoc?.kind === KIND_PREDICTION ? KIND_PREDICTION : KIND_QUIZ;
}

function isPrediction(quizDoc) {
  return getKind(quizDoc) === KIND_PREDICTION;
}

function getMode(quizDoc) {
  return quizDoc?.mode === MODE_SOLO ? MODE_SOLO : MODE_SPLIT;
}

function isSolo(quizDoc) {
  return getMode(quizDoc) === MODE_SOLO && !isPrediction(quizDoc);
}

function modeLabel(quizDoc) {
  return isSolo(quizDoc) ? "搶答獨佔" : "平分獎金";
}

function newQuizId(hostId, kind) {
  const prefix = kind === KIND_PREDICTION ? "pd" : "qz";
  return `${prefix}-${Date.now().toString(36)}-${hostId.slice(-5)}`;
}

function formatEndsAt(endsAt) {
  const ts = Math.floor(new Date(endsAt).getTime() / 1000);
  return `<t:${ts}:R>（<t:${ts}:T>）`;
}

function kindLabel(quizDoc) {
  return isPrediction(quizDoc) ? "預測" : "問答";
}

function tsEpoch(d) {
  return Math.floor((d ? new Date(d).getTime() : Date.now()) / 1000);
}

function buildActiveContainer(quizDoc, { intro = "", guild = null } = {}) {
  const { question, options, prizePool, hostId, endsAt, answers = {} } = quizDoc;
  const answerCount = Object.keys(answers).length;
  const prediction = isPrediction(quizDoc);
  const solo = isSolo(quizDoc);

  const optionLines = options
    .map((o) => `${OPTION_EMOJIS[o.key]} **${o.key}.** ${o.text}`)
    .join("\n");

  const title = prediction
    ? `🔮 [預測] ${question}`
    : solo
    ? `⚡ [搶答] ${question}`
    : `❓ ${question}`;
  const footerTip = prediction
    ? "答對者平分獎金池（答案稍後由主辦人公布）"
    : solo
    ? "首位答對者獨得全部獎金"
    : "答對者平分獎金池";

  const color = prediction
    ? COLOR_PREDICTION_ACTIVE
    : solo
    ? COLOR_SOLO_ACTIVE
    : COLOR_ACTIVE;

  const infoLines = [
    `**主辦人**：${plainifyUserMentions(guild, `<@${hostId}>`)}`,
    `**獎金池**：${prizePool.toLocaleString()} credits`,
    `**已作答人數**：${answerCount} 人`,
  ];
  if (!prediction) infoLines.push(`**模式**：${modeLabel(quizDoc)}`);
  infoLines.push(
    `**截止時間**：${
      endsAt ? formatEndsAt(endsAt) : "♾️ 無時間限制（等待主辦人結算或首位答對者搶答）"
    }`,
  );

  const head = intro ? `${intro}\n# ${title}\n${optionLines}` : `# ${title}\n${optionLines}`;

  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(head))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(infoLines.join("\n")),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${kindLabel(quizDoc)} ID：${quizDoc.quizId} ・ 提示：${footerTip} ・ <t:${tsEpoch(quizDoc.createdAt)}:f>`,
      ),
    );
}

function buildLockedContainer(quizDoc, guild) {
  const { question, options, prizePool, hostId, answers = {}, lockedAt } = quizDoc;
  const answerCount = Object.keys(answers).length;

  const optionLines = options
    .map((o) => `${OPTION_EMOJIS[o.key]} **${o.key}.** ${o.text}`)
    .join("\n");

  const ts = lockedAt ? Math.floor(new Date(lockedAt).getTime() / 1000) : null;
  const tip = isPrediction(quizDoc)
    ? "**作答已截止**，等待主辦人公布正確答案 🔮"
    : "**作答已截止**，等待主辦人公布答案 ⏳";

  return new ContainerBuilder()
    .setAccentColor(COLOR_LOCKED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔒 ${question}\n${optionLines}\n\n${tip}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**主辦人**：${plainifyUserMentions(guild, `<@${hostId}>`)}\n` +
          `**獎金池**：${prizePool.toLocaleString()} credits\n` +
          `**已作答人數**：${answerCount} 人\n` +
          (ts
            ? `**截止時間**：<t:${ts}:R>（<t:${ts}:T>）`
            : `**狀態**：作答已截止`),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${kindLabel(quizDoc)} ID：${quizDoc.quizId} ・ <t:${tsEpoch(lockedAt)}:f>`,
      ),
    );
}

function buildSettledContainer(quizDoc, guild) {
  const {
    question,
    options,
    correctKey,
    prizePool,
    hostId,
    answers = {},
    winners = [],
    perWinnerPrize = 0,
    totalPaid = 0,
  } = quizDoc;

  const unpaid = prizePool - totalPaid;
  const refundFee = quizDoc.refundFee || 0;
  const refundNet =
    quizDoc.refundNet !== undefined ? quizDoc.refundNet : Math.max(unpaid - refundFee, 0);
  const correctOpt = options.find((o) => o.key === correctKey);

  const tally = {};
  for (const k of OPTION_KEYS) tally[k] = 0;
  for (const ans of Object.values(answers)) {
    if (tally[ans.key] !== undefined) tally[ans.key] += 1;
  }
  const optionLines = options
    .map((o) => {
      const mark = o.key === correctKey ? "✅" : "▫️";
      return `${mark} **${o.key}.** ${o.text} — ${tally[o.key] || 0} 票`;
    })
    .join("\n");

  const solo = isSolo(quizDoc);
  const nameOf = (id) => plainifyUserMentions(guild, `<@${id}>`);
  const winnersField = winners.length
    ? winners
        .map((w) =>
          solo
            ? `🏆 ${nameOf(w.userId)} 搶答成功 — ${w.prize.toLocaleString()} credits`
            : `🎉 ${nameOf(w.userId)} — ${w.prize.toLocaleString()} credits`,
        )
        .join("\n")
    : "（無人答對，獎金已退回主辦人）";

  const winnersHeader = solo
    ? `**搶答得獎者**（獨得 ${perWinnerPrize.toLocaleString()} credits）`
    : `**得獎者**（每人 ${perWinnerPrize.toLocaleString()} credits）`;

  const infoLines = [
    `**主辦人**：${nameOf(hostId)}`,
    `**原始獎金池**：${prizePool.toLocaleString()} credits`,
  ];
  if (!isPrediction(quizDoc)) infoLines.push(`**模式**：${modeLabel(quizDoc)}`);

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SETTLED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🏁 ${question}\n${optionLines}`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(infoLines.join("\n")),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**正確答案**\n${OPTION_EMOJIS[correctKey]} **${correctKey}.** ${correctOpt?.text || ""}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${winnersHeader}\n${winnersField}`),
    );

  if (unpaid > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**退回主辦人**：${refundNet.toLocaleString()} credits` +
          (refundFee > 0
            ? `\n**系統抽成（防洗錢）**：${refundFee.toLocaleString()} credits`
            : ""),
      ),
    );
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# ${kindLabel(quizDoc)} ID：${quizDoc.quizId} ・ <t:${tsEpoch(quizDoc.settledAt)}:f>`,
    ),
  );
  return container;
}

function buildCancelledContainer(quizDoc, guild) {
  const refundFee = quizDoc.refundFee || 0;
  const refundNet =
    quizDoc.refundNet !== undefined
      ? quizDoc.refundNet
      : Math.max(quizDoc.prizePool - refundFee, 0);

  const lines = [
    `**主辦人**：${plainifyUserMentions(guild, `<@${quizDoc.hostId}>`)}`,
    `**獎金已退還**：${refundNet.toLocaleString()} credits`,
  ];
  if (refundFee > 0) {
    lines.push(`**系統抽成（防洗錢）**：${refundFee.toLocaleString()} credits`);
  }

  return new ContainerBuilder()
    .setAccentColor(COLOR_CANCELLED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🚫 ${quizDoc.question}（已取消）`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n")),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${kindLabel(quizDoc)} ID：${quizDoc.quizId} ・ <t:${tsEpoch(quizDoc.cancelledAt)}:f>`,
      ),
    );
}

function buildActionRow(quizDoc) {
  const prediction = isPrediction(quizDoc);
  const status = quizDoc.status;
  const rows = [];

  if (status === "ACTIVE") {
    const answerRow = new ActionRowBuilder();
    for (const opt of quizDoc.options) {
      answerRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`quiz_ans_${quizDoc.quizId}_${opt.key}`)
          .setEmoji(OPTION_EMOJIS[opt.key])
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(answerRow);

    const ctrlRow = new ActionRowBuilder();
    if (prediction) {
      ctrlRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`quiz_lock_${quizDoc.quizId}`)
          .setLabel("提早截止作答（限主辦人）")
          .setEmoji("🔒")
          .setStyle(ButtonStyle.Primary)
      );
    } else {
      ctrlRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`quiz_reveal_${quizDoc.quizId}`)
          .setLabel("立即公布答案並發獎金（限主辦人）")
          .setEmoji("🏁")
          .setStyle(ButtonStyle.Success)
      );
    }
    ctrlRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_cancel_${quizDoc.quizId}`)
        .setLabel("取消")
        .setEmoji("🚫")
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(ctrlRow);
    return rows;
  }

  if (status === "LOCKED") {
    if (prediction) {
      // 預測：作答已截止，主辦人按 A/B/C/D 公布正確答案
      const setAnsRow = new ActionRowBuilder();
      for (const opt of quizDoc.options) {
        setAnsRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`quiz_setans_${quizDoc.quizId}_${opt.key}`)
            .setLabel(`公布 ${opt.key}`)
            .setEmoji(OPTION_EMOJIS[opt.key])
            .setStyle(ButtonStyle.Success)
        );
      }
      setAnsRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`quiz_cancel_${quizDoc.quizId}`)
          .setLabel("取消")
          .setEmoji("🚫")
          .setStyle(ButtonStyle.Danger)
      );
      rows.push(setAnsRow);
      return rows;
    }
    // 舊版問答（kind=quiz）在 LOCKED 狀態的相容路徑：保留公布答案/取消按鈕
    const ctrlRow = new ActionRowBuilder();
    ctrlRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_reveal_${quizDoc.quizId}`)
        .setLabel("公布答案並發獎金（限主辦人）")
        .setEmoji("🏁")
        .setStyle(ButtonStyle.Success)
    );
    ctrlRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_cancel_${quizDoc.quizId}`)
        .setLabel("取消")
        .setEmoji("🚫")
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(ctrlRow);
    return rows;
  }

  // SETTLED / CANCELLED：不放任何按鈕
  return [];
}

function validateInputs({
  question,
  options,
  correctKey,
  prizePool,
  minutes,
  kind,
  mode,
}) {
  if (!question || question.length > MAX_QUESTION_LEN) {
    throw new Error(`題目長度需為 1 ~ ${MAX_QUESTION_LEN} 字。`);
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    throw new Error("選項數量需為 2 ~ 4 個。");
  }
  for (const o of options) {
    if (!o.text || o.text.length > MAX_OPTION_LEN) {
      throw new Error(`選項 ${o.key} 內容需為 1 ~ ${MAX_OPTION_LEN} 字。`);
    }
  }
  if (kind !== KIND_PREDICTION) {
    if (!options.some((o) => o.key === correctKey)) {
      throw new Error(`正確答案 ${correctKey} 不在提供的選項中。`);
    }
  }
  if (!Number.isInteger(prizePool) || prizePool < 1) {
    throw new Error("獎金池需為 ≥ 1 的整數。");
  }
  if (minutes === null || minutes === undefined) {
    // null/undefined 代表不限時，僅問答（搶答獨佔）允許
    if (kind === KIND_PREDICTION) {
      throw new Error("預測必須指定答題時間。");
    }
    if (mode !== MODE_SOLO) {
      throw new Error("不限時答題只有搶答獨佔模式支援。");
    }
  } else if (
    !Number.isInteger(minutes) ||
    minutes < MIN_MINUTES ||
    minutes > MAX_MINUTES
  ) {
    throw new Error(`時間需為 ${MIN_MINUTES} ~ ${MAX_MINUTES} 分鐘。`);
  }
  if (mode && mode !== MODE_SPLIT && mode !== MODE_SOLO) {
    throw new Error("模式只能是「平分獎金」或「搶答獨佔」。");
  }
  if (kind === KIND_PREDICTION && mode === MODE_SOLO) {
    throw new Error("預測不支援搶答獨佔模式。");
  }
}

async function createQuiz(client, opts) {
  const {
    guild,
    host,
    member,
    question,
    options,
    correctKey,
    prizePool,
    minutes,
    kind: rawKind,
    mode: rawMode,
  } = opts;

  const kind = rawKind === KIND_PREDICTION ? KIND_PREDICTION : KIND_QUIZ;
  const mode =
    kind === KIND_PREDICTION
      ? MODE_SPLIT
      : rawMode === MODE_SOLO
      ? MODE_SOLO
      : MODE_SPLIT;

  if (!client.quizGamesCollection) {
    throw new Error(`${kind === KIND_PREDICTION ? "預測" : "問答"}系統尚未啟動（資料庫未連線）`);
  }

  validateInputs({ question, options, correctKey, prizePool, minutes, kind, mode });

  const before = await client.userCoinsCollection.findOne({
    userId: host.id,
    guildId: guild.id,
  });
  const balance = before?.totalCoins || 0;
  if (balance < prizePool) {
    throw new Error(
      `餘額不足！需鎖定 ${prizePool.toLocaleString()} credits，目前 ${balance.toLocaleString()}。`
    );
  }

  const channel = await guild.channels.fetch(QUIZ_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased?.()) {
    throw new Error(
      `找不到${kind === KIND_PREDICTION ? "預測" : "問答"}發布頻道（${QUIZ_CHANNEL_ID}），請聯絡舒舒。`
    );
  }

  const quizId = newQuizId(host.id, kind);
  const endsAt =
    minutes === null || minutes === undefined
      ? null
      : new Date(Date.now() + minutes * 60 * 1000);

  const debit = await grantCoins(client, {
    userId: host.id,
    guildId: guild.id,
    username: member?.displayName || host.username,
    avatarHash: host.avatar,
    amount: -prizePool,
    source: "event_host_lock",
    member,
    meta: { quizId, question, kind },
  });
  if (!debit) {
    throw new Error("扣款失敗，未建立。");
  }

  const quizDoc = {
    quizId,
    kind,
    mode,
    guildId: guild.id,
    channelId: channel.id,
    messageId: null,
    hostId: host.id,
    hostName: member?.displayName || host.username,
    question,
    options,
    correctKey: kind === KIND_PREDICTION ? null : correctKey,
    prizePool,
    endsAt,
    status: "ACTIVE",
    answers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const label = kind === KIND_PREDICTION ? "預測" : "問答";
    const intro =
      mode === MODE_SOLO
        ? `📣 新${label}（⚡ 搶答獨佔）！首位答對者獨得 **${prizePool.toLocaleString()}** credits！`
        : `📣 新${label}！答對者平分 **${prizePool.toLocaleString()}** credits 獎金池。`;
    const container = buildActiveContainer(quizDoc, { intro, guild });
    for (const row of buildActionRow(quizDoc)) {
      container.addActionRowComponents(row);
    }
    const msg = await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    quizDoc.messageId = msg.id;
    await client.quizGamesCollection.insertOne(quizDoc);
    return { quizDoc, channel, message: msg };
  } catch (err) {
    await grantCoins(client, {
      userId: host.id,
      guildId: guild.id,
      amount: prizePool,
      source: "event_refund",
      meta: { quizId, reason: "create_rollback", kind },
    }).catch(() => {});
    throw err;
  }
}

function unwrap(res) {
  if (!res) return null;
  return res.value !== undefined ? res.value : res;
}

async function refreshQuizMessage(client, quizDoc) {
  const channel = await client.channels.fetch(quizDoc.channelId).catch(() => null);
  if (!channel) return null;
  const msg = await channel.messages.fetch(quizDoc.messageId).catch(() => null);
  if (!msg) return null;

  const guild = quizDoc.guildId
    ? client.guilds.cache.get(quizDoc.guildId)
    : channel.guild || null;

  let container;
  if (quizDoc.status === "ACTIVE") {
    container = buildActiveContainer(quizDoc, { guild });
  } else if (quizDoc.status === "LOCKED") {
    container = buildLockedContainer(quizDoc, guild);
  } else if (quizDoc.status === "SETTLED") {
    container = buildSettledContainer(quizDoc, guild);
  } else {
    container = buildCancelledContainer(quizDoc, guild);
  }
  for (const row of buildActionRow(quizDoc)) {
    container.addActionRowComponents(row);
  }

  await msg
    .edit({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return msg;
}

async function setAnswer(client, quizDoc, userId, key, displayName) {
  if (quizDoc.status !== "ACTIVE") {
    return { action: "closed", doc: quizDoc };
  }
  if (!quizDoc.options.some((o) => o.key === key)) {
    return { action: "invalid", doc: quizDoc };
  }
  const ans = { key, name: displayName || null, ts: new Date() };
  const updated = await client.quizGamesCollection.findOneAndUpdate(
    { _id: quizDoc._id, status: "ACTIVE" },
    { $set: { [`answers.${userId}`]: ans, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) return { action: "closed", doc: quizDoc };

  // 搶答獨佔模式：答對的第一人原子地拿下整個獎金池並立刻結算
  if (isSolo(doc) && doc.correctKey && key === doc.correctKey) {
    const settled = await trySettleSoloWinner(client, doc, userId);
    if (settled) {
      return { action: "solo_won", doc: settled };
    }
    const fresh = await client.quizGamesCollection.findOne({ _id: doc._id });
    return { action: "too_late", doc: fresh || doc };
  }

  return { action: "ok", doc };
}

async function trySettleSoloWinner(client, quizDoc, winnerUserId) {
  const settledAt = new Date();
  const winners = [{ userId: winnerUserId, prize: quizDoc.prizePool }];
  const setFields = {
    status: "SETTLED",
    settledAt,
    lockedAt: settledAt,
    lockReason: "solo_win",
    updatedAt: settledAt,
    winners,
    perWinnerPrize: quizDoc.prizePool,
    totalPaid: quizDoc.prizePool,
    settleReason: "solo_win",
    soloWinnerId: winnerUserId,
  };

  const updated = await client.quizGamesCollection.findOneAndUpdate(
    { _id: quizDoc._id, status: "ACTIVE" },
    { $set: setFields },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) return null;

  await grantCoins(client, {
    userId: winnerUserId,
    guildId: doc.guildId,
    amount: doc.prizePool,
    source: "event_prize",
    meta: {
      quizId: doc.quizId,
      hostId: doc.hostId,
      kind: getKind(doc),
      mode: MODE_SOLO,
    },
  }).catch((e) => {
    console.log(`[ERROR] solo prize payout failed (${doc.quizId}): ${e}`.red);
  });

  const msg = await refreshQuizMessage(client, doc);
  if (msg) {
    const guild = doc.guildId ? client.guilds.cache.get(doc.guildId) : null;
    await msg
      .reply({
        content:
          `🏆 問答「${doc.question}」搶答結束！正確答案：**${doc.correctKey}**\n` +
          `${plainifyUserMentions(guild, `<@${winnerUserId}>`)} 搶答成功，獨得 **${doc.prizePool.toLocaleString()}** credits！`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  return doc;
}

async function lockQuiz(client, quizDoc, reason = "manual") {
  if (quizDoc.status !== "ACTIVE") {
    throw new Error("已不在作答中。");
  }
  const updated = await client.quizGamesCollection.findOneAndUpdate(
    { _id: quizDoc._id, status: "ACTIVE" },
    {
      $set: {
        status: "LOCKED",
        lockedAt: new Date(),
        lockReason: reason,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) {
    throw new Error("狀態已改變，無法截止作答。");
  }

  const msg = await refreshQuizMessage(client, doc);
  if (msg) {
    const guild = doc.guildId ? client.guilds.cache.get(doc.guildId) : null;
    const head = reason === "expired" ? "⏰" : "🔒";
    const tip =
      reason === "expired"
        ? "答題時間到，作答已截止。"
        : "主辦人提早截止作答。";
    await msg
      .reply({
        content: `${head} 預測「${doc.question}」${tip}\n等待主辦人 ${plainifyUserMentions(guild, `<@${doc.hostId}>`)} 公布正確答案。`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  return doc;
}

async function settleQuiz(client, quizDoc, reason = "manual") {
  // quiz 類型可從 ACTIVE 直接結算；prediction 必須先 LOCKED 並具備 correctKey
  if (quizDoc.status === "CANCELLED" || quizDoc.status === "SETTLED") {
    throw new Error("已不在可結算的狀態。");
  }
  if (!quizDoc.correctKey) {
    throw new Error("尚未設定正確答案，無法結算。");
  }

  const fromStatus = quizDoc.status; // "ACTIVE" or "LOCKED"
  const settledAt = new Date();

  const answers = quizDoc.answers || {};
  const correctEntries = Object.entries(answers).filter(
    ([, a]) => a.key === quizDoc.correctKey
  );
  const solo = isSolo(quizDoc);

  let winnerIds;
  if (solo) {
    // 搶答獨佔：只取最早答對的那一位
    const earliest = correctEntries
      .map(([uid, a]) => ({ uid, ts: new Date(a.ts).getTime() }))
      .sort((x, y) => x.ts - y.ts)[0];
    winnerIds = earliest ? [earliest.uid] : [];
  } else {
    winnerIds = correctEntries.map(([uid]) => uid);
  }

  const winnerCount = winnerIds.length;
  const perWinnerPrize =
    winnerCount > 0
      ? solo
        ? quizDoc.prizePool
        : Math.floor(quizDoc.prizePool / winnerCount)
      : 0;
  const totalPaid = perWinnerPrize * winnerCount;
  const unpaid = quizDoc.prizePool - totalPaid;
  const { fee: refundFee, net: refundNet, rate: refundFeeRate } = computeRefundFee(unpaid);
  const winners = winnerIds.map((uid) => ({ userId: uid, prize: perWinnerPrize }));

  const setFields = {
    status: "SETTLED",
    settledAt,
    updatedAt: settledAt,
    winners,
    perWinnerPrize,
    totalPaid,
    settleReason: reason,
    refundFee,
    refundNet,
    refundFeeRate,
  };
  if (fromStatus === "ACTIVE") {
    setFields.lockedAt = settledAt;
    setFields.lockReason = reason;
  }

  const updated = await client.quizGamesCollection.findOneAndUpdate(
    { _id: quizDoc._id, status: fromStatus },
    { $set: setFields },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) {
    throw new Error("狀態已改變，無法結算。");
  }

  for (const w of winners) {
    await grantCoins(client, {
      userId: w.userId,
      guildId: quizDoc.guildId,
      amount: w.prize,
      source: "event_prize",
      meta: { quizId: quizDoc.quizId, hostId: quizDoc.hostId, kind: getKind(doc) },
    }).catch((e) => {
      console.log(
        `[ERROR] ${getKind(doc)} prize payout failed (${quizDoc.quizId} user ${w.userId}): ${e}`.red
      );
    });
  }

  if (refundNet > 0) {
    await grantCoins(client, {
      userId: quizDoc.hostId,
      guildId: quizDoc.guildId,
      amount: refundNet,
      source: "event_refund",
      meta: {
        quizId: quizDoc.quizId,
        reason: winnerCount === 0 ? "no_winner" : "leftover",
        kind: getKind(doc),
        gross: unpaid,
        fee: refundFee,
        feeRate: refundFeeRate,
      },
    }).catch((e) => {
      console.log(`[ERROR] ${getKind(doc)} refund failed: ${e}`.red);
    });
  }

  const msg = await refreshQuizMessage(client, doc);

  if (msg) {
    const guild = doc.guildId ? client.guilds.cache.get(doc.guildId) : null;
    const hostLabel = plainifyUserMentions(guild, `<@${doc.hostId}>`);
    const label = kindLabel(doc);
    let summary;
    if (winnerCount === 0) {
      const feeNote =
        refundFee > 0
          ? `系統抽成 ${refundFee.toLocaleString()} credits，退還主辦人 ${hostLabel} ${refundNet.toLocaleString()} credits。`
          : `獎金 ${refundNet.toLocaleString()} credits 已退還主辦人 ${hostLabel}。`;
      summary =
        `🏁 ${label}「${doc.question}」結束\n` +
        `正確答案：**${doc.correctKey}**\n` +
        `沒有人答對，${feeNote}`;
      await msg
        .reply({ content: summary, allowedMentions: { parse: [] } })
        .catch(() => {});
    } else if (isSolo(doc)) {
      const names = winnerIds
        .map((id) => plainifyUserMentions(guild, `<@${id}>`))
        .join("、");
      summary =
        `🏆 ${label}「${doc.question}」搶答結束！正確答案：**${doc.correctKey}**\n` +
        `${names} 搶答成功，獨得 **${perWinnerPrize.toLocaleString()}** credits！`;
      await msg
        .reply({
          content: summary,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    } else {
      const names = winnerIds
        .map((id) => plainifyUserMentions(guild, `<@${id}>`))
        .join("、");
      let leftoverNote = "";
      if (unpaid > 0) {
        leftoverNote =
          refundFee > 0
            ? `\n（餘數 ${unpaid.toLocaleString()}，系統抽成 ${refundFee.toLocaleString()}，退回主辦人 ${refundNet.toLocaleString()}）`
            : `\n（餘數 ${refundNet.toLocaleString()} 已退回主辦人）`;
      }
      summary =
        `🎉 ${label}「${doc.question}」結束！正確答案：**${doc.correctKey}**\n` +
        `${winnerCount} 人答對，每人獲得 **${perWinnerPrize.toLocaleString()}** credits\n${names}` +
        leftoverNote;
      await msg
        .reply({
          content: summary,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
  }

  return doc;
}

async function setCorrectAnswerAndSettle(client, quizDoc, correctKey, reason = "manual") {
  if (!isPrediction(quizDoc)) {
    throw new Error("這不是預測，請直接公布答案。");
  }
  if (quizDoc.status !== "LOCKED") {
    throw new Error("預測尚未截止作答，無法公布答案。");
  }
  if (!quizDoc.options.some((o) => o.key === correctKey)) {
    throw new Error(`選項 ${correctKey} 不存在。`);
  }

  const updated = await client.quizGamesCollection.findOneAndUpdate(
    { _id: quizDoc._id, status: "LOCKED" },
    { $set: { correctKey, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const doc = unwrap(updated);
  if (!doc) {
    throw new Error("狀態已改變，無法公布答案。");
  }

  return settleQuiz(client, doc, reason);
}

async function cancelQuiz(client, quizDoc, actor) {
  const { fee, net, rate } = computeRefundFee(quizDoc.prizePool);

  const updated = await client.quizGamesCollection.findOneAndUpdate(
    { _id: quizDoc._id, status: { $in: ["ACTIVE", "LOCKED"] } },
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
    throw new Error("已結束，無法取消。");
  }

  if (net > 0) {
    await grantCoins(client, {
      userId: quizDoc.hostId,
      guildId: quizDoc.guildId,
      amount: net,
      source: "event_refund",
      meta: {
        quizId: quizDoc.quizId,
        reason: "host_cancelled",
        kind: getKind(doc),
        gross: quizDoc.prizePool,
        fee,
        feeRate: rate,
      },
    }).catch((e) => {
      console.log(`[ERROR] ${getKind(doc)} cancel refund failed: ${e}`.red);
    });
  }

  const msg = await refreshQuizMessage(client, doc);
  if (msg) {
    const label = kindLabel(doc);
    const feeNote =
      fee > 0
        ? `（系統抽成 ${fee.toLocaleString()} credits，實際退還 ${net.toLocaleString()}）`
        : "";
    await msg
      .reply({
        content: `🚫 ${label}「${doc.question}」已由主辦人取消，獎金已退還。${feeNote}`,
      })
      .catch(() => {});
  }
  return doc;
}

module.exports = {
  QUIZ_CHANNEL_ID,
  MIN_MINUTES,
  MAX_MINUTES,
  MAX_QUESTION_LEN,
  MAX_OPTION_LEN,
  OPTION_KEYS,
  OPTION_EMOJIS,
  KIND_QUIZ,
  KIND_PREDICTION,
  MODE_SPLIT,
  MODE_SOLO,
  isPrediction,
  isSolo,
  getKind,
  getMode,
  modeLabel,
  createQuiz,
  setAnswer,
  lockQuiz,
  settleQuiz,
  setCorrectAnswerAndSettle,
  cancelQuiz,
  refreshQuizMessage,
  buildActiveContainer,
  buildLockedContainer,
  buildSettledContainer,
  buildCancelledContainer,
  buildActionRow,
};
