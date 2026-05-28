require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ThumbnailBuilder,
} = require("discord.js");

const { mining } = require("../../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("../../mining/miningProfile");
const gameTitleService = require("../../gameTitles/gameTitleService");
const { COIN_EMOJI } = require("../../../constants/coin");

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}

function oreLine(lifetime) {
  const ores = mining?.ores || {};
  return Object.entries(ores)
    .map(
      ([key, def]) =>
        `${def.emoji || ""} ${def.name || key} ${(lifetime?.[key] || 0).toLocaleString()}`
    )
    .join("\n");
}

async function buildMinerProfileView(client, { target, member, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { content: "🔧 挖礦系統尚未啟動！" };
  }

  const profile = await getOrCreate(client, target.id, guildId);

  let coins = 0;
  if (client.userCoinsCollection) {
    const doc = await client.userCoinsCollection
      .findOne({ userId: target.id, guildId })
      .catch(() => null);
    coins = doc?.totalCoins || 0;
  }

  const levelDoc = await gameTitleService.getDoc(client, target.id, guildId);
  const activeTitle = levelDoc?.title || "（依等級顯示）";
  const unlockedCount = (levelDoc?.gameTitles || []).length;
  const totalTitles = gameTitleService.order().length;

  const durabilityText =
    profile.pickaxe === "wood" || profile.pickaxe_durability == null
      ? "永久"
      : `${profile.pickaxe_durability} 次`;
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);

  const displayName = member?.displayName || target.username;
  const avatarUrl = target.displayAvatarURL?.({ extension: "png", size: 256 });

  const container = new ContainerBuilder().setAccentColor(0xe67e22);

  const headerSection = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 📜 ${displayName} 的礦工檔案\n-# 展示稱號：${activeTitle}`
    )
  );
  if (avatarUrl) {
    headerSection.setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl));
  }
  container.addSectionComponents(headerSection);

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 📋 基本資料\n` +
        `🏷️ 已解鎖稱號：**${unlockedCount}/${totalTitles}**\n` +
        `🏆 週冠次數：**${(profile.weekly_champion_count || 0).toLocaleString()}** 次\n` +
        `⛏️ 目前鎬子：${pickaxeLabel(profile.pickaxe)}（耐久 ${durabilityText}）\n` +
        `💰 錢包餘額：**${coins.toLocaleString()}** ${COIN_EMOJI}\n` +
        `🎒 背包：**${used}/${cap}**`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 📊 生涯統計\n` +
        `⛏️ 挖礦 **${(profile.mine_count_total || 0).toLocaleString()}** 次\n` +
        `🔨 合成 **${(profile.craft_count_total || 0).toLocaleString()}** 件\n` +
        `🗺️ 地下城 **${(profile.dungeon_count || 0).toLocaleString()}** 次`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 📦 歷史採集量\n${oreLine(profile.lifetime_ore)}`
    )
  );

  return {
    useV2: true,
    components: [container],
  };
}

module.exports = { buildMinerProfileView };
