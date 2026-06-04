// /逼幣任務 介面的 Components V2 容器建構（指令與通知開關按鈕共用）。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const { DateTime } = require("luxon");
const { questSystem } = require("../../config");
const questService = require("./questService");
const questNotifyPref = require("./questNotifyPref");
const questClaimButton = require("./questClaimButton");
const questManageButton = require("./questManageButton");
const questAssignmentService = require("./questAssignmentService");
const { COIN_EMOJI } = require("../../constants/coin");

const TZ = () => questSystem?.resetTimezone || "Asia/Taipei";

function nextDailyResetUnix() {
  return Math.floor(
    DateTime.now().setZone(TZ()).plus({ days: 1 }).startOf("day").toSeconds(),
  );
}

function nextWeeklyResetUnix() {
  // ISO 週：週一 00:00 為下一週的開始
  const now = DateTime.now().setZone(TZ());
  const daysUntilMon = ((8 - now.weekday) % 7) || 7;
  return Math.floor(now.plus({ days: daysUntilMon }).startOf("day").toSeconds());
}

const PROGRESS_BAR_LEN = 8;
const BAR_FILLED = "🟩";
const BAR_FILLED_CLAIMED = "🟦";
const BAR_EMPTY = "⬛";
const STATE_EMOJI = {
  pending: "⬜",
  in_progress: "🟡",
  ready: "✅",
  claimed: COIN_EMOJI,
};
const STATE_LABEL = {
  pending: "未開始",
  in_progress: "進行中",
  ready: "待入帳",
  claimed: "已領取",
};

const renderBar = (progress, target, claimed) => {
  const ratio = target > 0 ? Math.min(1, progress / target) : 0;
  let filled = Math.round(ratio * PROGRESS_BAR_LEN);
  if (filled === 0 && progress > 0) filled = 1;
  const fillEmoji = claimed ? BAR_FILLED_CLAIMED : BAR_FILLED;
  return fillEmoji.repeat(filled) + BAR_EMPTY.repeat(PROGRESS_BAR_LEN - filled);
};

const renderQuestLine = (q) => {
  const bar = renderBar(q.progress, q.target, q.state === "claimed");
  return [
    `${STATE_EMOJI[q.state]} **${q.name}** ・ ${STATE_LABEL[q.state]}`,
    `-# ${q.description}`,
    `${bar} \`${q.progress} / ${q.target}\` ・ 獎勵 **${q.reward}** ${COIN_EMOJI}`,
  ].join("\n");
};

function appendQuestList(container, header, quests, userId, tier, assignment) {
  const resetUnix = tier === "weekly" ? nextWeeklyResetUnix() : nextDailyResetUnix();
  const headerWithReset = tier
    ? `${header}　-# 下次刷新 <t:${resetUnix}:R>`
    : header;

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerWithReset));

  if (quests.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# （此期間沒有任務，可能全被跳過）"),
    );
    return;
  }

  const showButtons =
    !!tier && questAssignmentService.isEnabled() && !!assignment;
  const rerollCost = tier ? questAssignmentService.rerollCostFor(tier) : 0;
  const skipCost = tier ? questAssignmentService.skipCostFor(tier) : 0;
  const actionLimit = tier ? questAssignmentService.actionLimitFor(tier) : 0;
  const rerollsUsed = assignment?.rerollsUsed || 0;
  const skipsUsed = assignment?.skipsUsed || 0;
  const actionsUsed = rerollsUsed + skipsUsed;
  const actionFull = actionsUsed >= actionLimit;

  for (const q of quests) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(renderQuestLine(q)),
    );
    if (showButtons && q.state !== "claimed") {
      container.addActionRowComponents(
        questManageButton.buildButtonRow({
          userId,
          questId: q.id,
          state: q.state,
          reward: q.reward,
          rerollCost,
          skipCost,
          rerollDisabled: actionFull,
          skipDisabled: actionFull,
        }),
      );
    }
  }

  if (showButtons) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🔄 重抽 ${rerollsUsed} ・ ⏭️ 跳過 ${skipsUsed}　・ 本期調整額度 **${actionsUsed}/${actionLimit}**（合計）`,
      ),
    );
  }
}

async function buildQuestContainer(client, userId, guildId) {
  const status = await questService.getStatus(client, userId, guildId);
  const dmNotify = await questNotifyPref.isDmEnabled(client, userId, guildId);

  const eventQuestList = status.event || [];
  const readyCount =
    status.daily.filter((q) => q.state === "ready").length +
    status.weekly.filter((q) => q.state === "ready").length +
    eventQuestList.filter((q) => q.state === "ready").length;

  const container = new ContainerBuilder()
    .setAccentColor(readyCount > 0 ? 0xffa726 : 0x607d8b)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📜 逼幣任務${
          readyCount > 0 ? ` ・ 有 **${readyCount}** 個任務剛完成等入帳` : ""
        }`,
      ),
    );

  appendQuestList(
    container,
    "### 🌞 每日任務",
    status.daily,
    userId,
    "daily",
    status.assignment?.daily,
  );

  appendQuestList(
    container,
    "### 📅 週常任務",
    status.weekly,
    userId,
    "weekly",
    status.assignment?.weekly,
  );

  if (eventQuestList.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🎉 限時活動任務\n${eventQuestList.map(renderQuestLine).join("\n\n")}\n` +
            `-# 活動任務不可重抽 / 跳過`,
        ),
      );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 任務完成後不再自動入帳；自己按 💰 領取，或下方「一鍵領取」全收；忘了領的話每天 23:50 系統會自動結算當日未領的任務。\n` +
        `-# 「不做了 ⏭️」=付幣消除該任務、**不會發獎勵**；「重抽 🔄」=付幣抽一個新的同 tier 任務（也可能更難）。\n` +
        `-# 「完成 DM 通知」可開關「被動任務（發言／語音／表情等）完成時的 DM 通知」，目前**${
          dmNotify ? "已開啟 🔔" : "已關閉 🔕"
        }**。`,
    ),
  );

  container.addActionRowComponents(
    questClaimButton.buildButtonRow({ userId, hasReady: readyCount > 0 }),
    questNotifyPref.buildButtonRow({ userId, enabled: dmNotify }),
  );

  return container;
}

module.exports = { buildQuestContainer };
