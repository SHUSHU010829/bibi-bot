require("colors");
const { levelSystem } = require("../../config");
const { randomInt } = require("../../utils/levelMath");
const grantXp = require("./grantXp");

// 日常活動（打工 / 挖礦 / 釣魚 / 地下城）共用的經驗發放。
// XP 區間走 config（levelSystem.activityXp.<activity>），數值調整不動程式。
// 回傳本次實際獲得的 XP（含倍率），失敗或未啟用一律回 0，絕不 throw、不擋主流程。
const META = {
  work: { source: "work", counterField: "xpFromWork" },
  mine: { source: "mine", counterField: "xpFromMining" },
  fish: { source: "fish", counterField: "xpFromFishing" },
  dungeon: { source: "dungeon", counterField: "xpFromDungeon" },
};

module.exports = async function grantActivityXp(client, activity, ctx) {
  try {
    const cfg = levelSystem?.activityXp;
    if (!cfg?.enabled) return 0;
    const meta = META[activity];
    const range = cfg[activity];
    if (!meta || !range) return 0;

    const amount = randomInt(range.minXp ?? 0, range.maxXp ?? 0);
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
};
