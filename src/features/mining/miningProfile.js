// 集中管理 MiningProfiles 的預設欄位與讀取，避免 schema 預設散落各處。

function defaultProfile(userId, guildId) {
  return {
    userId,
    guildId,
    mine_cooldown_at: 0,
    pickaxe: "wood",
    pickaxe_durability: null,
    luck_potion_uses: 0,
    cd_ticket_count: 0,
    backpack_bonus_slots: 0,
    mine_count_total: 0,
    craft_count_total: 0,
    backpack: { stone: 0, coal: 0, iron: 0, crystal: 0, rainbow: 0 },
    createdAt: new Date(),
  };
}

// 補齊舊文件可能缺少的欄位（例如先前只由商店購買 upsert 出來的 doc）。
function normalize(doc) {
  if (!doc) return doc;
  doc.backpack = { stone: 0, coal: 0, iron: 0, crystal: 0, rainbow: 0, ...(doc.backpack || {}) };
  doc.mine_cooldown_at ??= 0;
  doc.pickaxe ??= "wood";
  if (doc.pickaxe_durability === undefined) doc.pickaxe_durability = null;
  doc.luck_potion_uses ??= 0;
  doc.cd_ticket_count ??= 0;
  doc.backpack_bonus_slots ??= 0;
  doc.mine_count_total ??= 0;
  doc.craft_count_total ??= 0;
  return doc;
}

async function getOrCreate(client, userId, guildId) {
  const now = new Date();
  const res = await client.miningProfilesCollection.findOneAndUpdate(
    { userId, guildId },
    {
      $setOnInsert: defaultProfile(userId, guildId),
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  return normalize(res.value || res);
}

// 背包總容量（基礎 + 擴充）
function backpackCapacity(profile, mining) {
  const base = mining?.backpackBaseSlots ?? 100;
  return base + (profile?.backpack_bonus_slots || 0);
}

// 背包目前使用量（所有礦石數量加總）
function backpackUsed(profile) {
  const bp = profile?.backpack || {};
  return Object.values(bp).reduce((sum, n) => sum + (n || 0), 0);
}

module.exports = {
  defaultProfile,
  normalize,
  getOrCreate,
  backpackCapacity,
  backpackUsed,
};
