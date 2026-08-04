require("colors");
const { MessageFlags, PermissionFlagsBits } = require("discord.js");

const { eventFundraise } = require("../../config");
const fundraise = require("../../features/event/fundraiseService");
const view = require("../../features/event/fundraiseView");
const itemRegistry = require("../../features/economy/itemRegistry");
const { refreshEventMessage, cancelEvent } = require("../../features/event/hostedEvent");
const { getOrCreate } = require("../../features/mining/miningProfile");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");

const PREFIXES = [
  "fundreview_approve_",
  "fundreview_reject_",
  "fundreject_modal_",
  "fund_coin_",
  "fund_coinmodal_",
  "fund_item_",
  "fund_itemsel_",
  "fund_itemqty_",
  "fund_detail_",
  "fund_manage_",
  "fund_start_",
  "fund_cancel_",
  "fund_cancelconfirm_",
];

function matchPrefix(customId) {
  return PREFIXES.find((p) => customId.startsWith(p)) || null;
}

async function loadEvent(client, customId, prefix) {
  const eventId = customId.slice(prefix.length);
  const doc = await client.hostedEventsCollection.findOne({ eventId });
  return doc;
}

function isAdmin(interaction) {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function ephemeralV2(components) {
  return { components, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function notice(opts) {
  return ephemeralV2([view.buildNotice(opts)]);
}

async function notifyHost(client, doc, content) {
  const user = await client.users.fetch(doc.hostId).catch(() => null);
  if (!user) return;
  await user.send({ content }).catch(() => {});
}

async function refreshReviewMessage(client, doc) {
  const f = doc.funding || {};
  if (!f.reviewChannelId || !f.reviewMessageId) return;
  const channel = await client.channels.fetch(f.reviewChannelId).catch(() => null);
  const msg = await channel?.messages?.fetch(f.reviewMessageId).catch(() => null);
  if (!msg) return;
  const guild = client.guilds.cache.get(doc.guildId);
  await msg
    .edit({
      components: [view.buildReviewDecidedContainer(doc, guild)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

async function handleApprove(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  if (!isAdmin(interaction)) {
    return interaction.editReply(
      notice({ title: "❌ 只有管理員能審核募資申請", kind: "bad" }),
    );
  }

  const doc = await loadEvent(client, interaction.customId, "fundreview_approve_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個申請", kind: "bad" }));

  const result = await fundraise.approve(client, doc, interaction.user);
  if (!result.ok) {
    return interaction.editReply(notice({ ...result.error, kind: "bad" }));
  }

  await refreshReviewMessage(client, result.doc);
  await notifyHost(
    client,
    result.doc,
    `✅ 你的募資活動「${result.doc.name}」已通過審核，募資已開放！\n${result.message.url}`,
  );

  return interaction.editReply(
    notice({
      title: "✅ 已通過，募資開始",
      body: `**${result.doc.name}**\n募資訊息：${result.message.url}`,
      hint: `募資將於 <t:${Math.floor(new Date(result.doc.funding.deadline).getTime() / 1000)}:R> 截止。`,
    }),
  );
}

async function handleRejectButton(client, interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply(notice({ title: "❌ 只有管理員能審核募資申請", kind: "bad" }));
  }
  const eventId = interaction.customId.slice("fundreview_reject_".length);
  const doc = await client.hostedEventsCollection.findOne({ eventId });
  if (!doc) return interaction.reply(notice({ title: "❌ 找不到這個申請", kind: "bad" }));
  if (doc.status !== "PENDING_REVIEW") {
    return interaction.reply(
      notice({ title: "❌ 這個申請已經處理過了", body: `目前狀態：${doc.status}`, kind: "bad" }),
    );
  }
  await interaction.showModal(view.buildRejectModal(eventId));
}

async function handleRejectModal(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const doc = await loadEvent(client, interaction.customId, "fundreject_modal_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個申請", kind: "bad" }));

  const reason = interaction.fields.getTextInputValue("reason").trim();
  const result = await fundraise.reject(client, doc, interaction.user, reason);
  if (!result.ok) {
    return interaction.editReply(notice({ ...result.error, kind: "bad" }));
  }

  await refreshReviewMessage(client, result.doc);
  await notifyHost(
    client,
    result.doc,
    `🚫 你的募資活動「${result.doc.name}」未通過審核。\n理由：${reason}`,
  );

  return interaction.editReply(
    notice({ title: "🚫 已駁回", body: `**${doc.name}**\n理由：${reason}`, kind: "warn" }),
  );
}

async function handleCoinButton(client, interaction) {
  const doc = await loadEvent(client, interaction.customId, "fund_coin_");
  if (!doc) return interaction.reply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));
  if (!fundraise.isFundingOpen(doc)) {
    return interaction.reply(
      notice({
        title: "⏰ 募資已截止",
        body: `「${doc.name}」目前不接受新的贊助。`,
        hint: "等主辦人開始報名後就能報名參加活動。",
        kind: "warn",
      }),
    );
  }

  const wallet = await client.userCoinsCollection.findOne({
    userId: interaction.user.id,
    guildId: doc.guildId,
  });
  const min = eventFundraise?.minCoinDonation ?? 100;
  await interaction.showModal(view.buildCoinModal(doc, wallet?.totalCoins || 0, min));
}

function donateSuccessNotice(doc, bodyLine) {
  return {
    title: "🎉 贊助成功，感謝你！",
    body:
      `${bodyLine}\n\n**${doc.name}** 目前募得 **${doc.funding.raised.toLocaleString()} / ${doc.funding.goal.toLocaleString()}** credits\n` +
      view.progressBar(doc.funding.raised, doc.funding.goal),
    hint: "這筆贊助鎖在活動錢包，只能在結算時發給參加者；活動若取消會原路退還給你。",
  };
}

async function handleCoinModal(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const doc = await loadEvent(client, interaction.customId, "fund_coinmodal_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));

  const raw = interaction.fields.getTextInputValue("amount").trim().replace(/[,，\s]/g, "");
  const amount = Number(raw);

  const result = await fundraise.donateCoins(client, doc, {
    user: interaction.user,
    member: interaction.member,
    amount: Number.isInteger(amount) ? amount : NaN,
  });
  if (!result.ok) {
    return interaction.editReply(notice({ ...result.error, kind: "bad" }));
  }

  await refreshEventMessage(client, result.doc).catch(() => {});
  return interaction.editReply(
    notice(donateSuccessNotice(result.doc, `你贊助了 **${result.amount.toLocaleString()}** credits`)),
  );
}

async function handleItemButton(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const doc = await loadEvent(client, interaction.customId, "fund_item_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));
  if (!fundraise.isFundingOpen(doc)) {
    return interaction.editReply(
      notice({ title: "⏰ 募資已截止", body: `「${doc.name}」目前不接受新的贊助。`, kind: "warn" }),
    );
  }

  const profile = await getOrCreate(client, interaction.user.id, doc.guildId);
  const owned = itemRegistry.listOwned(profile);
  if (!owned.length) {
    return interaction.editReply(
      notice({
        title: "❌ 你沒有可以贊助的物品",
        body: "背包、魚袋、菜園與道具欄都是空的。",
        hint: "去 /挖礦、/釣魚、/菜園 收成一些再回來吧。",
        kind: "bad",
      }),
    );
  }

  const container = view
    .buildNotice({
      title: `🎁 贊助物品給「${doc.name}」`,
      body: "選一種物品，接著填入要贊助的數量。",
      hint:
        owned.length > 25
          ? "你的物品種類超過 25 種，這裡只列出前 25 種。"
          : "贊助的物品會鎖進活動的物品獎池，結算時由主辦人指定發給得獎者。",
      kind: "fund",
    })
    .addActionRowComponents(view.buildOwnedItemSelect(doc, owned));

  return interaction.editReply(ephemeralV2([container]));
}

async function handleItemSelect(client, interaction) {
  const doc = await loadEvent(client, interaction.customId, "fund_itemsel_");
  if (!doc) return interaction.reply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));

  const value = interaction.values[0];
  const item = itemRegistry.resolve(value);
  if (!item) return interaction.reply(notice({ title: "❌ 找不到這個物品", kind: "bad" }));

  const profile = await getOrCreate(client, interaction.user.id, doc.guildId);
  const owned = itemRegistry.ownedQty(profile, value);
  await interaction.showModal(view.buildItemQtyModal(doc, item, owned));
}

async function handleItemQtyModal(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const rest = interaction.customId.slice("fund_itemqty_".length);
  const sep = rest.indexOf("_");
  const eventId = rest.slice(0, sep);
  const value = rest.slice(sep + 1);

  const doc = await client.hostedEventsCollection.findOne({ eventId });
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));

  const raw = interaction.fields.getTextInputValue("qty").trim().replace(/[,，\s]/g, "");
  const qty = Number(raw);

  const result = await fundraise.donateItem(client, doc, {
    user: interaction.user,
    member: interaction.member,
    value,
    qty: Number.isInteger(qty) ? qty : NaN,
  });
  if (!result.ok) {
    return interaction.editReply(notice({ ...result.error, kind: "bad" }));
  }

  await refreshEventMessage(client, result.doc).catch(() => {});
  return interaction.editReply(
    notice(
      donateSuccessNotice(
        result.doc,
        `你贊助了 **${result.item.label} ×${result.qty.toLocaleString()}**`,
      ),
    ),
  );
}

async function handleDetail(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const doc = await loadEvent(client, interaction.customId, "fund_detail_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));

  const donors = await fundraise.listDonors(client, doc.eventId);
  const guild = client.guilds.cache.get(doc.guildId);
  return interaction.editReply(ephemeralV2([view.buildDetailContainer(doc, donors, guild)]));
}

function startGate(doc) {
  const raised = doc.funding.raised || 0;
  const items = fundraise.itemPoolOf(doc);
  if (raised <= 0 && items.length === 0) {
    return { canStart: false, reason: "還沒有任何贊助，沒有東西可以當獎品。" };
  }
  return { canStart: true, reason: null };
}

async function showManagePanel(client, interaction, doc, useUpdate) {
  const ack = useUpdate
    ? await deferUpdateSafe(interaction)
    : await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral });
  if (!ack) return null;

  const isHost = interaction.user.id === doc.hostId;
  if (!isHost && !isAdmin(interaction)) {
    return interaction.editReply(
      notice({ title: "❌ 這不是你的活動", body: "只有主辦人能管理募資。", kind: "bad" }),
    );
  }
  if (doc.status === "RECRUITING") {
    return interaction.editReply(
      notice({
        title: "ℹ️ 募資已結束，活動進入報名階段",
        body: "請改用活動訊息上的「管理（限主辦人）」按鈕來結束報名或結算。",
        kind: "warn",
      }),
    );
  }
  if (doc.status !== "FUNDRAISING") {
    return interaction.editReply(
      notice({ title: "❌ 這個活動已經結束", body: `目前狀態：${doc.status}`, kind: "bad" }),
    );
  }

  const gate = startGate(doc);
  // 管理員只是來救場（主辦人跑掉時退款），不能代替主辦人開跑活動。
  const canStart = isHost && gate.canStart;
  return interaction.editReply(
    ephemeralV2([
      view.buildFundManagePanel(doc, {
        open: fundraise.isFundingOpen(doc),
        canStart,
        startBlockReason: isHost ? gate.reason : "你是以管理員身分開啟，只能取消並退款。",
      }),
    ]),
  );
}

async function handleManage(client, interaction) {
  const doc = await loadEvent(client, interaction.customId, "fund_manage_");
  if (!doc) {
    if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
    return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));
  }
  // 從取消確認畫面按「再想想」回來時要就地更新同一則 ephemeral 訊息。
  const useUpdate = interaction.message?.flags?.has?.(MessageFlags.Ephemeral) === true;
  return showManagePanel(client, interaction, doc, useUpdate);
}

async function handleStart(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;

  const doc = await loadEvent(client, interaction.customId, "fund_start_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));
  if (interaction.user.id !== doc.hostId) {
    return interaction.editReply(
      notice({ title: "❌ 這不是你的活動", body: "只有主辦人能結束募資。", kind: "bad" }),
    );
  }

  const result = await fundraise.startRecruiting(client, doc);
  if (!result.ok) {
    return interaction.editReply(notice({ ...result.error, kind: "bad" }));
  }

  const msg = await refreshEventMessage(client, result.doc).catch(() => null);
  const itemLine = view.formatItemPool(fundraise.itemPoolOf(result.doc));

  return interaction.editReply(
    notice({
      title: "🚀 募資結束，開始報名！",
      body:
        `**獎金池**：${result.prizePool.toLocaleString()} credits（必須全數發完）\n` +
        (result.retention > 0 ? `**你保留**：${result.retention.toLocaleString()} credits（結算時入帳）\n` : "") +
        (itemLine ? `**物品獎池**：${itemLine}\n` : "") +
        (msg ? `\n活動訊息：${msg.url}` : ""),
      hint: "結算時獎金總和必須剛好等於獎金池，物品也要全部指定給名次，否則無法送出。",
    }),
  );
}

async function handleCancelPrompt(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;

  const doc = await loadEvent(client, interaction.customId, "fund_cancel_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));
  if (interaction.user.id !== doc.hostId && !isAdmin(interaction)) {
    return interaction.editReply(
      notice({ title: "❌ 這不是你的活動", body: "只有主辦人或管理員能取消募資。", kind: "bad" }),
    );
  }
  return interaction.editReply(ephemeralV2([view.buildCancelConfirmContainer(doc)]));
}

async function handleCancelConfirm(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;

  const doc = await loadEvent(client, interaction.customId, "fund_cancelconfirm_");
  if (!doc) return interaction.editReply(notice({ title: "❌ 找不到這個活動", kind: "bad" }));
  if (interaction.user.id !== doc.hostId && !isAdmin(interaction)) {
    return interaction.editReply(
      notice({ title: "❌ 這不是你的活動", body: "只有主辦人或管理員能取消募資。", kind: "bad" }),
    );
  }

  try {
    const cancelled = await cancelEvent(client, doc, interaction.user);
    const summary = cancelled.fundRefund || { donorCount: 0, refundedCoins: 0, refundedItems: 0 };
    return interaction.editReply(
      notice({
        title: "🚫 活動已取消，贊助已全額退還",
        body:
          `**${cancelled.name}**\n` +
          `退還 **${summary.refundedCoins.toLocaleString()}** credits 給 ${summary.donorCount} 位贊助者` +
          (summary.refundedItems > 0 ? `\n退還物品 ${summary.refundedItems.toLocaleString()} 件` : ""),
        kind: "warn",
      }),
    );
  } catch (error) {
    console.log(`[ERROR] fundraise cancel ${doc.eventId}: ${error}\n${error.stack || ""}`.red);
    return interaction.editReply(
      notice({ title: "❌ 取消失敗", body: error.message || String(error), kind: "bad" }),
    );
  }
}

module.exports = async (client, interaction) => {
  const customId = interaction.customId;
  if (!customId) return;
  const prefix = matchPrefix(customId);
  if (!prefix) return;
  if (!client.hostedEventsCollection || !client.eventFundDonationsCollection) return;

  const rl = consume(interaction.user.id, "btn:fund", { windowMs: 1500, max: 1 });
  if (!rl.allowed) {
    const reply = {
      content: `⏳ 操作太頻繁，請 ${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (!interaction.replied && !interaction.deferred) await interaction.reply(reply);
    } catch (_) { /* noop */ }
    return;
  }

  try {
    if (interaction.isButton()) {
      if (prefix === "fundreview_approve_") return handleApprove(client, interaction);
      if (prefix === "fundreview_reject_") return handleRejectButton(client, interaction);
      if (prefix === "fund_coin_") return handleCoinButton(client, interaction);
      if (prefix === "fund_item_") return handleItemButton(client, interaction);
      if (prefix === "fund_detail_") return handleDetail(client, interaction);
      if (prefix === "fund_manage_") return handleManage(client, interaction);
      if (prefix === "fund_start_") return handleStart(client, interaction);
      if (prefix === "fund_cancelconfirm_") return handleCancelConfirm(client, interaction);
      if (prefix === "fund_cancel_") return handleCancelPrompt(client, interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (prefix === "fund_itemsel_") return handleItemSelect(client, interaction);
    } else if (interaction.isModalSubmit()) {
      if (prefix === "fundreject_modal_") return handleRejectModal(client, interaction);
      if (prefix === "fund_coinmodal_") return handleCoinModal(client, interaction);
      if (prefix === "fund_itemqty_") return handleItemQtyModal(client, interaction);
    }
  } catch (error) {
    console.log(`[ERROR] handleFundraiseInteraction (${customId}): ${error}\n${error.stack || ""}`.red);
    try {
      const payload = notice({
        title: "❌ 處理募資互動時發生錯誤",
        hint: "稍後再試一次，若持續失敗請聯絡舒舒。",
        kind: "bad",
      });
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply(payload);
    } catch (_) { /* noop */ }
  }
};
