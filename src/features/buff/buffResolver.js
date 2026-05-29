// 統一 buff 解析門面。
//
// 目的：把散落各處的加成來源（鎬子 / 幸運藥水 / Twitch 訂閱 / 伺服器加成 /
// 抖內 / 商店 buff…）收斂成單一查詢入口，供決鬥、地城、挖礦與 /buff 總覽使用。
// 未來新增 buff 來源（公會 Phase A、技能 Phase S3、食物 S4、活動 S5）時，
// 只需在此檔對應分支擴充，呼叫端不需改動，也不應再直接讀 UserCoins.activeBuffs。
//
// 注意：金幣倍率的「實際套用」仍由 grantCoins 負責（load-bearing 的集中點）；
// 這裡的 getEffectiveIncomeMultiplier 提供統一「查詢」口徑，供 summary / 未來來源彙整。

const miningResolve = require("../mining/buffResolver"); // resolve(profile, member)
const { playerAtk } = require("../mining/dungeonService");
const { getOrCreate } = require("../mining/miningProfile");
const {
  getCoinTwitchSubBonus,
  getCoinServerBoostBonus,
} = require("../economy/coinMultiplier");
const { getActiveBuffMultiplier } = require("../shop/activeBuff");
const eventEngine = require("../event/eventEngine");

// ── ATK ───────────────────────────────────────────────
// 目前 = baseAtk + 鎬子加成；未來食物 / 技能 / 活動 buff 在此加分支。
function atkFromProfile(profile) {
  return playerAtk(profile);
}

async function getEffectiveAtk(client, userId, guildId) {
  const profile = await getOrCreate(client, userId, guildId);
  return atkFromProfile(profile);
}

// ── LUCK / 挖礦數量 / CD ──────────────────────────────
// 沿用 mining/buffResolver.resolve（鎬子 + 藥水 + Twitch + 抖內，已套 luckCap）。
async function getMiningResolve(client, userId, guildId, member) {
  const profile = await getOrCreate(client, userId, guildId);
  return miningResolve.resolve(profile, member);
}

async function getEffectiveLuck(client, userId, guildId, member) {
  return (await getMiningResolve(client, userId, guildId, member)).luckBonus;
}

async function getEffectiveCdMs(client, userId, guildId, member, source = "mine") {
  if (source === "mine") {
    return (await getMiningResolve(client, userId, guildId, member)).actualCdMs;
  }
  return null; // 其他來源尚無 CD 減免
}

// ── INCOME 倍率（查詢用，套用仍在 grantCoins）────────────
async function getEffectiveIncomeMultiplier(client, userId, guildId, member, source) {
  const tw = getCoinTwitchSubBonus(member, source)?.multiplier || 1;
  const boost = getCoinServerBoostBonus(member, source)?.multiplier || 1;
  const coinBuff = await getActiveBuffMultiplier(
    client,
    userId,
    guildId,
    "coin_boost"
  ).catch(() => 1);
  return tw * boost * coinBuff;
}

// ── SUMMARY（/buff 指令用：列所有來源）──────────────────
async function summary(client, userId, guildId, member) {
  const profile = await getOrCreate(client, userId, guildId);
  const m = miningResolve.resolve(profile, member);
  const [coinBuff, xpBuff] = await Promise.all([
    getActiveBuffMultiplier(client, userId, guildId, "coin_boost").catch(() => 1),
    getActiveBuffMultiplier(client, userId, guildId, "xp_boost").catch(() => 1),
  ]);
  return {
    atk: atkFromProfile(profile),
    luckBonus: m.luckBonus,
    qtyBonus: m.qtyBonus,
    miningCdMs: m.actualCdMs,
    income: {
      twitch: getCoinTwitchSubBonus(member, "mining_sell"),
      serverBoost: getCoinServerBoostBonus(member, "mining_sell"),
      coinBoost: coinBuff,
    },
    xpBoost: xpBuff,
    events: eventEngine.getActiveEvents().map((e) => ({
      id: e.id,
      name: e.name,
      luck: Number(e.effects?.miningLuckBonus) || 0,
      qty: Number(e.effects?.miningQtyBonus) || 0,
    })),
  };
}

module.exports = {
  atkFromProfile,
  getEffectiveAtk,
  getMiningResolve,
  getEffectiveLuck,
  getEffectiveCdMs,
  getEffectiveIncomeMultiplier,
  summary,
};
