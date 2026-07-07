const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

// ── 失風追逃小遊戲 ────────────────────────────────────
function riskWord(rate) {
  if (rate < 0.2) return "穩";
  if (rate < 0.45) return "險";
  return "玩命";
}

function progressBar(distance, clear) {
  const filled = Math.max(0, Math.min(clear, distance));
  return "🟧".repeat(filled) + "⬜".repeat(Math.max(0, clear - filled));
}

// 逃亡進行中：進度條 + 各路線風險 + 每條路線一顆按鈕，全部限本人操作。
function fleeChaseContainer(ownerId, token, stage, bounty) {
  const { distance, distanceToClear, routes } = stage;
  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏃 快跑！被發現了\n` +
          `逃亡進度 ${progressBar(distance, distanceToClear)} **${distance}/${distanceToClear}**\n` +
          `躲到終點就**清白脫身**、神不知鬼不覺；被逮才會上通緝榜、凍結賞金 **${bounty.toLocaleString()}** ${COIN_EMOJI}。`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        routes
          .map(
            (r) =>
              `${r.emoji} **${r.name}** — ${riskWord(r.catchRate)}（被逮 ${Math.round(
                r.catchRate * 100
              )}%）· 前進 ${r.advance} 格`
          )
          .join("\n")
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        ...routes.map((r) =>
          new ButtonBuilder()
            .setCustomId(`theft_flee_${ownerId}_${token}_${r.key}`)
            .setLabel(r.name)
            .setEmoji(r.emoji)
            .setStyle(ButtonStyle.Primary)
        )
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 越往後熱度越高、越危險。放著不逃約 10 分鐘後視同沒逃掉，會自動上通緝榜。"
      )
    );
  return container;
}

// 逃亡終局（私人）：清白脫身 / 被逮上榜。
function fleeOutcomeContainer(result) {
  if (result.outcome === "escaped") {
    return new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🕊️ 甩掉追捕，全身而退！\n` +
            `你溜進暗處，沒人知道剛剛是你幹的——**沒上通緝榜、賞金一毛沒扣**。`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 這次算你走運。收手金盆洗手，還是再幹一票？")
      );
  }
  const expiresEpoch = Math.floor((result.expiresAt || Date.now()) / 1000);
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🚔 被逮個正著！\n` +
          `你在「${result.route?.name || "逃亡途中"}」被逮，正式遭全鎮通緝。\n` +
          `頭上賞金 **${result.bounty.toLocaleString()}** ${COIN_EMOJI}（已從你錢包凍結託管）　|　時效 <t:${expiresEpoch}:R>`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 潛伏熬過時效可取回賞金；或撐過 ${Math.round((theft?.surrender?.lockMs ?? 0) / 60000)} 分鐘鎖定期後用 /自首 花保釋金提早脫身。`
      )
    );
}

// 通緝令（公開廣播）：帶「我要追捕」按鈕，逃亡失敗上榜 / 逾時上榜共用。
function wantedAnnounceContainer(userId, bounty, expiresAt) {
  const expiresEpoch = Math.floor(expiresAt / 1000);
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🚨 通緝令\n` +
          `<@${userId}> 偷竊失風、逃亡未果，遭全鎮通緝！\n` +
          `賞金 **${bounty.toLocaleString()}** ${COIN_EMOJI}　|　時效 <t:${expiresEpoch}:R>\n` +
          `抓到他就能領走賞金——誰要出手？`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`theft_hunt_${userId}`)
          .setLabel("我要追捕")
          .setEmoji("🕵️")
          .setStyle(ButtonStyle.Danger)
      )
    );
}

module.exports = {
  errorContainer,
  infoContainer,
  huntResultContainer,
  broadcast,
  fleeChaseContainer,
  fleeOutcomeContainer,
  wantedAnnounceContainer,
};
