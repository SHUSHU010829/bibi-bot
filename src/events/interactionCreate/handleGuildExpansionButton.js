// 公會擴張系統按鈕處理器：熔爐 / 精煉站 / 公會建築
//
// customId 命名（prefix gcx_）：
//   gcx_forge_pick_<viewerId>_<guildClubId>            — Select 選配方 → 顯示數量面板
//   gcx_forge_make_<viewerId>_<guildClubId>_<recipeKey>_<qty> — 確認製造
//   gcx_forge_up_<viewerId>_<guildClubId>              — 升級熔爐
//   gcx_refinery_up_<viewerId>_<guildClubId>           — 升級精煉站
//   gcx_forge_back_<guildClubId>                       — 回熔爐主面板
//   gcx_bld_pick_<viewerId>_<guildClubId>              — Select 選建築 → 顯示確認
//   gcx_bld_confirm_<viewerId>_<guildClubId>_<kind>    — 確認升級建築
//   gcx_bld_cancel_<viewerId>                          — 取消
//   gcx_bld_back_<guildClubId>                         — 回建築主面板

require("colors");
const { MessageFlags } = require("discord.js");

const guildClubService = require("../../features/guild_club/guildClubService");
const forgeService = require("../../features/guild_club/forgeService");
const buildingService = require("../../features/guild_club/buildingService");
const warehouseService = require("../../features/guild_club/warehouse/warehouseService");
const expansionView = require("../../features/guild_club/expansionView");
const { guildForge } = require("../../config");

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

async function loadClub(client, guildClubId) {
  return await guildClubService.getClubById(client, guildClubId).catch(() => null);
}

async function loadMembership(client, userId, guildId) {
  return await guildClubService.getMembership(client, userId, guildId).catch(() => null);
}

async function renderForgePanel(client, interaction, club) {
  const warehouseRows = await warehouseService
    .getInventory(client, club.guild_club_id)
    .catch(() => []);
  const m = await loadMembership(client, interaction.user.id, interaction.guildId);
  const isManager = !!(m && guildClubService.isManager(m.role) && m.guild_club_id === club.guild_club_id);
  return expansionView.buildForgePanel({
    viewerId: interaction.user.id,
    club,
    warehouseRows,
    isManager,
  });
}

async function renderBuildingsPanel(client, interaction, club) {
  const warehouseRows = await warehouseService
    .getInventory(client, club.guild_club_id)
    .catch(() => []);
  const m = await loadMembership(client, interaction.user.id, interaction.guildId);
  const isManager = !!(m && guildClubService.isManager(m.role) && m.guild_club_id === club.guild_club_id);
  return expansionView.buildBuildingsPanel({
    viewerId: interaction.user.id,
    club,
    warehouseRows,
    isManager,
  });
}

async function handleForgePick(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[3];
  const guildClubId = parts[4];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const recipeKey = interaction.values?.[0];
  const club = await loadClub(client, guildClubId);
  if (!club || !recipeKey)
    return updateMsg(interaction, expansionView.buildSimpleError({ title: "❌ 找不到資料", body: "公會或配方不存在。" }));

  const refineryLv = guildClubService.refineryLevelOf(club);
  const inputs = forgeService.getEffectiveInputs(recipeKey, refineryLv);
  let maxQty = Infinity;
  for (const [k, v] of Object.entries(inputs)) {
    const row = await client.guildClubWarehouseCollection
      .findOne({ guild_club_id: club.guild_club_id, item_id: k })
      .catch(() => null);
    const avail = row?.available_qty || 0;
    maxQty = Math.min(maxQty, Math.floor(avail / v));
  }
  if (!Number.isFinite(maxQty)) maxQty = 0;

  return updateMsg(
    interaction,
    expansionView.buildForgeQtyPanel({
      viewerId,
      club,
      recipeKey,
      maxQty,
    })
  );
}

async function handleForgeMake(client, interaction) {
  const parts = interaction.customId.split("_");
  // gcx_forge_make_<viewerId>_<guildClubId>_<recipeKey>_<qty>
  const viewerId = parts[3];
  const recipeKey = parts[5];
  const qty = parseInt(parts[6], 10);
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const result = await forgeService.craft(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    recipeKey,
    qty,
  });

  if (!result.ok) {
    return updateMsg(interaction, forgeErrorView(result));
  }

  return updateMsg(
    interaction,
    expansionView.buildForgeSuccess({
      club: result.club,
      recipe: result.recipe,
      qty: result.qty,
      outputQty: result.outputQty,
      inputsUsed: result.inputsUsed,
      discountPct: result.discountPct,
    })
  );
}

async function handleForgeUpgrade(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[3];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const result = await forgeService.upgradeForge(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  if (!result.ok) return updateMsg(interaction, forgeErrorView(result));

  return updateMsg(
    interaction,
    expansionView.buildForgeUpgradeSuccess({
      club: result.club,
      target: "forge",
      fromLevel: result.fromLevel,
      toLevel: result.toLevel,
    })
  );
}

async function handleRefineryUpgrade(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[3];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const result = await forgeService.upgradeRefinery(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  if (!result.ok) return updateMsg(interaction, forgeErrorView(result));

  return updateMsg(
    interaction,
    expansionView.buildForgeUpgradeSuccess({
      club: result.club,
      target: "refinery",
      fromLevel: result.fromLevel,
      toLevel: result.toLevel,
    })
  );
}

async function handleForgeBack(client, interaction) {
  const parts = interaction.customId.split("_");
  const guildClubId = parts[3];
  const club = await loadClub(client, guildClubId);
  if (!club) return;
  return updateMsg(interaction, await renderForgePanel(client, interaction, club));
}

async function handleBldPick(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[3];
  const guildClubId = parts[4];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const kind = interaction.values?.[0];
  const club = await loadClub(client, guildClubId);
  if (!club || !kind) return;
  const lv = guildClubService.buildingsOf(club)[kind] || 0;
  const next = buildingService.nextLevelRow(kind, lv);
  if (!next) return;
  return updateMsg(
    interaction,
    expansionView.buildBuildingConfirmPanel({
      viewerId,
      club,
      kind,
      next: next.level,
      cost: next.cost,
    })
  );
}

async function handleBldConfirm(client, interaction) {
  const parts = interaction.customId.split("_");
  // gcx_bld_confirm_<viewerId>_<guildClubId>_<kind>
  const viewerId = parts[3];
  const kind = parts[5];
  const blocked = verifyViewer(interaction, viewerId);
  if (blocked) return blocked;

  const result = await buildingService.upgradeBuilding(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    kind,
  });
  if (!result.ok) return updateMsg(interaction, buildingErrorView(result));

  return updateMsg(
    interaction,
    expansionView.buildBuildingUpgradeSuccess({
      club: result.club,
      kind: result.kind,
      fromLevel: result.fromLevel,
      toLevel: result.toLevel,
    })
  );
}

async function handleBldCancel(client, interaction) {
  // 從 customId 解析不到 guildClubId 時，找成員資料
  const m = await loadMembership(client, interaction.user.id, interaction.guildId);
  if (!m) return interaction.deferUpdate().catch(() => {});
  const club = await loadClub(client, m.guild_club_id);
  if (!club) return interaction.deferUpdate().catch(() => {});
  return updateMsg(interaction, await renderBuildingsPanel(client, interaction, club));
}

async function handleBldBack(client, interaction) {
  const parts = interaction.customId.split("_");
  const guildClubId = parts[3];
  const club = await loadClub(client, guildClubId);
  if (!club) return;
  return updateMsg(interaction, await renderBuildingsPanel(client, interaction, club));
}

// ───────── 錯誤訊息 ─────────

function forgeErrorView(result) {
  const r = result.reason;
  if (r === "club_level_locked")
    return expansionView.buildSimpleError({
      title: "🔒 公會等級不足",
      body: `熔爐需要公會等級 ${result.need}，目前 Lv.${result.have}。`,
      hint: "用 /公會 捐款 累積金庫升等。",
    });
  if (r === "forge_not_built")
    return expansionView.buildSimpleError({
      title: "🔥 熔爐尚未建造",
      body: "請會長 / 副會長先建造熔爐才能製造。",
    });
  if (r === "recipe_locked")
    return expansionView.buildSimpleError({
      title: "🔒 配方未解鎖",
      body: `需熔爐 Lv.${result.needForgeLevel}，目前 Lv.${result.haveForgeLevel}。`,
      hint: "再升一級熔爐就會開放此配方。",
    });
  if (r === "insufficient_inputs") {
    const lines = result.lacks
      .map((l) => {
        const { guildWarehouse } = require("../../config");
        const name = guildWarehouse.items[l.item_id]?.name || l.item_id;
        return `• ${name}：需要 ${l.need}，公會倉庫有 ${l.have}（缺 ${l.need - l.have}）`;
      })
      .join("\n");
    return expansionView.buildSimpleError({
      title: "❌ 公會倉庫材料不足",
      body: lines,
      hint: "用 /公會 存入 把成員背包的素材搬到公會倉庫。",
    });
  }
  if (r === "capacity_exceeded") {
    const { guildWarehouse } = require("../../config");
    const name = guildWarehouse.items[result.item_id]?.name || result.item_id;
    return expansionView.buildSimpleError({
      title: "❌ 公會倉庫已滿",
      body: `${name} 目前 ${result.have}/${result.cap}，再加 ${result.add} 就超過。`,
      hint: "蓋倉庫擴建以提升容量。",
    });
  }
  if (r === "max_level_reached")
    return expansionView.buildSimpleError({
      title: "🏆 已達最高等級",
      body: `目前 Lv.${result.current} 已是滿級。`,
    });
  if (r === "insufficient_treasury")
    return expansionView.buildSimpleError({
      title: "❌ 公會資金不足",
      body: `需要 ${result.need.toLocaleString()}，目前 ${result.have.toLocaleString()}（差 ${(result.need - result.have).toLocaleString()}）。`,
      hint: "用 /公會 捐款 累積金庫。",
    });
  if (r === "not_manager")
    return expansionView.buildSimpleError({
      title: "❌ 權限不足",
      body: "只有會長 / 副會長能升級熔爐 / 精煉站。",
    });
  if (r === "race_lost")
    return expansionView.buildSimpleError({
      title: "⏳ 操作衝突",
      body: "別的會員剛剛動了金庫，請再點一次。",
    });
  return expansionView.buildSimpleError({
    title: "❌ 操作失敗",
    body: `原因：${r}`,
  });
}

function buildingErrorView(result) {
  const r = result.reason;
  if (r === "not_manager")
    return expansionView.buildSimpleError({
      title: "❌ 權限不足",
      body: "只有會長 / 副會長能升級公會建築。",
    });
  if (r === "club_level_locked")
    return expansionView.buildSimpleError({
      title: "🔒 公會等級不足",
      body: `公會建築需要公會 Lv.${result.need}，目前 Lv.${result.have}。`,
    });
  if (r === "max_level_reached")
    return expansionView.buildSimpleError({
      title: "🏆 已達最高等級",
      body: `目前 Lv.${result.current} 已是滿級。`,
    });
  if (r === "insufficient_resources") {
    const { guildWarehouse } = require("../../config");
    const lines = result.lacks
      .map((l) => {
        if (l.resource === "coins")
          return `• 公會資金：需要 ${l.need.toLocaleString()}，目前 ${l.have.toLocaleString()}（缺 ${(l.need - l.have).toLocaleString()}）`;
        const name = guildWarehouse.items[l.resource]?.name || l.resource;
        return `• ${name}：需要 ${l.need}，倉庫有 ${l.have}（缺 ${l.need - l.have}）`;
      })
      .join("\n");
    return expansionView.buildSimpleError({
      title: "❌ 升級條件不足",
      body: lines,
      hint: "熔爐製造建材 / 鋼錠、捐款累積資金，再回來升級。",
    });
  }
  if (r === "race_lost" || r === "race_lost_club")
    return expansionView.buildSimpleError({
      title: "⏳ 操作衝突",
      body: "別人剛剛動了倉庫 / 金庫，請再點一次。",
    });
  return expansionView.buildSimpleError({
    title: "❌ 升級失敗",
    body: `原因：${r}`,
  });
}

module.exports = async (client, interaction) => {
  const id = interaction.customId || "";
  if (!id.startsWith("gcx_")) return;

  try {
    if (interaction.isStringSelectMenu?.()) {
      if (id.startsWith("gcx_forge_pick_")) return handleForgePick(client, interaction);
      if (id.startsWith("gcx_bld_pick_")) return handleBldPick(client, interaction);
    }
    if (!interaction.isButton()) return;

    if (id.startsWith("gcx_forge_make_")) return handleForgeMake(client, interaction);
    if (id.startsWith("gcx_forge_up_")) return handleForgeUpgrade(client, interaction);
    if (id.startsWith("gcx_refinery_up_")) return handleRefineryUpgrade(client, interaction);
    if (id.startsWith("gcx_forge_back_")) return handleForgeBack(client, interaction);
    if (id.startsWith("gcx_bld_confirm_")) return handleBldConfirm(client, interaction);
    if (id.startsWith("gcx_bld_cancel_")) return handleBldCancel(client, interaction);
    if (id.startsWith("gcx_bld_back_")) return handleBldBack(client, interaction);
  } catch (e) {
    console.log(`[GUILD_EXPANSION] ${id} 失敗：${e.stack || e.message}`.red);
    try {
      const view = expansionView.buildSimpleError({
        title: "❌ 操作出錯",
        body: "出了點狀況，請稍後再試。",
      });
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({ components: [view], flags: MessageFlags.IsComponentsV2 });
      else
        await interaction.reply({
          components: [view],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
    } catch (_) {}
  }
};
