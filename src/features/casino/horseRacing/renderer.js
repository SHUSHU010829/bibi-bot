// 賽馬訊息渲染：售票期 / 比賽中 / 結算 三種狀態。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const { HORSES } = require("./engine");
const { buildCasinoEmbed } = require("../casinoEmbed");

// 由 state 取出開盤者資訊，當成 embed 的玩家（author + mention）。
function hostUser(state) {
  if (!state?.hostUserId) return undefined;
  return {
    id: state.hostUserId,
    displayName: state.hostUsername,
    avatarURL: state.hostAvatarURL,
  };
}

function aggregateBetsByHorse(bets = []) {
  const map = new Map();
  for (const h of HORSES) map.set(h.id, { totalAmount: 0, betters: 0 });
  for (const b of bets) {
    const e = map.get(b.horseId);
    if (!e) continue;
    e.totalAmount += b.amount;
    e.betters += 1;
  }
  return map;
}

// ── 售票期：訊息內容 + 按鈕 ──
function buildBettingButtons(gameId) {
  const row1 = new ActionRowBuilder().addComponents(
    ...HORSES.slice(0, 3).map((h) =>
      new ButtonBuilder()
        .setCustomId(`hr_pick_${h.id}_${gameId}`)
        .setLabel(`${h.id}.${h.name} ×${h.payout.toFixed(1)}`)
        .setEmoji(h.emoji)
        .setStyle(ButtonStyle.Primary),
    ),
  );
  const row2 = new ActionRowBuilder().addComponents(
    ...HORSES.slice(3, 6).map((h) =>
      new ButtonBuilder()
        .setCustomId(`hr_pick_${h.id}_${gameId}`)
        .setLabel(`${h.id}.${h.name} ×${h.payout.toFixed(1)}`)
        .setEmoji(h.emoji)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hr_start_${gameId}`)
      .setLabel("🚀 提早開賽（開盤者）")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`hr_cancel_${gameId}`)
      .setLabel("❌ 取消（開盤者）")
      .setStyle(ButtonStyle.Danger),
  );
  return [row1, row2, row3];
}

function renderBettingPhase(state) {
  const expiresAtTs = Math.floor(new Date(state.expiresAt).getTime() / 1000);
  const totalPool = (state.bets || []).reduce((s, b) => s + b.amount, 0);
  const byHorse = aggregateBetsByHorse(state.bets || []);

  const lines = [
    `🎫 售票截止：<t:${expiresAtTs}:R>（<t:${expiresAtTs}:T>）・每人可押多匹`,
    "─────────────────────",
    "**馬匹賠率（總倍率，含本金）**",
  ];

  for (const h of HORSES) {
    const agg = byHorse.get(h.id);
    const tag =
      agg.betters > 0
        ? ` ・ 已押 ${agg.totalAmount.toLocaleString()}（${agg.betters} 人）`
        : "";
    lines.push(
      `${h.id} ${h.emoji} **${h.name}** ×${h.payout.toFixed(1)}${tag}`,
    );
  }

  lines.push("─────────────────────");
  lines.push(`${MONEY_EMOJI} 目前總彩池：**${totalPool.toLocaleString()}** credits`);
  if ((state.bets || []).length === 0) {
    lines.push("-# 尚無人下注 ・ 沒人買票就會自動取消，不會跑賽");
  } else {
    lines.push(`-# ${state.bets.length} 筆下注 ・ 點下方按鈕押你看好的馬`);
  }

  // 售票期：開盤者當 author，狀態 neutral；尚未結算所以不顯示輸贏。
  const embed = buildCasinoEmbed({
    game: "🐎 賽馬大賽 ・ 開盤中",
    user: hostUser(state),
    outcome: "neutral",
    headline: "🐎 **賽馬大賽開盤！** 點下方按鈕押你看好的馬",
    lines,
    footer: "開盤者可提早開賽或取消",
  });

  return {
    content: "",
    embeds: [embed],
    components: buildBettingButtons(state.gameId),
  };
}

// ── 比賽中：上方文字搭配 GIF 附件 ──
// withImage：是否已附上 GIF（呼叫端先做一次無附件 edit 清按鈕，再帶 GIF edit）。
function renderRunningPhase(state, { withImage = false } = {}) {
  const totalPool = (state.bets || []).reduce((s, b) => s + b.amount, 0);
  const lines = [
    `${MONEY_EMOJI} 總彩池：**${totalPool.toLocaleString()}** credits ・ ${(state.bets || []).length} 筆下注`,
    "-# 🏇 看誰先衝過終點線…",
  ];

  // 比賽中：只有確定有 GIF 附件時才 setImage，避免顯示破圖。
  const embed = buildCasinoEmbed({
    game: "🐎 賽馬大賽 ・ 比賽進行中",
    user: hostUser(state),
    outcome: "neutral",
    lines,
    imageName: withImage && state.gameId ? `race-${state.gameId}.gif` : undefined,
  });

  return { content: "", embeds: [embed], components: [] };
}

// ── 結算 ──
// 圖卡裡已經有領獎台 / 完整名次 / 彩池統計,文字部分只負責「冠軍宣告 + 中獎玩家 mention」。
// withImage：是否附上結果卡 PNG。
function renderSettledPhase(state, { withImage = false } = {}) {
  const rankings = state.rankings || [];
  const winnerHorse = HORSES.find((h) => h.id === rankings[0]);

  const headline = winnerHorse
    ? `🏆 冠軍：${winnerHorse.emoji} **${winnerHorse.name}** ×${winnerHorse.payout.toFixed(1)}`
    : "🏆 冠軍：—";

  const lines = [];
  const settles = state.settles || [];
  const winners = settles.filter((s) => s.payout > 0);
  if (winners.length > 0) {
    lines.push("**🎉 中獎玩家**");
    for (const w of winners) {
      lines.push(
        `・<@${w.userId}> 押 ${HORSES.find((h) => h.id === w.horseId)?.name} ${w.amount.toLocaleString()} → +${w.payout.toLocaleString()}`,
      );
    }
  } else if (settles.length > 0) {
    lines.push("-# 🥲 本局無人押中，全部下注沒入莊家口袋。");
  }

  const totalPool = (state.bets || []).reduce((s, b) => s + b.amount, 0);
  const totalPaid = settles.reduce((s, x) => s + (x.payout || 0), 0);

  // 多人賽局：有人中獎 → win（綠），全槓龜 → lose（紅）。
  const embed = buildCasinoEmbed({
    game: "🐎 賽馬大賽 ・ 結果出爐",
    user: hostUser(state),
    outcome: winners.length > 0 ? "win" : "lose",
    headline,
    lines,
    footer: `總彩池 ${totalPool.toLocaleString()} ・ 派彩 ${totalPaid.toLocaleString()} ・ ${(state.bets || []).length} 筆下注`,
    imageName: withImage && state.gameId ? `race-${state.gameId}.png` : undefined,
  });

  return { content: "", embeds: [embed], components: [] };
}

function renderCancelled(state, reason = "已取消") {
  const refunds = (state.bets || []).map(
    (b) => `・<@${b.userId}> 退款 ${b.amount.toLocaleString()}`,
  );
  const lines = [];
  if (refunds.length > 0) {
    lines.push("已下注金額將全額退回：");
    lines.push(...refunds);
  } else {
    lines.push("-# 沒有任何下注，直接取消。");
  }

  // 取消：中性顏色，不顯示輸贏欄位（已退款）。
  const embed = buildCasinoEmbed({
    game: `🐎 賽馬大賽 ・ ${reason}`,
    user: hostUser(state),
    outcome: "neutral",
    lines,
  });

  return { content: "", embeds: [embed], components: [] };
}

module.exports = {
  renderBettingPhase,
  renderRunningPhase,
  renderSettledPhase,
  renderCancelled,
  buildBettingButtons,
  aggregateBetsByHorse,
};
