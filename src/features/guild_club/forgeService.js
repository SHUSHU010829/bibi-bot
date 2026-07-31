require("colors");
const { guildForge, guildWarehouse } = require("../../config");
const guildClubService = require("./guildClubService");
const buildingService = require("./buildingService");
const { capacityFor, itemDef } = require("./warehouse/warehouseSettings");

const forgeCfg = () => guildForge?.forge || {};
const refineryCfg = () => guildForge?.refinery || {};

const recipeDef = (recipeKey) => forgeCfg().recipes?.[recipeKey] || null;

const allRecipeKeys = () => Object.keys(forgeCfg().recipes || {});

const upgradeForgeRow = (fromLv) =>
  (forgeCfg().upgrades || []).find((u) => u.fromLevel === fromLv) || null;

const upgradeRefineryRow = (fromLv) =>
  (refineryCfg().upgrades || []).find((u) => u.fromLevel === fromLv) || null;

const discountPctFor = (refineryLevel) => {
  if (!refineryLevel) return 0;
  const row = (refineryCfg().upgrades || []).find((u) => u.toLevel === refineryLevel);
  return row?.discountPct || 0;
};

// 算配方在精煉站等級下實扣的素材數。整體百分比折扣，向上取整避免免費漏洞。
const getEffectiveInputs = (recipeKey, refineryLevel) => {
  const recipe = recipeDef(recipeKey);
  if (!recipe) return null;
  const pct = discountPctFor(refineryLevel);
  const factor = (100 - pct) / 100;
  const out = {};
  for (const [k, v] of Object.entries(recipe.inputs)) {
    out[k] = Math.max(1, Math.ceil(v * factor));
  }
  return out;
};

const ensureRecipeUnlocked = (recipeKey, forgeLevel) => {
  const recipe = recipeDef(recipeKey);
  if (!recipe) return { ok: false, reason: "unknown_recipe" };
  if (forgeLevel < (recipe.requiresForgeLevel || 1)) {
    return {
      ok: false,
      reason: "recipe_locked",
      needForgeLevel: recipe.requiresForgeLevel,
      haveForgeLevel: forgeLevel,
    };
  }
  return { ok: true };
};

// 單原子操作從多個 warehouse rows 扣料；任何一個失敗就 rollback 已扣的。
const consumeWarehouseInputs = async (client, guildClubId, inputs) => {
  const consumed = [];
  for (const [itemId, qty] of Object.entries(inputs)) {
    const res = await client.guildClubWarehouseCollection.findOneAndUpdate(
      {
        guild_club_id: guildClubId,
        item_id: itemId,
        available_qty: { $gte: qty },
      },
      {
        $inc: { qty: -qty, available_qty: -qty },
        $set: { updated_at: new Date() },
      },
      { returnDocument: "after" }
    );
    const ok = !!(res?.value || res);
    if (!ok) {
      for (const c of consumed) {
        await client.guildClubWarehouseCollection.updateOne(
          { guild_club_id: guildClubId, item_id: c.itemId },
          {
            $inc: { qty: c.qty, available_qty: c.qty },
            $set: { updated_at: new Date() },
          }
        ).catch(() => {});
      }
      return { ok: false, reason: "not_enough_in_warehouse", item_id: itemId };
    }
    consumed.push({ itemId, qty });
  }
  return { ok: true };
};

const writeOutputToWarehouse = async (client, guildClubId, itemId, qty) => {
  await client.guildClubWarehouseCollection.updateOne(
    { guild_club_id: guildClubId, item_id: itemId },
    {
      $setOnInsert: {
        guild_club_id: guildClubId,
        item_id: itemId,
        pending: [],
      },
      $inc: { qty, available_qty: qty },
      $set: { updated_at: new Date() },
    },
    { upsert: true }
  );
};

const craft = async (client, { userId, guildId, recipeKey, qty }) => {
  if (!guildForge?.enabled) return { ok: false, reason: "disabled" };
  if (!Number.isInteger(qty) || qty <= 0)
    return { ok: false, reason: "invalid_qty" };

  const membership = await guildClubService.getMembership(client, userId, guildId);
  if (!membership) return { ok: false, reason: "not_in_club" };

  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const need = forgeCfg().unlockClubLevel || 4;
  if ((club.level || 1) < need)
    return { ok: false, reason: "club_level_locked", need, have: club.level || 1 };

  const forgeLv = guildClubService.forgeLevelOf(club);
  if (forgeLv < 1)
    return { ok: false, reason: "forge_not_built", need_club_level: need };

  const unlock = ensureRecipeUnlocked(recipeKey, forgeLv);
  if (!unlock.ok) return unlock;

  const recipe = recipeDef(recipeKey);
  const refineryLv = guildClubService.refineryLevelOf(club);
  const perInputs = getEffectiveInputs(recipeKey, refineryLv);
  const totalInputs = {};
  for (const [k, v] of Object.entries(perInputs)) totalInputs[k] = v * qty;

  // 預檢：每個輸入在公會倉庫的 available_qty。先報缺料完整清單，不要扣到一半才失敗。
  const lacks = [];
  for (const [itemId, need] of Object.entries(totalInputs)) {
    const row = await client.guildClubWarehouseCollection.findOne({
      guild_club_id: club.guild_club_id,
      item_id: itemId,
    });
    const have = row?.available_qty || 0;
    if (have < need) lacks.push({ item_id: itemId, need, have });
  }
  if (lacks.length > 0) return { ok: false, reason: "insufficient_inputs", lacks };

  // 容量檢查：產出物
  const outputQty = (recipe.output || 1) * qty;
  const totalCap = capacityFor(recipeKey, club.level, club.warehouse_settings, club);
  const existing = await client.guildClubWarehouseCollection.findOne({
    guild_club_id: club.guild_club_id,
    item_id: recipeKey,
  });
  const current = existing?.qty || 0;
  if (current + outputQty > totalCap) {
    return {
      ok: false,
      reason: "capacity_exceeded",
      item_id: recipeKey,
      have: current,
      cap: totalCap,
      add: outputQty,
    };
  }

  const consume = await consumeWarehouseInputs(client, club.guild_club_id, totalInputs);
  if (!consume.ok) return consume;

  await writeOutputToWarehouse(client, club.guild_club_id, recipeKey, outputQty);

  const now = new Date();
  await client.guildClubWarehouseLogsCollection.insertMany([
    ...Object.entries(totalInputs).map(([item_id, q]) => ({
      guild_club_id: club.guild_club_id,
      user_id: userId,
      action: "forge_consume",
      item_id,
      qty: q,
      fee: 0,
      market_value: 0,
      created_at: now,
    })),
    {
      guild_club_id: club.guild_club_id,
      user_id: userId,
      action: "forge_produce",
      item_id: recipeKey,
      qty: outputQty,
      fee: 0,
      market_value: 0,
      created_at: now,
    },
  ]).catch(() => {});

  return {
    ok: true,
    club,
    recipeKey,
    recipe,
    qty,
    inputsUsed: totalInputs,
    outputQty,
    discountPct: discountPctFor(refineryLv),
  };
};

const upgradeForge = async (client, { userId, guildId }) => {
  if (!guildForge?.enabled) return { ok: false, reason: "disabled" };

  const membership = await guildClubService.getMembership(client, userId, guildId);
  if (!membership) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(membership.role))
    return { ok: false, reason: "not_manager" };

  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const need = forgeCfg().unlockClubLevel || 4;
  if ((club.level || 1) < need)
    return { ok: false, reason: "club_level_locked", need, have: club.level || 1 };

  const currentLv = guildClubService.forgeLevelOf(club);
  const upgrade = upgradeForgeRow(currentLv);
  if (!upgrade) return { ok: false, reason: "max_level_reached", current: currentLv };

  if ((club.treasury_current || 0) < upgrade.cost)
    return {
      ok: false,
      reason: "insufficient_treasury",
      need: upgrade.cost,
      have: club.treasury_current || 0,
    };

  const upd = await client.guildsClubCollection.findOneAndUpdate(
    {
      guild_club_id: club.guild_club_id,
      // currentLv === 0 時也要匹配舊公會「欄位不存在」的文件
      $or: currentLv === 0
        ? [{ forge_level: 0 }, { forge_level: { $exists: false } }]
        : [{ forge_level: currentLv }],
      treasury_current: { $gte: upgrade.cost },
    },
    {
      $set: { forge_level: upgrade.toLevel, updated_at: new Date() },
      $inc: { treasury_current: -upgrade.cost },
    },
    { returnDocument: "after" }
  );
  const newDoc = upd?.value || upd;
  if (!newDoc) return { ok: false, reason: "race_lost" };

  await client.guildClubLogsCollection.insertOne({
    guild_club_id: club.guild_club_id,
    user_id: userId,
    amount: -upgrade.cost,
    source: "forge_upgrade",
    meta: { fromLevel: currentLv, toLevel: upgrade.toLevel },
    createdAt: new Date(),
  }).catch(() => {});

  return { ok: true, club: newDoc, fromLevel: currentLv, toLevel: upgrade.toLevel, cost: upgrade.cost };
};

const upgradeRefinery = async (client, { userId, guildId }) => {
  if (!guildForge?.enabled) return { ok: false, reason: "disabled" };

  const membership = await guildClubService.getMembership(client, userId, guildId);
  if (!membership) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(membership.role))
    return { ok: false, reason: "not_manager" };

  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const need = refineryCfg().unlockClubLevel || 5;
  if ((club.level || 1) < need)
    return { ok: false, reason: "club_level_locked", need, have: club.level || 1 };

  const currentLv = guildClubService.refineryLevelOf(club);
  const upgrade = upgradeRefineryRow(currentLv);
  if (!upgrade) return { ok: false, reason: "max_level_reached", current: currentLv };

  if ((club.treasury_current || 0) < upgrade.cost)
    return {
      ok: false,
      reason: "insufficient_treasury",
      need: upgrade.cost,
      have: club.treasury_current || 0,
    };

  // 高階升級除了金庫還要材料（例：魔晶礦）。先扣材料，等級沒升成再還回去。
  const materials = upgrade.materials || {};
  if (Object.keys(materials).length > 0) {
    const consumed = await consumeWarehouseInputs(client, club.guild_club_id, materials);
    if (!consumed.ok) {
      const row = await client.guildClubWarehouseCollection
        .findOne({ guild_club_id: club.guild_club_id, item_id: consumed.item_id })
        .catch(() => null);
      return {
        ok: false,
        reason: "insufficient_materials",
        item_id: consumed.item_id,
        need: materials[consumed.item_id],
        have: row?.available_qty || 0,
      };
    }
  }

  const upd = await client.guildsClubCollection.findOneAndUpdate(
    {
      guild_club_id: club.guild_club_id,
      $or: currentLv === 0
        ? [{ refinery_level: 0 }, { refinery_level: { $exists: false } }]
        : [{ refinery_level: currentLv }],
      treasury_current: { $gte: upgrade.cost },
    },
    {
      $set: { refinery_level: upgrade.toLevel, updated_at: new Date() },
      $inc: { treasury_current: -upgrade.cost },
    },
    { returnDocument: "after" }
  );
  const newDoc = upd?.value || upd;
  if (!newDoc) {
    for (const [itemId, qty] of Object.entries(materials)) {
      await client.guildClubWarehouseCollection.updateOne(
        { guild_club_id: club.guild_club_id, item_id: itemId },
        { $inc: { qty, available_qty: qty }, $set: { updated_at: new Date() } }
      ).catch(() => {});
    }
    return { ok: false, reason: "race_lost" };
  }

  await client.guildClubLogsCollection.insertOne({
    guild_club_id: club.guild_club_id,
    user_id: userId,
    amount: -upgrade.cost,
    source: "refinery_upgrade",
    meta: { fromLevel: currentLv, toLevel: upgrade.toLevel, materials },
    createdAt: new Date(),
  }).catch(() => {});

  return { ok: true, club: newDoc, fromLevel: currentLv, toLevel: upgrade.toLevel, cost: upgrade.cost, materials };
};

module.exports = {
  craft,
  upgradeForge,
  upgradeRefinery,
  getEffectiveInputs,
  discountPctFor,
  recipeDef,
  allRecipeKeys,
  upgradeForgeRow,
  upgradeRefineryRow,
};
