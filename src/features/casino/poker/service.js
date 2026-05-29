// 德州撲克 service：橋接 engine、Mongo、Discord，提供高階操作給 commands / handlers 共用。
//
// 命名約定：state 指 mongo doc（含 gameId / channelId / threadId / messageId），
// engine 純函數產出的純 state 不含 Discord 相關欄位。

require("colors");
const crypto = require("crypto");
const { ChannelType } = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const { coinSystem, casino } = require("../../../config");
const grantCoins = require("../../economy/grantCoins");
const engine = require("./engine");
const { renderTableMessage } = require("./renderer");

function getCfg() {
  return casino?.poker || {};
}

function blindsFromBig(bb) {
  return { smallBlind: Math.max(1, Math.floor(bb / 2)), bigBlind: bb };
}

function buyInFor(bb) {
  const cfg = getCfg();
  const mult = cfg.buyInMultiplier || 50;
  return bb * mult;
}

async function findActiveGameInChannel(client, channelId) {
  return client.pokerGamesCollection.findOne({
    channelId,
    status: { $in: ["waiting", "playing", "settled"] },
  });
}

async function findUserActiveGame(client, userId) {
  return client.pokerGamesCollection.findOne({
    "players.userId": userId,
    status: { $in: ["waiting", "playing", "settled"] },
  });
}

function makeFreshPlayer({ userId, username, chips }) {
  return {
    userId,
    username,
    chips,
    bet: 0,
    totalBet: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    busted: false,
    leaving: false,
    holeCards: [],
  };
}

function ttlExpiresAt() {
  const sec = getCfg().gameTtlSeconds || 900;
  return new Date(Date.now() + sec * 1000);
}

function actionDeadlineNow() {
  const sec = getCfg().actionTimeoutSeconds || 60;
  return new Date(Date.now() + sec * 1000);
}

async function refreshTableMessage(client, doc, { viewerId, avatarURL } = {}) {
  try {
    const channel = await client.channels.fetch(doc.threadId).catch(() => null);
    if (!channel) {
      console.log(`[POKER] refresh: thread ${doc.threadId} not found`.yellow);
      return;
    }
    const msg = await channel.messages.fetch(doc.messageId).catch(() => null);
    if (!msg) {
      console.log(
        `[POKER] refresh: message ${doc.messageId} not in ${doc.threadId}`.yellow
      );
      return;
    }
    const payload = await renderTableMessage(doc, { viewerId, avatarURL });
    await msg.edit({ ...payload, attachments: [] }).catch((e) => {
      console.log(`[POKER] refresh edit failed: ${e.message}`.red);
    });
  } catch (e) {
    console.log(`[POKER] refreshTableMessage error: ${e.message}`.red);
  }
}

// 在 thread 內公告（會 ping 指定使用者，讓他們收到通知）
async function postThreadAnnouncement(client, doc, content, mentionUserIds = []) {
  try {
    const thread = await client.channels.fetch(doc.threadId).catch(() => null);
    if (!thread) return;
    await thread.send({
      content,
      allowedMentions: { users: mentionUserIds.filter(Boolean) },
    });
  } catch (e) {
    console.log(`[POKER] announcement failed: ${e.message}`.red);
  }
}

function formatCardEmoji(c) {
  if (!c) return "[ ?? ]";
  const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const RANK = { A: "A", T: "10", J: "J", Q: "Q", K: "K" };
  return `[${RANK[c[0]] || c[0]}${SUIT[c[1]]}]`;
}

async function announceHandStart(client, doc) {
  console.log(
    `[POKER] announceHandStart gameId=${doc.gameId} thread=${doc.threadId} hand=${doc.handNumber}`.cyan
  );
  // 1) 開局橫幅
  await postThreadAnnouncement(
    client,
    doc,
    `═══════════════════\n🃏 **第 ${doc.handNumber} 局開始！** 洗牌發牌中...\n═══════════════════`,
    []
  );
  // 2) 莊位
  const dealer = doc.players[doc.buttonIdx];
  if (dealer) {
    await postThreadAnnouncement(
      client,
      doc,
      `🟢 **莊位（Dealer）**：<@${dealer.userId}>`,
      [dealer.userId]
    );
  }
  // 3) 盲注
  const sb = doc.players[doc.sbIdx];
  const bb = doc.players[doc.bbIdx];
  if (sb && bb) {
    const lines = [
      `🪙 小盲：<@${sb.userId}> 下了 **${doc.smallBlind.toLocaleString()}**`,
      `🪙 大盲：<@${bb.userId}> 下了 **${doc.bigBlind.toLocaleString()}**`,
    ];
    await postThreadAnnouncement(
      client,
      doc,
      lines.join("\n"),
      [sb.userId, bb.userId]
    );
  }
  // 4) 發底牌提示
  await postThreadAnnouncement(
    client,
    doc,
    `🂠 已發 2 張底牌給每位玩家 ・ 點桌面「🂠 查看手牌」按鈕看自己的牌（私訊只給你）`,
    []
  );
  // 5) 第一個行動
  await announceTurnChange(client, doc);
}

async function announceTurnChange(client, doc) {
  if (doc.status !== "playing") return;
  const actor = doc.players[doc.toActIdx];
  if (!actor) return;
  const ts = doc.actionDeadline
    ? Math.floor(new Date(doc.actionDeadline).getTime() / 1000)
    : null;
  const toCall = Math.max(0, (doc.currentBet || 0) - (actor.bet || 0));
  const hint =
    toCall === 0
      ? `沒人下注，可按「✓ 過牌」或「💰 加注」`
      : `需跟 **${toCall.toLocaleString()}**，可按「跟 ${toCall.toLocaleString()}」「💰 加注」「🔥 All-In」或「🚫 棄牌」`;
  await postThreadAnnouncement(
    client,
    doc,
    `⏳ **輪到 <@${actor.userId}> 行動**${ts ? ` ・ <t:${ts}:R> 倒數` : ""}\n-# ${hint}`,
    [actor.userId]
  );
}

async function announcePhaseChange(client, doc) {
  if (doc.status !== "playing") return;
  const map = {
    flop: "翻牌（Flop） 🌟",
    turn: "轉牌（Turn） 🔁",
    river: "河牌（River） 🌊",
  };
  const label = map[doc.phase];
  if (!label) return;
  const cards = (doc.community || []).map(formatCardEmoji).join(" ");
  await postThreadAnnouncement(
    client,
    doc,
    `═══════════════════\n🎴 **${label}**\n公牌：${cards}\n═══════════════════`,
    []
  );
}

async function announceAction(client, doc, beforeDoc, idx, action, opts = {}) {
  const me = doc.players[idx];
  const beforeMe = beforeDoc.players[idx] || { totalBet: 0 };
  const paid = (me.totalBet || 0) - (beforeMe.totalBet || 0);
  let line = null;
  if (action === "fold") line = `👋 **${me.username}** 棄牌（fold）`;
  else if (action === "check") line = `✓ **${me.username}** 過牌（check）`;
  else if (action === "call")
    line = `🪙 **${me.username}** 跟注 **${paid.toLocaleString()}**（本輪總 ${me.bet.toLocaleString()}）`;
  else if (action === "raise")
    line = `💰 **${me.username}** 加注到 **${me.bet.toLocaleString()}**（推 ${paid.toLocaleString()}）`;
  else if (action === "allin")
    line = `🔥🔥🔥 **${me.username}** All-In！推 **${paid.toLocaleString()}** 上桌（剩餘 ${me.chips.toLocaleString()}）`;
  if (line) await postThreadAnnouncement(client, doc, line, []);
}

async function announceSettlement(client, doc) {
  if (!doc.settle) return;
  // 1) 結算橫幅
  await postThreadAnnouncement(
    client,
    doc,
    `═══════════════════\n🎉 **本局結算 (Hand ${doc.handNumber})**\n═══════════════════`,
    []
  );
  // 2) 攤牌（如有）
  if (doc.settle.showdown && doc.settle.scores) {
    const handLines = [];
    for (const s of doc.settle.scores) {
      const player = doc.players.find((p) => p.userId === s.userId);
      if (!player) continue;
      const cards = (s.holeCards || []).map(formatCardEmoji).join(" ");
      const cat = s.score
        ? require("./hand").categoryLabel(s.score)
        : "";
      handLines.push(
        `🂠 <@${player.userId}>：${cards}${cat ? ` ・ **${cat}**` : ""}`
      );
    }
    if (handLines.length) {
      await postThreadAnnouncement(client, doc, handLines.join("\n"), []);
    }
  } else {
    await postThreadAnnouncement(
      client,
      doc,
      `（其他玩家全部棄牌，免攤牌）`,
      []
    );
  }
  // 3) 派彩（每池一行）
  for (const pot of doc.settle.winners || []) {
    const splitText = pot.splits
      .map((s) => `<@${s.userId}> +**${s.amount.toLocaleString()}**`)
      .join(" ・ ");
    await postThreadAnnouncement(
      client,
      doc,
      `🏆 底池 ${pot.amount.toLocaleString()} → ${splitText}`,
      pot.splits.map((s) => s.userId)
    );
  }

  // 4) 各家本局淨輸贏（before → after）
  const stackLines = [];
  for (const p of doc.players) {
    const won = (doc.settle.winners || []).reduce((sum, pot) => {
      const s = pot.splits.find((x) => x.userId === p.userId);
      return sum + (s?.amount || 0);
    }, 0);
    const delta = won - (p.totalBet || 0);
    if (delta === 0 && p.totalBet === 0) continue; // 沒參與
    const before = (p.chips || 0) - delta;
    const sign = delta > 0 ? "+" : "";
    const tag =
      delta > 0 ? "📈" : delta < 0 ? "📉" : "➖";
    stackLines.push(
      `${tag} **${p.username}**：${before.toLocaleString()} → ${p.chips.toLocaleString()}（${sign}${delta.toLocaleString()}）`
    );
  }
  if (stackLines.length) {
    await postThreadAnnouncement(
      client,
      doc,
      `📊 **本局籌碼變動**\n${stackLines.join("\n")}`,
      []
    );
  }

  // 5) 下一局預告（誰會 button、誰會出局/離桌）
  const nextSurvivors = doc.players.filter(
    (p) => !p.busted && !p.leaving && (p.chips || 0) > 0
  );
  const bustedNames = doc.players
    .filter((p) => p.busted || (p.chips || 0) <= 0)
    .map((p) => `<@${p.userId}>`);
  const leavingNames = doc.players
    .filter((p) => p.leaving && !p.busted && (p.chips || 0) > 0)
    .map((p) => `<@${p.userId}>`);
  const previewLines = [];
  if (nextSurvivors.length >= (doc.minPlayers || 2)) {
    // 推算下一局 button：current button 之後的第一個 survivor
    const ids = doc.players.map((p) => p.userId);
    const start = (doc.buttonIdx ?? -1);
    let nextBtnUser = null;
    for (let step = 1; step <= ids.length; step += 1) {
      const i = (start + step) % ids.length;
      const cand = doc.players[i];
      if (cand && nextSurvivors.find((x) => x.userId === cand.userId)) {
        nextBtnUser = cand;
        break;
      }
    }
    if (nextBtnUser) {
      previewLines.push(`🟢 下一局莊位：<@${nextBtnUser.userId}>`);
    }
    previewLines.push(
      `🪑 在場：${nextSurvivors.map((p) => `<@${p.userId}>`).join(" ・ ")}`
    );
  } else {
    previewLines.push(
      `⚠️ 在場玩家不足（需 ${doc.minPlayers || 2} 人），下一局將解散`
    );
  }
  if (bustedNames.length) {
    previewLines.push(`💀 出局：${bustedNames.join(" ・ ")}（籌碼歸零）`);
  }
  if (leavingNames.length) {
    previewLines.push(`👋 將離桌：${leavingNames.join(" ・ ")}（下一局開始時退回）`);
  }
  if (previewLines.length) {
    await postThreadAnnouncement(
      client,
      doc,
      previewLines.join("\n"),
      []
    );
  }

  // 6) 下一步提示
  await postThreadAnnouncement(
    client,
    doc,
    `-# 開桌者按 **🔁 下一局** 繼續，或 **🛑 解散牌桌** 結束（剩餘籌碼會退回錢包）`,
    []
  );
}

// 把舊桌面訊息刪掉、重新發一張新的（給「重貼桌面」按鈕用）
async function resendTableMessage(client, doc, { avatarURL } = {}) {
  const thread = await client.channels.fetch(doc.threadId).catch(() => null);
  if (!thread) return null;
  // 試著刪舊訊息
  if (doc.messageId) {
    const old = await thread.messages.fetch(doc.messageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }
  const payload = await renderTableMessage(doc, { avatarURL });
  const msg = await thread.send(payload).catch((e) => {
    console.log(`[POKER] resend send failed: ${e.message}`.red);
    return null;
  });
  if (!msg) return null;
  await client.pokerGamesCollection.updateOne(
    { _id: doc._id },
    { $set: { messageId: msg.id, updatedAt: new Date() } }
  );
  return msg;
}

async function createTable(client, interaction, { maxPlayers, blind }) {
  if (!coinSystem?.enabled) return { error: "🔧 金幣系統尚未啟動！" };
  if (!client.pokerGamesCollection || !client.userCoinsCollection) {
    return { error: "🔧 撲克系統尚未啟動，請聯絡舒舒！" };
  }
  const cfg = getCfg();
  if (cfg.enabled === false) return { error: "🔧 德州撲克暫時關閉中！" };

  const minBlind = cfg.minBlind ?? 10;
  const minPlayers = cfg.minPlayers ?? 2;
  const maxPlayersCap = cfg.maxPlayers ?? 8;

  if (blind < minBlind) {
    return {
      error: `盲注至少需 ${minBlind.toLocaleString()}。`,
    };
  }
  if (maxPlayers < minPlayers || maxPlayers > maxPlayersCap) {
    return { error: `人數需介於 ${minPlayers} ~ ${maxPlayersCap}。` };
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { error: "🔧 請在一般文字頻道使用此指令（會自動開執行緒）。" };
  }

  // 同人不可多桌
  const userActive = await findUserActiveGame(client, interaction.user.id);
  if (userActive) {
    return { error: "🃏 你已經在另一張撲克桌上了，先把那桌結束再開新桌！" };
  }

  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const username = interaction.member?.displayName || interaction.user.username;
  const buyIn = buyInFor(blind);

  // 餘額檢查
  const userDoc = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = userDoc?.totalCoins || 0;
  if (balance < buyIn) {
    return {
      error: `${MONEY_EMOJI} 餘額不足！進桌需要 **${buyIn.toLocaleString()}** credits（盲 ${blind} × ${cfg.buyInMultiplier || 50} 倍）。目前 ${balance.toLocaleString()}。`,
    };
  }

  // 扣 buy-in
  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash: interaction.user.avatar,
    amount: -buyIn,
    source: "bet",
    member: interaction.member,
    meta: { game: "poker", reason: "buyin" },
  });
  if (!debit) return { error: "🔧 扣款失敗，請稍後再試。" };

  // 建立 thread
  let thread;
  try {
    thread = await channel.threads.create({
      name: `🃏 德州撲克 ${blind} bb · @${username}`.slice(0, 100),
      autoArchiveDuration: 60,
      type: ChannelType.PublicThread,
      reason: "Texas Hold'em table",
    });
  } catch (e) {
    // 退錢
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: buyIn,
      source: "payout",
      member: interaction.member,
      meta: { game: "poker", result: "thread_create_failed" },
    });
    return { error: `🔧 無法建立執行緒：${e.message}` };
  }

  const blinds = blindsFromBig(blind);
  const gameId = crypto.randomUUID();
  const now = new Date();
  const doc = {
    gameId,
    guildId,
    parentChannelId: channel.id,
    channelId: thread.id,
    threadId: thread.id,
    messageId: null,
    creatorId: userId,
    status: "waiting",
    phase: null,
    bigBlind: blinds.bigBlind,
    smallBlind: blinds.smallBlind,
    buyIn,
    minPlayers,
    maxPlayers,
    handNumber: 0,
    buttonIdx: -1,
    sbIdx: -1,
    bbIdx: -1,
    toActIdx: -1,
    currentBet: 0,
    minRaise: blinds.bigBlind,
    lastAggressorIdx: -1,
    pot: 0,
    deck: [],
    community: [],
    players: [makeFreshPlayer({ userId, username, chips: buyIn })],
    settle: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlExpiresAt(),
  };

  const payload = await renderTableMessage(doc, {
    avatarURL: interaction.user.displayAvatarURL(),
  });
  let msg;
  try {
    msg = await thread.send(payload);
  } catch (e) {
    // 救援：退錢、刪 thread
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: buyIn,
      source: "payout",
      member: interaction.member,
      meta: { game: "poker", result: "thread_send_failed" },
    });
    await thread.delete().catch(() => {});
    return { error: `🔧 無法發送桌面訊息：${e.message}` };
  }
  doc.messageId = msg.id;

  await client.pokerGamesCollection.insertOne(doc);
  console.log(
    `[POKER] 開桌 user=${userId} gameId=${gameId} thread=${thread.id} blind=${blind}`.cyan
  );
  return { doc, thread };
}

async function joinTable(client, interaction) {
  if (!client.pokerGamesCollection) return { error: "🔧 撲克系統未啟動。" };
  const channelId = interaction.channelId;
  const game = await findActiveGameInChannel(client, channelId);
  if (!game) return { error: "🃏 這個執行緒沒有等候中的撲克桌。" };
  if (game.status !== "waiting") {
    return { error: "🃏 牌局已經開始，等下一局再加入。" };
  }
  const userId = interaction.user.id;
  if (game.players.find((p) => p.userId === userId)) {
    return { error: "你已經在桌上囉。" };
  }
  if (game.players.length >= game.maxPlayers) {
    return { error: "🃏 牌桌已滿。" };
  }
  // 同人不可多桌（含其他頻道）
  const userActive = await findUserActiveGame(client, userId);
  if (userActive && userActive.gameId !== game.gameId) {
    return { error: "🃏 你已經在另一張撲克桌上了。" };
  }

  const username = interaction.member?.displayName || interaction.user.username;
  const guildId = interaction.guildId;
  const buyIn = game.buyIn;

  const userDoc = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = userDoc?.totalCoins || 0;
  if (balance < buyIn) {
    return {
      error: `${MONEY_EMOJI} 餘額不足！進桌需 **${buyIn.toLocaleString()}** credits，目前 ${balance.toLocaleString()}。`,
    };
  }

  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash: interaction.user.avatar,
    amount: -buyIn,
    source: "bet",
    member: interaction.member,
    meta: { game: "poker", reason: "buyin" },
  });
  if (!debit) return { error: "🔧 扣款失敗，請稍後再試。" };

  const newPlayer = makeFreshPlayer({ userId, username, chips: buyIn });
  await client.pokerGamesCollection.updateOne(
    { _id: game._id },
    {
      $push: { players: newPlayer },
      $set: { updatedAt: new Date(), expiresAt: ttlExpiresAt() },
    }
  );
  const updated = await client.pokerGamesCollection.findOne({ _id: game._id });
  await refreshTableMessage(client, updated);
  return { doc: updated };
}

// 解散 / 玩家全離 → 退回桌上 chips、archive thread
async function closeTable(client, doc, { reason = "closed" } = {}) {
  if (!doc) return;
  const guildId = doc.guildId;
  for (const p of doc.players) {
    // 等候中 / 結算後：p.chips 已是該玩家全部餘籌（結算後派彩進 chips、totalBet 不重置但已派完）
    // 牌局進行中：p.chips 不含已下進池的 totalBet，要把池內金額也退回，否則玩家損失
    let refund = p.chips || 0;
    if (doc.status === "playing") {
      refund += p.totalBet || 0;
    }
    if (refund > 0) {
      await grantCoins(client, {
        userId: p.userId,
        guildId,
        username: p.username,
        amount: refund,
        source: "payout",
        meta: { game: "poker", result: reason, gameId: doc.gameId },
      });
    }
  }
  await client.pokerGamesCollection.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: "closed",
        players: doc.players.map((p) => ({ ...p, chips: 0 })),
        updatedAt: new Date(),
      },
    }
  );
  // archive thread（若 thread 已被刪掉，client.channels.fetch 會 null，silent skip）
  try {
    const thread = await client.channels.fetch(doc.threadId).catch(() => null);
    if (thread && thread.isThread()) {
      await thread.send("🛑 牌桌已解散，籌碼已退回各位錢包。執行緒將封存。").catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
  } catch (_) {
    /* noop */
  }
}

// 把指定 userId 從牌桌移除（等候中），退回他桌上的 chips
async function leaveDuringWaiting(client, doc, userId) {
  const player = doc.players.find((p) => p.userId === userId);
  if (!player) return { error: "你不在這張桌上。" };
  if (player.chips > 0) {
    await grantCoins(client, {
      userId,
      guildId: doc.guildId,
      username: player.username,
      amount: player.chips,
      source: "payout",
      meta: { game: "poker", result: "cashout_waiting", gameId: doc.gameId },
    });
  }
  const remaining = doc.players.filter((p) => p.userId !== userId);
  if (remaining.length === 0) {
    // 全空 → 關桌
    await client.pokerGamesCollection.updateOne(
      { _id: doc._id },
      { $set: { status: "closed", players: [], updatedAt: new Date() } }
    );
    return { closed: true };
  }
  await client.pokerGamesCollection.updateOne(
    { _id: doc._id },
    { $set: { players: remaining, updatedAt: new Date(), expiresAt: ttlExpiresAt() } }
  );
  const updated = await client.pokerGamesCollection.findOne({ _id: doc._id });
  return { doc: updated };
}

async function startNextHand(client, doc) {
  // 從 settled 進下一局：先把 leaving 玩家帶走、busted 玩家帶走
  const guildId = doc.guildId;
  const survivors = [];
  for (const p of doc.players) {
    if (p.leaving || p.busted || p.chips <= 0) {
      if (p.chips > 0) {
        await grantCoins(client, {
          userId: p.userId,
          guildId,
          username: p.username,
          amount: p.chips,
          source: "payout",
          meta: {
            game: "poker",
            result: p.busted ? "bust_cashout" : "leave_cashout",
            gameId: doc.gameId,
          },
        });
      }
      continue;
    }
    survivors.push({ ...p, leaving: false });
  }
  if (survivors.length < doc.minPlayers) {
    // 人不夠 → 關桌、退錢
    for (const p of survivors) {
      if (p.chips > 0) {
        await grantCoins(client, {
          userId: p.userId,
          guildId,
          username: p.username,
          amount: p.chips,
          source: "payout",
          meta: { game: "poker", result: "underpopulated_cashout", gameId: doc.gameId },
        });
      }
    }
    await client.pokerGamesCollection.updateOne(
      { _id: doc._id },
      { $set: { status: "closed", players: [], updatedAt: new Date() } }
    );
    return { closed: true };
  }

  const baseState = {
    ...doc,
    players: survivors,
    buttonIdx: doc.buttonIdx,
  };
  const next = engine.startHand(baseState);
  await persistEngineState(client, doc, next);
  const updated = await client.pokerGamesCollection.findOne({ _id: doc._id });
  return { doc: updated };
}

// engine 跑完之後把所有變動欄位寫回 mongo
async function persistEngineState(client, doc, next) {
  const isActiveTurn =
    next.status === "playing" &&
    typeof next.toActIdx === "number" &&
    next.toActIdx >= 0;
  await client.pokerGamesCollection.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: next.status,
        phase: next.phase,
        deck: next.deck || [],
        community: next.community || [],
        players: next.players,
        buttonIdx: next.buttonIdx,
        sbIdx: next.sbIdx,
        bbIdx: next.bbIdx,
        toActIdx: next.toActIdx,
        currentBet: next.currentBet || 0,
        minRaise: next.minRaise || doc.bigBlind,
        lastAggressorIdx: next.lastAggressorIdx ?? -1,
        pot: next.pot || 0,
        handNumber: next.handNumber || doc.handNumber,
        settle: next.settle || null,
        actionDeadline: isActiveTurn ? actionDeadlineNow() : null,
        // 換人或新發牌 → 重置 warning 旗標
        actionWarningFired: false,
        updatedAt: new Date(),
        expiresAt: ttlExpiresAt(),
      },
    }
  );
}

// 玩家行動
async function applyPlayerAction(client, doc, userId, action, opts = {}) {
  if (doc.status !== "playing") return { error: "牌局現在不需要你行動。" };
  const idx = doc.players.findIndex((p) => p.userId === userId);
  if (idx < 0) return { error: "你不在這張桌上。" };
  if (doc.toActIdx !== idx) return { error: "現在還沒輪到你。" };

  const beforePhase = doc.phase;
  const beforeStatus = doc.status;
  const result = engine.applyAction(doc, idx, action, opts);
  if (result.error) return { error: result.error };
  await persistEngineState(client, doc, result.state);
  const updated = await client.pokerGamesCollection.findOne({ _id: doc._id });

  // 1) 動作公告
  await announceAction(client, updated, doc, idx, action, opts);
  // 2) 街道換 / 結算 / 換人
  if (updated.status === "playing") {
    if (updated.phase !== beforePhase) {
      await announcePhaseChange(client, updated);
    }
    if (updated.toActIdx >= 0) {
      await announceTurnChange(client, updated);
    }
  } else if (updated.status === "settled" && beforeStatus !== "settled") {
    await announceSettlement(client, updated);
  }
  return { doc: updated, settled: updated.status === "settled" };
}

// 行動逾時：把 toActIdx 玩家自動 fold（若可 check 則自動 check，免費就過）
async function autoActOnTimeout(client, doc) {
  if (doc.status !== "playing") return null;
  const idx = doc.toActIdx;
  if (typeof idx !== "number" || idx < 0) return null;
  const player = doc.players[idx];
  if (!player || player.folded || player.busted || player.allIn) return null;
  const toCall = Math.max(0, (doc.currentBet || 0) - (player.bet || 0));
  const action = toCall === 0 ? "check" : "fold";
  const beforePhase = doc.phase;
  const beforeStatus = doc.status;
  const r = engine.applyAction(doc, idx, action);
  if (r.error) return null;
  await persistEngineState(client, doc, r.state);
  const updated = await client.pokerGamesCollection.findOne({ _id: doc._id });
  await refreshTableMessage(client, updated);
  // 公告：逾時 + 動作 + 後續
  await postThreadAnnouncement(
    client,
    updated,
    `⏰ **${player.username}** 行動逾時，自動 ${action === "fold" ? "棄牌" : "過牌"}`,
    []
  );
  if (updated.status === "playing") {
    if (updated.phase !== beforePhase) {
      await announcePhaseChange(client, updated);
    }
    if (updated.toActIdx >= 0) {
      await announceTurnChange(client, updated);
    }
  } else if (updated.status === "settled" && beforeStatus !== "settled") {
    await announceSettlement(client, updated);
  }
  return updated;
}

module.exports = {
  getCfg,
  blindsFromBig,
  buyInFor,
  findActiveGameInChannel,
  findUserActiveGame,
  refreshTableMessage,
  resendTableMessage,
  createTable,
  joinTable,
  closeTable,
  leaveDuringWaiting,
  startNextHand,
  applyPlayerAction,
  persistEngineState,
  autoActOnTimeout,
  actionDeadlineNow,
  announceHandStart,
  announcePhaseChange,
  announceTurnChange,
  announceAction,
  announceSettlement,
  postThreadAnnouncement,
};
