// 世界事件按鈕處理器
//
// customId prefix: we_
//   we_view_<eventDbId>                       — 從公告點查看（不限 user）
//   we_donate_<viewerId>_<eventDbId>          — 開啟捐獻選單
//   we_pick_<viewerId>_<eventDbId>            — Select 選物品
//   we_give_<viewerId>_<eventDbId>_<itemId>_<qty> — 確認捐獻

require("colors");
const { MessageFlags } = require("discord.js");

const worldEventService = require("../../features/world_event/worldEventService");
const worldEventView = require("../../features/world_event/worldEventView");
const { guildWarehouse } = require("../../config");

const replyEphem = (interaction, c) =>
  interaction.reply({
    components: [c],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });

const updateMsg = (interaction, c) =>
  interaction.update({ components: [c], flags: MessageFlags.IsComponentsV2 });

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
  const eventDbId = interaction.customId.split("_")[2];
  const event = await loadEvent(client, eventDbId);
  if (!event) {
    return replyEphem(
      interaction,
      worldEventView.buildSimpleError({
        title: "❌ 事件不存在",
        body: "可能已結束。",
      })
    );
  }
  return replyEphem(
    interaction,
    worldEventView.buildHomePanel({
      viewerId: interaction.user.id,
      events: [event],
    })
  );
}

async function handleDonate(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[2];
  const eventDbId = parts[3];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const event = await loadEvent(client, eventDbId);
  if (!event || event.state !== "collecting") {
    return updateMsg(
      interaction,
      worldEventView.buildSimpleError({
        title: "❌ 事件已結束",
        body: "此事件不再接受捐獻。",
      })
    );
  }
  return updateMsg(
    interaction,
    worldEventView.buildDonatePicker({ viewerId, event })
  );
}

async function handlePick(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[2];
  const eventDbId = parts[3];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const itemId = interaction.values?.[0];
  const event = await loadEvent(client, eventDbId);
  if (!event || !itemId || event.state !== "collecting") {
    return updateMsg(
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
  return updateMsg(
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
  const parts = interaction.customId.split("_");
  // we_give_<viewerId>_<eventDbId>_<itemId>_<qty>
  const viewerId = parts[2];
  const eventDbId = parts[3];
  const itemId = parts[4];
  const qty = parseInt(parts[5], 10);
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const r = await worldEventService.donate(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    eventDbId,
    itemId,
    qty,
  });
  if (!r.ok) {
    return updateMsg(interaction, donateErrorView(r));
  }
  return updateMsg(
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
  return worldEventView.buildSimpleError({
    title: "❌ 捐獻失敗",
    body: `原因：${reason}`,
  });
}

module.exports = async (client, interaction) => {
  const id = interaction.customId || "";
  if (!id.startsWith("we_")) return;

  try {
    if (interaction.isStringSelectMenu?.()) {
      if (id.startsWith("we_pick_")) return handlePick(client, interaction);
    }
    if (!interaction.isButton()) return;
    if (id.startsWith("we_view_")) return handleView(client, interaction);
    if (id.startsWith("we_donate_")) return handleDonate(client, interaction);
    if (id.startsWith("we_give_")) return handleGive(client, interaction);
  } catch (e) {
    console.log(`[WORLD_EVENT] ${id} 失敗：${e.stack || e.message}`.red);
  }
};
