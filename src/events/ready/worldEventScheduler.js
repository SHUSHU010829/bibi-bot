require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const config = require("../../config");
const worldEventService = require("../../features/world_event/worldEventService");
const worldEventBuffs = require("../../features/world_event/worldEventBuffs");
const { formatBuff } = require("../../features/buff/buffLabels");
const { itemLabel } = require("../../features/world_event/worldEventItems");

const eventDef = (id) => worldEventService.eventDef(id);

const COLOR_OPEN = 0xf1c40f;
const COLOR_BUFF = 0x2ecc71;
const COLOR_END = 0x95a5a6;
const COLOR_FAIL = 0xe74c3c;

function resolveChannelId() {
  return config?.worldEvents?.announceChannelId
    || config?.guildClub?.announce?.channelIdOverride
    || config?.announceChannelId
    || "";
}

function resolveRoleId() {
  return config?.worldEvents?.announceRoleId || "";
}

// 在 Components v2 訊息中加入 role mention：把 <@&ID> 放進 TextDisplay 並
// 在 send 時帶 allowedMentions.roles 才會真的 ping（否則只顯示文字不通知）。
function prependRoleMention(container, roleId) {
  if (!roleId) return container;
  // 直接 mutate components 陣列：把第一個 TextDisplay 內容前面加上 ping
  const comps = container.components || [];
  for (const comp of comps) {
    if (comp.data?.type === 10 /* TextDisplay */ || comp.constructor?.name === "TextDisplayBuilder") {
      const current = comp.data?.content || "";
      comp.setContent(`<@&${roleId}>\n${current}`);
      return container;
    }
  }
  return container;
}

async function claimAnnounce(client, eventDbId, phase) {
  if (!client.worldEventAnnouncementsCollection) return false;
  try {
    await client.worldEventAnnouncementsCollection.insertOne({
      event_db_id: eventDbId,
      phase,
      created_at: new Date(),
    });
    return true;
  } catch (e) {
    if (e?.code === 11000) return false;
    return false;
  }
}

function buildOpenContainer(event) {
  const c = new ContainerBuilder().setAccentColor(event.color || COLOR_OPEN);
  const def = eventDef(event.event_id) || {};
  const mainline = event.kind === "mainline";
  const daily = event.daily_limits || {};
  const reqLines = Object.entries(event.requirements_remaining || {})
    .map(([k, v]) => {
      const limit = daily[k];
      return (
        `• ${itemLabel(k)} 0 / ${(v || 0).toLocaleString()}`
        + (limit ? `　-# 每人每日上限 ${limit.toLocaleString()}` : "")
      );
    })
    .join("\n");
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ${event.emoji || "🌍"} ${mainline ? "主線活動開啟" : "世界事件開啟"}：${event.label}\n${event.description || ""}`
    )
  );
  // 先講「達標後拿得到什麼」再講「要交什麼」——沒有這段，玩家只看得到成本。
  // 文案與達標公告共用 completion.lines，避免兩邊各寫一份而改到不一致。
  const unlockLines = def.completion?.lines || [];
  if (unlockLines.length) {
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🎁 **達標後全服永久解鎖**\n${unlockLines.join("\n")}\n` +
          `-# 這些是永久開放，不是限時 buff。`
      )
    );
  }
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**徵集需求：**\n${reqLines}\n\n` +
        `截止時間：<t:${Math.floor(new Date(event.ends_at).getTime() / 1000)}:R>`
    )
  );
  // 主線需要拓荒錘才捐得了，不在開場講的話玩家會直接撞到「還沒有拓荒錘」
  if (def.entryRequirement) {
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🔨 **參加前置**\n${def.entryRequirement}`)
    );
  }
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`we_view|${event.event_db_id}`)
        .setLabel(`查看事件 / 捐獻`)
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Primary)
    )
  );
  return c;
}

function buildBuffStartContainer(event) {
  const c = new ContainerBuilder().setAccentColor(COLOR_BUFF);
  // 主線活動給的是永久解鎖、不是會過期的 buff，rewards.buffs 是空的。
  // 沿用一般事件的「全服 buff 啟動 / 持續至 X」會印出空白區塊而且語意也錯。
  const completion = eventDef(event.event_id)?.completion;
  if (completion) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ ${event.emoji || "🌍"} ${event.label} 達標！\n## ${completion.title}`
      )
    );
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent((completion.lines || []).join("\n"))
    );
    if (completion.footer) {
      c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${completion.footer}`)
      );
    }
    return c;
  }

  const buffLines = Object.entries(event.rewards?.buffs || {})
    .map(([k, v]) => `• ${formatBuff(k, v)}`)
    .join("\n");
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ✅ ${event.emoji || "🌍"} ${event.label} 達標！全服 buff 啟動`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**全伺服器 buff：**\n${buffLines}\n\n` +
        `持續至 <t:${Math.floor(new Date(event.ends_at).getTime() / 1000)}:R>`
    )
  );
  return c;
}

// 整體進度取各項需求完成率的平均：主線同時要鐵礦與逼幣，只看其中一項會誤導。
function overallProgressPct(event) {
  const totals = Object.entries(event.requirements_total || {});
  if (!totals.length) return 0;
  const sum = totals.reduce((acc, [k, total]) => {
    if (!total) return acc + 1;
    const remain = (event.requirements_remaining || {})[k] || 0;
    return acc + Math.max(0, Math.min(1, (total - remain) / total));
  }, 0);
  return Math.floor((sum / totals.length) * 100);
}

function buildMilestoneContainer(event, milestone) {
  const c = new ContainerBuilder().setAccentColor(event.color || COLOR_OPEN);
  const lines = Object.entries(event.requirements_total || {})
    .map(([k, total]) => {
      const remain = (event.requirements_remaining || {})[k] || 0;
      const filled = total - remain;
      const ratio = total ? Math.max(0, Math.min(1, filled / total)) : 1;
      const on = Math.round(ratio * 12);
      return `• ${itemLabel(k)}　${filled.toLocaleString()} / ${total.toLocaleString()}\n`
        + `\`${"█".repeat(on)}${"░".repeat(12 - on)} ${Math.floor(ratio * 100)}%\``;
    })
    .join("\n");
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ${event.emoji || "🌍"} ${event.label} 進度 ${milestone}%`,
    ),
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`we_view|${event.event_db_id}`)
        .setLabel("查看事件 / 捐獻")
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Primary),
    ),
  );
  return c;
}

function buildEndContainer(event, kind) {
  const c = new ContainerBuilder().setAccentColor(
    kind === "buff_ended" ? COLOR_END : COLOR_FAIL
  );
  const title =
    kind === "buff_ended"
      ? `# 🏁 ${event.label} buff 結束`
      : `# ⏰ ${event.label} 募集逾時`;
  const body =
    kind === "buff_ended"
      ? `全服 buff 已停止，感謝大家的貢獻。`
      : `本次募集未達標，全服 buff 不會啟動。請等下次機會。`;
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(title));
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  return c;
}

async function sendAnnounce(client, channelId, container, { ping = false } = {}) {
  if (!channelId) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased?.()) return;
  const roleId = ping ? resolveRoleId() : "";
  if (roleId) prependRoleMention(container, roleId);
  await ch
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
    })
    .catch((e) => console.log(`[WORLD_EVENT] 公告失敗：${e.message}`.yellow));
}

async function scanOnce(client) {
  if (!worldEventService.isEnabled()) return;
  if (!client?.worldEventsCollection) return;
  const channelId = resolveChannelId();

  // 1) 收尾過期事件（結束類公告不 ping，避免擾民）
  const settled = await worldEventService.settleExpired(client).catch(() => ({ transitions: [] }));
  for (const t of settled.transitions || []) {
    const kind = t.from === "buffing" ? "buff_ended" : "collect_failed";
    if (await claimAnnounce(client, t.event.event_db_id, kind)) {
      await sendAnnounce(client, channelId, buildEndContainer(t.event, kind));
    }
  }

  // 2) 廣播：新開的 collecting + 新進入的 buffing（這兩個值得 ping）
  const active = await worldEventService.getActiveEvents(client);
  for (const e of active) {
    if (e.state === "collecting") {
      if (await claimAnnounce(client, e.event_db_id, "open")) {
        await sendAnnounce(client, channelId, buildOpenContainer(e), { ping: true });
      }
    } else if (e.state === "buffing") {
      if (await claimAnnounce(client, e.event_db_id, "buff_started")) {
        await sendAnnounce(client, channelId, buildBuffStartContainer(e), { ping: true });
      }
    }
    // 主線活動跑好幾天，中間要有進度回報維持參與感
    if (e.kind === "mainline" && e.state === "collecting") {
      const pct = overallProgressPct(e);
      for (const milestone of [75, 50, 25]) {
        if (pct < milestone) continue;
        if (await claimAnnounce(client, e.event_db_id, `pct${milestone}`)) {
          await sendAnnounce(client, channelId, buildMilestoneContainer(e, milestone), { ping: true });
        }
        break;
      }
    }
  }

  // 3) 主線達標公告：mainline 達標後 state 直接進 completed（沒有會過期的
  //    buffing 階段），所以不在 getActiveEvents 裡，得另外撈才發得出來。
  for (const e of await worldEventService.getRecentlyCompleted(client)) {
    if (await claimAnnounce(client, e.event_db_id, "completed")) {
      await sendAnnounce(client, channelId, buildBuffStartContainer(e), { ping: true });
    }
  }

  // 4) refresh buff cache（每分鐘）
  await worldEventBuffs.refreshCache(client).catch(() => {});
}

module.exports = async (client) => {
  if (!worldEventService.isEnabled()) {
    console.log(`[WORLD_EVENT] 系統未啟用，跳過排程`.gray);
    return;
  }
  // 啟動時先 refresh 一次
  await worldEventBuffs.refreshCache(client).catch(() => {});
  registerCron(client, {
    name: "world_event.scan",
    label: "世界事件掃描",
    schedule: "* * * * *",
    timezone: "Asia/Taipei",
    runner: () => scanOnce(client),
  });
};

module.exports.scanOnce = scanOnce;
