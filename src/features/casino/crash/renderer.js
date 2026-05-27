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

function buildCashOutButton(state) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cr_cash_${state.gameId}`)
      .setLabel("收手")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
      .setDisabled(state.status !== "playing"),
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

  // 倍率區塊放大一點，方便看
  const big = `## 🚀 火箭升空中... ×${m.toFixed(2)}`;
  const meta = `Bet **${state.bet.toLocaleString()}**${handle ? ` ・ ${handle}` : ""}${target}${tail}`;
  const hint = "按下「💰 收手」鎖定當下倍率，慢一步火箭就炸了！";
  const note = "⚠️ DC 訊息更新太快會被限流，畫面上的倍率每隔幾秒才會跳一次，實際數字以伺服器為準（你按下去那一刻的倍率才是真的）";

  return `${big}\n${meta}\n${hint}\n${note}`;
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

function buildPlayingPayload(state, ctx = {}) {
  return {
    content: renderPlayingText(state, ctx),
    components: [buildCashOutButton(state)],
    files: [],
    attachments: [],
  };
}

async function buildSettledPayload(state, { username, balance } = {}) {
  const components = state.userId
    ? [buildReplayRow("crash", state.userId, { name: username })]
    : [];
  let content = "";
  let files = [];
  try {
    const buf = await generateCrashCard({
      username,
      state,
      balance: balance ?? 0,
    });
    files = [
      new AttachmentBuilder(buf, {
        name: `crash-${state.gameId || "result"}.png`,
      }),
    ];
    content = settleHeadline(state);
  } catch (e) {
    console.log(
      `[WARN] crash card render failed, falling back to text: ${e.message}`,
    );
    content = renderSettledText(state, { username, balance });
  }
  return { content, components, files, attachments: [] };
}

module.exports = {
  buildPlayingPayload,
  buildSettledPayload,
  renderPlayingText,
  renderSettledText,
  settleHeadline,
  buildCashOutButton,
};
