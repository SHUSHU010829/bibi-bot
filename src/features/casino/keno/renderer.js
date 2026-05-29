// 尋寶（簡易版 Keno）訊息與按鈕渲染。
// 開局 + 每次按鈕互動共用。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { DEFAULT_PAYTABLE } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");

const TILES_PER_ROW = 5;

function tileButton(state, tile) {
  const gameId = state.gameId;
  const settled = state.status === "settled";
  const isPick = state.picks.includes(tile);
  const isTreasure = state.treasures.includes(tile);

  const btn = new ButtonBuilder().setCustomId(`k_t_${tile}_${gameId}`);

  if (settled) {
    // 開獎後：揭曉每格
    if (isPick && isTreasure) {
      btn.setEmoji("💎").setLabel(`${tile}`).setStyle(ButtonStyle.Success);
    } else if (!isPick && isTreasure) {
      btn.setEmoji("❤️").setLabel(`${tile}`).setStyle(ButtonStyle.Danger);
    } else if (isPick && !isTreasure) {
      btn.setLabel(`${tile}`).setStyle(ButtonStyle.Primary);
    } else {
      btn.setLabel(`${tile}`).setStyle(ButtonStyle.Secondary);
    }
    btn.setDisabled(true);
  } else {
    // 選號階段
    btn.setLabel(`${tile}`).setStyle(isPick ? ButtonStyle.Primary : ButtonStyle.Secondary);
    btn.setDisabled(state.status !== "selecting");
  }

  return btn;
}

function buildBoardRows(state) {
  const rows = [];
  for (let r = 0; r < state.boardSize / TILES_PER_ROW; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < TILES_PER_ROW; c++) {
      const tile = r * TILES_PER_ROW + c + 1;
      row.addComponents(tileButton(state, tile));
    }
    rows.push(row);
  }
  return rows;
}

function buildControlRow(state) {
  const gameId = state.gameId;
  const settled = state.status !== "selecting";
  const hasPicks = state.picks.length > 0;
  const fullPicks = state.picks.length >= state.pickCount;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`k_q_${gameId}`)
      .setEmoji("🎲")
      .setLabel("機選")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(settled),
    new ButtonBuilder()
      .setCustomId(`k_r_${gameId}`)
      .setEmoji("🔄")
      .setLabel("重選")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(settled || !hasPicks),
    new ButtonBuilder()
      .setCustomId(`k_d_${gameId}`)
      .setEmoji("🎯")
      .setLabel("開獎")
      .setStyle(ButtonStyle.Success)
      .setDisabled(settled || !fullPicks),
    new ButtonBuilder()
      .setCustomId(`k_x_${gameId}`)
      .setEmoji("❌")
      .setLabel("取消退款")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(settled)
  );
  return row;
}

function buildPaytableLine(paytable) {
  // 顯示 2~5 命中（0/1 命中都是 0x，省略）
  const parts = [];
  for (let h = 2; h < paytable.length; h++) {
    parts.push(`${h}中 \`×${paytable[h]}\``);
  }
  return parts.join("　");
}

// 由 state 組出 embed 所需的 outcome / headline / lines / footer。
// outcome：選號中 → neutral（僅下注）；開獎 → 中獎 win、槓龜 lose；取消 → neutral。
// net：payout 已含本金，故淨輸贏 = payout - bet（沒中 payout=0 → -bet）。
function buildHeader(state) {
  const paytable = state.paytable || DEFAULT_PAYTABLE;

  if (state.status === "selecting") {
    return {
      outcome: "neutral",
      headline: "🗺️ **選擇 5 個寶藏格**",
      lines: [
        `已選 **${state.picks.length}/${state.pickCount}** 格`,
        `賠率：${buildPaytableLine(paytable)}`,
        ``,
        `📜 點擊格子手動挑選，或按 **🎲機選** 自動補滿，按 **🎯開獎** 揭曉。`,
      ],
      footer: undefined,
      net: undefined,
      settled: false,
    };
  }
  if (state.status === "cancelled") {
    return {
      outcome: "neutral",
      headline: "❌ **取消尋寶**",
      lines: [`已退款 **${state.bet.toLocaleString()}** credits。`],
      footer: undefined,
      net: undefined,
      settled: true,
    };
  }
  // settled（開獎）
  const won = state.payout > 0;
  const headline = won
    ? `💎 **命中 ${state.hitCount}/${state.pickCount}！** ＋${state.payout.toLocaleString()} credits（×${state.multiplier}）`
    : `💸 **命中 ${state.hitCount}/${state.pickCount}　差一點！**`;
  return {
    outcome: won ? "win" : "lose",
    headline,
    lines: [
      `你的號碼：${state.picks.slice().sort((a, b) => a - b).join("、") || "—"}`,
      `寶藏位置：${state.treasures.slice().sort((a, b) => a - b).join("、")}`,
      ``,
      `賠率表：${buildPaytableLine(paytable)}`,
    ],
    footer: undefined,
    net: (state.payout || 0) - state.bet,
    settled: true,
  };
}

function renderMessage(state, { username, balance, userId, avatarURL } = {}) {
  const lastRow =
    state.status === "settled" && state.userId
      ? buildReplayRow("keno", state.userId, { name: username })
      : buildControlRow(state);
  const rows = [...buildBoardRows(state), lastRow];
  const head = buildHeader(state);

  const embed = buildCasinoEmbed({
    game: "🗺️ 尋寶 ・ KENO",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome: head.outcome,
    headline: head.headline,
    lines: head.lines,
    bet: state.bet,
    // 結算（開獎）才顯示淨輸贏；取消已退款不算輸贏。
    net: head.settled && state.status === "settled" ? head.net : undefined,
    balance: head.settled && typeof balance === "number" ? balance : undefined,
    footer: head.footer,
  });

  return { content: "", embeds: [embed], components: rows };
}

module.exports = { renderMessage };
