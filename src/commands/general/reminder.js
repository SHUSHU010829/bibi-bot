require("colors");
const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require("discord.js");
const { DateTime } = require("luxon");

const { reminder: cfg } = require("../../config");
const service = require("../../features/reminder/reminderService");
const { parseWhen, TZ } = require("../../features/reminder/timeParser");
const { repeatLabel, leadLabel } = require("../../features/reminder/reminderLabels");
const {
  errorContainer,
  buildCreatedContainer,
  buildGroupMessage,
  buildListContainer,
  ts,
} = require("../../features/reminder/reminderView");

const TIME_EXAMPLES = "`30分鐘後`、`2小時後`、`20:00`、`明天 9:00`、`週五 晚上8點`、`12-25 18:30`";
const V2_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

function replyError(interaction, title, detail, hint) {
  return interaction.reply({ components: [errorContainer(title, detail, hint)], flags: V2_EPHEMERAL });
}

// 共用的時間 / 重複解析。失敗時直接回錯誤並回傳 null。
async function parseSchedule(interaction) {
  const whenRaw = interaction.options.getString("時間", true);
  const when = parseWhen(whenRaw);
  if (!when.ok) {
    if (when.reason === "past") {
      await replyError(
        interaction,
        "❌ 這個時間已經過了",
        `你輸入「${whenRaw}」，換算是 ${ts(when.at)}，已經是過去的時間。`,
        "請填一個未來的時間；只寫時間（例 `20:00`）會自動排到下一個 20:00。",
      );
    } else {
      await replyError(
        interaction,
        "❌ 時間格式看不懂",
        `我沒辦法解析「${whenRaw}」。\n可以這樣寫：${TIME_EXAMPLES}`,
        "只寫日期時預設早上 " + (cfg?.defaultTime || "09:00") + "；日期格式 `2026-12-25` 或 `12-25` 都可以。",
      );
    }
    return null;
  }

  const repeat = interaction.options.getString("重複") || "none";
  const untilRaw = interaction.options.getString("重複到");
  let repeatUntil = null;
  if (untilRaw && repeat !== "none") {
    const until = parseWhen(untilRaw);
    if (!until.ok) {
      await replyError(
        interaction,
        "❌ 「重複到」的日期看不懂",
        `我沒辦法把「${untilRaw}」當成未來的日期。`,
        "例：`12-31`、`2027-03-01`、`3週後`。會一直重複到那天結束為止。",
      );
      return null;
    }
    repeatUntil = DateTime.fromJSDate(until.at, { zone: TZ() }).endOf("day").toJSDate();
    if (repeatUntil < when.at) {
      await replyError(
        interaction,
        "❌ 重複結束日早於第一次提醒",
        `第一次提醒：${ts(when.at)}\n重複到：${ts(repeatUntil, "D")}`,
        "把「重複到」往後延，或改成不重複。",
      );
      return null;
    }
  }
  return { at: when.at, repeat, repeatUntil };
}

function createFailure(interaction, result, schedule) {
  if (result.reason === "until_before_first" || result.reason === "no_occurrence") {
    return replyError(
      interaction,
      "❌ 排不出任何一次提醒",
      `重複規則「${repeatLabel(schedule.repeat)}」在 ${ts(schedule.at, "D")} 之後${
        schedule.repeatUntil ? `、${ts(schedule.repeatUntil, "D")} 之前` : ""
      }找不到符合的日子。`,
      "調整「重複到」或換一個重複規則。",
    );
  }
  return replyError(interaction, "❌ 無法建立提醒", "設定有誤，請再確認一次。");
}

async function handleCreate(client, interaction) {
  const count = await service.countPersonal(client, interaction.user.id);
  const max = cfg?.maxPersonalPerUser || 25;
  if (count >= max) {
    return replyError(
      interaction,
      "❌ 提醒數量已達上限",
      `你目前有 ${count} 個進行中的個人提醒（上限 ${max} 個）。`,
      "用 `/提醒 列表` 刪掉不需要的提醒後再新增。",
    );
  }
  const schedule = await parseSchedule(interaction);
  if (!schedule) return;

  const nagMinutes = interaction.options.getInteger("追加提醒") || 0;
  const result = await service.createReminder(client, {
    kind: service.KIND_PERSONAL,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    ownerId: interaction.user.id,
    title: interaction.options.getString("內容", true).trim(),
    note: interaction.options.getString("備註") || "",
    ...schedule,
    leadMinutes: interaction.options.getInteger("提前") || 0,
    nagMinutes,
    nagCount: interaction.options.getInteger("追加次數") ?? undefined,
  });
  if (!result.ok) return createFailure(interaction, result, schedule);

  return interaction.reply({
    components: [buildCreatedContainer(result.reminder, interaction.user.id)],
    flags: V2_EPHEMERAL,
  });
}

async function handleGroup(client, interaction) {
  const count = await service.countGroups(client, interaction.guildId);
  const max = cfg?.maxGroupPerGuild || 25;
  if (count >= max) {
    return replyError(
      interaction,
      "❌ 揪團提醒數量已達上限",
      `本伺服器進行中的揪團提醒已有 ${count} 個（上限 ${max} 個）。`,
      "等既有的揪團結束，或請發起人取消不需要的揪團後再試。",
    );
  }
  const schedule = await parseSchedule(interaction);
  if (!schedule) return;

  const result = await service.createReminder(client, {
    kind: service.KIND_GROUP,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    ownerId: interaction.user.id,
    title: interaction.options.getString("標題", true).trim(),
    note: interaction.options.getString("說明") || "",
    ...schedule,
    leadMinutes: interaction.options.getInteger("提前") ?? cfg?.defaultGroupLeadMinutes ?? 10,
    nagMinutes: 0,
  });
  if (!result.ok) return createFailure(interaction, result, schedule);

  const response = await interaction.reply({
    components: [buildGroupMessage(result.reminder)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    withResponse: true,
  });
  const messageId = response?.resource?.message?.id;
  if (messageId) await service.setMessageId(client, result.reminder._id, messageId);
}

async function handleList(client, interaction) {
  const rems = await service.listForUser(client, interaction.user.id);
  return interaction.reply({
    components: [buildListContainer(rems, interaction.user.id)],
    flags: V2_EPHEMERAL,
  });
}

const repeatChoices = () => (cfg?.repeatChoices || []).map((c) => ({ name: c.name, value: c.value }));
const leadChoices = () => (cfg?.leadChoices || []).map((c) => ({ name: c.name, value: c.minutes }));
const nagChoices = () => (cfg?.nagChoices || []).map((c) => ({ name: c.name, value: c.minutes }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName("提醒")
    .setDescription("提醒事項：時間到私訊你，也能揪團一起提醒")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("新增")
        .setDescription("設定一個個人提醒，時間到私訊你")
        .addStringOption((o) =>
          o.setName("內容").setDescription("要提醒什麼").setRequired(true).setMaxLength(100),
        )
        .addStringOption((o) =>
          o
            .setName("時間")
            .setDescription("例：30分鐘後、20:00、明天 9:00、週五 晚上8點、12-25 18:30")
            .setRequired(true)
            .setMaxLength(50),
        )
        .addStringOption((o) =>
          o.setName("重複").setDescription("要不要重複（預設不重複）").addChoices(...repeatChoices()),
        )
        .addStringOption((o) =>
          o.setName("重複到").setDescription("重複到哪一天為止，例：12-31（選填，不填則一直重複）").setMaxLength(50),
        )
        .addIntegerOption((o) =>
          o.setName("提前").setDescription("提早多久先提醒一次（預設不提前）").addChoices(...leadChoices()),
        )
        .addIntegerOption((o) =>
          o
            .setName("追加提醒")
            .setDescription("時間到後每隔多久再提醒一次，直到你按「完成」（預設不追加）")
            .addChoices(...nagChoices()),
        )
        .addIntegerOption((o) =>
          o
            .setName("追加次數")
            .setDescription(`最多追加幾次（預設 ${cfg?.defaultNagCount ?? 3} 次）`)
            .setMinValue(1)
            .setMaxValue(cfg?.maxNagCount || 10),
        )
        .addStringOption((o) => o.setName("備註").setDescription("補充說明（選填）").setMaxLength(300)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("揪團")
        .setDescription("發起一個活動提醒，大家按按鈕加入，時間到一起私訊提醒")
        .addStringOption((o) =>
          o.setName("標題").setDescription("活動名稱").setRequired(true).setMaxLength(100),
        )
        .addStringOption((o) =>
          o
            .setName("時間")
            .setDescription("例：今晚 9點、明天 20:00、週六 14:00、12-25 18:30")
            .setRequired(true)
            .setMaxLength(50),
        )
        .addStringOption((o) => o.setName("說明").setDescription("活動說明（選填）").setMaxLength(300))
        .addStringOption((o) =>
          o.setName("重複").setDescription("固定活動可以設重複（預設不重複）").addChoices(...repeatChoices()),
        )
        .addStringOption((o) =>
          o.setName("重複到").setDescription("重複到哪一天為止，例：12-31（選填）").setMaxLength(50),
        )
        .addIntegerOption((o) =>
          o
            .setName("提前")
            .setDescription(`成員預設提前多久提醒（預設 ${leadLabel(cfg?.defaultGroupLeadMinutes ?? 10).replace("提前 ", "")}，每個人可以自己改）`)
            .addChoices(...leadChoices()),
        ),
    )
    .addSubcommand((sub) => sub.setName("列表").setDescription("查看 / 調整 / 刪除我的提醒"))
    .toJSON(),

  run: async (client, interaction) => {
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === "新增") return await handleCreate(client, interaction);
      if (sub === "揪團") return await handleGroup(client, interaction);
      if (sub === "列表") return await handleList(client, interaction);
    } catch (err) {
      console.log(`[REMINDER] 指令錯誤：${err?.stack || err}`.red);
      const payload = {
        components: [errorContainer("❌ 發生錯誤", "處理指令時出了點狀況，請稍後再試。")],
        flags: V2_EPHEMERAL,
      };
      if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  },
};
