require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const gameTitleService = require("../../features/gameTitles/gameTitleService");
const { buildChoices, respondChoices, resolveChoice } = require("../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../utils/choiceErrorContainer");

const DAY_MS = 24 * 60 * 60 * 1000;

function titleChoices() {
  return buildChoices(gameTitleService.order(), (id) => {
    const d = gameTitleService.def(id) || {};
    return {
      name: `${d.emoji || ""} ${d.name || id} (${id})`.trim(),
      value: id,
      search: `${id} ${d.name || ""}`,
    };
  });
}

// 選單顯示「emoji 中文名 (id)」，貼整行回來也要吃得下
async function pickTitle(interaction) {
  const picked = resolveChoice(interaction.options.getString("稱號"), titleChoices());
  if (picked.ok) return picked.value;
  await interaction.reply({
    components: [buildChoiceErrorContainer(picked, { what: "稱號" })],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("title-admin")
    .setDescription("[ADMIN] 遊戲稱號管理（授予 / 撤銷 / 列出）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("grant")
        .setDescription("手動授予玩家稱號（天數留空 = 永久）")
        .addUserOption((o) =>
          o.setName("玩家").setDescription("要授予的玩家").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("稱號")
            .setDescription("稱號 ID")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption((o) =>
          o
            .setName("天數")
            .setDescription("有效天數（留空 = 永久）")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(3650)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("revoke")
        .setDescription("手動撤銷玩家稱號")
        .addUserOption((o) =>
          o.setName("玩家").setDescription("要撤銷的玩家").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("稱號")
            .setDescription("稱號 ID")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("列出玩家所有稱號（含過期 / 已撤銷）")
        .addUserOption((o) =>
          o.setName("玩家").setDescription("要查詢的玩家").setRequired(true)
        )
    ),

  autocomplete: async (client, interaction) => {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "稱號") return interaction.respond([]).catch(() => {});
      await respondChoices(interaction, titleChoices(), focused.value);
    } catch (e) {
      await interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    try {
      if (!client.userLevelsCollection) {
        return interaction.reply({
          content: "🔧 等級/稱號系統尚未啟動",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (sub === "grant") return runGrant(client, interaction);
      if (sub === "revoke") return runRevoke(client, interaction);
      if (sub === "list") return runList(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /title-admin ${sub}:\n${error}\n${error.stack}`.red);
      const reply = { content: "🔧 操作失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};

async function runGrant(client, interaction) {
  const target = interaction.options.getUser("玩家");
  const titleId = await pickTitle(interaction);
  if (!titleId) return;
  const days = interaction.options.getInteger("天數");

  const expiresAt = days ? Date.now() + days * DAY_MS : null;
  await gameTitleService.grant(client, {
    userId: target.id,
    guildId: interaction.guildId,
    member: null,
    titleId,
    announce: false,
    expiresAt,
    source: "admin_grant",
  });

  const expiryNote = expiresAt
    ? `，有效至 <t:${Math.floor(expiresAt / 1000)}:R>`
    : "（永久）";
  return interaction.reply({
    content: `✅ 已授予 ${target} 稱號 **${gameTitleService.label(titleId)}**${expiryNote}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function runRevoke(client, interaction) {
  const target = interaction.options.getUser("玩家");
  const titleId = await pickTitle(interaction);
  if (!titleId) return;

  const unlocked = await gameTitleService.getUnlocked(client, target.id, interaction.guildId);
  if (!unlocked.has(titleId)) {
    return interaction.reply({
      content: `❌ ${target} 目前沒有 **${gameTitleService.label(titleId)}**`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  await gameTitleService.revoke(client, {
    userId: target.id,
    guildId: interaction.guildId,
    titleId,
    status: "revoked",
  });

  return interaction.reply({
    content: `✅ 已撤銷 ${target} 的稱號 **${gameTitleService.label(titleId)}**`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function runList(client, interaction) {
  const target = interaction.options.getUser("玩家");
  const [unlocked, meta] = await Promise.all([
    gameTitleService.getUnlocked(client, target.id, interaction.guildId),
    gameTitleService.getTitleMeta(client, target.id, interaction.guildId),
  ]);

  const metaById = new Map(meta.map((m) => [m.titleId, m]));

  const STATUS_TAG = { active: "🟢 持有中", expired: "⌛ 已過期", revoked: "🚫 已撤銷" };
  const lines = [];

  // 目前持有（gameTitles 權威清單）
  for (const id of gameTitleService.order()) {
    if (!unlocked.has(id)) continue;
    const m = metaById.get(id);
    const bits = [STATUS_TAG.active];
    if (m?.source) bits.push(`來源 ${m.source}`);
    if (m?.grantedAt) bits.push(`授予 <t:${Math.floor(m.grantedAt / 1000)}:d>`);
    if (m?.expiresAt) bits.push(`到期 <t:${Math.floor(m.expiresAt / 1000)}:R>`);
    lines.push(`${gameTitleService.label(id)} — ${bits.join(" ・ ")}`);
  }

  // 歷史紀錄（meta 中已過期 / 撤銷者）
  for (const m of meta) {
    if (m.status === "active" && unlocked.has(m.titleId)) continue;
    const tag = STATUS_TAG[m.status] || m.status;
    lines.push(`${gameTitleService.label(m.titleId)} — ${tag}`);
  }

  const body = lines.length ? lines.join("\n") : "（無任何稱號紀錄）";
  return interaction.reply({
    content: `# 🎖️ ${target.username} 的稱號\n${body}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
