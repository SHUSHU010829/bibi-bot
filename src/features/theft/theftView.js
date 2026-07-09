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

// 懸賞通緝令（公開廣播）：報案人出錢把兇手掛上榜，帶「我要追捕」按鈕。
function bountyAnnounceContainer(victimId, culpritId, bounty, expiresAt) {
  const expiresEpoch = Math.floor(expiresAt / 1000);
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎯 懸賞通緝\n` +
          `<@${victimId}> 花錢懸賞捉拿 <@${culpritId}>——他偷了東西還逍遙法外！\n` +
          `賞金 **${bounty.toLocaleString()}** ${COIN_EMOJI}　|　時效 <t:${expiresEpoch}:R>\n` +
          `抓到他就能領走賞金，他無法自首、只能被抓或逃亡——誰要出手？`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`theft_hunt_${culpritId}`)
          .setLabel("我要追捕")
          .setEmoji("🕵️")
          .setStyle(ButtonStyle.Danger)
      )
    );
}

// ── 報案壞事件（偵探出包）：私人 Container + 公開廣播文案 ──
const n = (v) => (v || 0).toLocaleString();

// 每種壞事件的呈現資料：私人標題/內文 + 公開廣播一句話。
const REPORT_BAD_EVENTS = {
  abscond: {
    accent: 0xe67e22,
    heading: "🕵️‍♂️💨 偵探捲款跑路了！",
    detail: (tl, fee) =>
      `你付了 **${n(fee)}** ${COIN_EMOJI} 委託 ${tl}，他拿了錢就人間蒸發…`,
    broadcast: (uid, tl) => `🕵️‍♂️💨 <@${uid}> 委託的 ${tl} 拿了委託金就人間蒸發、捲款跑路了！`,
  },
  bribed: {
    accent: 0xe67e22,
    heading: "🤝💰 偵探被兇手收買了！",
    detail: (tl, fee) =>
      `${tl} 收了你 **${n(fee)}** ${COIN_EMOJI}，卻反過來被兇手買通，回報「查無此人」…`,
    broadcast: (uid, tl) => `🤝💰 <@${uid}> 委託的 ${tl} 被兇手收買，兩手一攤說查無此人！`,
  },
  crooked: {
    accent: 0xe74c3c,
    heading: "🕵️‍♂️🔪 遇到壞人偵探！",
    detail: (tl, fee, extra) =>
      `${tl} 收了你 **${n(fee)}** ${COIN_EMOJI} 委託費，還趁機黑吃黑` +
      (extra > 0
        ? `，從你錢包又捲走 **${n(extra)}** ${COIN_EMOJI}！`
        : "，還好你錢包沒剩多少沒得偷。"),
    broadcast: (uid, tl) => `🕵️‍♂️🔪 <@${uid}> 遇到壞人偵探，委託費之外還被黑吃黑捲走一筆！`,
  },
  arale: {
    accent: 0xe74c3c,
    heading: "🤖⚡ 王牌偵探變身阿拉雷了！",
    detail: (tl, fee, extra) =>
      `你花 **${n(fee)}** ${COIN_EMOJI} 請的 ${tl} 突然大喊「んちゃ——！」變身成阿拉雷，抄起棒子朝你捅——捅——` +
      (extra > 0
        ? `，蹦蹦跳跳捲走 **${n(extra)}** ${COIN_EMOJI} 就跑掉了！`
        : "，還好你錢包空空沒得捅。"),
    broadcast: (uid, tl) => `🤖⚡ <@${uid}> 花大錢請的王牌偵探竟變身阿拉雷，抄棒子把他捅跑了！`,
  },
};

// 報案壞事件（私人 ephemeral）：說明損失 + 兩顆選擇按鈕（試圖逮捕 / 自認倒楣）。
function reportBadEventContainer(event, { tierLabel, fee, extra = 0, ownerId }) {
  const meta = REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond;
  const recoverable = (fee || 0) + (extra || 0);
  const winPct = Math.round((theft?.report?.catch?.winRate ?? 0.5) * 100);
  return new ContainerBuilder()
    .setAccentColor(meta.accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${meta.heading}\n${meta.detail(tierLabel, fee, extra)}`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `這一趟你損失了 **${n(recoverable)}** ${COIN_EMOJI}。要自認倒楣，還是追上去逮捕他？`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`theft_catch_${ownerId}_${event}_${recoverable}`)
          .setLabel(`試圖逮捕他（${winPct}% 討回 ${n(recoverable)}）`)
          .setEmoji("🏃")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`theft_giveup_${ownerId}`)
          .setLabel("自認倒楣")
          .setEmoji("🤷")
          .setStyle(ButtonStyle.Secondary)
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🏃 逮到 → 討回全部 **${n(recoverable)}** ${COIN_EMOJI}；失敗 → 被他反咬一口、再搶走一筆。`
      )
    );
}

// 報案壞事件（公開廣播）：把偵探的糗事推到治安頻道增加趣味。
function reportBadEventBroadcast(event, victimId, tierLabel) {
  const meta = REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond;
  return infoContainer(meta.accent, meta.broadcast(victimId, tierLabel));
}

// 逮捕偵探結果（私人）：討回 / 追丟挨揍。
function reportCatchContainer(event, result) {
  if (result.win) {
    const araleWin =
      event === "arale"
        ? "你死命追上暴走的阿拉雷，"
        : "你追上了那個落跑的偵探，揪著他";
    return new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🏃 逮個正著！\n${araleWin}討回了 **${n(result.recovered)}** ${COIN_EMOJI}！`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 這次沒讓他得逞，委託金全數奉還。")
      );
  }
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        result.penalty > 0
          ? `# 😭 追丟還挨揍\n你沒追上他，反被他反咬一口，又被搶走 **${n(result.penalty)}** ${COIN_EMOJI}…`
          : `# 😭 撲了個空\n你沒追上他，好在錢包空空，他也懶得再踹你一腳。`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 早知道就自認倒楣了…下次找靠譜點的偵探吧。")
    );
}

// 逮捕偵探結果（公開廣播）。
function reportCatchBroadcast(victimId, result) {
  if (result.win) {
    return infoContainer(0xf1c40f, `🏃 <@${victimId}> 追上落跑的偵探，成功討回 **${n(result.recovered)}** ${COIN_EMOJI}！`);
  }
  return infoContainer(
    0x95a5a6,
    result.penalty > 0
      ? `😭 <@${victimId}> 追偵探反被扁，又被搶走 **${n(result.penalty)}** ${COIN_EMOJI}！`
      : `😭 <@${victimId}> 追偵探撲了個空，兩手空空回家。`
  );
}

module.exports = {
  errorContainer,
  infoContainer,
  huntResultContainer,
  broadcast,
  reportBadEventContainer,
  reportBadEventBroadcast,
  reportCatchContainer,
  reportCatchBroadcast,
  fleeChaseContainer,
  fleeOutcomeContainer,
  wantedAnnounceContainer,
  bountyAnnounceContainer,
};
