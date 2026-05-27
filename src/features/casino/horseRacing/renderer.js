// 賽馬訊息渲染：售票期 / 比賽中 / 結算 三種狀態。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const { HORSES } = require("./engine");

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
    `🐎 **賽馬大賽開盤！** 由 <@${state.hostUserId}> 發起`,
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

  return {
    content: lines.join("\n"),
    components: buildBettingButtons(state.gameId),
  };
}

// ── 比賽中：上方文字搭配 GIF 附件 ──
function renderRunningPhase(state) {
  const totalPool = (state.bets || []).reduce((s, b) => s + b.amount, 0);
  const lines = [
    `🐎 **賽馬大賽 ・ 比賽進行中**`,
    `${MONEY_EMOJI} 總彩池：**${totalPool.toLocaleString()}** credits ・ ${(state.bets || []).length} 筆下注`,
    "-# 🏇 看誰先衝過終點線…",
  ];
  return { content: lines.join("\n"), components: [] };
}

// ── 結算 ──
// 圖卡裡已經有領獎台 / 完整名次 / 彩池統計,文字部分只負責「冠軍宣告 + 中獎玩家 mention」。
function renderSettledPhase(state) {
  const rankings = state.rankings || [];
  const winnerHorse = HORSES.find((h) => h.id === rankings[0]);

  const lines = [
    `🐎 **賽馬大賽 ・ 結果出爐**`,
    winnerHorse
      ? `🏆 冠軍：${winnerHorse.emoji} **${winnerHorse.name}** ×${winnerHorse.payout.toFixed(1)}`
      : `🏆 冠軍：—`,
  ];

  const settles = state.settles || [];
  const winners = settles.filter((s) => s.payout > 0);
  if (winners.length > 0) {
    lines.push("");
    lines.push("**🎉 中獎玩家**");
    for (const w of winners) {
      lines.push(
        `・<@${w.userId}> 押 ${HORSES.find((h) => h.id === w.horseId)?.name} ${w.amount.toLocaleString()} → +${w.payout.toLocaleString()}`,
      );
    }
  } else if (settles.length > 0) {
    lines.push("");
    lines.push("-# 🥲 本局無人押中，全部下注沒入莊家口袋。");
  }

  return { content: lines.join("\n"), components: [] };
}

function renderCancelled(state, reason = "已取消") {
  const refunds = (state.bets || []).map(
    (b) => `・<@${b.userId}> 退款 ${b.amount.toLocaleString()}`,
  );
  const lines = [
    `🐎 **賽馬大賽 ・ ${reason}**`,
    "─────────────────────",
  ];
  if (refunds.length > 0) {
    lines.push("已下注金額將全額退回：");
    lines.push(...refunds);
  } else {
    lines.push("-# 沒有任何下注，直接取消。");
  }
  return { content: lines.join("\n"), components: [] };
}

module.exports = {
  renderBettingPhase,
  renderRunningPhase,
  renderSettledPhase,
  renderCancelled,
  buildBettingButtons,
  aggregateBetsByHorse,
};
