// 賭場「再來一局」共用工具：
//   - 紀錄玩家在每款遊戲的「上一注」參數
//   - 產生重玩按鈕（綁定本人，避免別人誤觸）
// 重玩流程由 events/interactionCreate/handleCasinoReplayButton.js 處理。

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const REPLAY_PREFIX = "rb_";

// Discord 按鈕文字上限 80 字
const MAX_LABEL_LEN = 80;

// customId 格式：rb_<game>_<ownerId>
// game 皆為無底線的代號（slot/sicbo/blackjack/hilo/crash/keno/dragonGate/roulette/lottery），
// ownerId 為純數字 snowflake，因此可用最後一個底線安全切分。
// 帶上玩家名稱（name），讓大量訊息中能快速分辨是誰的按鈕。
function buildReplayRow(game, ownerId, { label = "🔁 再來一局", name } = {}) {
  let finalLabel = name ? `${label}・${name}` : label;
  if (finalLabel.length > MAX_LABEL_LEN) {
    finalLabel = finalLabel.slice(0, MAX_LABEL_LEN);
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REPLAY_PREFIX}${game}_${ownerId}`)
      .setLabel(finalLabel)
      .setStyle(ButtonStyle.Secondary)
  );
}

function parseReplayId(customId) {
  if (!customId || !customId.startsWith(REPLAY_PREFIX)) return null;
  const rest = customId.slice(REPLAY_PREFIX.length);
  const sep = rest.lastIndexOf("_");
  if (sep <= 0) return null;
  return { game: rest.slice(0, sep), ownerId: rest.slice(sep + 1) };
}

async function saveLastBet(client, { userId, guildId, game, payload }) {
  if (!client.casinoLastBetsCollection) return;
  try {
    await client.casinoLastBetsCollection.updateOne(
      { userId, guildId, game },
      { $set: { userId, guildId, game, payload, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.log(`[WARN] casino saveLastBet(${game}) failed: ${e.message}`);
  }
}

async function getLastBet(client, { userId, guildId, game }) {
  if (!client.casinoLastBetsCollection) return null;
  try {
    return await client.casinoLastBetsCollection.findOne({
      userId,
      guildId,
      game,
    });
  } catch (e) {
    console.log(`[WARN] casino getLastBet(${game}) failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  REPLAY_PREFIX,
  buildReplayRow,
  parseReplayId,
  saveLastBet,
  getLastBet,
};
