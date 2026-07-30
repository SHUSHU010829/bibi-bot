// 世界事件按鈕處理器
//
// customId（dispatch 用 _，欄位用 |，因為 eventDbId / itemId 本身含 _）：
//   we_view|<eventDbId>                       — 從公告點查看（不限 user）
//   we_donate|<viewerId>|<eventDbId>          — 開啟捐獻選單
//   we_pick|<viewerId>|<eventDbId>            — Select 選物品
//   we_give|<viewerId>|<eventDbId>|<itemId>|<qty> — 確認捐獻

require("colors");
const { MessageFlags } = require("discord.js");

const worldEventService = require("../../features/world_event/worldEventService");
const { itemLabel } = require("../../features/world_event/worldEventItems");
const worldEventView = require("../../features/world_event/worldEventView");
const { guildWarehouse } = require("../../config");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");

const splitId = (id) => id.split("|");

const editReplyV2 = (interaction, c) =>
  interaction.editReply({
    components: [c],
    flags: MessageFlags.IsComponentsV2,
  });

const verifyViewer = (interaction, viewerId) => {
  if (interaction.user.id !== viewerId) {
    return interaction
      .reply({ content: "這不是你的面板。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
  return null;
};

async function loadEvent(client, eventDbId) {
  return await client.worldEventsCollection
    .findOne({ event_db_id: eventDbId })
    .catch(() => null);
}

async function getPersonalQty(client, userId, guildId, itemId) {
  // 逼幣存在 UserCoins，不在任何袋子裡
  if (itemId === worldEventService.CURRENCY_ITEM) {
    const c = await client.userCoinsCollection?.findOne({ userId, guildId }).catch(() => null);
    return c?.totalCoins || 0;
  }
  const meta = guildWarehouse?.items?.[itemId];
  const bag =
    meta?.kind === "fish_bag"
      ? "fish_bag"
      : meta?.kind === "veggie_bag"
      ? "veggie_bag"
      : "backpack";
  const p = await client.miningProfilesCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  return p?.[bag]?.[itemId] || 0;
}

async function getGuildQty(client, userId, guildId, itemId) {
  if (itemId === worldEventService.CURRENCY_ITEM) return 0;
  const m = await client.guildClubMembersCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!m) return 0;
  const r = await client.guildClubWarehouseCollection
    .findOne({ guild_club_id: m.guild_club_id, item_id: itemId })
    .catch(() => null);
  return r?.available_qty || 0;
}

async function handleView(client, interaction) {
  // we_view|<eventDbId>
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const eventDbId = splitId(interaction.customId)[1];
  const event = await loadEvent(client, eventDbId);
  if (!event) {
    return editReplyV2(
      interaction,
      worldEventView.buildSimpleError({
        title: "❌ 事件不存在",
        body: "可能已結束。",
      })
    );
  }
  return editReplyV2(
    interaction,
    worldEventView.buildHomePanel({
      viewerId: interaction.user.id,
      events: [event],
    })
  );
}

async function handleDonate(client, interaction) {
  // we_donate|<viewerId>|<eventDbId>
  const parts = splitId(interaction.customId);
  const viewerId = parts[1];
  const eventDbId = parts[2];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  if (!(await deferUpdateSafe(interaction))) return;

  const event = await loadEvent(client, eventDbId);
  if (!event || event.state !== "collecting") {
    return editReplyV2(
      interaction,
      worldEventView.buildSimpleError({
        title: "❌ 事件已結束",
        body: "此事件不再接受捐獻。",
      })
    );
  }
  return editReplyV2(
    interaction,
    worldEventView.buildDonatePicker({ viewerId, event })
  );
}

async function handlePick(client, interaction) {
  // we_pick|<viewerId>|<eventDbId>
  const parts = splitId(interaction.customId);
  const viewerId = parts[1];
  const eventDbId = parts[2];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  if (!(await deferUpdateSafe(interaction))) return;

  const itemId = interaction.values?.[0];
  const event = await loadEvent(client, eventDbId);
  if (!event || !itemId || event.state !== "collecting") {
    return editReplyV2(
      interaction,
      worldEventView.buildSimpleError({
        title: "❌ 事件已結束",
        body: "此事件不再接受捐獻。",
      })
    );
  }
  const [maxPersonal, maxGuild] = await Promise.all([
    getPersonalQty(client, interaction.user.id, interaction.guildId, itemId),
    getGuildQty(client, interaction.user.id, interaction.guildId, itemId),
  ]);
  return editReplyV2(
    interaction,
    worldEventView.buildQtyPicker({
      viewerId,
      event,
      itemId,
      maxPersonal,
      maxGuild,
    })
  );
}

async function handleGive(client, interaction) {
  // we_give|<viewerId>|<eventDbId>|<itemId>|<qty>
  const parts = splitId(interaction.customId);
  const viewerId = parts[1];
  const eventDbId = parts[2];
  const itemId = parts[3];
  const qty = parseInt(parts[4], 10);
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  if (!(await deferUpdateSafe(interaction))) return;

  const r = await worldEventService.donate(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    eventDbId,
    itemId,
    qty,
  });
  if (!r.ok) {
    return editReplyV2(interaction, donateErrorView(r));
  }
  return editReplyV2(
    interaction,
    worldEventView.buildDonateSuccess({
      event: r.event,
      deposited: r.deposited,
      fromPersonal: r.fromPersonal,
      fromGuild: r.fromGuild,
      itemId,
      completed: r.completed,
      buffEndsAt: r.buffEndsAt,
    })
  );
}

function donateErrorView(r) {
  const reason = r.reason;
  if (reason === "event_not_found" || reason === "event_not_collecting" || reason === "event_expired")
    return worldEventView.buildSimpleError({
      title: "❌ 事件無法捐獻",
      body: "此事件已不在募集階段。",
    });
  if (reason === "no_more_needed")
    return worldEventView.buildSimpleError({
      title: "❌ 此物資已滿",
      body: "事件已達到此物資的徵集上限。",
    });
  if (reason === "insufficient_personal")
    return worldEventView.buildSimpleError({
      title: "❌ 個人背包不足",
      body: "你的數量不夠捐這麼多。",
    });
  if (reason === "insufficient_guild_warehouse")
    return worldEventView.buildSimpleError({
      title: "❌ 公會倉庫不足",
      body: "公會倉庫的此物資不夠這次捐獻量。",
    });
  if (reason === "guild_source_needs_membership")
    return worldEventView.buildSimpleError({
      title: "❌ 必須在公會中才能用公會倉庫",
      body: "個人背包不足以填滿此次捐獻，且你不在公會。",
    });
  if (reason === "no_pioneer_hammer")
    return worldEventView.buildSimpleError({
      title: "🔒 還沒有拓荒錘",
      body: "全服共建活動需要先打造 **🔨 拓荒錘** 才能投入資源。\n合成材料：鐵礦 ×50、煤炭 ×10（非消耗品，打一把用到底）",
      hint: "到 `/工坊` →「合成」→「活動」分頁打造",
    });
  if (reason === "daily_limit")
    return worldEventView.buildSimpleError({
      title: "⏳ 今天的投入額度已用完",
      body: `**${itemLabel(r.item_id)}** 每日上限 ${(r.limit || 0).toLocaleString()}，你今天已投入 ${(r.usedToday || 0).toLocaleString()}。`,
      hint: "每日上限是為了讓活動撐過多天，明天 00:00（台北）重置",
    });
  if (reason === "insufficient_coins")
    return worldEventView.buildSimpleError({
      title: "❌ 逼幣不足",
      body: `需要 ${(r.need || 0).toLocaleString()} 逼幣，你只有 ${(r.have || 0).toLocaleString()}。`,
      hint: "去 `/打工`、`/地下城` 或賣點礦石再回來",
    });
  return worldEventView.buildSimpleError({
    title: "❌ 捐獻失敗",
    body: "這次捐獻沒有成功，請再試一次。",
    hint: "若持續發生請呼叫舒舒",
  });
}

module.exports = async (client, interaction) => {
  const id = interaction.customId || "";
  if (!id.startsWith("we_")) return;

  const prefix = id.split("|")[0];

  try {
    if (interaction.isStringSelectMenu?.()) {
      if (prefix === "we_pick") return handlePick(client, interaction);
    }
    if (!interaction.isButton()) return;
    if (prefix === "we_view") return handleView(client, interaction);
    if (prefix === "we_donate") return handleDonate(client, interaction);
    if (prefix === "we_give") return handleGive(client, interaction);
  } catch (e) {
    console.log(`[WORLD_EVENT] ${id} 失敗：${e.stack || e.message}`.red);
  }
};
