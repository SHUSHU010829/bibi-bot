// /提醒 的按鈕與選單：
//   rmdg_<action>_<reminderId>                       揪團訊息上的公開按鈕（任何人可按）
//   rmd_<action>_<ownerId>_<reminderId>[_<occ>[_<min>]]  個人面板 / 私訊上的按鈕，只有本人能按
const { MessageFlags, PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError } = require("../../utils/errorTracker");
const service = require("../../features/reminder/reminderService");
const notifier = require("../../features/reminder/reminderNotifier");
const { leadLabel, nagLabel, snoozeLabel } = require("../../features/reminder/reminderLabels");
const {
  errorContainer,
  buildGroupMessage,
  buildSettingsPanel,
  buildListContainer,
  buildDeliveryContainer,
  ts,
} = require("../../features/reminder/reminderView");

const V2 = MessageFlags.IsComponentsV2;
const V2_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

const notFound = () =>
  errorContainer("❌ 找不到這個提醒", "它可能已經被刪除、取消，或結束超過保留期限了。", "用 `/提醒 列表` 看目前還有哪些提醒。");

function ephemeral(interaction, container) {
  const payload = { components: [container], flags: V2_EPHEMERAL, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function panel(interaction, container) {
  return interaction.update({ components: [container], flags: V2, allowedMentions: { parse: [] } });
}

function simpleContainer(title, body) {
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}${body ? `\n${body}` : ""}`));
}

function joinError(result) {
  if (result.reason === "full") {
    return errorContainer(
      "❌ 揪團已額滿",
      `這個揪團最多 ${result.max} 人，目前已經滿了。`,
      "等有人退出後再試，或自己用 `/提醒 新增` 設定個人提醒。",
    );
  }
  if (result.reason === "finished") {
    return errorContainer("❌ 這個揪團提醒已經結束", "時間已經過了，不能再加入。", "想要類似的提醒可以用 `/提醒 揪團` 重新發起。");
  }
  return notFound();
}

async function handleGroupButton(client, interaction, action, reminderId) {
  const userId = interaction.user.id;

  if (action === "join") {
    if (!(await deferUpdateSafe(interaction))) return;
    const result = await service.joinGroup(client, reminderId, userId);
    if (!result.ok) {
      if (result.reason === "already") {
        return ephemeral(interaction, buildSettingsPanel(result.reminder, userId, "-# 你已經在名單裡了，可以在這裡調整自己的設定。"));
      }
      return ephemeral(interaction, joinError(result));
    }
    await interaction.editReply({ components: [buildGroupMessage(result.reminder)], flags: V2, allowedMentions: { parse: [] } });
    return ephemeral(
      interaction,
      buildSettingsPanel(result.reminder, userId, `✅ 已加入！${ts(result.reminder.dueAt, "f")} 我會私訊提醒你。`),
    );
  }

  if (action === "cfg") {
    const rem = await service.getReminder(client, reminderId);
    if (!rem) return ephemeral(interaction, notFound());
    return ephemeral(interaction, buildSettingsPanel(rem, userId));
  }

  if (action === "leave") {
    if (!(await deferUpdateSafe(interaction))) return;
    const result = await service.leaveGroup(client, reminderId, userId);
    if (!result.ok) {
      if (result.reason === "not_joined") {
        return ephemeral(
          interaction,
          errorContainer("❌ 你不在這個揪團裡", "你還沒加入，所以不需要退出。", "想收到提醒的話按「加入提醒」。"),
        );
      }
      return ephemeral(interaction, notFound());
    }
    if (!result.reminder.finished) {
      await interaction.editReply({ components: [buildGroupMessage(result.reminder)], flags: V2, allowedMentions: { parse: [] } });
    }
    return ephemeral(interaction, simpleContainer(`👋 已退出：${result.reminder.title}`, "-# 之後不會再私訊你這個揪團的提醒。"));
  }

  if (action === "cancel") {
    const rem = await service.getReminder(client, reminderId);
    if (!rem) return ephemeral(interaction, notFound());
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (rem.ownerId !== userId && !isAdmin) {
      return ephemeral(
        interaction,
        errorContainer(
          "❌ 這不是你的揪團！",
          `只有發起人 <@${rem.ownerId}> 或伺服器管理員可以取消。`,
          "不想收到提醒的話，按「退出」就好。",
        ),
      );
    }
    if (!(await deferUpdateSafe(interaction))) return;
    await service.cancelReminder(client, rem._id);
    await interaction.editReply({ components: [buildGroupMessage(rem, "cancelled")], flags: V2, allowedMentions: { parse: [] } });
    return ephemeral(interaction, simpleContainer(`🗑️ 已取消揪團：${rem.title}`, "-# 所有成員的提醒都已移除。"));
  }
}

function deliveryState(rem, userId, occTs) {
  return {
    reminder: rem,
    participant: service.participantOf(rem, userId) || { userId },
    kind: "due",
    occurrenceAt: new Date(occTs),
    nagIndex: 0,
    nagTotal: 0,
  };
}

async function handleDeliveryButton(client, interaction, action, userId, rem, occKey, minutes) {
  const occTs = parseInt(occKey, 36);
  if (!Number.isFinite(occTs)) return panel(interaction, notFound());
  const d = deliveryState(rem, userId, occTs);
  let status;

  if (action === "done") {
    await service.markDone(client, rem, userId, occTs);
    status = "✅ 已完成，這次不會再追加提醒。";
  } else if (action === "snz") {
    const at = await service.snooze(client, rem, userId, occTs, minutes);
    status = `💤 已延後，${snoozeLabel(minutes)}（${ts(at, "t")}）再提醒你。`;
  } else if (action === "skip") {
    await service.skipOccurrence(client, rem, userId, occTs);
    status = "🔕 好的，這次不提醒了。";
  } else if (action === "stop") {
    if (rem.kind === service.KIND_GROUP) {
      const result = await service.leaveGroup(client, rem._id, userId);
      if (result.ok && !result.reminder.finished) await notifier.refreshGroupMessage(client, result.reminder);
      status = "👋 已退出揪團，之後不會再提醒你。";
    } else {
      await service.cancelReminder(client, rem._id);
      status = "🛑 已停止這個提醒，之後不會再提醒你。";
    }
  } else {
    return;
  }
  return panel(interaction, buildDeliveryContainer(d, { status }));
}

async function handleOwnerAction(client, interaction, action, userId, rest) {
  if (action === "list") {
    const rems = await service.listForUser(client, userId);
    return ephemeral(interaction, buildListContainer(rems, userId));
  }

  const reminderId = action === "pick" ? interaction.values?.[0] : rest[0];
  const rem = await service.getReminder(client, reminderId);
  if (!rem) return panel(interaction, notFound());

  if (["done", "snz", "skip", "stop"].includes(action)) {
    return handleDeliveryButton(client, interaction, action, userId, rem, rest[1], parseInt(rest[2], 10));
  }

  if (action === "pick" || action === "cfg") {
    return panel(interaction, buildSettingsPanel(rem, userId));
  }

  if (action === "lead" || action === "nag" || action === "nagn") {
    const value = parseInt(interaction.values?.[0], 10);
    if (!Number.isFinite(value)) return;
    const field = { lead: "leadMinutes", nag: "nagMinutes", nagn: "nagCount" }[action];
    const result = await service.updateParticipant(client, rem._id, userId, field, value);
    if (!result.ok) return panel(interaction, notFound());
    const p = service.participantOf(result.reminder, userId);
    const notice =
      action === "lead"
        ? `✅ 已改為：${leadLabel(p.leadMinutes)}`
        : `✅ 追加提醒已改為：${nagLabel(p.nagMinutes, p.nagMinutes ? p.nagCount : 0)}`;
    return panel(interaction, buildSettingsPanel(result.reminder, userId, notice));
  }

  if (action === "del") {
    if (rem.kind !== service.KIND_PERSONAL || rem.ownerId !== userId) {
      return ephemeral(interaction, errorContainer("❌ 這不是你的提醒！", "只能刪除自己建立的個人提醒。"));
    }
    await service.cancelReminder(client, rem._id);
    return panel(interaction, simpleContainer(`🗑️ 已刪除提醒：${rem.title}`, "-# 用 `/提醒 列表` 查看其他提醒。"));
  }

  if (action === "leave") {
    const result = await service.leaveGroup(client, rem._id, userId);
    if (!result.ok) {
      return panel(interaction, buildSettingsPanel(rem, userId, "-# 你已經不在這個揪團裡了。"));
    }
    if (!result.reminder.finished) await notifier.refreshGroupMessage(client, result.reminder);
    return panel(interaction, simpleContainer(`👋 已退出：${rem.title}`, "-# 之後不會再私訊你這個揪團的提醒。"));
  }

  if (action === "cancel") {
    if (rem.ownerId !== userId) {
      return ephemeral(interaction, errorContainer("❌ 這不是你的揪團！", `只有發起人 <@${rem.ownerId}> 可以從這裡取消。`));
    }
    await service.cancelReminder(client, rem._id);
    await notifier.refreshGroupMessage(client, rem, "cancelled");
    return panel(interaction, simpleContainer(`🗑️ 已取消揪團：${rem.title}`, "-# 所有成員的提醒都已移除。"));
  }
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  const customId = interaction.customId || "";
  if (!customId.startsWith("rmd_") && !customId.startsWith("rmdg_")) return;

  try {
    const rl = consume(interaction.user.id, "btn:reminder", { windowMs: 1000, max: 2 });
    if (!rl.allowed) {
      return interaction
        .reply({ content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    const [prefix, action, ...rest] = customId.split("_");
    if (prefix === "rmdg") return await handleGroupButton(client, interaction, action, rest[0]);

    const [ownerId, ...payload] = rest;
    if (interaction.user.id !== ownerId) {
      return interaction
        .reply({ content: "🚫 這不是你的提醒！想要自己的提醒請用 `/提醒 新增`。", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    return await handleOwnerAction(client, interaction, action, ownerId, payload);
  } catch (error) {
    logger.error(
      { source: "reminder-interaction", customId, err: error.message, stack: error.stack },
      "處理提醒互動時出錯",
    );
    trackError("reminder-interaction", error, { customId });
    await ephemeral(interaction, errorContainer("❌ 發生錯誤", "處理提醒時出了點狀況，請稍後再試。")).catch(() => {});
  }
};
