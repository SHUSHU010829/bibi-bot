const { mining } = require("../../config");
const twitchPerks = require("./twitchPerks");
const eventEngine = require("../event/eventEngine");
const { getFoodLuckBonus, consumeMineLuckUse } = require("../fishing/cookService");

// 整合鎬子 / 幸運藥水 / Twitch 訂閱者權益。
// CD 縮短券改為冷卻中於 /背包 主動使用（見 mineService.useCdTicket），不在挖礦時自動消耗。
// 回傳 { luckBonus, qtyBonus, actualCdMs, consume: { usePotion } }。
function resolve(profile, member) {
  const pickaxes = mining?.pickaxes || {};
  const pdef = pickaxes[profile?.pickaxe] || pickaxes.wood || {};

  let luckBonus = pdef.luckBonus || 0;
  let qtyBonus = pdef.qtyBonus || 0;
  let cdMs = (mining?.cooldownMs || 0) - (pdef.cdReductionMs || 0);

  // 幸運藥水：持有次數 > 0 時自動生效並消耗一次
  const usePotion = (profile?.luck_potion_uses || 0) > 0;
  if (usePotion) luckBonus += mining?.luckPotionBonus || 0;

  // luck 全域上限：僅套用於鎬子 / 幸運藥水 / Twitch 權益的加總
  const cap = mining?.luckCap ?? 0.25;

  // Twitch 加入「前」的封頂值，用來換算訂閱實際生效的幸運加成
  const cappedBeforeTwitch = Math.min(luckBonus, cap);

  // Twitch 訂閱者權益：依 tier 加挖礦 luck、縮短 CD（沿用訂閱角色 ID）
  const perks = twitchPerks.resolvePerks(member);
  let twitchTierKey = null;
  if (perks) {
    twitchTierKey = perks.tierKey || null;
    luckBonus += perks.miningLuckBonus || 0;
    cdMs -= perks.miningCdReductionMs || 0;
  }

  // luck 全域上限
  if (luckBonus > cap) luckBonus = cap;

  // 訂閱在封頂後「實際生效」的幸運加成：被上限吃掉的部分不計
  // = 封頂後（鎬子+藥水+訂閱）- 封頂後（鎬子+藥水）
  const twitchLuckBonus = luckBonus - cappedBeforeTwitch;

  // 抖內 luck buff（永久 expiresAt=null，限時則需 > now）
  // 抖內加成獨立於上限之外，於封頂後額外疊加，故等級給多少實拿多少。
  let donationLuckBonus = Number(profile?.donation_luck_bonus || 0);
  if (donationLuckBonus > 0) {
    const exp = profile?.donation_luck_expires_at;
    const stillValid = !exp || new Date(exp).getTime() > Date.now();
    if (stillValid) luckBonus += donationLuckBonus;
    else donationLuckBonus = 0;
  } else {
    donationLuckBonus = 0;
  }

  // 限時活動加成（Phase S5）：與抖內同，獨立於 luckCap 之外於封頂後額外疊加，
  // 讓「加倍週末」等活動的加成可靠生效；數量加成直接累加。
  const eventLuckBonus = eventEngine.getMiningLuckBonus();
  if (eventLuckBonus > 0) luckBonus += eventLuckBonus;
  const eventQtyBonus = eventEngine.getMiningQtyBonus();
  if (eventQtyBonus > 0) qtyBonus += eventQtyBonus;

  // 食物 buff（Phase S4）：mine_luck / all_boost 類型，獨立於 luckCap 之外疊加。
  // uses_left 型 buff（章魚飯）在此扣次數；cookService 負責非同步寫 DB，
  // resolve() 本身保持同步以免影響挖礦主流程效能。
  const foodLuckBonus = getFoodLuckBonus(profile);
  if (foodLuckBonus > 0) luckBonus += foodLuckBonus;

  // CD 下限保護（避免負數 / 零）
  const actualCdMs = Math.max(cdMs, 60 * 1000);

  // donationLuckBonus / eventLuckBonus / eventQtyBonus / twitchLuckBonus / foodLuckBonus：
  // 本次實際生效值，供指令層顯示
  return {
    luckBonus,
    qtyBonus,
    actualCdMs,
    donationLuckBonus,
    eventLuckBonus,
    eventQtyBonus,
    twitchLuckBonus,
    twitchTierKey,
    foodLuckBonus,
    consume: { usePotion },
  };
}

module.exports = { resolve };
