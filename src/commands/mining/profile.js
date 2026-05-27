require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("../../features/mining/miningProfile");
const titleManager = require("../../features/mining/titleManager");
const { COIN_EMOJI } = require("../../constants/coin");

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}

function oreLine(lifetime) {
  const ores = mining?.ores || {};
  return Object.entries(ores)
    .map(([key, def]) => `${def.emoji || ""} ${def.name || key} ${(lifetime?.[key] || 0).toLocaleString()}`)
    .join("\n");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("礦工檔案")
    .setDescription("查看礦工檔案：裝備、稱號、生涯統計 📜")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("玩家").setDescription("要查看的玩家（預設為自己）").setRequired(false)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const target = interaction.options.getUser("玩家") || interaction.user;
      const profile = await getOrCreate(client, target.id, interaction.guildId);

      let coins = 0;
      if (client.userCoinsCollection) {
        const doc = await client.userCoinsCollection
          .findOne({ userId: target.id, guildId: interaction.guildId })
          .catch(() => null);
        coins = doc?.totalCoins || 0;
      }

      const durabilityText =
        profile.pickaxe === "wood" || profile.pickaxe_durability == null
          ? "永久"
          : `${profile.pickaxe_durability} 次`;
      const cap = backpackCapacity(profile, mining);
      const used = backpackUsed(profile);
      const unlocked = profile.unlocked_titles || [];
      const totalTitles = Object.keys(mining?.titles?.defs || {}).length;

      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`📜 ${target.username} 的礦工檔案`)
        .setThumbnail(target.displayAvatarURL?.() || null)
        .addFields(
          {
            name: "展示稱號",
            value: titleManager.titleLabel(profile.active_title || "novice_miner"),
            inline: true,
          },
          {
            name: "已解鎖稱號",
            value: `${unlocked.length}/${totalTitles}`,
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
          {
            name: "背包",
            value: `${used}/${cap}`,
            inline: true,
          },
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

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /礦工檔案:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看檔案失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
