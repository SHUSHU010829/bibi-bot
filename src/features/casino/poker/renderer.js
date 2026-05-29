// 把 poker game state 渲染成 Discord message payload。
// 公牌與動作按鈕為公開；hole cards 走 ephemeral（在按「查看手牌」時 reply）。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { legalActions, totalPot } = require("./engine");
const { categoryLabel, evaluate7 } = require("./hand");
const generatePokerCard = require("../../../utils/generatePokerCard");
const { buildCasinoEmbed } = require("../casinoEmbed");

const SUIT_EMOJI = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function formatCard(card) {
  if (!card) return "[ ?? ]";
  return `[${RANK_LABEL[card[0]]}${SUIT_EMOJI[card[1]]}]`;
}

function formatCardLine(cards, expected = 0) {
  const out = cards.map(formatCard);
  for (let i = out.length; i < expected; i += 1) out.push("[  ]");
  return out.join(" ");
}

function phaseLabel(phase) {
  if (!phase) return "等候開始";
  return (
    {
      preflop: "Pre-Flop",
      flop: "Flop（翻牌）",
      turn: "Turn（轉牌）",
      river: "River（河牌）",
      showdown: "Showdown（攤牌）",
    }[phase] || phase
  );
}

function playerStatusBadge(state, p, idx) {
  const tags = [];
  if (state.buttonIdx === idx) tags.push("🟢 D");
  if (state.sbIdx === idx) tags.push("SB");
  if (state.bbIdx === idx) tags.push("BB");
  if (state.toActIdx === idx && state.status === "playing") tags.push("⏳ 行動中");
  if (p.allIn) tags.push("🔥 All-In");
  if (p.folded) tags.push("🚫 棄");
  if (p.busted) tags.push("💀 出局");
  return tags.join(" · ");
}

function buildTableLines(state) {
  const lines = [];
  const pot = totalPot(state);
  lines.push(
    `🃏 **德州撲克** ・ 第 ${state.handNumber || 0} 局 ・ ${phaseLabel(state.phase)}`
  );
  lines.push(
    `盲注：**${state.smallBlind.toLocaleString()}/${state.bigBlind.toLocaleString()}** ・ 進桌：**${state.buyIn.toLocaleString()}** ・ 桌上 ${state.players.filter((p) => !p.busted).length}/${state.maxPlayers} 人`
  );
  lines.push("─────────────────────");

  // 公牌
  if (state.status === "playing" || state.status === "settled") {
    lines.push(`公牌：${formatCardLine(state.community || [], 5)}`);
    lines.push(
      `底池：**${pot.toLocaleString()}** credits ・ 本輪需跟：**${(state.currentBet || 0).toLocaleString()}**`
    );
    if (state.status === "playing" && state.actionDeadline) {
      const ts = Math.floor(new Date(state.actionDeadline).getTime() / 1000);
      const actor = state.players[state.toActIdx];
      if (actor) {
        lines.push(
          `⏳ **輪到 <@${actor.userId}> 行動** ・ <t:${ts}:R> 倒數 ・ 逾時自動處理`
        );
      }
    }
  } else {
    lines.push("公牌：[尚未發牌]");
  }
  lines.push("─────────────────────");

  // 玩家列
  state.players.forEach((p, idx) => {
    const badge = playerStatusBadge(state, p, idx);
    const betPart = p.bet > 0 ? ` ・ 本輪 ${p.bet.toLocaleString()}` : "";
    lines.push(
      `**#${idx + 1}** @${p.username} ・ 籌碼 **${p.chips.toLocaleString()}**${betPart}${badge ? ` ・ ${badge}` : ""}`
    );
  });

  // 攤牌結果
  if (state.status === "settled" && state.settle) {
    lines.push("─────────────────────");
    if (state.settle.showdown && state.settle.scores) {
      for (const s of state.settle.scores) {
        const player = state.players.find((p) => p.userId === s.userId);
        if (!player) continue;
        const hand = formatCardLine(s.holeCards || [], 2);
        const cat = s.score ? categoryLabel(s.score) : "";
        lines.push(`@${player.username} ・ ${hand} ・ ${cat}`);
      }
    }
    for (const pot of state.settle.winners || []) {
      const splitText = pot.splits
        .map((s) => {
          const pl = state.players.find((p) => p.userId === s.userId);
          return `@${pl?.username || s.userId.slice(-4)} ＋${s.amount.toLocaleString()}`;
        })
        .join(" ・ ");
      lines.push(`🏆 底池 ${pot.amount.toLocaleString()} → ${splitText}`);
    }
  }

  // 等候提示
  if (state.status === "waiting") {
    lines.push("─────────────────────");
    lines.push(
      `等候開桌中 ・ 需 ${state.minPlayers}-${state.maxPlayers} 人 ・ 開桌者按 **開始** 開局`
    );
    lines.push("-# 點下方「🪑 加入」入座，開桌者按「🃏 開始」開局");
  }

  return lines.join("\n");
}

// 計算 quick-raise 預設金額（½池 / 池 / 2×池）。
// 回傳 [{ label, raiseTo }, ...]，已 clamp 到 [minRaiseTo, maxRaiseTo]。
// 若全部都被 clamp 到同一個值（=可加注空間太小），回傳空陣列代表不顯示快加注。
function computeQuickRaises(state, actor) {
  if (!actor) return [];
  const pot = totalPot(state);
  const toCall = Math.max(0, (state.currentBet || 0) - (actor.bet || 0));
  const potIfCalled = pot + toCall;
  const minRaiseTo = Math.max(
    (state.currentBet || 0) + (state.minRaise || state.bigBlind),
    state.bigBlind
  );
  const maxRaiseTo = (actor.bet || 0) + (actor.chips || 0);
  if (maxRaiseTo <= minRaiseTo) return [];

  const presets = [
    { label: "½池", multiplier: 0.5 },
    { label: "池", multiplier: 1 },
    { label: "2×池", multiplier: 2 },
  ];

  return presets
    .map((p) => {
      let raiseTo = (state.currentBet || 0) + Math.round(potIfCalled * p.multiplier);
      // 至少 min raise；超過全推就 = all-in
      if (raiseTo < minRaiseTo) raiseTo = minRaiseTo;
      if (raiseTo > maxRaiseTo) raiseTo = maxRaiseTo;
      return { label: p.label, raiseTo };
    })
    // 同樣金額會出現幾顆按鈕，去重
    .filter((p, i, arr) => arr.findIndex((x) => x.raiseTo === p.raiseTo) === i);
}

function buildActionButtons(state, viewerId) {
  const rows = [];
  const gameId = state.gameId;

  if (state.status === "waiting") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pk_join_${gameId}`)
        .setLabel("加入")
        .setEmoji("🪑")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`pk_leave_${gameId}`)
        .setLabel("離桌")
        .setEmoji("👋")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pk_start_${gameId}`)
        .setLabel("開始")
        .setEmoji("🃏")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`pk_resend_${gameId}`)
        .setLabel("重貼桌面")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pk_help_${gameId}`)
        .setLabel("玩法說明")
        .setEmoji("❓")
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(row);
    return rows;
  }

  if (state.status === "playing") {
    const toAct = state.players[state.toActIdx];
    const isMyTurn = !!(viewerId && toAct && toAct.userId === viewerId);
    // 動作按鈕：所有玩家都看到，但只有當前 toAct 能按（handler 內二次驗證）
    const actor = toAct;
    const acts = actor ? legalActions(state, state.toActIdx) : [];
    const toCall = actor ? Math.max(0, state.currentBet - actor.bet) : 0;
    const callLabel = toCall === 0 ? "✓ 過牌" : `跟 ${toCall.toLocaleString()}`;

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pk_fold_${gameId}`)
        .setLabel("棄牌")
        .setEmoji("🚫")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!acts.includes("fold")),
      new ButtonBuilder()
        .setCustomId(`pk_callcheck_${gameId}`)
        .setLabel(callLabel)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!acts.includes("check") && !acts.includes("call")),
      new ButtonBuilder()
        .setCustomId(`pk_raise_${gameId}`)
        .setLabel("加注")
        .setEmoji("💰")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!acts.includes("raise")),
      new ButtonBuilder()
        .setCustomId(`pk_allin_${gameId}`)
        .setLabel("All-In")
        .setEmoji("🔥")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!acts.includes("allin")),
      new ButtonBuilder()
        .setCustomId(`pk_hand_${gameId}`)
        .setLabel("查看手牌")
        .setEmoji("🂠")
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(row1);

    // 第 2 列：½池 / 池 / 2×池 快速加注（計算後才放入）
    const quicks = computeQuickRaises(state, actor);
    if (quicks.length && acts.includes("raise")) {
      const quickRow = new ActionRowBuilder();
      for (const q of quicks) {
        quickRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`pk_raiseto_${q.raiseTo}_${gameId}`)
            .setLabel(`${q.label} (${q.raiseTo.toLocaleString()})`)
            .setEmoji("💰")
            .setStyle(ButtonStyle.Success)
        );
      }
      rows.push(quickRow);
    }

    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pk_leave_${gameId}`)
        .setLabel("離桌")
        .setEmoji("👋")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pk_resend_${gameId}`)
        .setLabel("重貼桌面")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pk_help_${gameId}`)
        .setLabel("玩法說明")
        .setEmoji("❓")
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(row3);

    // 抑制未使用警告
    void isMyTurn;
    return rows;
  }

  if (state.status === "settled") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pk_next_${gameId}`)
        .setLabel("下一局")
        .setEmoji("🔁")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`pk_close_${gameId}`)
        .setLabel("解散牌桌")
        .setEmoji("🛑")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`pk_hand_${gameId}`)
        .setLabel("查看手牌")
        .setEmoji("🂠")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pk_resend_${gameId}`)
        .setLabel("重貼桌面")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pk_help_${gameId}`)
        .setLabel("玩法說明")
        .setEmoji("❓")
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(row);
  }

  return rows;
}

// 撲克是多人共桌，沒有單一「玩家輸贏」可對應到 embed 欄位。
// 因此 embed 以「開桌者（host）」作為身分標示（author 頭像＋名稱、內文 mention/ID），
// 牌桌全貌（公牌 / 籌碼 / 行動倒數 / 攤牌贏家）一律放進內文行；底色維持 neutral。
function pokerOutcome(state) {
  // 結算時若桌上出現贏家，用 jackpot 金色點綴一下；其餘狀態 neutral。
  if (state.status === "settled" && state.settle?.winners?.length) {
    return "jackpot";
  }
  return "neutral";
}

function hostIdentity(state, avatarURL) {
  const host = state.players?.find((p) => p.userId === state.creatorId);
  return {
    id: state.creatorId || host?.userId,
    displayName: host?.username || "開桌者",
    avatarURL,
  };
}

async function renderTableMessage(state, { viewerId, avatarURL } = {}) {
  const components =
    state.status === "abandoned" ? [] : buildActionButtons(state, viewerId);
  // mention 玩家但不觸發通知（沿用舊行為）
  const allowedMentions = { parse: [] };

  const fullText = buildTableLines(state);
  let files = [];
  let imageName;
  let lines = fullText.split("\n");
  try {
    const buf = await generatePokerCard(state);
    imageName = `poker-${state.gameId}-h${state.handNumber || 0}-${state.phase || "wait"}.png`;
    files = [new AttachmentBuilder(buf, { name: imageName })];
    // 有圖卡時：圖卡已涵蓋公牌 / 籌碼 / 玩家，內文只留最重要的：行動倒數 + 標題 + 攤牌結果
    const headline = lines[0]; // 🃏 德州撲克 ・ 第 N 局 ・ Phase
    const action = lines.find((l) => l.startsWith("⏳"));
    const settleLines = lines.filter((l) => l.startsWith("🏆"));
    const blocks = [];
    if (action) blocks.push(action);
    blocks.push(headline);
    blocks.push(...settleLines);
    lines = blocks.filter(Boolean);
  } catch (e) {
    console.log(`[WARN] poker card render failed, falling back to text: ${e.message}`);
    // 沒圖時：保留完整桌面文字行
  }

  const embed = buildCasinoEmbed({
    game: "🃏 德州撲克",
    user: hostIdentity(state, avatarURL),
    outcome: pokerOutcome(state),
    lines,
    imageName,
    footer:
      state.status === "waiting"
        ? `等候開桌 ・ 盲注 ${state.smallBlind}/${state.bigBlind} ・ 進桌 ${state.buyIn.toLocaleString()}`
        : `第 ${state.handNumber || 0} 局 ・ ${phaseLabel(state.phase)}`,
  });

  return {
    content: "",
    embeds: [embed],
    components,
    files,
    allowedMentions,
  };
}

// 起手評估（pre-flop 沒公牌時提供簡易提示）。
function preflopHint(holeCards) {
  if (!holeCards || holeCards.length < 2) return null;
  const [a, b] = holeCards;
  const r1 = a[0];
  const r2 = b[0];
  const s1 = a[1];
  const s2 = b[1];
  const tags = [];
  if (r1 === r2) tags.push(`對 **${r1 === "T" ? "10" : r1}**`);
  if (s1 === s2 && r1 !== r2) tags.push("同花潛力");
  // 連張（只看 rank 距離 1 或 12=A2）
  const order = "23456789TJQKA";
  const i1 = order.indexOf(r1);
  const i2 = order.indexOf(r2);
  if (i1 >= 0 && i2 >= 0 && r1 !== r2) {
    const gap = Math.abs(i1 - i2);
    if (gap === 1 || gap === 12) tags.push("順子潛力");
  }
  // 高張
  if ((r1 === "A" || r2 === "A") && r1 !== r2) tags.push("含 A");
  if (tags.length === 0) return "起手較弱";
  return tags.join(" ・ ");
}

function renderEphemeralHand(state, userId) {
  const p = state.players.find((pp) => pp.userId === userId);
  if (!p) {
    return { content: "🂠 你不在這張桌上。", flags: MessageFlags.Ephemeral };
  }
  if (!p.holeCards || p.holeCards.length === 0) {
    return { content: "🂠 還沒發牌喔。", flags: MessageFlags.Ephemeral };
  }
  const hand = formatCardLine(p.holeCards, 2);
  const community = formatCardLine(state.community || [], 5);
  const lines = [
    `🂠 **你的手牌（第 ${state.handNumber} 局）**`,
    `底牌：${hand}`,
    `公牌：${community}`,
  ];

  // 牌力提示
  const community5 = state.community || [];
  if (community5.length >= 3) {
    try {
      const score = evaluate7([...p.holeCards, ...community5]);
      const cat = categoryLabel(score);
      lines.push(`🎯 目前最強：**${cat}**（用底牌 + ${community5.length} 張公牌組成）`);
    } catch (_) {
      /* noop */
    }
  } else {
    const hint = preflopHint(p.holeCards);
    if (hint) lines.push(`🎯 起手判斷：${hint}`);
  }

  lines.push(
    `籌碼：**${p.chips.toLocaleString()}** ・ 本輪 ${p.bet.toLocaleString()} ・ 本局已投 ${p.totalBet.toLocaleString()}`
  );
  if (p.folded) lines.push("（你已棄牌）");
  if (p.allIn) lines.push("（你已 All-In）");
  return { content: lines.join("\n"), flags: MessageFlags.Ephemeral };
}

function renderHelp() {
  const lines = [
    "**❓ 德州撲克新手懶人包**",
    "",
    "**🎯 目標**：用 2 張底牌 + 5 張公牌中任選湊出最強 5 張牌。",
    "",
    "**🃏 流程**：",
    "1. 每人發 2 張**底牌**（只有自己看得到）",
    "2. **Pre-Flop**：依順序行動",
    "3. **Flop** 翻 3 張公牌 → 第二輪行動",
    "4. **Turn** 翻 1 張 → 第三輪行動",
    "5. **River** 翻 1 張 → 最後一輪",
    "6. **攤牌**：剩下沒棄的玩家比牌，最大者拿底池",
    "",
    "**🎮 行動按鈕**：",
    "• 🚫 **棄牌**：不玩這局，已下的注都拿不回",
    "• ✓ **過牌**：本輪沒人下注時，免費傳給下家",
    "• 🪙 **跟 N**：補到當前注額繼續玩",
    "• 💰 **加注**：把本輪總注拉高（modal 自填或快加注按鈕）",
    "• 💰 **½池 / 池 / 2×池**：常見加注幅度，一鍵下",
    "• 🔥 **All-In**：推光所有籌碼（拼一把）",
    "• 🂠 **查看手牌**：私訊看自己底牌 + 牌力提示",
    "• 🔄 **重貼桌面**：訊息被淹沒時把桌面拉到最下",
    "",
    "**💡 牌型大小（小→大）**：",
    "高牌 < 一對 < 兩對 < 三條 < 順子 < 同花 < 葫蘆 < 四條 < 同花順",
    "",
    "**🪙 進桌 / 籌碼**：",
    "• 進桌費 = 大盲 × 50（例：盲 50 → 進 2500 credits）",
    "• 籌碼輸光自動出局；中途離桌會在本局結算後退回剩餘",
    "",
    "**⏰ 倒數**：每回合 60 秒，逾時自動處理（沒人下注 → 過牌；有人下注 → 棄牌）",
  ];
  return { content: lines.join("\n"), flags: MessageFlags.Ephemeral };
}

module.exports = {
  renderTableMessage,
  renderEphemeralHand,
  renderHelp,
  formatCard,
  formatCardLine,
};
