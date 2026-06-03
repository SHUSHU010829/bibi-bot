const { farming } = require("../../config");

async function sendFarmAnnouncement(client, fallbackChannel, content) {
  const channelId = farming?.announceChannelId;
  try {
    if (channelId) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch?.isTextBased()) {
        await ch.send({ content, allowedMentions: { parse: ["users"] } });
        return;
      }
    }
    if (fallbackChannel?.isTextBased?.()) {
      await fallbackChannel.send({ content, allowedMentions: { parse: ["users"] } });
    }
  } catch (e) {
    console.log(`[WARN] 農場公告失敗：${e.message}`.yellow);
  }
}

function buildHarvestAnnouncement({ user, result }) {
  if (!result?.ok) return null;
  const def = result.cropDef || {};
  const threshold = farming?.bigHarvestYieldBonusPct ?? 0.5;
  const isRare = result.crop === "black_rose";
  const isBig = (result.yieldBonus || 0) >= threshold;
  if (!isRare && !isBig) return null;

  if (isRare) {
    const lines = [
      `🌹✨ **${user}** 在自家農場收成了傳說中的 **${def.emoji || ""} ${def.name || "黑玫瑰"}**！`,
    ];
    for (const drop of result.bonusDrops || []) {
      if (drop.kind === "fragment") lines.push(`✨ 額外掉落：傳說碎片 ×${drop.amount}`);
      if (drop.kind === "rare_bait") lines.push(`✨ 額外掉落：稀有魚餌 ×${drop.amount}`);
    }
    return lines.join("\n");
  }

  return `🌟 **${user}** 大豐收！收成 **${def.emoji || ""} ${def.name || result.crop}** ` +
    `獲得 **+${result.coins} 幣**（收成加成 +${Math.round((result.yieldBonus || 0) * 100)}%）`;
}

function buildDefendAnnouncement({ user, result }) {
  if (!result?.ok) return null;
  const m = result.monster || {};
  if (result.won) {
    return `🛡️ **${user}** 擊退了入侵農場的 **${m.monsterEmoji || "👾"} ${m.monsterName || "怪物"}**！` +
      (result.coinsGained > 0 ? `（戰利品 +${result.coinsGained} 幣）` : "");
  }
  return `💀 **${user}** 的農場被 **${m.monsterEmoji || "👾"} ${m.monsterName || "怪物"}** 攻陷，作物全毀！` +
    (result.weaponBroke ? "（武器也斷了 💥）" : "");
}

function buildTrapAnnouncement({ user, result }) {
  if (!result?.ok) return null;
  const m = result.monster || {};
  const mTag = `${m.monsterEmoji || "👾"} ${m.monsterName || "怪物"}`;
  if (result.won) {
    return `🪤 **${user}** 體力耗盡只能擺陷阱…結果還真把 **${mTag}** 逼退了！` +
      (result.coinsGained > 0 ? `（撿到 +${result.coinsGained} 幣）` : "");
  }
  const flavor = result.flavor ? `\n-# ${result.flavor}` : "";
  return `🪤 **${user}** 沒體力只好擺陷阱…可惜沒派上用場，作物全毀了 🥲${flavor}`;
}

module.exports = {
  sendFarmAnnouncement,
  buildHarvestAnnouncement,
  buildDefendAnnouncement,
  buildTrapAnnouncement,
};
