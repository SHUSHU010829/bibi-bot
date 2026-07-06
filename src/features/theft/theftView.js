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

// ── /潛逃 追逃小遊戲 ──────────────────────────────────
function riskWord(rate) {
  if (rate < 0.2) return "穩";
  if (rate < 0.45) return "險";
  return "玩命";
}

function progressBar(distance, clear) {
  const filled = Math.max(0, Math.min(clear, distance));
  return "🟧".repeat(filled) + "⬜".repeat(Math.max(0, clear - filled));
}

function stopRefundAmount(bounty, distance) {
  const e = theft?.escapeRun || {};
  const pct = Math.min(
    (e.stopRefundBasePct ?? 0.35) + distance * (e.stopRefundPerDistance ?? 0.1),
    e.stopRefundMaxPct ?? 0.8
  );
  return Math.floor(bounty * pct);
}

// 逃亡進行中：進度條 + 各路線風險 + 每條路線一顆按鈕（+ 收手），全部限本人操作。
function fleeChaseContainer(ownerId, token, stage, bounty) {
  const { distance, distanceToClear, routes } = stage;
  const stopRefund = stopRefundAmount(bounty, distance);
  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏃 逃亡中…\n` +
          `躲藏進度 ${progressBar(distance, distanceToClear)} **${distance}/${distanceToClear}**\n` +
          `託管賞金 **${bounty.toLocaleString()}** ${COIN_EMOJI}　躲到終點就全額拿回！`
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
    );

  const routeRow = new ActionRowBuilder().addComponents(
    ...routes.map((r) =>
      new ButtonBuilder()
        .setCustomId(`theft_flee_${ownerId}_${token}_${r.key}`)
        .setLabel(r.name)
        .setEmoji(r.emoji)
        .setStyle(ButtonStyle.Primary)
    )
  );
  container.addActionRowComponents(routeRow);

  if (distance >= 1) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`theft_flee_${ownerId}_${token}_stop`)
          .setLabel(`躲起來收手（拿回 ${stopRefund.toLocaleString()}）`)
          .setEmoji("🛑")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 被逮 → 賞金全數充公；躲得越遠、收手拿回越多。越往後熱度越高、越危險。"
    )
  );
  return container;
}

// 逃亡終局（私人）：脫身 / 收手 / 落網。
function fleeOutcomeContainer(result) {
  if (result.outcome === "clear") {
    return new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🕊️ 甩掉追捕，逍遙法外！\n` +
            `你一路躲到終點，通緝解除，託管賞金 **${result.bounty.toLocaleString()}** ${COIN_EMOJI} 全額入袋！`
        )
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 惡名下降了一些。這波賭對了。"));
  }
  if (result.outcome === "stop") {
    return new ContainerBuilder()
      .setAccentColor(0x3498db)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🫥 躲好了，通緝解除\n` +
            `你見好就收，拿回 **${result.refund.toLocaleString()}** ${COIN_EMOJI}` +
            (result.forfeit > 0
              ? `，沒收 **${result.forfeit.toLocaleString()}** ${COIN_EMOJI} 進治安基金。`
              : "。")
        )
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 再往前躲能拿回更多，但風險也更高。"));
  }
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🚔 逃亡失敗，當場落網！\n` +
          `你在「${result.route?.name || "逃亡途中"}」被逮個正著，託管賞金 **${result.bounty.toLocaleString()}** ${COIN_EMOJI} 全數充公進治安基金。`
      )
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 惡名又漲了。貪心的代價…"));
}

// 逃亡終局（公開廣播）：全鎮看熱鬧。
function fleeBroadcastContainer(userId, result) {
  if (result.outcome === "clear") {
    return infoContainer(
      0x2ecc71,
      `# 🕊️ 通緝解除\n<@${userId}> 一路狂奔甩掉所有追兵，逍遙法外、拿回賞金！`
    );
  }
  if (result.outcome === "stop") {
    return infoContainer(
      0x3498db,
      `# 🫥 通緝解除\n<@${userId}> 見好就收躲了起來，繳了部分賞金換清白。`
    );
  }
  return infoContainer(
    0xe74c3c,
    `# 🚔 落網！\n<@${userId}> 逃亡途中當場被逮，賞金全數充公進治安基金。`
  );
}

module.exports = {
  errorContainer,
  infoContainer,
  huntResultContainer,
  broadcast,
  fleeChaseContainer,
  fleeOutcomeContainer,
  fleeBroadcastContainer,
};
