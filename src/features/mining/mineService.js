require("colors");
const { mining } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const dropTable = require("./dropTable");
const buffResolver = require("./buffResolver");

// 執行一次挖礦。回傳結果物件交由指令層呈現（含彩虹石公告與耐久 DM 所需資料）。
async function mine(client, { userId, guildId, member, username, useTicket = false }) {
  if (!mining?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();

  if ((profile.mine_cooldown_at || 0) > now) {
    return {
      ok: false,
      reason: "cooldown",
      remainingMs: profile.mine_cooldown_at - now,
      readyAt: profile.mine_cooldown_at,
    };
  }

  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used >= cap) {
    return { ok: false, reason: "backpack_full", used, cap };
  }

  const buff = buffResolver.resolve(profile, member, { useTicket });
  const ore = dropTable.roll(buff.luckBonus);
  let qty = dropTable.randQty(ore, buff.qtyBonus);

  // 不讓單次掉落超出背包剩餘空間
  const space = cap - used;
  if (qty > space) qty = space;

  const newCooldownAt = now + buff.actualCdMs;

  const inc = {
    [`backpack.${ore}`]: qty,
    [`lifetime_ore.${ore}`]: qty,
    mine_count_total: 1,
  };
  if (buff.consume.usePotion) inc.luck_potion_uses = -1;
  if (buff.consume.useTicket) inc.cd_ticket_count = -1;

  const set = { mine_cooldown_at: newCooldownAt, updatedAt: new Date() };

  // 耐久：非木鎬且有耐久值才消耗；歸 0 退回木鎬
  let durabilityBroke = false;
  let durabilityAfter = null;
  const hasDurability =
    profile.pickaxe !== "wood" && typeof profile.pickaxe_durability === "number";
  if (hasDurability) {
    durabilityAfter = profile.pickaxe_durability - 1;
    if (durabilityAfter <= 0) {
      durabilityBroke = true;
      durabilityAfter = null;
      set.pickaxe = "wood";
      set.pickaxe_durability = null;
    } else {
      inc.pickaxe_durability = -1;
    }
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: set }
  );

  client.mineLogsCollection
    ?.insertOne({ user_id: userId, guild_id: guildId, ore, qty, ts: new Date() })
    .catch((e) => console.log(`[ERROR] insert mine log: ${e}`.red));

  // 鑽石（傳說）：計全服累積次數（含本次）供公告「第 N 位」
  let diamondGlobalCount = null;
  if (ore === "diamond") {
    diamondGlobalCount = await client.mineLogsCollection
      ?.countDocuments({ guild_id: guildId, ore: "diamond" })
      .catch(() => null);
  }

  return {
    ok: true,
    ore,
    qty,
    buff,
    newCooldownAt,
    pickaxeBefore: profile.pickaxe,
    durabilityBroke,
    durabilityAfter,
    diamondGlobalCount,
    mineCountTotal: (profile.mine_count_total || 0) + 1,
  };
}

module.exports = { mine };
