require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const { countdown: cfg } = require("../../config");
const countdownService = require("../../features/countdown/countdownService");
const {
  buildRegisteredContainer,
  buildListContainer,
} = require("../../features/countdown/countdownView");

function errorContainer(title, detail, hint) {
  const c = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(detail));
  if (hint) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return c;
}

async function handleCreate(client, interaction) {
  const title = interaction.options.getString("標題", true).trim();
  const dateStr = interaction.options.getString("日期", true);
  const description = interaction.options.getString("說明") || "";
  const timeStr = interaction.options.getString("時間") || "";

  const target = countdownService.parseTarget(dateStr, timeStr);
  if (!target) {
    return interaction.reply({
      components: [
        errorContainer(
          "❌ 日期格式看不懂",
          `我沒辦法解析「${dateStr}${timeStr ? ` ${timeStr}` : ""}」。`,
          "日期格式：`2026-08-15` 或 `08-15`；時間（選填）：`20:00`。",
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  const targetAt = target.toJSDate();
  if (countdownService.daysUntil(targetAt) < 0) {
    return interaction.reply({
      components: [
        errorContainer(
          "❌ 這個日期已經過了",
          `目標時間 <t:${Math.floor(targetAt.getTime() / 1000)}:F> 在過去。`,
          "請填一個未來的日期。",
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  const count = (await countdownService.listCountdowns(client, interaction.guildId)).length;
  const max = cfg?.maxPerGuild || 25;
  if (count >= max) {
    return interaction.reply({
      components: [
        errorContainer(
          "❌ 倒數數量已達上限",
          `本伺服器進行中的倒數已有 ${count} 個（上限 ${max}）。`,
          "先用 `/倒數 刪除` 移除不需要的倒數，再新增。",
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  const doc = await countdownService.createCountdown(client, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    createdBy: interaction.user.id,
    title,
    description,
    targetAt,
  });

  return interaction.reply({
    components: [buildRegisteredContainer(doc)],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleList(client, interaction) {
  const docs = await countdownService.listCountdowns(client, interaction.guildId);
  return interaction.reply({
    components: [buildListContainer(docs)],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function handleDelete(client, interaction) {
  const id = interaction.options.getString("倒數", true);
  const doc = await countdownService.deleteCountdown(client, interaction.guildId, id);
  if (!doc) {
    return interaction.reply({
      components: [
        errorContainer(
          "❌ 找不到這個倒數",
          "可能已經被刪除或已結束。",
          "用 `/倒數 列表` 看目前還有哪些倒數。",
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  return interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🗑️ 已刪除倒數：${doc.title}`),
        ),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("倒數")
    .setDescription("[ADMIN] 日期倒數提醒（里程碑天數自動播報）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("新增")
        .setDescription("建立一個倒數，之後在本頻道自動提醒")
        .addStringOption((o) =>
          o.setName("標題").setDescription("倒數標題").setRequired(true).setMaxLength(80),
        )
        .addStringOption((o) =>
          o
            .setName("日期")
            .setDescription("目標日期，格式 2026-08-15 或 08-15")
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("說明").setDescription("補充說明（選填）").setMaxLength(500),
        )
        .addStringOption((o) =>
          o.setName("時間").setDescription("目標時間 HH:mm（選填，預設當天）"),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("列表").setDescription("查看本伺服器進行中的倒數"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("刪除")
        .setDescription("刪除一個倒數")
        .addStringOption((o) =>
          o
            .setName("倒數")
            .setDescription("要刪除的倒數")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .toJSON(),

  autocomplete: async (client, interaction) => {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "倒數") return interaction.respond([]).catch(() => {});
      const q = (focused.value || "").toLowerCase();
      const docs = await countdownService.listCountdowns(client, interaction.guildId);
      const opts = docs
        .filter((d) => d.title.toLowerCase().includes(q))
        .slice(0, 25)
        .map((d) => ({
          name: `${d.title}（還剩 ${countdownService.daysUntil(d.targetAt)} 天）`.slice(0, 100),
          value: String(d._id),
        }));
      return interaction.respond(opts).catch(() => {});
    } catch {
      return interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === "新增") return await handleCreate(client, interaction);
      if (sub === "列表") return await handleList(client, interaction);
      if (sub === "刪除") return await handleDelete(client, interaction);
    } catch (err) {
      console.log(`[COUNTDOWN] 指令錯誤：${err?.stack || err}`.red);
      const payload = {
        components: [
          errorContainer("❌ 發生錯誤", "處理指令時出了點狀況，請稍後再試。"),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        return interaction.followUp(payload).catch(() => {});
      }
      return interaction.reply(payload).catch(() => {});
    }
  },
};
