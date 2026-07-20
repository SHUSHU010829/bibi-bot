require("colors");
const { levelSystem } = require("../../config");
const { randomInt } = require("../../utils/levelMath");
const grantXp = require("./grantXp");

// 日常活動（打工 / 挖礦 / 釣魚 / 地下城 / 種田）共用的經驗發放。
// XP 區間走 config（levelSystem.activityXp.<activity>），數值調整不動程式。
// 回傳本次實際獲得的 XP（含倍率），失敗或未啟用一律回 0，絕不 throw、不擋主流程。
const META = {
  work: { source: "work", counterField: "xpFromWork" },
  mine: { source: "mine", counterField: "xpFromMining" },
  fish: { source: "fish", counterField: "xpFromFishing" },
  dungeon: { source: "dungeon", counterField: "xpFromDungeon" },
  farm: { source: "farm", counterField: "xpFromFarm" },
};

// 只 roll 出本次活動的基礎 XP（不套倍率、不寫 DB）。連續挖礦 / 釣魚 / 一鍵收成用來逐次累計，
// 最後一次性授予，避免每次迭代都打一次 UserLevels 熱點文件。
function rollActivityXp(activity) {
  const cfg = levelSystem?.activityXp;
  if (!cfg?.enabled) return 0;
  const range = cfg[activity];
  if (!META[activity] || !range) return 0;
  const amount = randomInt(range.minXp ?? 0, range.maxXp ?? 0);
  return amount > 0 ? amount : 0;
}

async function grantActivityXp(client, activity, ctx) {
  try {
    const meta = META[activity];
    if (!meta) return 0;

    // ctx.amount 已由呼叫端 roll 好（連續挖礦 / 釣魚 / 一鍵收成匯總）時直接沿用，否則即時 roll。
    const amount =
      typeof ctx.amount === "number" ? ctx.amount : rollActivityXp(activity);
    if (amount <= 0) return 0;

    const res = await grantXp(client, {
      userId: ctx.userId,
      guildId: ctx.guildId,
      username: ctx.username,
      avatarHash: ctx.avatarHash,
      amount,
      source: meta.source,
      counterField: meta.counterField,
      meta: ctx.meta || {},
      channel: ctx.channel || null,
      member: ctx.member,
    });
    return res?.grantedAmount ?? 0;
  } catch (e) {
    console.log(`[ERROR] grantActivityXp(${activity}): ${e}`.red);
    return 0;
  }
}

module.exports = grantActivityXp;
module.exports.roll = rollActivityXp;
