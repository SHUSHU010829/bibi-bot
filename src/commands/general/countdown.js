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
  buildIntervalRegisteredContainer,
} = require("../../features/countdown/countdownView");
const { buildChoices, respondChoices, resolveChoice } = require("../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../utils/choiceErrorContainer");

// 「還剩 N 天」是顯示用尾巴，玩家貼整行回來時要剝掉才對得上標題
const COUNTDOWN_STRIP = [/\(還剩[^)]*\)/g];

async function countdownChoices(client, guildId) {
  const docs = await countdownService.listCountdowns(client, guildId);
  return buildChoices(docs, (d) => ({
    name: `${d.title}（還剩 ${countdownService.daysUntil(d.targetAt)} 天）`,
    value: String(d._id),
    search: d.title,
  }));
}

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

function intervalPlanError(plan, input) {
  const icfg = cfg?.interval || {};
  const t = (at) => `<t:${Math.floor(at.getTime() / 1000)}:f>`;
  switch (plan.reason) {
    case "bad_start":
    case "bad_end": {
      const which = plan.reason === "bad_start" ? "開始" : "結束";
      const date = plan.reason === "bad_start" ? input.startDate : input.endDate;
      const time = plan.reason === "bad_start" ? input.startTime : input.endTime;
      return errorContainer(
        `❌ ${which}時間看不懂`,
        `我沒辦法解析${which}時間「${date}${time ? ` ${time}` : ""}」。`,
        `日期格式：\`2026-08-15\` 或 \`08-15\`；時間（選填）：\`20:00\`。未填時間時開始預設 ${icfg.defaultStartTime || "09:00"}、結束預設 ${icfg.defaultEndTime || "22:00"}。`,
      );
    }
    case "bad_window":
      return errorContainer(
        "❌ 每日時段看不懂",
        `我沒辦法解析每日時段「${input.dailyStart || icfg.dailyStart || "09:00"}～${input.dailyEnd || icfg.dailyEnd || "22:00"}」。`,
        `格式：\`HH:mm\`，例如 \`09:00\`、\`22:00\`。不填則預設 ${icfg.dailyStart || "09:00"}～${icfg.dailyEnd || "22:00"}。`,
      );
    case "end_before_start":
      return errorContainer(
        "❌ 結束時間早於開始時間",
        `開始：${t(plan.startAt)}\n結束：${t(plan.endAt)}`,
        "同一天的話記得把「結束時間」填得比「開始時間」晚。",
      );
    case "ended":
      return errorContainer(
        "❌ 這段期間已經結束",
        `結束時間 ${t(plan.endAt)} 已經過了。`,
        "請填一個還沒結束的期間。",
      );
    case "no_slot":
      return errorContainer(
        "❌ 剩下的期間排不進任何一次提醒",
        `期間：${t(plan.startAt)} ～ ${t(plan.endAt)}\n間隔：${countdownService.intervalLabel(input.intervalMinutes)}\n每日時段：${countdownService.hmLabel(plan.dailyStartMin)}～${countdownService.hmLabel(plan.dailyEndMin)}`,
        "提醒時間必須落在每日時段內——調整開始時間、把結束時間往後延，或選短一點的間隔。",
      );
    case "too_many":
      return errorContainer(
        "❌ 提醒次數太多",
        `這樣設定會提醒 **${plan.remaining}** 次（上限 ${plan.max} 次）。`,
        "選長一點的間隔，或縮短期間。",
      );
    default:
      return errorContainer("❌ 無法建立期間提醒", "設定有誤，請再確認一次。");
  }
}

async function handleInterval(client, interaction) {
  const title = interaction.options.getString("標題", true).trim();
  const input = {
    startDate: interaction.options.getString("開始日期", true),
    endDate: interaction.options.getString("結束日期", true),
    intervalMinutes: interaction.options.getInteger("間隔", true),
    startTime: interaction.options.getString("開始時間") || "",
    endTime: interaction.options.getString("結束時間") || "",
    dailyStart: interaction.options.getString("每日開始") || "",
    dailyEnd: interaction.options.getString("每日結束") || "",
  };
  const description = interaction.options.getString("說明") || "";

  const plan = countdownService.planInterval(input);
  if (!plan.ok) {
    return interaction.reply({
      components: [intervalPlanError(plan, input)],
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
          `本伺服器進行中的倒數 / 期間提醒已有 ${count} 個（上限 ${max}）。`,
          "先用 `/倒數 刪除` 移除不需要的項目，再新增。",
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  const doc = await countdownService.createIntervalReminder(client, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    createdBy: interaction.user.id,
    title,
    description,
    startAt: plan.startAt,
    endAt: plan.endAt,
    dailyStartMin: plan.dailyStartMin,
    dailyEndMin: plan.dailyEndMin,
    nextAt: plan.nextAt,
    intervalMinutes: input.intervalMinutes,
  });

  return interaction.reply({
    components: [buildIntervalRegisteredContainer(doc, plan)],
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
  const options = await countdownChoices(client, interaction.guildId);
  const picked = resolveChoice(interaction.options.getString("倒數", true), options, {
    strip: COUNTDOWN_STRIP,
  });
  if (!picked.ok) {
    return interaction.reply({
      components: [
        buildChoiceErrorContainer(picked, {
          what: "倒數",
          hint: "-# 用 `/倒數 列表` 看目前還有哪些倒數；直接貼上選單那一行也可以。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  const doc = await countdownService.deleteCountdown(
    client,
    interaction.guildId,
    picked.value,
  );
  if (!doc) {
    return interaction.reply({
      components: [
        errorContainer(
          "❌ 找不到這個倒數",
          "可能剛剛已經被別人刪掉或已結束。",
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
    .setDescription("[ADMIN] 日期倒數提醒 / 期間定時提醒")
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
      sub
        .setName("期間提醒")
        .setDescription("在一段期間內每隔固定時間，於本頻道發送提醒")
        .addStringOption((o) =>
          o.setName("標題").setDescription("提醒標題").setRequired(true).setMaxLength(80),
        )
        .addStringOption((o) =>
          o
            .setName("開始日期")
            .setDescription("開始日期，格式 2026-08-15 或 08-15")
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("結束日期")
            .setDescription("結束日期（可與開始同一天），格式 2026-08-15 或 08-15")
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName("間隔")
            .setDescription("多久提醒一次")
            .setRequired(true)
            .addChoices(
              ...(cfg?.interval?.choices || []).map((c) => ({ name: c.name, value: c.minutes })),
            ),
        )
        .addStringOption((o) =>
          o
            .setName("開始時間")
            .setDescription(`第一次提醒時間 HH:mm（選填，預設 ${cfg?.interval?.defaultStartTime || "09:00"}）`),
        )
        .addStringOption((o) =>
          o
            .setName("結束時間")
            .setDescription(`結束日期的截止時間 HH:mm（選填，預設 ${cfg?.interval?.defaultEndTime || "22:00"}）`),
        )
        .addStringOption((o) =>
          o
            .setName("每日開始")
            .setDescription(`每天最早幾點提醒 HH:mm（選填，預設 ${cfg?.interval?.dailyStart || "09:00"}）`),
        )
        .addStringOption((o) =>
          o
            .setName("每日結束")
            .setDescription(`每天最晚幾點提醒 HH:mm（選填，預設 ${cfg?.interval?.dailyEnd || "22:00"}）`),
        )
        .addStringOption((o) =>
          o.setName("說明").setDescription("每次提醒附帶的說明（選填）").setMaxLength(500),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("列表").setDescription("查看本伺服器進行中的倒數"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("刪除")
        .setDescription("刪除一個倒數 / 期間提醒")
        .addStringOption((o) =>
          o
            .setName("倒數")
            .setDescription("要刪除的倒數或期間提醒")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .toJSON(),

  autocomplete: async (client, interaction) => {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "倒數") return interaction.respond([]).catch(() => {});
      const options = await countdownChoices(client, interaction.guildId);
      return respondChoices(interaction, options, focused.value, { strip: COUNTDOWN_STRIP });
    } catch {
      return interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === "新增") return await handleCreate(client, interaction);
      if (sub === "期間提醒") return await handleInterval(client, interaction);
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
