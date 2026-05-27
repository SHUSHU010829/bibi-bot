// 尋寶（簡易版 Keno）訊息與按鈕渲染。
// 開局 + 每次按鈕互動共用。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const { DEFAULT_PAYTABLE } = require("./engine");
const { buildReplayRow } = require("../replay");

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

function buildEmbed(state, { username, balance }) {
  const paytable = state.paytable || DEFAULT_PAYTABLE;
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username} 的尋寶之旅` })
    .setColor(0xfee75c);

  if (state.status === "selecting") {
    embed
      .setTitle("🗺️ 選擇 5 個寶藏格")
      .setDescription(
        [
          `下注：**${state.bet.toLocaleString()}** credits　・餘額：**${(balance ?? 0).toLocaleString()}**`,
          `已選 **${state.picks.length}/${state.pickCount}** 格`,
          `賠率：${buildPaytableLine(paytable)}`,
          ``,
          `📜 點擊格子手動挑選，或按 **🎲機選** 自動補滿，按 **🎯開獎** 揭曉。`,
        ].join("\n")
      );
  } else if (state.status === "cancelled") {
    embed
      .setTitle("❌ 取消尋寶")
      .setColor(0x99aab5)
      .setDescription(
        [
          `已退款 **${state.bet.toLocaleString()}** credits。`,
          `餘額：**${(balance ?? 0).toLocaleString()}**`,
        ].join("\n")
      );
  } else if (state.status === "settled") {
    const won = state.payout > 0;
    embed
      .setColor(won ? 0x57f287 : 0xed4245)
      .setTitle(
        won
          ? `💎 命中 ${state.hitCount}/${state.pickCount}！+${state.payout.toLocaleString()} credits（×${state.multiplier}）`
          : `💸 命中 ${state.hitCount}/${state.pickCount}　差一點！`
      )
      .setDescription(
        [
          `下注：**${state.bet.toLocaleString()}**　・餘額：**${(balance ?? 0).toLocaleString()}**`,
          `你的號碼：${state.picks.sort((a, b) => a - b).join("、") || "—"}`,
          `寶藏位置：${state.treasures.slice().sort((a, b) => a - b).join("、")}`,
          ``,
          `賠率表：${buildPaytableLine(paytable)}`,
        ].join("\n")
      );
  }

  return embed;
}

function renderMessage(state, { username, balance } = {}) {
  // 開獎後棋盤已占 4 列，控制鈕全停用 → 換成「再來一局」一列（避免超過 5 列上限）
  const lastRow =
    state.status === "settled" && state.userId
      ? buildReplayRow("keno", state.userId, { name: username })
      : buildControlRow(state);
  const components = [...buildBoardRows(state), lastRow];
  const embed = buildEmbed(state, { username, balance });
  return { embeds: [embed], components };
}

module.exports = { renderMessage };
