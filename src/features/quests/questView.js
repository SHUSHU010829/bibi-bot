// /逼幣任務 介面的 Components V2 容器建構（指令與通知開關按鈕共用）。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const questService = require("./questService");
const questNotifyPref = require("./questNotifyPref");
const { COIN_EMOJI } = require("../../constants/coin");

const PROGRESS_BAR_LEN = 10;
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

const renderBar = (progress, target) => {
  const ratio = target > 0 ? Math.min(1, progress / target) : 0;
  const filled = Math.round(ratio * PROGRESS_BAR_LEN);
  return "▰".repeat(filled) + "▱".repeat(PROGRESS_BAR_LEN - filled);
};

const renderQuestLine = (q) => {
  const bar = renderBar(q.progress, q.target);
  return [
    `${STATE_EMOJI[q.state]} **${q.name}** ・ ${STATE_LABEL[q.state]}`,
    `-# ${q.description}`,
    `\`${bar}\` ${q.progress}/${q.target} ・ 獎勵 **${q.reward}** ${COIN_EMOJI}`,
  ].join("\n");
};

// 讀取任務進度與通知偏好，組出 /逼幣任務 的 V2 容器。
async function buildQuestContainer(client, userId, guildId) {
  const status = await questService.getStatus(client, userId, guildId);
  const dmNotify = await questNotifyPref.isDmEnabled(client, userId, guildId);

  const readyCount =
    status.daily.filter((q) => q.state === "ready").length +
    status.weekly.filter((q) => q.state === "ready").length;

  const container = new ContainerBuilder()
    .setAccentColor(readyCount > 0 ? 0xffa726 : 0x607d8b)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📜 逼幣任務${
          readyCount > 0 ? ` ・ 有 **${readyCount}** 個任務剛完成等入帳` : ""
        }`
      )
    );

  if (status.daily.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🌞 每日任務\n${status.daily.map(renderQuestLine).join("\n\n")}`
        )
      );
  }
  if (status.weekly.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 📅 週常任務\n${status.weekly.map(renderQuestLine).join("\n\n")}`
        )
      );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 任務完成會自動入帳；若有「待入帳」未到帳，可用 \`/領錢\` 補領。\n` +
        `-# 下方按鈕可開關「被動任務（發言／語音／表情等）完成時的 DM 通知」，目前**${
          dmNotify ? "已開啟 🔔" : "已關閉 🔕"
        }**。`
    )
  );

  container.addActionRowComponents(
    questNotifyPref.buildButtonRow({ userId, enabled: dmNotify })
  );

  return container;
}

module.exports = { buildQuestContainer };
