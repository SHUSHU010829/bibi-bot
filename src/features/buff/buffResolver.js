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
const twitchPerks = require("../mining/twitchPerks");
const { getFoodFarmYieldBonus } = require("../fishing/cookService");
const { MONEY_EMOJI } = require("../../constants/coin");
const { donation, levelSystem } = require("../../config");

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
    farmYieldBonus: getFoodFarmYieldBonus(profile),
    events: eventEngine.getActiveEvents().map((e) => ({
      id: e.id,
      name: e.name,
      luck: Number(e.effects?.miningLuckBonus) || 0,
      qty: Number(e.effects?.miningQtyBonus) || 0,
    })),
  };
}

// ── 依身分組彙整加成（/背包 用：列出各身分組目前提供的 buff）─────────
// 取 member 持有的「最高」Twitch 訂閱身分組對應的 XP 倍率設定。
function xpTwitchSubMultiplier(member) {
  const cfg = levelSystem?.twitchSubBonus;
  if (!cfg?.enabled || !member?.roles?.cache) return { multiplier: 1, name: null };
  let best = null;
  for (const t of cfg.tiers || []) {
    if (!t?.roleId || !(t.multiplier > 1)) continue;
    if (!member.roles.cache.has(t.roleId)) continue;
    if (!best || t.multiplier > best.multiplier) best = t;
  }
  return best
    ? { multiplier: best.multiplier, name: best.name }
    : { multiplier: 1, name: null };
}

function xpServerBoostMultiplier(member) {
  const cfg = levelSystem?.serverBoostBonus;
  if (!cfg?.enabled || !(cfg.multiplier > 1) || !cfg.roleId) {
    return { multiplier: 1, name: null };
  }
  if (!member?.roles?.cache?.has(cfg.roleId)) return { multiplier: 1, name: null };
  return { multiplier: cfg.multiplier, name: cfg.name || "伺服器加成" };
}

// 回傳 [{ header, lines: [] }]，列出此成員目前因「身分組」吃到的加成。
// 沒有任何身分組加成則回 []。涵蓋：Twitch 訂閱、伺服器加成（Booster）、贊助。
async function roleBuffSummary(client, userId, guildId, member) {
  if (!member?.roles?.cache) return [];
  const groups = [];

  // ── Twitch 訂閱（不帶 source → 不套 appliesTo 過濾，取身分組本身的倍率）──
  const perks = twitchPerks.resolvePerks(member);
  const twCoin = getCoinTwitchSubBonus(member);
  const twXp = xpTwitchSubMultiplier(member);
  if (perks || twCoin.multiplier > 1 || twXp.multiplier > 1) {
    const tierLabel =
      twCoin.name ||
      twXp.name ||
      { tier1: "Tier 1", tier2: "Tier 2", tier3: "Tier 3" }[perks?.tierKey] ||
      "訂閱者";
    const lines = [];
    if (twXp.multiplier > 1) lines.push(`📈 經驗 ×${twXp.multiplier}`);
    if (twCoin.multiplier > 1) lines.push(`${MONEY_EMOJI} 金幣 ×${twCoin.multiplier}`);
    if (perks?.miningLuckBonus > 0)
      lines.push(`🍀 挖礦幸運 +${Math.round(perks.miningLuckBonus * 100)}%`);
    if (perks?.miningCdReductionMs > 0)
      lines.push(`⏱️ 挖礦冷卻 -${Math.round(perks.miningCdReductionMs / 60000)} 分`);
    if (lines.length) groups.push({ header: `💜 Twitch 訂閱（${tierLabel}）`, lines });
  }

  // ── 伺服器加成（Booster）──
  const sbCoin = getCoinServerBoostBonus(member);
  const sbXp = xpServerBoostMultiplier(member);
  if (sbCoin.multiplier > 1 || sbXp.multiplier > 1) {
    const lines = [];
    if (sbXp.multiplier > 1) lines.push(`📈 經驗 ×${sbXp.multiplier}`);
    if (sbCoin.multiplier > 1) lines.push(`${MONEY_EMOJI} 金幣 ×${sbCoin.multiplier}`);
    groups.push({ header: `🚀 ${sbCoin.name || sbXp.name || "伺服器加成"}`, lines });
  }

  // ── 贊助（Donor / VIP Donor）──
  const donorRoleId = donation?.roleIds?.donor;
  const vipRoleId = donation?.roleIds?.vipDonor;
  const hasDonor = donorRoleId && member.roles.cache.has(donorRoleId);
  const hasVip = vipRoleId && member.roles.cache.has(vipRoleId);
  if (hasDonor || hasVip) {
    let luck = 0;
    let exp = 0;
    try {
      if (client.miningProfilesCollection) {
        const profile = await getOrCreate(client, userId, guildId);
        exp = profile?.donation_luck_expires_at
          ? new Date(profile.donation_luck_expires_at).getTime()
          : 0;
        if (exp > Date.now()) luck = profile.donation_luck_bonus || 0;
      }
    } catch {
      /* 讀不到 profile 就只顯示身分組本身 */
    }
    const lines =
      luck > 0
        ? [`🍀 挖礦幸運 +${Math.round(luck * 100)}%（<t:${Math.floor(exp / 1000)}:R>）`]
        : ["・專屬身分組與外觀"];
    groups.push({ header: `💖 ${hasVip ? "VIP 贊助者" : "贊助者"}`, lines });
  }

  return groups;
}

module.exports = {
  atkFromProfile,
  getEffectiveAtk,
  getMiningResolve,
  getEffectiveLuck,
  getEffectiveCdMs,
  getEffectiveIncomeMultiplier,
  summary,
  roleBuffSummary,
};
