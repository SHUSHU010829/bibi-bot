require("colors");
const { guildBanquet, guildWarehouse } = require("../../config");
const guildClubService = require("./guildClubService");

const cfg = () => guildBanquet || {};

const isEnabled = () => !!cfg().enabled;

// buffs 統一成 [{type,value}]：resolver / view 都用 for-of 與 .map 讀它，
// 設定寫成 { type: value } 物件時會直接炸掉面板。
const normalizeBuffs = (buffs) =>
  Array.isArray(buffs)
    ? buffs
    : Object.entries(buffs || {}).map(([type, value]) => ({ type, value }));

const normalizeMenu = (menu) =>
  menu ? { ...menu, buffs: normalizeBuffs(menu.buffs) } : null;

const menuDef = (menuId) => normalizeMenu(cfg().menus?.[menuId]);

const menuEntries = () =>
  Object.entries(cfg().menus || {}).map(([menuId, menu]) => [menuId, normalizeMenu(menu)]);

const allMenuIds = () => Object.keys(cfg().menus || {});

const requiredFarmKitchenLevel = () => cfg().requiredFarmKitchenLevel || 5;

const cooldownMs = () => (cfg().cooldownHours || 24) * 3600 * 1000;

// 中文物品名（從倉庫設定取，保證一份名稱表）
const itemLabel = (itemId) => guildWarehouse?.items?.[itemId]?.name || itemId;
const itemEmoji = (itemId) => guildWarehouse?.items?.[itemId]?.emoji || "";

function isActiveBanquet(banquet) {
  if (!banquet) return false;
  if (typeof banquet.expires_at !== "number") return false;
  return banquet.expires_at > Date.now();
}

function getActiveBanquet(club) {
  return isActiveBanquet(club?.active_banquet) ? club.active_banquet : null;
}

// 嘗試發起一場宴會。原子性：以 last_banquet_at + active_banquet 為樂觀鎖。
async function startBanquet(client, { userId, guildId, menuId }) {
  if (!isEnabled()) return { ok: false, reason: "disabled" };

  const membership = await guildClubService.getMembership(client, userId, guildId);
  if (!membership) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(membership.role))
    return { ok: false, reason: "not_manager" };

  const menu = menuDef(menuId);
  if (!menu) return { ok: false, reason: "invalid_menu" };

  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const farmKitchenLv = guildClubService.buildingsOf(club).farm_kitchen || 0;
  const required = requiredFarmKitchenLevel();
  if (farmKitchenLv < required) {
    return {
      ok: false,
      reason: "farm_kitchen_locked",
      have: farmKitchenLv,
      need: required,
    };
  }

  if (isActiveBanquet(club.active_banquet)) {
    return {
      ok: false,
      reason: "banquet_active",
      expiresAt: club.active_banquet.expires_at,
    };
  }

  const cd = cooldownMs();
  const lastAt = club.last_banquet_at ? new Date(club.last_banquet_at).getTime() : 0;
  if (lastAt > 0 && Date.now() < lastAt + cd) {
    return { ok: false, reason: "cooldown", readyAt: lastAt + cd };
  }

  // 倉庫材料檢查（含 building_material / steel_ingot 這類 guild_only 也走同一張表）
  const lacks = [];
  for (const [itemId, need] of Object.entries(menu.materials || {})) {
    const row = await client.guildClubWarehouseCollection
      .findOne({ guild_club_id: club.guild_club_id, item_id: itemId })
      .catch(() => null);
    const have = row?.available_qty || 0;
    if (have < need) lacks.push({ itemId, need, have });
  }
  if (lacks.length > 0) {
    return { ok: false, reason: "insufficient_materials", lacks };
  }

  // 樂觀鎖：用 last_banquet_at + active_banquet 雙條件 swap，避免兩個 manager 同時觸發
  const startedAt = Date.now();
  const expiresAt = startedAt + (menu.durationMs || 3600000);
  const newBanquet = {
    menu_id: menuId,
    buffs: menu.buffs || [],
    started_at: startedAt,
    expires_at: expiresAt,
    started_by_user_id: userId,
  };

  const lockQuery = {
    guild_club_id: club.guild_club_id,
    disbanded_at: null,
  };
  if (lastAt > 0) {
    lockQuery.last_banquet_at = club.last_banquet_at;
  } else {
    lockQuery.$or = [
      { last_banquet_at: { $exists: false } },
      { last_banquet_at: null },
    ];
  }
  lockQuery.$and = [
    {
      $or: [
        { active_banquet: { $exists: false } },
        { active_banquet: null },
        { "active_banquet.expires_at": { $lte: Date.now() } },
      ],
    },
  ];

  const locked = await client.guildsClubCollection
    .findOneAndUpdate(
      lockQuery,
      {
        $set: {
          active_banquet: newBanquet,
          last_banquet_at: new Date(startedAt),
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" }
    )
    .catch(() => null);
  const lockedDoc = locked?.value || locked;
  if (!lockedDoc) {
    return { ok: false, reason: "race_lost" };
  }

  // 扣倉庫材料（逐項 atomic 扣；失敗則回滾已扣項目 + 回滾 active_banquet）
  const consumed = [];
  for (const [itemId, need] of Object.entries(menu.materials || {})) {
    const dec = await client.guildClubWarehouseCollection
      .findOneAndUpdate(
        {
          guild_club_id: club.guild_club_id,
          item_id: itemId,
          available_qty: { $gte: need },
        },
        {
          $inc: { qty: -need, available_qty: -need },
          $set: { updated_at: new Date() },
        },
        { returnDocument: "after" }
      )
      .catch(() => null);
    if (!(dec?.value || dec)) {
      // 回滾
      for (const c of consumed) {
        await client.guildClubWarehouseCollection
          .updateOne(
            { guild_club_id: club.guild_club_id, item_id: c.itemId },
            {
              $inc: { qty: c.qty, available_qty: c.qty },
              $set: { updated_at: new Date() },
            }
          )
          .catch(() => {});
      }
      await client.guildsClubCollection
        .updateOne(
          { guild_club_id: club.guild_club_id },
          {
            $set: {
              active_banquet: null,
              last_banquet_at: club.last_banquet_at || null,
              updated_at: new Date(),
            },
          }
        )
        .catch(() => {});
      return { ok: false, reason: "race_lost_materials", item_id: itemId };
    }
    consumed.push({ itemId, qty: need });
  }

  const now = new Date();
  await client.guildClubWarehouseLogsCollection
    .insertMany(
      consumed.map((c) => ({
        guild_club_id: club.guild_club_id,
        user_id: userId,
        action: "banquet",
        item_id: c.itemId,
        qty: c.qty,
        fee: 0,
        market_value: 0,
        created_at: now,
      }))
    )
    .catch(() => {});

  await client.guildClubLogsCollection
    .insertOne({
      guild_club_id: club.guild_club_id,
      user_id: userId,
      amount: 0,
      source: "banquet_start",
      meta: { menu_id: menuId, expires_at: expiresAt },
      createdAt: now,
    })
    .catch(() => {});

  return {
    ok: true,
    club: lockedDoc,
    menu,
    menuId,
    banquet: newBanquet,
    consumed,
  };
}

module.exports = {
  isEnabled,
  menuDef,
  menuEntries,
  allMenuIds,
  requiredFarmKitchenLevel,
  cooldownMs,
  itemLabel,
  itemEmoji,
  getActiveBanquet,
  isActiveBanquet,
  startBanquet,
};
