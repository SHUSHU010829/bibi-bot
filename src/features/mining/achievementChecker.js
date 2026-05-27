require("colors");
const { getOrCreate } = require("./miningProfile");
const titleManager = require("./titleManager");

// 成就稱號解鎖條件。ores 以實際設定的礦種對齊（水晶→黃金 gold、彩虹石→鑽石 diamond）。
// requiresCoins 標記需要錢包餘額才能判定，省去非必要的 DB 查詢。
const ACHIEVEMENTS = [
  {
    id: "coal_collector",
    requiresCoins: true,
    test: (p, coins) => (p.mine_count_total || 0) >= 50 && coins >= 500,
  },
  {
    id: "iron_smith",
    test: (p) => (p.craft_count_total || 0) >= 10 && (p.lifetime_ore?.iron || 0) >= 100,
  },
  {
    id: "gem_hunter",
    test: (p) => (p.lifetime_ore?.gold || 0) >= 20 && (p.lifetime_ore?.diamond || 0) >= 1,
  },
  {
    id: "legend_miner",
    test: (p) =>
      (p.mine_count_total || 0) >= 1000 &&
      (p.lifetime_ore?.diamond || 0) >= 5 &&
      (p.weekly_champion_count || 0) >= 3,
  },
];

// 計算每個成就的進度（給 /成就 指令用）。
function progress(profile, coins) {
  const p = profile || {};
  const lo = p.lifetime_ore || {};
  return [
    {
      id: "coal_collector",
      unlocked: false,
      parts: [
        { label: "累積挖礦", cur: p.mine_count_total || 0, target: 50 },
        { label: "持有金幣", cur: coins || 0, target: 500 },
      ],
    },
    {
      id: "iron_smith",
      unlocked: false,
      parts: [
        { label: "累積合成", cur: p.craft_count_total || 0, target: 10 },
        { label: "歷史鐵礦", cur: lo.iron || 0, target: 100 },
      ],
    },
    {
      id: "gem_hunter",
      unlocked: false,
      parts: [
        { label: "歷史黃金", cur: lo.gold || 0, target: 20 },
        { label: "歷史鑽石", cur: lo.diamond || 0, target: 1 },
      ],
    },
    {
      id: "legend_miner",
      unlocked: false,
      parts: [
        { label: "累積挖礦", cur: p.mine_count_total || 0, target: 1000 },
        { label: "歷史鑽石", cur: lo.diamond || 0, target: 5 },
        { label: "週冠次數", cur: p.weekly_champion_count || 0, target: 3 },
      ],
    },
  ];
}

// 檢查並解鎖符合條件的成就稱號。fire-and-forget 友善：自身吃掉錯誤回傳空陣列。
async function checkAndGrant(client, { userId, guildId, member, profile }) {
  if (!client?.miningProfilesCollection) return [];
  try {
    const p = profile || (await getOrCreate(client, userId, guildId));
    const unlocked = new Set(p.unlocked_titles || []);

    const pending = ACHIEVEMENTS.filter((a) => !unlocked.has(a.id));
    if (pending.length === 0) return [];

    let coins = 0;
    if (pending.some((a) => a.requiresCoins) && client.userCoinsCollection) {
      const doc = await client.userCoinsCollection
        .findOne({ userId, guildId })
        .catch(() => null);
      coins = doc?.totalCoins || 0;
    }

    const newly = [];
    for (const a of pending) {
      if (a.test(p, coins)) {
        await titleManager
          .grantTitle(client, { userId, guildId, member, titleId: a.id })
          .catch(() => {});
        newly.push(a.id);
      }
    }

    for (const id of newly) {
      await titleManager
        .announceTitle(client, { member, userId, titleId: id })
        .catch(() => {});
    }
    return newly;
  } catch (e) {
    console.log(`[ACHIEVEMENT] check failed: ${e.message}`.yellow);
    return [];
  }
}

module.exports = { checkAndGrant, progress, ACHIEVEMENTS };
