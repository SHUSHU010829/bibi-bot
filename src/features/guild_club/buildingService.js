require("colors");
const { guildBuildings, dungeon } = require("../../config");
const guildClubService = require("./guildClubService");

const buildingCfg = () => guildBuildings || {};
const allKinds = () => Object.keys(buildingCfg().kinds || {});
const kindDef = (kind) => buildingCfg().kinds?.[kind] || null;
const levelRow = (kind, level) =>
  (kindDef(kind)?.levels || []).find((l) => l.level === level) || null;
const nextLevelRow = (kind, currentLevel) =>
  (kindDef(kind)?.levels || []).find((l) => l.level === currentLevel + 1) || null;

// 每種建築可獨立設 unlockClubLevel；缺則 fallback 到 root 設定。
const unlockClubLevelOf = (kind) =>
  kindDef(kind)?.unlockClubLevel || buildingCfg().unlockClubLevel || 2;

// 查使用者所屬公會的建築 buff（給 farmService / cookService / mineService 等呼叫）。
// 沒公會或公會解散 → 空物件。所有非主要流程 catch 吞掉，不擋玩家動作。
async function getMemberBuildingBuffs(client, userId, guildId) {
  if (!guildBuildings?.enabled) return {};
  if (!client?.guildClubMembersCollection || !client?.guildsClubCollection) return {};
  const m = await client.guildClubMembersCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!m) return {};
  const club = await client.guildsClubCollection
    .findOne({ guild_club_id: m.guild_club_id, disbanded_at: null })
    .catch(() => null);
  if (!club) return {};
  return buildingsBuffs(club);
}

// 倉庫擴建：累加 [≤lv] 的 capacity_bonus
const warehouseCapacityBonus = (club) => {
  if (!guildBuildings?.enabled) return 0;
  const lv = guildClubService.buildingsOf(club).warehouse;
  if (lv === 0) return 0;
  let total = 0;
  for (const row of (buildingCfg().kinds?.warehouse?.levels || [])) {
    if (row.level <= lv) total += row.capacity_bonus || 0;
  }
  return total;
};

// 取礦坑 / 訓練場目前等級對應「該等級行」的 buffs（覆蓋式，不累加之前等級；
// PDF 表上已給累積總值，所以只看當前 row 即可）。
const buildingsBuffs = (club) => {
  if (!guildBuildings?.enabled) return {};
  const cfg = buildingCfg();
  const out = {};
  const lvByKind = guildClubService.buildingsOf(club);
  for (const kind of allKinds()) {
    if (kind === "warehouse") continue;
    const lv = lvByKind[kind] || 0;
    if (lv === 0) continue;
    const row = levelRow(kind, lv);
    for (const b of row?.buffs || []) {
      out[b.type] = (out[b.type] || 0) + (b.value || 0);
    }
  }
  return out;
};

// 依「下一級」row 算所需材料 + 是否夠用；不夠的列出 lacks。
const checkUpgradeRequirements = async (client, club, kind) => {
  const cfg = kindDef(kind);
  if (!cfg) return { ok: false, reason: "unknown_kind" };
  const lv = guildClubService.buildingsOf(club)[kind] || 0;
  const next = nextLevelRow(kind, lv);
  if (!next) return { ok: false, reason: "max_level_reached", current: lv };

  const lacks = [];
  const costs = next.cost || {};
  for (const [resource, need] of Object.entries(costs)) {
    if (resource === "coins") {
      const have = club.treasury_current || 0;
      if (have < need) lacks.push({ resource, need, have });
      continue;
    }
    const row = await client.guildClubWarehouseCollection.findOne({
      guild_club_id: club.guild_club_id,
      item_id: resource,
    });
    const have = row?.available_qty || 0;
    if (have < need) lacks.push({ resource, need, have });
  }
  return { ok: lacks.length === 0, lacks, nextLevel: next.level, cost: costs };
};

const upgradeBuilding = async (client, { userId, guildId, kind }) => {
  if (!guildBuildings?.enabled) return { ok: false, reason: "disabled" };

  const membership = await guildClubService.getMembership(client, userId, guildId);
  if (!membership) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(membership.role))
    return { ok: false, reason: "not_manager" };

  const cfg = kindDef(kind);
  if (!cfg) return { ok: false, reason: "unknown_kind" };

  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const need = unlockClubLevelOf(kind);
  if ((club.level || 1) < need)
    return { ok: false, reason: "club_level_locked", need, have: club.level || 1 };

  const check = await checkUpgradeRequirements(client, club, kind);
  if (!check.ok) return { ok: false, reason: "insufficient_resources", lacks: check.lacks };

  const currentLv = guildClubService.buildingsOf(club)[kind] || 0;
  const costs = check.cost;
  const coinsNeed = costs.coins || 0;
  const itemCosts = Object.entries(costs).filter(([k]) => k !== "coins");

  const consumed = [];
  for (const [itemId, qty] of itemCosts) {
    const res = await client.guildClubWarehouseCollection.findOneAndUpdate(
      {
        guild_club_id: club.guild_club_id,
        item_id: itemId,
        available_qty: { $gte: qty },
      },
      {
        $inc: { qty: -qty, available_qty: -qty },
        $set: { updated_at: new Date() },
      },
      { returnDocument: "after" }
    );
    if (!(res?.value || res)) {
      for (const c of consumed) {
        await client.guildClubWarehouseCollection.updateOne(
          { guild_club_id: club.guild_club_id, item_id: c.itemId },
          {
            $inc: { qty: c.qty, available_qty: c.qty },
            $set: { updated_at: new Date() },
          }
        ).catch(() => {});
      }
      return { ok: false, reason: "race_lost", item_id: itemId };
    }
    consumed.push({ itemId, qty });
  }

  const upd = await client.guildsClubCollection.findOneAndUpdate(
    {
      guild_club_id: club.guild_club_id,
      // currentLv === 0 時要匹配舊公會「buildings.kind 不存在」的文件
      $or: currentLv === 0
        ? [{ [`buildings.${kind}`]: 0 }, { [`buildings.${kind}`]: { $exists: false } }]
        : [{ [`buildings.${kind}`]: currentLv }],
      treasury_current: { $gte: coinsNeed },
    },
    {
      $set: { [`buildings.${kind}`]: check.nextLevel, updated_at: new Date() },
      $inc: { treasury_current: -coinsNeed },
    },
    { returnDocument: "after" }
  );
  const newDoc = upd?.value || upd;
  if (!newDoc) {
    for (const c of consumed) {
      await client.guildClubWarehouseCollection.updateOne(
        { guild_club_id: club.guild_club_id, item_id: c.itemId },
        {
          $inc: { qty: c.qty, available_qty: c.qty },
          $set: { updated_at: new Date() },
        }
      ).catch(() => {});
    }
    return { ok: false, reason: "race_lost_club" };
  }

  const now = new Date();
  await client.guildClubWarehouseLogsCollection.insertMany(
    consumed.map((c) => ({
      guild_club_id: club.guild_club_id,
      user_id: userId,
      action: "building_upgrade",
      item_id: c.itemId,
      qty: c.qty,
      fee: 0,
      market_value: 0,
      created_at: now,
    }))
  ).catch(() => {});
  if (coinsNeed > 0) {
    await client.guildClubLogsCollection.insertOne({
      guild_club_id: club.guild_club_id,
      user_id: userId,
      amount: -coinsNeed,
      source: "building_upgrade",
      meta: { kind, fromLevel: currentLv, toLevel: check.nextLevel },
      createdAt: now,
    }).catch(() => {});
  }

  if (kind === "blacksmith") {
    syncMembersWeaponMaxDurability(client, newDoc).catch((e) => {
      console.log(`[GUILD_BUILDING] 同步武器耐久失敗：${e.message}`.yellow);
    });
  }

  return {
    ok: true,
    club: newDoc,
    kind,
    fromLevel: currentLv,
    toLevel: check.nextLevel,
    cost: costs,
  };
};

// 鐵匠鋪升級後，把公會內所有有武器的成員 weapon_max_durability 重算。
// 不調整當前 weapon_durability（不送禮包，避免戰力通膨）；但若舊上限 < 新上限，
// 玩家修武器到滿時自然會吃到。
async function syncMembersWeaponMaxDurability(client, club) {
  if (!club) return;
  const buffs = buildingsBuffs(club);
  const pct = buffs.weapon_max_durability_pct || 0;
  const members = await guildClubService
    .listMembers(client, club.guild_club_id)
    .catch(() => []);
  const weapons = dungeon?.weapons || {};
  for (const m of members) {
    const profile = await client.miningProfilesCollection
      .findOne({ userId: m.userId, guildId: m.guildId })
      .catch(() => null);
    if (!profile) continue;
    if (!profile.weapon || profile.weapon === "fist") continue;
    const baseDur = weapons[profile.weapon]?.durability;
    if (typeof baseDur !== "number") continue;
    const newMax = Math.floor(baseDur * (1 + pct / 100));
    if (newMax === profile.weapon_max_durability) continue;
    await client.miningProfilesCollection
      .updateOne(
        { userId: m.userId, guildId: m.guildId },
        { $set: { weapon_max_durability: newMax, updatedAt: new Date() } }
      )
      .catch(() => {});
  }
}

module.exports = {
  allKinds,
  kindDef,
  levelRow,
  nextLevelRow,
  unlockClubLevelOf,
  warehouseCapacityBonus,
  buildingsBuffs,
  getMemberBuildingBuffs,
  checkUpgradeRequirements,
  upgradeBuilding,
  syncMembersWeaponMaxDurability,
};
