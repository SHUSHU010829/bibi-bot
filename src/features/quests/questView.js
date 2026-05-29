// /逼幣任務 介面的 Components V2 容器建構（指令與通知開關按鈕共用）。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const questService = require("./questService");
const questNotifyPref = require("./questNotifyPref");
const questClaimButton = require("./questClaimButton");
const { COIN_EMOJI } = require("../../constants/coin");

const PROGRESS_BAR_LEN = 8;
// 進度條方塊：填滿用綠色、未填用深色（接近 Dank Memer 那種綠色長條 + 深色底）。
// 已領取的任務改用藍色，跟「進行中／待入帳」的綠色區隔開。
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
  // 有進度但四捨五入成 0 時，至少亮一格（呼應圖上 1/10 也有一小段綠）。
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
      `-# 任務完成會自動入帳；若有「待入帳」未到帳，按下方「領錢」即可補領。\n` +
        `-# 「完成 DM 通知」可開關「被動任務（發言／語音／表情等）完成時的 DM 通知」，目前**${
          dmNotify ? "已開啟 🔔" : "已關閉 🔕"
        }**。`
    )
  );

  container.addActionRowComponents(
    questClaimButton.buildButtonRow({ userId, hasReady: readyCount > 0 }),
    questNotifyPref.buildButtonRow({ userId, enabled: dmNotify })
  );

  return container;
}

module.exports = { buildQuestContainer };
