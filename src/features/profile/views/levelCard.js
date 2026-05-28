require("colors");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");

const { getLevelProgress } = require("../../../utils/levelMath");
const { getTier } = require("../../../utils/levelTier");
const generateProfileCard = require("../../../utils/generateProfileCard");
const { BADGES } = require("../../leveling/badgeDefinitions");
const { resolveAccent } = require("../../../utils/cardThemes");
const { getTwitchSubBonus } = require("../../../utils/twitchSubBonus");
const { getTheme } = require("../../shop/catalog");

async function buildLevelCardView(client, { target, member, guildId }) {
  if (!client.userLevelsCollection) {
    return { content: "🔧 等級系統尚未啟動，請聯絡舒舒！" };
  }

  const doc = await client.userLevelsCollection.findOne({
    userId: target.id,
    guildId,
  });

  if (!doc) {
    return {
      content: `${target.username} 還沒有等級資料！多聊天/開語音才會開始累積喔 🌱`,
    };
  }

  const progress = getLevelProgress(doc.totalXp);
  const tier = getTier(progress.level);

  const rank =
    (await client.userLevelsCollection.countDocuments({
      guildId,
      totalXp: { $gt: doc.totalXp },
    })) + 1;
  const totalUsers = await client.userLevelsCollection.countDocuments({
    guildId,
  });

  const owned = new Set(doc.badges || []);
  const customDisplay = Array.isArray(doc.displayBadges)
    ? doc.displayBadges.filter((id) => owned.has(id))
    : null;
  const badgeIds = (customDisplay && customDisplay.length > 0
    ? customDisplay
    : doc.badges || []
  ).slice(0, 5);

  const badgeDocs = badgeIds.map((id) => {
    const found = BADGES.find((b) => b.id === id);
    if (found) return found;
    return { id, name: id, emoji: "🏅" };
  });

  const displayName = member?.displayName || target.username;
  const titleLine = doc.title ? doc.title : `${tier.emoji} ${tier.label}`;

  const cardAccent = resolveAccent(doc.cardAccent, tier.color);

  let styleId = null;
  if (doc.walletTheme) {
    const themeMeta = getTheme(doc.walletTheme);
    styleId = themeMeta?.styleId || doc.walletTheme;
  }

  const buf = await generateProfileCard({
    username: displayName,
    avatarUrl: target.displayAvatarURL({ extension: "png", size: 256 }),
    level: progress.level,
    currentLevelXp: progress.currentLevelXp,
    xpToNextLevel: progress.xpToNextLevel,
    progress: progress.progress,
    totalXp: doc.totalXp,
    rank,
    totalUsers,
    tier,
    title: titleLine,
    streak: doc.streak || 0,
    streakFreezes: doc.streakFreezes || 0,
    totalMessages: doc.totalMessages || 0,
    totalVoiceMinutes: doc.totalVoiceMinutes || 0,
    badges: badgeDocs,
    cardAccent,
    styleId,
  });

  const fileName = `profile-${target.id}.png`;
  const attachment = new AttachmentBuilder(buf, { name: fileName });

  const twitchSub = getTwitchSubBonus(member);
  const subLine =
    twitchSub.multiplier > 1
      ? ` ・ 💜 ${twitchSub.name}（XP x${twitchSub.multiplier}）`
      : "";

  const accentInt = parseInt(cardAccent.slice(1), 16);
  const embed = new EmbedBuilder()
    .setColor(accentInt)
    .setAuthor({
      name: `${tier.emoji} ${displayName} 的等級卡`,
      iconURL: target.displayAvatarURL?.() || undefined,
    })
    .setDescription(
      `Lv.${progress.level} ・ ${tier.label} ・ #${rank} / ${totalUsers}${subLine}`
    )
    .setImage(`attachment://${fileName}`);

  return {
    embeds: [embed],
    files: [attachment],
  };
}

module.exports = { buildLevelCardView };
