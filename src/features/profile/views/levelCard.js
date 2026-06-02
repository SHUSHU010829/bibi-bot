require("colors");
const {
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");

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

  let attachment = null;
  let fileName = null;
  try {
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
    fileName = `profile-${target.id}.png`;
    attachment = new AttachmentBuilder(buf, { name: fileName });
  } catch (cardErr) {
    console.log(
      `[WARN] profile card render failed, falling back to text: ${cardErr.message}`.yellow
    );
  }

  const twitchSub = getTwitchSubBonus(member);
  const subLine =
    twitchSub.multiplier > 1
      ? ` ・ 💜 ${twitchSub.name}（XP x${twitchSub.multiplier}）`
      : "";

  const accentInt = parseInt(cardAccent.slice(1), 16);
  const container = new ContainerBuilder()
    .setAccentColor(accentInt)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${tier.emoji} ${displayName} 的等級卡\n-# Lv.${progress.level} ・ ${tier.label} ・ #${rank} / ${totalUsers}${subLine}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (attachment) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${fileName}`)
          .setDescription(`Lv.${progress.level} · ${tier.label}`)
      )
    );
  } else {
    const pct = Math.round((progress.progress || 0) * 100);
    const barLen = 12;
    const filled = Math.max(0, Math.min(barLen, Math.round((pct / 100) * barLen)));
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const badgeLine =
      badgeDocs.length > 0
        ? badgeDocs.map((b) => `${b.emoji} ${b.name}`).join(" ・ ")
        : "尚無徽章";
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**稱號**　${titleLine}\n**進度**　\`${bar}\` ${pct}%（${progress.currentLevelXp.toLocaleString()} / ${progress.xpToNextLevel.toLocaleString()} XP）\n**總 XP**　${doc.totalXp.toLocaleString()}　**排名**　#${rank} / ${totalUsers}`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**🗓️ 連續簽到**　${doc.streak || 0} 天（🛡️ ${doc.streakFreezes || 0}）\n**💬 訊息**　${(doc.totalMessages || 0).toLocaleString()}　**🎙️ 語音**　${(doc.totalVoiceMinutes || 0).toLocaleString()} 分\n**🎖️ 徽章**　${badgeLine}`
        )
      );
  }

  return {
    useV2: true,
    components: [container],
    files: attachment ? [attachment] : [],
  };
}

module.exports = { buildLevelCardView };
