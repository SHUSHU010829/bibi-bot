const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");

// 紅色錯誤 Container（對齊 CLAUDE.md UX #2）：標題 + 具體差距 + -# 解決提示。
function errorContainer(title, body, hint) {
  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`));
  if (body) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  }
  if (hint) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return container;
}

function infoContainer(accent, content) {
  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

// 追捕結果（公開）：成功搶下賞金 / 通緝犯逃脫。
function huntResultContainer(result, hunterId, wantedUserId) {
  if (result.success) {
    const fineNote =
      result.hunterFineShare > 0
        ? `，另收到贖罪金分成 **${result.hunterFineShare.toLocaleString()}** ${COIN_EMOJI}`
        : "";
    return new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🕵️ 逮捕成功！\n` +
            `<@${hunterId}> 將通緝犯 <@${wantedUserId}> 繩之以法，` +
            `領走賞金 **${result.bounty.toLocaleString()}** ${COIN_EMOJI}${fineNote}！\n\n` +
            `攻擊力 ${result.hunterAtk} vs ${result.wantedAtk}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 裝備越好追捕成功率越高；用 /合成 打造更強武器。")
      );
  }
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💨 讓他跑了！\n` +
          `<@${wantedUserId}> 甩開了 <@${hunterId}> 的追捕，繼續在逃。\n\n` +
          `攻擊力 ${result.hunterAtk} vs ${result.wantedAtk}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 賞金續留通緝榜，換人再試試看！")
    );
}

module.exports = { errorContainer, infoContainer, huntResultContainer };
