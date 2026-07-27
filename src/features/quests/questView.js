// /逼幣任務 介面的 Components V2 容器建構（指令與按鈕共用）。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ActionRowBuilder,
} = require("discord.js");

const { DateTime } = require("luxon");
const { questSystem } = require("../../config");
const questService = require("./questService");
const questClaimButton = require("./questClaimButton");
const questManageButton = require("./questManageButton");
const questAssignmentService = require("./questAssignmentService");
const questRewards = require("./questRewards");
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
    `${bar} \`${q.progress} / ${q.target}\` ・ 獎勵 ${questRewards.rewardText(q)}`,
  ].join("\n");
};

function appendQuestList(container, header, quests, userId, tier, assignment) {
  const showButtons =
    !!tier && questAssignmentService.isEnabled() && !!assignment;
  const rerollCost = tier ? questAssignmentService.rerollCostFor(tier) : 0;
  const actionLimit = tier ? questAssignmentService.actionLimitFor(tier) : 0;
  const rerollsUsed = assignment?.rerollsUsed || 0;
  const rerollFull = rerollsUsed >= actionLimit;

  const resetUnix = tier === "weekly" ? nextWeeklyResetUnix() : nextDailyResetUnix();
  const headerParts = [header];
  if (tier) {
    headerParts.push(`-# 下次刷新 <t:${resetUnix}:R>`);
    if (showButtons) {
      headerParts.push(
        `-# 🔄 本期重抽次數 **${rerollsUsed}/${actionLimit}**`,
      );
    }
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(headerParts.join("\n")),
  );

  if (quests.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# （此期間沒有任務）"),
    );
    return;
  }

  for (const q of quests) {
    const line = renderQuestLine(q);

    // 已領取：純文字、不放按鈕
    if (q.state === "claimed") {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(line),
      );
      continue;
    }

    let accessory = null;
    if (q.state === "ready") {
      accessory = questManageButton.buildClaimButton({
        userId,
        questId: q.id,
        reward: q.reward,
        rewardItems: q.rewardItems,
      });
    } else if (showButtons) {
      accessory = questManageButton.buildRerollButton({
        userId,
        questId: q.id,
        rerollCost,
        disabled: rerollFull,
      });
    }

    if (accessory) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(line))
          .setButtonAccessory(accessory),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(line),
      );
    }
  }
}

async function buildQuestContainer(client, userId, guildId) {
  const status = await questService.getStatus(client, userId, guildId);

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
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎉 限時活動任務\n${eventQuestList.map(renderQuestLine).join("\n\n")}\n` +
          `-# 活動任務不可重抽`,
      ),
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 點任務右側「🔄 重抽」可換一個新任務；忘了領的話每天 23:50 系統會自動結算當日未領的任務。\n` +
        `-# 任務完成 DM 通知開關已搬到 \`/通知設定\`。`,
    ),
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      questClaimButton.buildButton({ userId, hasReady: readyCount > 0 }),
    ),
  );

  return container;
}

module.exports = { buildQuestContainer };
