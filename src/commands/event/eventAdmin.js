require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const eventEngine = require("../../features/event/eventEngine");
const eventScheduler = require("../../events/ready/eventScheduler");

const STATUS_TAG = {
  active: "🟢 生效中",
  upcoming: "🔜 即將開始",
  ended: "⚫ 已結束",
  disabled: "🚫 已停用",
  invalid: "⚠️ 設定錯誤",
};

function ts(ms) {
  return ms != null ? `<t:${Math.floor(ms / 1000)}:F>` : "—";
}

function effectsSummary(event) {
  const fx = event.effects || {};
  const bits = [];
  if (fx.miningLuckBonus) bits.push(`挖礦幸運 +${Math.round(fx.miningLuckBonus * 100)}%`);
  if (fx.miningQtyBonus) bits.push(`挖礦數量 +${fx.miningQtyBonus}`);
  for (const { def } of eventEngine.eventExtraOres(event)) {
    bits.push(`限定礦石 ${def.emoji || ""}${def.name}（權重 ${def.weight}、賣價 ${def.price}）`);
  }
  if ((event.quests || []).length) {
    bits.push(`限定任務 ×${event.quests.length}`);
  }
  return bits.length ? bits.join("\n") : "（無特殊效果）";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("event-admin")
    .setDescription("[ADMIN] 限時活動 / 節日系統管理")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("列出所有已設定的活動與狀態"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("preview")
        .setDescription("預覽單一活動的時間、效果與限定任務")
        .addStringOption((o) =>
          o
            .setName("活動")
            .setDescription("活動 ID")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("force-start")
        .setDescription("強制讓活動立即生效（測試用，重啟後失效）")
        .addStringOption((o) =>
          o
            .setName("活動")
            .setDescription("活動 ID")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addBooleanOption((o) =>
          o.setName("發公告").setDescription("是否同時發送開始公告（預設否）"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("force-end")
        .setDescription("強制讓活動立即結束（測試用，重啟後失效）")
        .addStringOption((o) =>
          o
            .setName("活動")
            .setDescription("活動 ID")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addBooleanOption((o) =>
          o.setName("發公告").setDescription("是否同時發送結束公告（預設否）"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear-force")
        .setDescription("清除某活動的強制覆寫，恢復依時間判定")
        .addStringOption((o) =>
          o
            .setName("活動")
            .setDescription("活動 ID")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .toJSON(),

  autocomplete: async (client, interaction) => {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "活動") return interaction.respond([]).catch(() => {});
      const q = (focused.value || "").toLowerCase();
      const opts = eventEngine
        .allEvents()
        .map((e) => ({
          name: `${e.name} (${e.id}) ・ ${STATUS_TAG[eventEngine.statusOf(e)] || ""}`.slice(0, 100),
          value: e.id,
          _q: `${e.id}${e.name}`.toLowerCase(),
        }))
        .filter((o) => !q || o._q.includes(q))
        .slice(0, 25)
        .map(({ name, value }) => ({ name, value }));
      await interaction.respond(opts);
    } catch {
      await interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    try {
      if (!eventEngine.isSystemEnabled()) {
        return interaction.reply({
          content: "🔧 限時活動系統未啟用（eventSystem.enabled = false）",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (sub === "list") return runList(interaction);
      if (sub === "preview") return runPreview(interaction);
      if (sub === "force-start") return runForce(client, interaction, "start");
      if (sub === "force-end") return runForce(client, interaction, "end");
      if (sub === "clear-force") return runClear(interaction);
    } catch (error) {
      console.log(`[ERROR] /event-admin ${sub}:\n${error}\n${error.stack}`.red);
      const reply = { content: "🔧 操作失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};

async function runList(interaction) {
  const events = eventEngine.allEvents();
  if (events.length === 0) {
    return interaction.reply({
      content: "目前沒有設定任何活動（events.json 的 eventSystem.events 為空）。",
      flags: MessageFlags.Ephemeral,
    });
  }
  const lines = events.map((e) => {
    const status = eventEngine.statusOf(e);
    const force = eventEngine.getForce(e.id);
    const { startMs, endMs } = eventEngine.eventWindow(e);
    const forceTag = force ? `（強制 ${force === "start" ? "開始" : "結束"}）` : "";
    return (
      `${STATUS_TAG[status] || status}${forceTag} **${e.name}** \`${e.id}\`\n` +
      `-# ${ts(startMs)} → ${ts(endMs)}`
    );
  });
  return interaction.reply({
    content: `# 🎉 限時活動列表\n${lines.join("\n\n")}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  });
}

async function runPreview(interaction) {
  const id = interaction.options.getString("活動");
  const event = eventEngine.getEventById(id);
  if (!event) {
    return interaction.reply({ content: `❌ 找不到活動 \`${id}\``, flags: MessageFlags.Ephemeral });
  }
  const status = eventEngine.statusOf(event);
  const { startMs, endMs } = eventEngine.eventWindow(event);
  const questLines = (event.quests || []).map(
    (q) => `• **${q.name}**（${q.id}）目標 ${q.target} ・ 獎勵 ${q.reward}`,
  );
  const body = [
    `# 🔍 ${event.name}　\`${event.id}\``,
    `狀態：${STATUS_TAG[status] || status}`,
    event.description ? `-# ${event.description}` : null,
    `**時間**\n${ts(startMs)} → ${ts(endMs)}`,
    `**效果**\n${effectsSummary(event)}`,
    questLines.length ? `**限定任務**\n${questLines.join("\n")}` : null,
    event.announcementText ? `**開始公告**\n${event.announcementText}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return interaction.reply({ content: body.slice(0, 1900), flags: MessageFlags.Ephemeral });
}

async function runForce(client, interaction, phase) {
  const id = interaction.options.getString("活動");
  const announce = interaction.options.getBoolean("發公告") || false;
  const event = eventEngine.getEventById(id);
  if (!event) {
    return interaction.reply({ content: `❌ 找不到活動 \`${id}\``, flags: MessageFlags.Ephemeral });
  }
  const ok =
    phase === "start" ? eventEngine.forceStart(id) : eventEngine.forceEnd(id);
  if (!ok) {
    return interaction.reply({ content: `❌ 強制操作失敗 \`${id}\``, flags: MessageFlags.Ephemeral });
  }

  let announceNote = "";
  if (announce) {
    const sent = await eventScheduler
      .sendAnnouncement(client, event, phase)
      .catch(() => false);
    announceNote = sent ? "，並已發送公告" : "，但公告未發送（未設定公告頻道？）";
  }

  return interaction.reply({
    content:
      `✅ 已強制${phase === "start" ? "開始" : "結束"} **${event.name}**${announceNote}。\n` +
      `-# 此為進程內覆寫，機器人重啟後恢復依時間判定；可用 \`/event-admin clear-force\` 還原。`,
    flags: MessageFlags.Ephemeral,
  });
}

async function runClear(interaction) {
  const id = interaction.options.getString("活動");
  const event = eventEngine.getEventById(id);
  if (!event) {
    return interaction.reply({ content: `❌ 找不到活動 \`${id}\``, flags: MessageFlags.Ephemeral });
  }
  const had = eventEngine.clearForce(id);
  return interaction.reply({
    content: had
      ? `✅ 已清除 **${event.name}** 的強制覆寫，恢復依時間判定（目前：${STATUS_TAG[eventEngine.statusOf(event)]}）。`
      : `ℹ️ **${event.name}** 沒有強制覆寫，無需清除。`,
    flags: MessageFlags.Ephemeral,
  });
}
