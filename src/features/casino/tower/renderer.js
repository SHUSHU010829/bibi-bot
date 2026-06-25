// 爬塔 Discord 訊息 payload 渲染。開局與每次按鈕互動共用同一份。
//
// 塔以文字畫在 embed 描述裡：最高層在最上面、底層在最下面。
//   ✅ 你踩過的安全格      💥 踩爆的陷阱       💣 揭曉的陷阱
//   ⬜ 揭曉的安全格        🟦 目前可選的格     ⬛ 還沒爬到的格

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const { resolveDifficulty, round2 } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");
const generateTowerCard = require("../../../utils/generateTowerCard");

const TILE = {
  picked: "✅",
  hit: "💥",
  trap: "💣",
  safe: "⬜",
  active: "🟦",
  locked: "⬛",
};

// 數字格按鈕用的 emoji（1–9 足夠，每層最多 4 格）。
const NUM_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

// 清完第 floor 層（0-based）後的累積倍率 = floorMul^(floor+1)。
function reachMultiplier(state, floor) {
  return round2(Math.pow(state.floorMultiplier, floor + 1));
}

// 某一層、某一格在當前 state 下該顯示哪個圖示。
function tileGlyph(state, floor, tile) {
  const isPlaying = state.status === "playing";

  if (floor < state.currentFloor) {
    // 已清關的層：揭曉全貌
    if (state.picks[floor] === tile) return TILE.picked;
    return state.traps[floor].includes(tile) ? TILE.trap : TILE.safe;
  }

  if (!isPlaying && state.result === "lose" && floor === state.currentFloor) {
    // 失敗的那層：踩中的是 💥，其餘陷阱 💣、安全格 ⬜
    if (tile === state.hitTile) return TILE.hit;
    return state.traps[floor].includes(tile) ? TILE.trap : TILE.safe;
  }

  if (isPlaying && floor === state.currentFloor) return TILE.active;
  return TILE.locked;
}

function floorRow(state, floor) {
  const tiles = [];
  for (let t = 0; t < state.tilesPerFloor; t += 1) {
    tiles.push(tileGlyph(state, floor, t));
  }
  const here =
    state.status === "playing" && floor === state.currentFloor ? "👉" : "　";
  const mult = reachMultiplier(state, floor);
  const top = floor === state.maxFloors - 1 ? "🏆" : "　";
  return `${here}${top}F${String(floor + 1).padStart(2, " ")}　${tiles.join(" ")}　×${mult.toFixed(2)}`;
}

function renderTower(state) {
  const lines = [];
  for (let f = state.maxFloors - 1; f >= 0; f -= 1) {
    lines.push(floorRow(state, f));
  }
  return lines.join("\n");
}

function settleHeadline(state) {
  switch (state.result) {
    case "win":
      return `🏆 **登頂成功！** 攻下整座塔，拿走 ${state.payout.toLocaleString()} credits（×${state.accMultiplier.toFixed(2)}）`;
    case "cashout":
      return `${MONEY_EMOJI} **收手成功！** 拿走 ${state.payout.toLocaleString()} credits（×${state.accMultiplier.toFixed(2)}）`;
    case "lose":
      return `💥 **踩到陷阱！** －${state.bet.toLocaleString()} credits，止步第 ${state.currentFloor + 1} 層，下次加油！`;
    default:
      return "";
  }
}

function buildTileButtons(state) {
  const row = new ActionRowBuilder();
  for (let t = 0; t < state.tilesPerFloor; t += 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`tw_p${t}_${state.gameId}`)
        .setLabel(`${t + 1}`)
        .setEmoji(NUM_EMOJI[t] || "🔢")
        .setStyle(ButtonStyle.Primary)
    );
  }
  return row;
}

function buildCashRow(state) {
  const canCashOut = state.currentFloor > 0;
  const amount = canCashOut
    ? Math.floor(state.bet * state.accMultiplier + 1e-9)
    : 0;
  const label = canCashOut
    ? `收手 +${amount.toLocaleString()}`
    : "收手（至少爬 1 層）";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tw_cash_${state.gameId}`)
      .setLabel(label)
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canCashOut)
  );
}

function settleOutcome(state) {
  if (state.status === "playing") return { outcome: "neutral", net: undefined };
  switch (state.result) {
    case "lose":
      return { outcome: "lose", net: -state.bet };
    case "cashout":
    case "win":
      return { outcome: "win", net: (state.payout || 0) - state.bet };
    default:
      return { outcome: "neutral", net: undefined };
  }
}

async function renderMessage(state, { username, balance, userId, avatarURL } = {}) {
  const isPlaying = state.status === "playing";
  const diff = resolveDifficulty(state.difficulty);
  const { outcome, net } = settleOutcome(state);

  let files = [];
  let imageName;
  let fallbackLines = [];
  try {
    const buf = await generateTowerCard(state, {
      username,
      balance,
      diffLabel: `${diff.label}（${state.tilesPerFloor} 格 ${state.trapsPerFloor} 雷）`,
    });
    imageName = `tower-${state.gameId}-${state.currentFloor}.png`;
    files = [new AttachmentBuilder(buf, { name: imageName })];
  } catch (e) {
    console.log(`[WARN] tower card render failed, falling back to text: ${e.message}`);
    fallbackLines = [
      `難度：**${diff.label}**（${state.tilesPerFloor} 格 ${state.trapsPerFloor} 雷）・每層 ×${state.floorMultiplier.toFixed(2)}`,
      "```",
      renderTower(state),
      "```",
    ];
    if (isPlaying) {
      const nextReach = reachMultiplier(state, state.currentFloor);
      fallbackLines.push(
        `第 **${state.currentFloor + 1}** 層・踩對 → 累積 ×${nextReach.toFixed(2)}`
      );
      if (state.currentFloor > 0) {
        const cash = Math.floor(state.bet * state.accMultiplier + 1e-9);
        fallbackLines.push(`收手可拿：**${cash.toLocaleString()}** credits`);
      }
    }
  }

  const components = isPlaying
    ? [buildTileButtons(state), buildCashRow(state)]
    : state.userId
      ? [buildReplayRow("tower", state.userId, { name: username })]
      : [];

  const embed = buildCasinoEmbed({
    game: "🗼 爬塔",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome,
    headline: isPlaying ? null : settleHeadline(state),
    lines: fallbackLines,
    bet: state.bet,
    net: isPlaying ? undefined : net,
    balance: isPlaying || typeof balance !== "number" ? undefined : balance,
    imageName,
    footer: isPlaying
      ? `累積倍率 ×${state.accMultiplier.toFixed(2)} ・ 已爬 ${state.currentFloor}/${state.maxFloors} 層`
      : undefined,
  });

  return { content: "", embeds: [embed], components, files };
}

module.exports = {
  renderMessage,
  renderTower,
  settleHeadline,
  reachMultiplier,
};
