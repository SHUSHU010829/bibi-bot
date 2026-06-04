// /逼幣任務 介面中，每個未領取任務旁邊的「重抽 / 跳過」按鈕。
// customId 格式：qrr_<userId>_<questId> / qsk_<userId>_<questId>
// questId 可能含有底線（例：daily_messages），所以解析時取「第二個底線之後的全部」當 questId。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const REROLL_PREFIX = "qrr";
const SKIP_PREFIX = "qsk";
const CLAIM_PREFIX = "qcl";
const MANAGE_PREFIX = "qmg";

const PREFIX_TO_ACTION = {
  [REROLL_PREFIX]: "reroll",
  [SKIP_PREFIX]: "skip",
  [CLAIM_PREFIX]: "claim",
  [MANAGE_PREFIX]: "manage",
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

// ready 狀態：給「領取」按鈕；其餘未領取狀態：給「重抽/跳過」
function buildButtonRow({
  userId,
  questId,
  state,
  reward,
  rerollCost,
  skipCost,
  rerollDisabled,
  skipDisabled,
  claimDisabled,
}) {
  if (state === "ready") {
    return new ActionRowBuilder().addComponents(
      buildClaimButton({ userId, questId, reward, disabled: claimDisabled }),
    );
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(REROLL_PREFIX, userId, questId))
      .setLabel(`重抽 (-${rerollCost})`)
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!rerollDisabled),
    new ButtonBuilder()
      .setCustomId(buildCustomId(SKIP_PREFIX, userId, questId))
      .setLabel(`不做了 (-${skipCost})`)
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!skipDisabled),
  );
}

// Section 側邊配件用：單顆「領取」按鈕（state === ready）
function buildClaimButton({ userId, questId, reward, disabled }) {
  return new ButtonBuilder()
    .setCustomId(buildCustomId(CLAIM_PREFIX, userId, questId))
    .setLabel(`領取 (+${reward})`)
    .setEmoji("💰")
    .setStyle(ButtonStyle.Success)
    .setDisabled(!!disabled);
}

// Section 側邊配件用：單顆「管理」按鈕（pending/in_progress），
// 點下後就地展開該任務的重抽 / 不做了選項，避免每筆任務都吃掉 4 個元件。
function buildManageButton({ userId, questId, disabled }) {
  return new ButtonBuilder()
    .setCustomId(buildCustomId(MANAGE_PREFIX, userId, questId))
    .setLabel("管理")
    .setEmoji("⋯")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!!disabled);
}

module.exports = {
  REROLL_PREFIX,
  SKIP_PREFIX,
  CLAIM_PREFIX,
  MANAGE_PREFIX,
  parseCustomId,
  buildButtonRow,
  buildClaimButton,
  buildManageButton,
};
