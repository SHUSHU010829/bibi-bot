// 討伐道具：平時用礦石 / 魚合成囤起來，魔王在場時丟出去造成固定傷害。
//
// 存來源不存結果：庫存存在 profile.boss_items.<key>，單場使用次數存在 BossEvents doc 的
// item_uses.<userId>.<key>，傷害在使用當下換算：flatDamage 是固定值，hpPctDamage 則依
// 「當場最大血量 × %」計算，不把算好的數字寫進任何欄位（百分比型在週六場本來就該比平日場痛）。
const { boss, craft } = require("../../config");
const bossEngine = require("./bossEngine");
const bossSkills = require("./bossSkills");
const { getOrCreate } = require("../mining/miningProfile");

function icfg() {
  return boss?.combatItems || {};
}

function itemList() {
  if (!icfg().enabled) return [];
  return Array.isArray(icfg().items) ? icfg().items : [];
}

function itemDef(key) {
  return itemList().find((i) => i.key === key) || null;
}

function itemLabel(key) {
  const def = itemDef(key);
  return def ? `${def.emoji} ${def.name}` : key;
}

function recipeOf(key) {
  return (craft?.recipes || []).find((r) => r.result?.type === "boss_item" && r.result?.id === key) || null;
}

function stockOf(profile, key) {
  return (profile?.boss_items || {})[key] || 0;
}

// 這隻魔王身上這個道具還能丟幾次（沒有魔王時回 null）。
function remainingUses(bossDoc, userId, key) {
  const def = itemDef(key);
  if (!def || !bossDoc) return null;
  const used = ((bossDoc.item_uses || {})[userId] || {})[key] || 0;
  return Math.max(0, (def.perBossUses ?? 1) - used);
}

// 固定傷害型（炸藥包）數字不隨場次變動；百分比型（燃燒彈 / 雷符）跟著該場最大血量走，
// 在血厚的週六場一樣有存在感。
function damageOf(def, bossDoc) {
  if (def.flatDamage > 0) return def.flatDamage;
  return Math.max(1, Math.round((bossDoc?.max_hp || 0) * (def.hpPctDamage || 0) / 100));
}

// 道具附帶的魔王 debuff 定義（寫在 boss.skills.list，標 itemOnly＝魔王自己不會施放）。
function debuffDefOf(def) {
  return def?.debuff ? bossSkills.skillDef(def.debuff) : null;
}

// 附帶效果的說明也只有這一份：合成頁、背包、道具面板、使用結果共用。
function effectLabel(def) {
  const d = debuffDefOf(def);
  if (!d) return null;
  return `${d.emoji} ${d.name}（全場傷害 ×${d.damageTakenMult}・${d.durationSec} 秒）`;
}

// 疊加規則在合成頁 / 道具面板 / 使用結果都要講一次，別讓人以為同一種丟兩顆會更痛。
const NO_STACK_HINT = "同一種 debuff 不疊加（再丟一顆只會刷新時間），不同種類可以同時生效並相乘";

// 傷害寫法只有這一份：合成頁、背包、道具面板、使用說明共用，免得固定型被寫成「0%」。
function damageLabel(def) {
  return def.flatDamage > 0
    ? `固定 ${def.flatDamage.toLocaleString()} 傷害`
    : `最大血量 ${def.hpPctDamage}% 的傷害`;
}

// 面板上數字已經寫出來了，括號裡只要交代「這個數字怎麼來的」。
function damageBasis(def) {
  return def.flatDamage > 0 ? "固定傷害" : `最大血量 ${def.hpPctDamage}%`;
}

// 戰況面板 / 道具面板用：每個道具的持有量、本場剩餘次數、傷害預估。
async function inventory(client, { userId, guildId }) {
  const profile = await getOrCreate(client, userId, guildId);
  const bossDoc = await bossEngine.getActiveBoss(client, guildId);
  const items = itemList().map((def) => ({
    def,
    count: stockOf(profile, def.key),
    remaining: bossDoc ? remainingUses(bossDoc, userId, def.key) : (def.perBossUses ?? 1),
    damage: bossDoc ? damageOf(def, bossDoc) : 0,
  }));
  return {
    enabled: !!icfg().enabled,
    boss: bossDoc,
    items,
    totalCount: items.reduce((s, i) => s + i.count, 0),
    usable: items.filter((i) => i.count > 0 && i.remaining > 0),
  };
}

// 使用流程：先原子扣庫存，再打傷害；傷害那步失敗（魔王剛結束 / 本場次數用完）就把庫存補回去。
async function useItem(client, { userId, guildId, username, itemKey }) {
  const def = itemDef(itemKey);
  if (!def) return { ok: false, reason: "disabled" };

  const bossDoc = await bossEngine.getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_boss" };

  const remaining = remainingUses(bossDoc, userId, itemKey);
  if (remaining <= 0) {
    return { ok: false, reason: "used_up", def, limit: def.perBossUses ?? 1 };
  }

  const field = `boss_items.${itemKey}`;
  const dec = await client.miningProfilesCollection.findOneAndUpdate(
    { userId, guildId, [field]: { $gte: 1 } },
    { $inc: { [field]: -1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const decDoc = dec?.value || dec;
  if (!decDoc) return { ok: false, reason: "no_stock", def };

  const res = await bossEngine.applyItemDamage(client, {
    userId,
    guildId,
    username,
    itemKey,
    damage: damageOf(def, bossDoc),
    perBossUses: def.perBossUses ?? 1,
    playerEventKey: def.grantsPlayerEvent || null,
    debuffKey: def.debuff || null,
  });

  if (!res.ok) {
    await client.miningProfilesCollection
      .updateOne({ userId, guildId }, { $inc: { [field]: 1 } })
      .catch(() => {});
    return { ...res, def, limit: def.perBossUses ?? 1 };
  }

  return {
    ...res,
    def,
    countAfter: stockOf(decDoc, itemKey),
    announcement: (def.announcement || "").replace(/\{damage\}/g, res.damage.toLocaleString()),
  };
}

module.exports = {
  icfg,
  itemList,
  itemDef,
  itemLabel,
  recipeOf,
  stockOf,
  remainingUses,
  damageOf,
  damageLabel,
  damageBasis,
  debuffDefOf,
  effectLabel,
  NO_STACK_HINT,
  inventory,
  useItem,
};
