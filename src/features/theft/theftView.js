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

// ── 看門狗被引開（沒擋下時的私人 flavor，只有小偷看得到）──
const WATCHDOG_DISTRACTIONS = {
  lured: "🍖 你丟了根骨頭把看門狗引開，趁牠低頭啃食時得手！",
  asleep: "💤 看門狗正趴著打盹，你躡手躡腳摸了進去！",
  chase: "🐈 看門狗追野貓去了，你趁牠不在偷偷下手！",
};
function watchdogDistractionLine(event) {
  return WATCHDOG_DISTRACTIONS[event] || WATCHDOG_DISTRACTIONS.lured;
}

// ── 報案壞事件（偵探出包）：私人 Container + 公開廣播文案 ──
const n = (v) => (v || 0).toLocaleString();

const STYLE = {
  Danger: ButtonStyle.Danger,
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
};

// 反擊型事件（走 catchDetective 的 50% 賭一把，各事件換皮）共用的兩顆按鈕
function catchChoices(ctx, m) {
  return [
    {
      action: "catch",
      emoji: m.action.emoji,
      style: "Danger",
      label: `${m.action.verb}（${ctx.winPct}% 討回 ${n(ctx.recoverable)}）`,
      amount: ctx.recoverable,
    },
    { action: "giveup", emoji: m.giveup.emoji, style: "Secondary", label: m.giveup.label, amount: 0 },
  ];
}

// 每種壞事件的呈現資料：私人標題/內文、公開廣播、prompt、以及 choices（二選一按鈕）。
const REPORT_BAD_EVENTS = {
  abscond: {
    accent: 0xe67e22,
    heading: "🕵️‍♂️💨 偵探捲款跑路了！",
    detail: (tl, fee) => `你付了 **${n(fee)}** ${COIN_EMOJI} 委託 ${tl}，他拿了錢就人間蒸發…`,
    broadcast: (uid, tl) => `🕵️‍♂️💨 <@${uid}> 委託的 ${tl} 拿了委託金就人間蒸發、捲款跑路了！`,
    prompt: "要摸摸鼻子認了，還是追上去逮他？",
    action: {
      emoji: "🏃",
      verb: "追上去逮他",
      winHead: "🏃 逮個正著！",
      win: (rec) => `你死命追上落跑的偵探，揪著他討回了 **${n(rec)}** ${COIN_EMOJI}！`,
      loseHead: "😭 追丟還挨揍",
      lose: (pen) => `你沒追上他，半路反被剪徑，又被搶走 **${n(pen)}** ${COIN_EMOJI}…`,
      loseZero: "你沒追上他，好在錢包空空，他也懶得再踹你一腳。",
      bcWin: (uid, rec) => `🏃 <@${uid}> 追上落跑的偵探，成功討回 **${n(rec)}** ${COIN_EMOJI}！`,
      bcLose: (uid, pen) =>
        pen > 0
          ? `😭 <@${uid}> 追偵探反被剪徑，又被搶走 **${n(pen)}** ${COIN_EMOJI}！`
          : `😭 <@${uid}> 追偵探撲了個空，兩手空空回家。`,
    },
    giveup: { emoji: "🤷", label: "自認倒楣", head: "🤷 算了，自認倒楣", body: "你摸摸鼻子，把這筆委託金當作繳學費。" },
    choices: catchChoices,
  },
  bribed: {
    accent: 0xe67e22,
    heading: "🤝💰 偵探被兇手收買了！",
    detail: (tl, fee) =>
      `${tl} 收了你 **${n(fee)}** ${COIN_EMOJI}，卻反過來被兇手買通，回報「查無此人」…`,
    broadcast: (uid, tl) => `🤝💰 <@${uid}> 委託的 ${tl} 被兇手收買，兩手一攤說查無此人！`,
    prompt: "要嚥下這口氣，還是當場拆穿這個雙面偵探？",
    action: {
      emoji: "🔨",
      verb: "拆穿雙面偵探",
      winHead: "🔨 當場拆穿！",
      win: (rec) => `你抓到他收買的把柄，逼這個雙面偵探把 **${n(rec)}** ${COIN_EMOJI} 全吐了出來！`,
      loseHead: "😤 反被倒打一耙",
      lose: (pen) => `他惱羞成怒、反咬你誣賴，你摸摸鼻子又賠了 **${n(pen)}** ${COIN_EMOJI}…`,
      loseZero: "他惱羞成怒，好在你錢包空空，訛不到什麼。",
      bcWin: (uid, rec) => `🔨 <@${uid}> 當場拆穿被收買的偵探，逼他吐回 **${n(rec)}** ${COIN_EMOJI}！`,
      bcLose: (uid, pen) =>
        pen > 0
          ? `😤 <@${uid}> 想拆穿偵探，反被倒打一耙又賠 **${n(pen)}** ${COIN_EMOJI}！`
          : `😤 <@${uid}> 想拆穿偵探，鬧了個沒趣。`,
    },
    giveup: { emoji: "😮‍💨", label: "算了認栽", head: "😮‍💨 算了認栽", body: "你嚥下這口氣，錢就當花錢消災。" },
    choices: catchChoices,
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
    prompt: "要自認倒楣，還是當場跟他翻臉討回來？",
    action: {
      emoji: "🗡️",
      verb: "當場翻臉討錢",
      winHead: "🗡️ 討回公道！",
      win: (rec) => `你當場翻臉，逼這個爛偵探把 **${n(rec)}** ${COIN_EMOJI} 全數吐回來！`,
      loseHead: "🩸 反被打劫",
      lose: (pen) => `打不過他，反被狠狠打劫，又被搶走 **${n(pen)}** ${COIN_EMOJI}…`,
      loseZero: "打不過他，好在錢包空空，他也搜刮不到。",
      bcWin: (uid, rec) => `🗡️ <@${uid}> 跟壞人偵探翻臉，硬是討回 **${n(rec)}** ${COIN_EMOJI}！`,
      bcLose: (uid, pen) =>
        pen > 0
          ? `🩸 <@${uid}> 跟壞人偵探翻臉，反被打劫又搶走 **${n(pen)}** ${COIN_EMOJI}！`
          : `🩸 <@${uid}> 跟壞人偵探翻臉，討了個沒趣。`,
    },
    giveup: { emoji: "🤷", label: "自認倒楣", head: "🤷 算了，自認倒楣", body: "惹不起躲得起，你摸摸鼻子走人。" },
    choices: catchChoices,
  },
  arale: {
    accent: 0xe74c3c,
    heading: "🤖⚡ 王牌偵探變身阿拉蕾了！",
    detail: (tl, fee, extra) =>
      `你花 **${n(fee)}** ${COIN_EMOJI} 請的 ${tl} 突然大喊「んちゃ——！」變身成阿拉蕾，抄起棒子朝你捅——捅——` +
      (extra > 0
        ? `，蹦蹦跳跳捲走 **${n(extra)}** ${COIN_EMOJI} 就跑掉了！`
        : "，還好你錢包空空沒得捅。"),
    broadcast: (uid, tl) => `🤖⚡ <@${uid}> 花大錢請的王牌偵探竟變身阿拉蕾，抄棒子把他捅跑了！`,
    prompt: "要拔腿就跑，還是想辦法哄住這隻暴走的機器娃娃？",
    action: {
      emoji: "🍡",
      verb: "拿零食哄她",
      winHead: "🍡 哄住她了！",
      win: (rec) => `你塞了零食給阿拉蕾，她開心地「んちゃ！」把 **${n(rec)}** ${COIN_EMOJI} 還你了！`,
      loseHead: "🤖 她玩瘋了",
      lose: (pen) => `阿拉蕾玩瘋了，抄起棒子又把你捅了一頓，再捲走 **${n(pen)}** ${COIN_EMOJI}…`,
      loseZero: "阿拉蕾玩瘋了，好在你錢包空空沒得捅。",
      bcWin: (uid, rec) => `🍡 <@${uid}> 拿零食哄住暴走的阿拉蕾，把 **${n(rec)}** ${COIN_EMOJI} 討了回來！`,
      bcLose: (uid, pen) =>
        pen > 0
          ? `🤖 <@${uid}> 想哄阿拉蕾，反被她玩瘋捅走 **${n(pen)}** ${COIN_EMOJI}！`
          : `🤖 <@${uid}> 想哄阿拉蕾，被她蹦蹦跳跳耍著玩。`,
    },
    giveup: { emoji: "😱", label: "拔腿就跑", head: "😱 拔腿就跑", body: "惹不起這隻機器娃娃，你頭也不回地開溜。" },
    choices: catchChoices,
  },
  selfheist: {
    accent: 0x8e44ad,
    heading: "🕳️🔍 監守自盜！",
    detail: (tl, fee) =>
      `你花 **${n(fee)}** ${COIN_EMOJI} 委託 ${tl} 查案，查到最後線索全指向他自己——原來偷你的就是這位偵探！`,
    broadcast: (uid, tl) => `🕳️ <@${uid}> 委託的 ${tl} 查到最後，兇手竟然就是偵探自己！`,
    prompt: "要報警把這個賊偵探抓起來，還是乾脆收編他當你的內應？",
    choices: (ctx) => [
      { action: "shreport", emoji: "📢", style: "Danger", label: `報警抓他（${ctx.winPct}% 討回+獎金）`, amount: ctx.fee },
      { action: "shrecruit", emoji: "🤝", style: "Primary", label: "收編當內應（下次報案免費）", amount: 0 },
    ],
  },
  gambler: {
    accent: 0x16a085,
    heading: "🎰 你遇到賭徒偵探！",
    detail: (tl, fee) =>
      `${tl} 收了你 **${n(fee)}** ${COIN_EMOJI}，卻眼睛發亮地說：「與其查案，不如來賭一把？」`,
    broadcast: (uid, tl) => `🎰 <@${uid}> 遇到賭徒偵探，被慫恿拿委託費賭一把！`,
    prompt: "要跟他賭運氣，還是叫他別鬧、把錢還來？",
    choices: (ctx) => [
      { action: "bet", emoji: "🎲", style: "Danger", label: `跟他賭（${ctx.winPct}% 委託費雙倍）`, amount: ctx.fee },
      { action: "betskip", emoji: "🚶", style: "Secondary", label: "不賭，退我錢", amount: ctx.fee },
    ],
  },
  misid: {
    accent: 0xe67e22,
    heading: "🐛 偵探抓錯人了！",
    detail: (tl, fee, extra, accused) =>
      `${tl} 收了你 **${n(fee)}** ${COIN_EMOJI}，信誓旦旦指認兇手是 ${accused ? `<@${accused}>` : "一個查無此人的路人"}——但你很清楚他根本沒偷你…`,
    broadcast: (uid, tl, accused) =>
      `🐛 <@${uid}> 委託的 ${tl} 亂指一通，一口咬定 ${accused ? `<@${accused}>` : "某個路人"} 是兇手！`,
    prompt: "要將錯就錯叫偵探硬辦他，還是道個歉放人？",
    choices: (ctx) => [
      { action: "frame", emoji: "🤥", style: "Danger", label: "將錯就錯辦他", amount: ctx.fee },
      { action: "apolo", emoji: "🙏", style: "Secondary", label: "道歉放人", amount: ctx.fee },
    ],
  },
};

function catchWinPct() {
  return Math.round((theft?.report?.catch?.winRate ?? 0.5) * 100);
}

// 報案壞事件（私人 ephemeral）：標題/內文 + 該事件專屬的兩顆選項按鈕。
function reportBadEventContainer(event, { tierLabel, fee, extra = 0, ownerId, accused = null }) {
  const meta = REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond;
  const recoverable = (fee || 0) + (extra || 0);
  const ctx = { fee: fee || 0, extra: extra || 0, recoverable, winPct: catchWinPct() };
  const buttons = meta.choices(ctx, meta).map((ch) =>
    new ButtonBuilder()
      .setCustomId(`theft_ev_${ch.action}_${ownerId}_${event}_${ch.amount}`)
      .setLabel(ch.label)
      .setEmoji(ch.emoji)
      .setStyle(STYLE[ch.style] || ButtonStyle.Secondary)
  );
  return new ContainerBuilder()
    .setAccentColor(meta.accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${meta.heading}\n${meta.detail(tierLabel, fee, extra, accused)}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(meta.prompt))
    .addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
}

// 報案壞事件（公開廣播）：把偵探的糗事推到治安頻道增加趣味。
function reportBadEventBroadcast(event, victimId, tierLabel, accused = null) {
  const meta = REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond;
  return infoContainer(meta.accent, meta.broadcast(victimId, tierLabel, accused));
}

// 反擊結果（私人）：討回 / 反被坑，文案依事件換皮。
function reportCatchContainer(event, result) {
  const a = (REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond).action;
  if (result.win) {
    return new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${a.winHead}\n${a.win(result.recovered)}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 這次沒讓他得逞，損失全數討回。")
      );
  }
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        result.penalty > 0 ? `# ${a.loseHead}\n${a.lose(result.penalty)}` : `# 😭 撲了個空\n${a.loseZero}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 早知道就別逞強…下次找靠譜點的偵探吧。")
    );
}

// 反擊結果（公開廣播），文案依事件換皮。
function reportCatchBroadcast(event, victimId, result) {
  const a = (REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond).action;
  return infoContainer(
    result.win ? 0xf1c40f : 0x95a5a6,
    result.win ? a.bcWin(victimId, result.recovered) : a.bcLose(victimId, result.penalty)
  );
}

// 認賠退場（私人），文案依事件換皮。
function reportGiveupContainer(event) {
  const g = (REPORT_BAD_EVENTS[event] || REPORT_BAD_EVENTS.abscond).giveup;
  return infoContainer(0x95a5a6, `# ${g.head}\n${g.body}`);
}

// ── 監守自盜「報警抓他」──
function reportSelfHeistContainer(result) {
  if (result.win) {
    return new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🚔 賊偵探落網！\n你報了警，人贓俱獲，討回委託費還領到獎金，共入袋 **${n(result.recovered)}** ${COIN_EMOJI}！`
        )
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 大快人心，這種偵探就該關起來。"));
  }
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        result.penalty > 0
          ? `# 🏃 讓他跑了\n他早有準備，反手誣賴你，你又被搜刮 **${n(result.penalty)}** ${COIN_EMOJI}…`
          : `# 🏃 讓他跑了\n他溜得比誰都快，好在你錢包空空沒得訛。`
      )
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 監守自盜的老油條，跑起來也專業。"));
}
function reportSelfHeistBroadcast(victimId, result) {
  return infoContainer(
    result.win ? 0xf1c40f : 0x95a5a6,
    result.win
      ? `🚔 <@${victimId}> 報警逮到監守自盜的賊偵探，入袋 **${n(result.recovered)}** ${COIN_EMOJI}！`
      : result.penalty > 0
        ? `🏃 <@${victimId}> 想抓賊偵探反被誣賴，又被搜刮 **${n(result.penalty)}** ${COIN_EMOJI}！`
        : `🏃 <@${victimId}> 想抓賊偵探，被他溜了。`
  );
}

// ── 監守自盜「收編當內應」──
function reportRecruitContainer() {
  return infoContainer(
    0x2ecc71,
    "# 🤝 收編成功！\n你把這個賊偵探收編成內應，他答應**下次 `/報案` 免費**幫你查——以後有他罩著，查案不出包。"
  );
}

// ── 賭徒偵探「跟他賭」──
function reportGambleContainer(result) {
  if (result.win) {
    return new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🎲 賭贏了！\n偵探大手一揮，委託費雙倍奉還，你拿回 **${n(result.payout)}** ${COIN_EMOJI}！`
        )
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 手氣正旺，見好就收。"));
  }
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🎲 賭輸了…\n偵探摸走你的委託費揚長而去，血本無歸。")
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 賭博一時爽…下次還是乖乖查案吧。"));
}
function reportGambleBroadcast(victimId, result) {
  return infoContainer(
    result.win ? 0xf1c40f : 0x95a5a6,
    result.win
      ? `🎲 <@${victimId}> 跟賭徒偵探賭一把，委託費雙倍入袋 **${n(result.payout)}** ${COIN_EMOJI}！`
      : `🎲 <@${victimId}> 跟賭徒偵探賭一把，血本無歸！`
  );
}

// ── 賭徒偵探「不賭」──
function reportGambleSkipContainer(result) {
  return infoContainer(
    0x95a5a6,
    `# 🚶 不賭\n你叫偵探別鬧，他摸摸鼻子把 **${n(result.refunded)}** ${COIN_EMOJI} 委託費退你了。`
  );
}

// ── 抓錯人「將錯就錯 / 道歉放人」──
function reportMisidContainer(result) {
  if (result.kind === "frame") {
    return new ContainerBuilder()
      .setAccentColor(0x95a5a6)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🤥 將錯就錯\n你再塞了 **${n(result.cost)}** ${COIN_EMOJI} 叫偵探硬辦那個無辜的人，結果查無實據、錢照樣打了水漂。`
        )
      )
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 冤枉好人不會有好報的啦。"));
  }
  return infoContainer(
    0x2ecc71,
    `# 🙏 道歉放人\n你付了 **${n(result.cost)}** ${COIN_EMOJI} 名譽費向對方賠不是，把人放了。`
  );
}
function reportMisidBroadcast(victimId, result) {
  return infoContainer(
    0x95a5a6,
    result.kind === "frame"
      ? `🤥 <@${victimId}> 將錯就錯要偵探硬辦無辜的人，又白花 **${n(result.cost)}** ${COIN_EMOJI}！`
      : `🙏 <@${victimId}> 為偵探的烏龍向人賠罪，付了 **${n(result.cost)}** ${COIN_EMOJI} 名譽費。`
  );
}

// ── 釣魚執法（好事件・終局・私人）──
function reportFishingContainer({ stingLeft }) {
  return new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# 🎣 釣魚執法！\n偵探這次沒揪出兇手，但幫你在錢包周圍布下陷阱——**下一個偷你的人會當場失風被通緝**！"
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 目前陷阱數：**${stingLeft}**。守株待兔，就等賊上門。`)
    );
}
function reportFishingBroadcast(victimId) {
  return infoContainer(
    0x2ecc71,
    `🎣 <@${victimId}> 的偵探設下釣魚執法陷阱，下個手癢的小偷準備當場失風吧！`
  );
}

// ── 偵探喝掛（壞事件・終局・無選擇・私人）──
function reportDrunkContainer({ refunded }) {
  return new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# 🍺 偵探喝掛了…\n你的偵探跑去喝到不省人事，案子沒查成" +
          (refunded > 0 ? `，酒醒後良心發現退你 **${n(refunded)}** ${COIN_EMOJI}。` : "。")
      )
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 下次找個清醒點的偵探吧。"));
}
function reportDrunkBroadcast(victimId) {
  return infoContainer(0xe67e22, `🍺 <@${victimId}> 委託的偵探喝到不省人事，案子直接辦砸！`);
}

module.exports = {
  errorContainer,
  infoContainer,
  huntResultContainer,
  watchdogDistractionLine,
  broadcast,
  reportBadEventContainer,
  reportBadEventBroadcast,
  reportCatchContainer,
  reportCatchBroadcast,
  reportGiveupContainer,
  reportSelfHeistContainer,
  reportSelfHeistBroadcast,
  reportRecruitContainer,
  reportGambleContainer,
  reportGambleBroadcast,
  reportGambleSkipContainer,
  reportMisidContainer,
  reportMisidBroadcast,
  reportFishingContainer,
  reportFishingBroadcast,
  reportDrunkContainer,
  reportDrunkBroadcast,
  fleeChaseContainer,
  fleeOutcomeContainer,
  wantedAnnounceContainer,
  bountyAnnounceContainer,
};
