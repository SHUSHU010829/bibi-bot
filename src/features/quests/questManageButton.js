// /逼幣任務 介面中，每個未領取任務旁邊的「重抽」與 ready 狀態的「領取」按鈕。
// customId 格式：qrr_<userId>_<questId> / qcl_<userId>_<questId>
// questId 可能含有底線（例：daily_messages），所以解析時取「第二個底線之後的全部」當 questId。

const { ButtonBuilder, ButtonStyle } = require("discord.js");
const questRewards = require("./questRewards");

const REROLL_PREFIX = "qrr";
const CLAIM_PREFIX = "qcl";

const PREFIX_TO_ACTION = {
  [REROLL_PREFIX]: "reroll",
  [CLAIM_PREFIX]: "claim",
};

function buildCustomId(prefix, userId, questId) {
  return `${prefix}_${userId}_${questId}`;
}

function parseCustomId(customId) {
  if (typeof customId !== "string") return null;
  const dash1 = customId.indexOf("_");
  if (dash1 < 0) return null;
  const prefix = customId.slice(0, dash1);
  const action = PREFIX_TO_ACTION[prefix];
  if (!action) return null;
  const dash2 = customId.indexOf("_", dash1 + 1);
  if (dash2 < 0) return null;
  const userId = customId.slice(dash1 + 1, dash2);
  const questId = customId.slice(dash2 + 1);
  if (!userId || !questId) return null;
  return { action, userId, questId };
}

// Section 側邊配件用：單顆「領取」按鈕（state === ready）
function buildClaimButton({ userId, questId, reward, rewardItems, disabled }) {
  return new ButtonBuilder()
    .setCustomId(buildCustomId(CLAIM_PREFIX, userId, questId))
    .setLabel(questRewards.claimButtonLabel({ reward, rewardItems }))
    .setEmoji("💰")
    .setStyle(ButtonStyle.Success)
    .setDisabled(!!disabled);
}

// Section 側邊配件用：單顆「重抽」按鈕（pending/in_progress）
function buildRerollButton({ userId, questId, rerollCost, disabled }) {
  return new ButtonBuilder()
    .setCustomId(buildCustomId(REROLL_PREFIX, userId, questId))
    .setLabel(`重抽 (-${rerollCost})`)
    .setEmoji("🔄")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!!disabled);
}

module.exports = {
  REROLL_PREFIX,
  CLAIM_PREFIX,
  parseCustomId,
  buildClaimButton,
  buildRerollButton,
};
