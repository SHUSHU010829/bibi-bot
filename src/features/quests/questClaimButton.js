// /逼幣任務 介面下方「領錢」按鈕。
//
// 點擊後等同呼叫 /領錢：補領所有「待入帳」的任務獎勵。
// customId = questclaim_<userId>，僅本人可操作（見 handleQuestClaimButton.js）。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const CUSTOM_ID_PREFIX = "questclaim";

function buildCustomId(userId) {
  return `${CUSTOM_ID_PREFIX}_${userId}`;
}

// 解析 questclaim_<userId>。userId 為純數字 Discord ID。
function parseCustomId(customId) {
  if (typeof customId !== "string") return null;
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}_`)) return null;
  const userId = customId.slice(CUSTOM_ID_PREFIX.length + 1);
  if (!userId) return null;
  return { userId };
}

// 產生「一鍵領取」按鈕。hasReady 時亮綠燈強調，否則灰色。
function buildButton({ userId, hasReady }) {
  return new ButtonBuilder()
    .setCustomId(buildCustomId(userId))
    .setLabel("一鍵領取")
    .setEmoji("🪙")
    .setStyle(hasReady ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// 單獨成列（如需與其他按鈕同列，直接用 buildButton）。
function buildButtonRow({ userId, hasReady }) {
  return new ActionRowBuilder().addComponents(buildButton({ userId, hasReady }));
}

module.exports = {
  CUSTOM_ID_PREFIX,
  buildCustomId,
  parseCustomId,
  buildButton,
  buildButtonRow,
};
