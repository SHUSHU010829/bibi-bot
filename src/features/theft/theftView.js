const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { COIN_EMOJI } = require("../../constants/coin");
const { theft } = require("../../config");

// 把治安動態推到設定的通緝廣播頻道。
// 回傳是否有送出（未設頻道 / 與 skipChannelId 相同 → 不送，回 false，讓呼叫端決定退回原頻道）。
async function broadcast(client, container, skipChannelId = null) {
  const chId = theft?.announceChannelId;
  if (!chId || chId === skipChannelId) return false;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch?.isTextBased?.()) return false;
  await ch
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
  return true;
}

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
  // 逃脫達上限 → 成功脫罪、通緝解除
  if (result.escaped) {
    return new ContainerBuilder()
      .setAccentColor(0x9b59b6)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🕊️ 逍遙法外！\n` +
            `<@${wantedUserId}> 連續躲過 **${result.clearAt}** 次追捕，成功脫罪，通緝解除！\n\n` +
            `攻擊力 ${result.hunterAtk} vs ${result.wantedAtk}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 這隻老狐狸溜了…下次別再讓他失風就沒戲唱了。")
      );
  }
  const lines = [];
  if (result.escapeCount && result.clearAt) {
    lines.push(`-# 他已躲過 **${result.escapeCount}/${result.clearAt}** 次，躲滿就脫罪。你這次不能再追他了。`);
  }
  lines.push(
    result.cooldownUntil
      ? `-# 他躲起來了，<t:${Math.floor(result.cooldownUntil / 1000)}:R> 之後其他人才能再追捕。`
      : "-# 賞金續留通緝榜，換人再試試看！"
  );
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💨 讓他跑了！\n` +
          `<@${wantedUserId}> 甩開了 <@${hunterId}> 的追捕，躲了起來。\n\n` +
          `攻擊力 ${result.hunterAtk} vs ${result.wantedAtk}`
      )
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
}

module.exports = { errorContainer, infoContainer, huntResultContainer, broadcast };
