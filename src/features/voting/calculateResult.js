const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

function calculateVoteResult(proposal, template) {
  const passCondition = template.passCondition;
  const voteCounts = {};
  let totalScore = 0;
  let totalVotes = 0;

  for (const btn of template.buttons) {
    const count = proposal.votes?.[btn.id]?.length || 0;
    voteCounts[btn.id] = count;
    totalScore += count * (btn.weight || 0);
    totalVotes += count;
  }

  let passed = false;
  let reason = "";

  switch (passCondition.type) {
    case "weighted": {
      const maxWeight = Math.max(...template.buttons.map((b) => b.weight || 0));
      const highInterestBtn = template.buttons.find(
        (btn) => (btn.weight || 0) === maxWeight,
      );
      const highInterestCount = highInterestBtn
        ? voteCounts[highInterestBtn.id] || 0
        : 0;

      passed =
        totalScore >= passCondition.minTotalScore &&
        highInterestCount >= passCondition.minHighInterest;

      reason = passed
        ? `總分 ${totalScore} ≥ ${passCondition.minTotalScore}，且高意願 ${highInterestCount} ≥ ${passCondition.minHighInterest}`
        : `需要：總分 ≥ ${passCondition.minTotalScore} 且 高意願 ≥ ${passCondition.minHighInterest}`;
      break;
    }

    case "reverse": {
      const stillActiveBtn = template.buttons[0];
      const stillActiveCount = voteCounts[stillActiveBtn.id] || 0;

      passed = stillActiveCount <= passCondition.maxStillActive;
      reason = passed
        ? `活躍人數 ${stillActiveCount} ≤ ${passCondition.maxStillActive}，頻道將被封存`
        : `仍有 ${stillActiveCount} 位玩家活躍，頻道將保留`;
      break;
    }

    case "majority": {
      const approveBtn = template.buttons.find((btn) => btn.id === "approve");
      const rejectBtn = template.buttons.find((btn) => btn.id === "reject");
      const approveCount = approveBtn ? voteCounts[approveBtn.id] || 0 : 0;
      const rejectCount = rejectBtn ? voteCounts[rejectBtn.id] || 0 : 0;

      passed =
        totalVotes >= passCondition.minTotalVotes && approveCount > rejectCount;

      reason = passed
        ? `總票數 ${totalVotes} ≥ ${passCondition.minTotalVotes}，且贊成 ${approveCount} > 反對 ${rejectCount}`
        : `需要：總票數 ≥ ${passCondition.minTotalVotes} 且 贊成 > 反對`;
      break;
    }

    case "simple": {
      const supportBtn = template.buttons.find((btn) => btn.id === "support");
      const supportCount = supportBtn ? voteCounts[supportBtn.id] || 0 : 0;

      passed = supportCount >= passCondition.minSupport;
      reason = passed
        ? `支持票 ${supportCount} ≥ ${passCondition.minSupport}`
        : `需要：支持票 ≥ ${passCondition.minSupport}`;
      break;
    }
  }

  return { passed, reason, voteCounts, totalScore, totalVotes };
}

const REASON_LABELS = {
  expired: "結束投票",
  manual_end: "被管理員提早結束",
  cancelled: "被管理員取消",
};

function createResultContainer(proposal, template, result, opts = {}) {
  const reason = opts.reason || "expired";
  const passed = result.passed;
  const title = proposal.title || proposal.gameName || "提案";
  const nowEpoch = Math.floor(Date.now() / 1000);

  if (reason === "cancelled") {
    return new ContainerBuilder()
      .setAccentColor(0xff0000)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🗑️ 投票已取消：【${title}】\n` +
            `此投票已被管理員取消。\n\n` +
            `**投票類型：** ${template.name}\n` +
            `**取消時間：** <t:${nowEpoch}:F>`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 投票系統 ・ <t:${nowEpoch}:R>`),
      );
  }

  const description =
    reason === "manual_end"
      ? `此提案已於 <t:${nowEpoch}:F> ${REASON_LABELS[reason]}`
      : `此提案已於 <t:${nowEpoch}:F> 結束投票`;

  const buttonLines = template.buttons.map(
    (btn) => `${btn.emoji} ${btn.label}：${result.voteCounts[btn.id] || 0} 人`,
  );

  const container = new ContainerBuilder()
    .setAccentColor(passed ? 0x00ff00 : 0xff0000)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${passed ? "✅ 提案通過" : "❌ 提案未通過"}：${title}\n${description}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📋 投票類型**：${template.name}\n${buttonLines.join("\n")}` +
          (result.totalScore > 0 ? `\n**📊 總分**：${result.totalScore} 分` : ""),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📋 結算結果**\n${
          passed ? `✅ **通過！**\n${result.reason}` : `❌ **未通過**\n${result.reason}`
        }`,
      ),
    );

  const footerSuffix = reason === "manual_end" ? " · 管理員提早結束" : "";
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 投票系統${footerSuffix} ・ <t:${nowEpoch}:R>`,
    ),
  );

  return container;
}

module.exports = { calculateVoteResult, createResultContainer };
