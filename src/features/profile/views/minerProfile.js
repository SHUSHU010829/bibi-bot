require("colors");
const { EmbedBuilder } = require("discord.js");

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

async function buildMinerProfileView(client, { target, guildId }) {
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

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`📜 ${target.username} 的礦工檔案`)
    .setThumbnail(target.displayAvatarURL?.() || null)
    .addFields(
      { name: "展示稱號", value: activeTitle, inline: true },
      {
        name: "已解鎖稱號",
        value: `${unlockedCount}/${totalTitles}`,
        inline: true,
      },
      {
        name: "週冠次數",
        value: `${(profile.weekly_champion_count || 0).toLocaleString()} 次`,
        inline: true,
      },
      {
        name: "目前鎬子",
        value: `${pickaxeLabel(profile.pickaxe)}（耐久 ${durabilityText}）`,
        inline: true,
      },
      {
        name: "錢包餘額",
        value: `${coins.toLocaleString()} ${COIN_EMOJI}`,
        inline: true,
      },
      { name: "背包", value: `${used}/${cap}`, inline: true },
      {
        name: "生涯統計",
        value:
          `⛏️ 挖礦 **${(profile.mine_count_total || 0).toLocaleString()}** 次\n` +
          `🔨 合成 **${(profile.craft_count_total || 0).toLocaleString()}** 件\n` +
          `🗺️ 地下城 **${(profile.dungeon_count || 0).toLocaleString()}** 次`,
        inline: false,
      },
      {
        name: "歷史採集量",
        value: oreLine(profile.lifetime_ore),
        inline: false,
      }
    );

  return { embeds: [embed] };
}

module.exports = { buildMinerProfileView };
