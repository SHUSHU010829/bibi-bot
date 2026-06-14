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

function itemLabel(id) {
  return config?.guildWarehouse?.items?.[id]?.name || id;
}

function buildOpenContainer(event) {
  const c = new ContainerBuilder().setAccentColor(event.color || COLOR_OPEN);
  const reqLines = Object.entries(event.requirements_remaining || {})
    .map(([k, v]) => `• ${itemLabel(k)} 0 / ${v}`)
    .join("\n");
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ${event.emoji || "🌍"} 世界事件開啟：${event.label}\n${event.description || ""}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**徵集需求：**\n${reqLines}\n\n` +
        `截止時間：<t:${Math.floor(new Date(event.ends_at).getTime() / 1000)}:R>`
    )
  );
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`we_view_${event.event_db_id}`)
        .setLabel(`查看事件 / 捐獻`)
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Primary)
    )
  );
  return c;
}

function buildBuffStartContainer(event) {
  const c = new ContainerBuilder().setAccentColor(COLOR_BUFF);
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
  }

  // 3) refresh buff cache（每分鐘）
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
