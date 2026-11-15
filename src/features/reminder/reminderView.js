const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { DateTime } = require("luxon");

const { reminder: cfg } = require("../../config");
const { TZ } = require("./timeParser");
const service = require("./reminderService");
const { repeatLabel, leadLabel, nagLabel, snoozeLabel } = require("./reminderLabels");

const COLORS = () => cfg?.colors || {};
const MENTION_LIMIT = 30;
const LIST_LIMIT = 25;
// 25 行 × 標題上限 100 字會超過 TextDisplay 的 4000 字，列表裡的標題要截短
const LIST_TITLE_MAX = 40;

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);
const ts = (d, style = "F") => `<t:${unix(d)}:${style}>`;
const occKey = (d) => new Date(d).getTime().toString(36);
const text = (s) => new TextDisplayBuilder().setContent(s);

function plainTime(d) {
  return DateTime.fromJSDate(new Date(d), { zone: TZ() }).setLocale("zh-TW").toFormat("M/d（ccc）HH:mm");
}

function errorContainer(title, detail, hint) {
  const c = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(text(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(detail));
  if (hint) c.addTextDisplayComponents(text(`-# ${hint}`));
  return c;
}

function scheduleLines(rem) {
  const lines = [`🕒 時間：${ts(rem.dueAt)}（${ts(rem.dueAt, "R")}）`];
  if (service.isRepeating(rem)) {
    lines.push(`🔁 重複：${repeatLabel(rem.repeat)}${rem.repeatUntil ? `（到 ${ts(rem.repeatUntil, "D")}）` : ""}`);
  }
  return lines;
}

function participantLines(p) {
  return [`⏰ 提前提醒：${leadLabel(p.leadMinutes)}`, `📣 追加提醒：${nagLabel(p.nagMinutes, p.nagMinutes ? p.nagCount : 0)}`];
}

function listButton(userId) {
  return new ButtonBuilder()
    .setCustomId(`rmd_list_${userId}`)
    .setLabel("我的提醒")
    .setEmoji("📋")
    .setStyle(ButtonStyle.Secondary);
}

function buildCreatedContainer(rem, userId) {
  const p = service.participantOf(rem, userId);
  const c = new ContainerBuilder()
    .setAccentColor(COLORS().personal ?? 0x3498db)
    .addTextDisplayComponents(text(`# ✅ 已設定提醒\n**${rem.title}**`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      text([...scheduleLines(rem), ...participantLines(p), ...(rem.note ? [`📝 ${rem.note}`] : [])].join("\n")),
    )
    .addTextDisplayComponents(text("-# 時間到了我會私訊你。若沒收到，請確認已開啟本伺服器的「允許私人訊息」。"))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rmd_cfg_${userId}_${rem._id}`)
          .setLabel("調整設定")
          .setEmoji("⚙️")
          .setStyle(ButtonStyle.Primary),
        listButton(userId),
      ),
    );
  return c;
}

function buildGroupMessage(rem, state = "active") {
  const participants = rem.participants || [];
  const mentions = participants.slice(0, MENTION_LIMIT).map((p) => `<@${p.userId}>`).join(" ");
  const more = participants.length > MENTION_LIMIT ? ` …等 ${participants.length} 人` : "";
  const color = state === "active" ? COLORS().group ?? 0x9b59b6 : COLORS().muted ?? 0x95a5a6;

  const c = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(text(`# 📢 揪團提醒：${rem.title}${rem.note ? `\n${rem.note}` : ""}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      text(
        [
          ...(state === "active" ? scheduleLines(rem) : [`🕒 時間：${ts(rem.dueAt)}`]),
          `⏰ 預設提前：${leadLabel(rem.defaultLeadMinutes)}`,
          `🙋 發起人：<@${rem.ownerId}>`,
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      text(`👥 已加入（${participants.length} 人）\n${participants.length ? mentions + more : "還沒有人加入"}`),
    );

  if (state === "ended") return c.addTextDisplayComponents(text("-# 🏁 這個揪團提醒已經結束。"));
  if (state === "cancelled") return c.addTextDisplayComponents(text("-# 🗑️ 發起人已取消這個揪團提醒。"));

  return c
    .addTextDisplayComponents(
      text("-# 按「加入提醒」，時間到我會私訊你；「我的設定」可以調整自己的提前時間與追加提醒。"),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rmdg_join_${rem._id}`)
          .setLabel("加入提醒")
          .setEmoji("🙋")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`rmdg_cfg_${rem._id}`)
          .setLabel("我的設定")
          .setEmoji("⚙️")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`rmdg_leave_${rem._id}`)
          .setLabel("退出")
          .setEmoji("👋")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`rmdg_cancel_${rem._id}`)
          .setLabel("取消揪團")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger),
      ),
    );
}

function selectRow(customId, placeholder, choices, current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(
        choices.map((c) => ({ label: c.label, value: String(c.value), default: c.value === current })),
      ),
  );
}

function buildSettingsPanel(rem, userId, notice) {
  const p = service.participantOf(rem, userId);
  const isGroup = rem.kind === service.KIND_GROUP;
  const c = new ContainerBuilder().setAccentColor(
    isGroup ? COLORS().group ?? 0x9b59b6 : COLORS().personal ?? 0x3498db,
  );
  if (notice) c.addTextDisplayComponents(text(notice));
  c.addTextDisplayComponents(text(`# ⚙️ ${isGroup ? "揪團提醒" : "提醒"}：${rem.title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      text(
        [
          ...scheduleLines(rem),
          ...(isGroup ? [`🙋 發起人：<@${rem.ownerId}>・${rem.participants.length} 人參加`] : []),
          ...(rem.note ? [`📝 ${rem.note}`] : []),
        ].join("\n"),
      ),
    );

  if (p && !rem.finished) {
    c.addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(text(`**你的設定**\n${participantLines(p).join("\n")}`))
      .addActionRowComponents(
        selectRow(
          `rmd_lead_${userId}_${rem._id}`,
          "提前提醒",
          (cfg?.leadChoices || []).map((x) => ({ label: x.name, value: x.minutes })),
          p.leadMinutes,
        ),
        selectRow(
          `rmd_nag_${userId}_${rem._id}`,
          "到點後追加提醒（直到按完成）",
          (cfg?.nagChoices || []).map((x) => ({ label: x.name, value: x.minutes })),
          p.nagMinutes,
        ),
      );
    if (p.nagMinutes > 0) {
      const max = cfg?.maxNagCount || 10;
      c.addActionRowComponents(
        selectRow(
          `rmd_nagn_${userId}_${rem._id}`,
          "最多追加幾次",
          Array.from({ length: max }, (_, i) => ({ label: `最多追加 ${i + 1} 次`, value: i + 1 })),
          p.nagCount,
        ),
      );
    }
  } else if (rem.finished) {
    c.addTextDisplayComponents(text("-# 🏁 這個提醒已經結束。"));
  } else {
    c.addTextDisplayComponents(text("-# 你還沒加入這個揪團提醒，按揪團訊息上的「加入提醒」就能加入。"));
  }

  const buttons = [];
  if (!isGroup) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`rmd_del_${userId}_${rem._id}`)
        .setLabel("刪除提醒")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    if (p) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`rmd_leave_${userId}_${rem._id}`)
          .setLabel("退出揪團")
          .setEmoji("👋")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (rem.ownerId === userId) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`rmd_cancel_${userId}_${rem._id}`)
          .setLabel("取消揪團")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger),
      );
    }
  }
  buttons.push(listButton(userId));
  return c.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
}

function buildListContainer(rems, userId) {
  const c = new ContainerBuilder().setAccentColor(COLORS().personal ?? 0x3498db);
  if (!rems.length) {
    return c
      .addTextDisplayComponents(text("# 📋 我的提醒"))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(text("你目前沒有任何進行中的提醒。"))
      .addTextDisplayComponents(
        text("-# 用 `/提醒 新增` 設定個人提醒，或用 `/提醒 揪團` 發起大家都能加入的活動提醒。"),
      );
  }

  const shown = rems.slice(0, LIST_LIMIT);
  const lines = shown.map((r, i) => {
    const icon = r.kind === service.KIND_GROUP ? "📢" : "🔔";
    const repeat = service.isRepeating(r) ? `・🔁 ${repeatLabel(r.repeat)}` : "";
    const title = r.title.length > LIST_TITLE_MAX ? `${r.title.slice(0, LIST_TITLE_MAX)}…` : r.title;
    return `**${i + 1}.** ${icon} ${title} — ${ts(r.dueAt, "f")}（${ts(r.dueAt, "R")}）${repeat}`;
  });
  c.addTextDisplayComponents(text(`# 📋 我的提醒（${rems.length}）`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(lines.join("\n")));
  if (rems.length > LIST_LIMIT) {
    c.addTextDisplayComponents(text(`-# 只顯示最近的 ${LIST_LIMIT} 個。`));
  }
  return c
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`rmd_pick_${userId}`)
          .setPlaceholder("選一個提醒來調整 / 刪除 / 退出")
          .addOptions(
            shown.map((r, i) => ({
              label: `${i + 1}. ${r.title}`.slice(0, 100),
              description: `${r.kind === service.KIND_GROUP ? "揪團・" : ""}${plainTime(r.dueAt)}${
                service.isRepeating(r) ? `・${repeatLabel(r.repeat)}` : ""
              }`.slice(0, 100),
              value: String(r._id),
              emoji: r.kind === service.KIND_GROUP ? "📢" : "🔔",
            })),
          ),
      ),
    )
    .addTextDisplayComponents(text("-# 🔔 個人提醒・📢 揪團提醒"));
}

function deliveryTitle(d) {
  if (d.kind === "lead") return `# ⏰ 即將到來：${d.reminder.title}`;
  if (d.kind === "nag") return `# 🔔 追加提醒（${d.nagIndex}/${d.nagTotal}）：${d.reminder.title}`;
  return `# 🔔 ${d.snoozed ? "延後提醒" : "提醒"}：${d.reminder.title}`;
}

// d：reminderService.processJob 回傳的 deliver 物件。
// status 有值 → 已處理（完成 / 延後…），拿掉按鈕只留狀態列。
function buildDeliveryContainer(d, { status, fallback, guildName } = {}) {
  const rem = d.reminder;
  const userId = d.participant.userId;
  const color =
    d.kind === "lead" ? COLORS().lead : d.kind === "nag" ? COLORS().nag : COLORS().due;
  const c = new ContainerBuilder().setAccentColor(status ? COLORS().done ?? 0x57f287 : color ?? 0xe67e22);

  if (fallback) c.addTextDisplayComponents(text(`<@${userId}> 私訊傳不到你，改在這裡提醒～`));
  const info = [`🕒 ${ts(d.occurrenceAt)}（${ts(d.occurrenceAt, "R")}）`];
  if (rem.kind === service.KIND_GROUP) {
    info.push(`📢 揪團提醒・發起人 <@${rem.ownerId}>${guildName ? `・${guildName}` : ""}`);
  } else if (guildName) {
    info.push(`🏠 ${guildName}`);
  }
  if (rem.note) info.push(`📝 ${rem.note}`);
  const next = service.nextOccurrence(rem, d.occurrenceAt);
  if (next) info.push(`🔁 下一次：${ts(next.at, "f")}（${repeatLabel(rem.repeat)}）`);

  c.addTextDisplayComponents(text(deliveryTitle(d)))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(info.join("\n")));

  if (status) return c.addTextDisplayComponents(text(`-# ${status}`));

  const key = `${userId}_${rem._id}_${occKey(d.occurrenceAt)}`;
  const buttons = [];
  if (d.kind === "lead") {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`rmd_skip_${key}`)
        .setLabel("這次不用提醒")
        .setEmoji("🔕")
        .setStyle(ButtonStyle.Secondary),
    );
  } else {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`rmd_done_${key}`)
        .setLabel("完成")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      ...(cfg?.snoozeChoices || []).slice(0, 2).map((s) =>
        new ButtonBuilder()
          .setCustomId(`rmd_snz_${key}_${s.minutes}`)
          .setLabel(snoozeLabel(s.minutes))
          .setEmoji("💤")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  if (service.isRepeating(rem) || rem.kind === service.KIND_GROUP) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`rmd_stop_${key}`)
        .setLabel(rem.kind === service.KIND_GROUP ? "退出揪團" : "不再提醒")
        .setEmoji("🛑")
        .setStyle(ButtonStyle.Danger),
    );
  }
  if (d.nagTotal > 0 && d.kind !== "lead" && d.nagIndex < d.nagTotal) {
    c.addTextDisplayComponents(text("-# 按「完成」之前我會繼續追加提醒你。"));
  }
  return c.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
}

module.exports = {
  errorContainer,
  buildCreatedContainer,
  buildGroupMessage,
  buildSettingsPanel,
  buildListContainer,
  buildDeliveryContainer,
  ts,
};
