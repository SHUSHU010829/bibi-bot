// Crash / 火箭 Discord 訊息 payload 渲染。
//
// 兩種狀態：
//   playing：純文字 + 收手按鈕（每 tick edit，畫圖太貴所以略過）
//   settled：完整結算卡片（贏 / 輸 兩種底色）

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const generateCrashCard = require("../../../utils/generateCrashCard");
const { multiplierAt } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");

// startedAt 在 DB 是 Date、開局當下是 number，統一轉成 ms。
function startedAtMs(state) {
  return state.startedAt instanceof Date
    ? state.startedAt.getTime()
    : state.startedAt;
}

// 火箭是否還在蓄勢（還沒真的升空）。蓄勢期間 now < startedAt。
function isLaunching(state, now = Date.now()) {
  const started = startedAtMs(state);
  return typeof started === "number" && now < started;
}

function buildCashOutButton(state, now = Date.now()) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cr_cash_${state.gameId}`)
      .setLabel("收手")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
      // 蓄勢中（火箭還沒升空）先關著，等真的起飛才亮
      .setDisabled(state.status !== "playing" || isLaunching(state, now)),
  );
}

function renderPlayingText(state, { username, balance } = {}) {
  const now = Date.now();
  const m = multiplierAt(state, now);
  const handle = username ? `@${username}` : "";
  const target =
    state.autocashout != null
      ? ` ・ 自動收手 ×${state.autocashout.toFixed(2)}`
      : "";
  const tail =
    typeof balance === "number"
      ? ` ・ 餘額 ${balance.toLocaleString()}`
      : "";

  // 倍率區塊放大一點，方便看。蓄勢中還沒升空 → 顯示「蓄勢待發」。
  const big = isLaunching(state, now)
    ? "## 🚀 火箭蓄勢待發... 即將升空！"
    : `## 🚀 火箭升空中... ×${m.toFixed(2)}`;
  const meta = `Bet **${state.bet.toLocaleString()}**${handle ? ` ・ ${handle}` : ""}${target}${tail}`;
  const hint = "按下「💰 收手」鎖定當下倍率，慢一步火箭就炸了！";
  const note = "⚠️ DC 訊息更新太快會被限流，畫面上的倍率每隔幾秒才會跳一次，實際數字以伺服器為準（你按下去那一刻的倍率才是真的）";

  return `${big}\n${meta}\n${hint}\n${note}`;
}

// 升空中的 embed 內文行（圖卡太貴，飛行階段只用文字＋每 tick 更新）。
function playingLines(state) {
  const now = Date.now();
  const m = multiplierAt(state, now);
  const headline = isLaunching(state, now)
    ? "## 🚀 火箭蓄勢待發... 即將升空！"
    : `## 🚀 火箭升空中... ×${m.toFixed(2)}`;
  const lines = [
    headline,
    "按下「💰 收手」鎖定當下倍率，慢一步火箭就炸了！",
    "⚠️ DC 訊息更新太快會被限流，畫面上的倍率每隔幾秒才會跳一次，實際數字以伺服器為準（你按下去那一刻的倍率才是真的）",
  ];
  if (state.autocashout != null) {
    lines.push(`自動收手目標：×${state.autocashout.toFixed(2)}`);
  }
  return lines;
}

// 結算時的輸贏判定：回傳顏色用的 outcome 與淨輸贏 net。
function settleOutcome(state) {
  if (state.status !== "settled") return { outcome: "neutral", net: undefined };
  if (state.result === "cashout") {
    return { outcome: "win", net: (state.payout || 0) - state.bet };
  }
  // 爆炸 → 全輸
  return { outcome: "lose", net: -state.bet };
}

// 圖片渲染失敗時，把結算牌況寫進 embed 內文的備援文字行。
function settledLines(state) {
  const lines = [];
  if (state.autocashout != null) {
    lines.push(`自動收手目標：×${state.autocashout.toFixed(2)}`);
  }
  lines.push(`本局爆炸倍率：×${state.bust.toFixed(2)}`);
  return lines;
}

function settleHeadline(state) {
  if (state.result === "cashout") {
    return `🚀 **成功收手！** ×${state.cashoutAt.toFixed(2)} ＝ +${state.payout.toLocaleString()} credits（本局爆炸於 ×${state.bust.toFixed(2)}）`;
  }
  return `💥 **火箭爆炸！** −${state.bet.toLocaleString()} credits（爆炸於 ×${state.bust.toFixed(2)}${state.autocashout != null ? `，目標 ×${state.autocashout.toFixed(2)}` : ""}）`;
}

function renderSettledText(state, { username, balance } = {}) {
  const handle = username ? `@${username}` : "";
  const lines = [
    `🚀 **火箭** ・ Bet: **${state.bet.toLocaleString()}**${handle ? ` ・ ${handle}` : ""}`,
    "─────────────────────",
  ];
  if (state.autocashout != null) {
    lines.push(`自動收手目標：×${state.autocashout.toFixed(2)}`);
  }
  lines.push(`本局爆炸倍率：×${state.bust.toFixed(2)}`);
  lines.push(settleHeadline(state));
  if (typeof balance === "number") {
    lines.push(`餘額：**${balance.toLocaleString()}** credits`);
  }
  return lines.join("\n");
}

// 升空中：火箭還在飛 → neutral 底色，只顯示下注（餘額不顯示，飛行中還沒結算）。
// 註：飛行階段不畫圖卡（太貴），直接把當下倍率塞進 embed 內文行＋頁尾。
function buildPlayingPayload(state, { username, balance, userId, avatarURL } = {}) {
  void balance; // 飛行中不顯示餘額
  const embed = buildCasinoEmbed({
    game: "🚀 火箭",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome: "neutral",
    lines: playingLines(state),
    bet: state.bet,
    footer: `當前倍率 ×${multiplierAt(state, Date.now()).toFixed(2)}${state.autocashout != null ? ` ・ 自動收手 ×${state.autocashout.toFixed(2)}` : ""}`,
  });
  return {
    content: "",
    embeds: [embed],
    components: [buildCashOutButton(state)],
    files: [],
    attachments: [],
  };
}

async function buildSettledPayload(state, { username, balance, userId, avatarURL } = {}) {
  const components = state.userId
    ? [buildReplayRow("crash", state.userId, { name: username })]
    : [];
  const { outcome, net } = settleOutcome(state);

  let files = [];
  let imageName;
  let fallbackLines = [];
  try {
    const buf = await generateCrashCard({
      username,
      state,
      balance: balance ?? 0,
    });
    imageName = `crash-${state.gameId || "result"}.png`;
    files = [new AttachmentBuilder(buf, { name: imageName })];
  } catch (e) {
    console.log(
      `[WARN] crash card render failed, falling back to text: ${e.message}`,
    );
    fallbackLines = settledLines(state); // 沒有圖時改用文字呈現本局結果
  }

  const embed = buildCasinoEmbed({
    game: "🚀 火箭",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome,
    headline: settleHeadline(state),
    lines: fallbackLines,
    bet: state.bet,
    net,
    balance: typeof balance === "number" ? balance : undefined,
    imageName,
  });

  return { content: "", embeds: [embed], components, files, attachments: [] };
}

module.exports = {
  buildPlayingPayload,
  buildSettledPayload,
  renderPlayingText,
  renderSettledText,
  settleHeadline,
  buildCashOutButton,
};
