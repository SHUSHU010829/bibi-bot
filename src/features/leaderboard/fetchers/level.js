const { getLevelProgress } = require("../../../utils/levelMath");
const { getTier } = require("../../../utils/levelTier");
const { getTwitchSubBonus } = require("../../../utils/twitchSubBonus");
const { getServerBoostBonus } = require("../../../utils/serverBoostBonus");

function getPersonalMultiplier(member) {
  if (!member) return 1;
  const sub = getTwitchSubBonus(member);
  const boost = getServerBoostBonus(member);
  return sub.multiplier * boost.multiplier;
}

function formatMultiplier(mult) {
  return Number.isInteger(mult) ? `${mult}` : `${mult.toFixed(2)}`;
}

async function buildMemberMap(guild, docs) {
  const map = new Map();
  if (!guild) return map;
  const missing = [];
  for (const d of docs) {
    const cached = guild.members.cache.get(d.userId);
    if (cached) map.set(d.userId, cached);
    else missing.push(d.userId);
  }
  if (missing.length > 0) {
    try {
      const fetched = await guild.members.fetch({ user: missing });
      fetched.forEach((m) => map.set(m.id, m));
    } catch {
      /* 部分成員可能已離開伺服器，忽略 */
    }
  }
  return map;
}

// 等級榜只有 all（全時）；period 參數忽略。
async function fetchLevel(client, { guild, guildId, viewerId, viewerMember }) {
  if (!client.userLevelsCollection) {
    return { rows: [], total: 0, disabled: "🔧 等級系統尚未啟動" };
  }

  const total = await client.userLevelsCollection.countDocuments({ guildId });
  if (total === 0) {
    return {
      rows: [],
      total: 0,
      emptyHint: "📊 還沒有人累積等級資料～",
    };
  }

  const docs = await client.userLevelsCollection
    .find({ guildId })
    .sort({ totalXp: -1 })
    .limit(10)
    .toArray();
  const memberMap = await buildMemberMap(guild, docs);

  const rows = docs.map((d) => {
    const prog = getLevelProgress(d.totalXp);
    const tier = getTier(prog.level);
    const member = memberMap.get(d.userId);
    const mult = getPersonalMultiplier(member);
    const bonus = mult > 1 ? ` ✨x${formatMultiplier(mult)}` : "";
    return {
      id: d.userId,
      mention: `<@${d.userId}>`,
      detail: `${tier.emoji} **Lv.${prog.level}** ・ ${d.totalXp.toLocaleString()} XP${bonus}`,
    };
  });

  // 自己排名（若不在 top 10）
  let myRank = null;
  let myDetail = null;
  if (viewerId && !rows.some((r) => r.id === viewerId)) {
    const myDoc = await client.userLevelsCollection.findOne({
      userId: viewerId,
      guildId,
    });
    if (myDoc) {
      myRank =
        (await client.userLevelsCollection.countDocuments({
          guildId,
          totalXp: { $gt: myDoc.totalXp },
        })) + 1;
      const prog = getLevelProgress(myDoc.totalXp);
      const tier = getTier(prog.level);
      const mult = getPersonalMultiplier(viewerMember);
      const bonus = mult > 1 ? ` ✨x${formatMultiplier(mult)}` : "";
      myDetail = `${tier.emoji} Lv.${prog.level} ・ ${myDoc.totalXp.toLocaleString()} XP${bonus}`;
    }
  }

  return { rows, total, myRank, myDetail };
}

module.exports = fetchLevel;
