const {
  SlashCommandBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ThumbnailBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { DateTime } = require("luxon");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("統計")
    .setDescription("📊 查看統計資料")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("用戶")
        .setDescription("查看用戶統計")
        .addUserOption((option) =>
          option
            .setName("目標")
            .setDescription("要查詢的用戶（不填則查詢自己）")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("期間")
            .setDescription("統計期間")
            .setRequired(false)
            .addChoices(
              { name: "今天", value: "today" },
              { name: "本週", value: "week" },
              { name: "本月", value: "month" },
              { name: "全部", value: "all" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("頻道")
        .setDescription("查看頻道統計")
        .addChannelOption((option) =>
          option
            .setName("目標")
            .setDescription("要查詢的頻道（不填則查詢目前頻道）")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("期間")
            .setDescription("統計期間")
            .setRequired(false)
            .addChoices(
              { name: "今天", value: "today" },
              { name: "本週", value: "week" },
              { name: "本月", value: "month" },
              { name: "全部", value: "all" }
            )
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    const period = interaction.options.getString("期間") || "today";

    try {
      if (subcommand === "用戶") {
        const targetUser =
          interaction.options.getUser("目標") || interaction.user;
        await showUserStats(client, interaction, targetUser, period);
      } else if (subcommand === "頻道") {
        const targetChannel =
          interaction.options.getChannel("目標") || interaction.channel;
        await showChannelStats(client, interaction, targetChannel, period);
      }
    } catch (error) {
      console.error(`[ERROR] Stats command error: ${error}`.red);
      await interaction.editReply("❌ 查詢統計資料時發生錯誤");
    }
  },
};

async function showUserStats(client, interaction, user, period) {
  const dateFilter = getDateFilter(period);
  const guildId = interaction.guild.id;

  const messageStats = await client.messageStatsCollection
    .aggregate([
      { $match: { userId: user.id, guildId, ...dateFilter } },
      {
        $group: {
          _id: null,
          totalMessages: { $sum: "$messageCount" },
          channelCount: { $addToSet: "$channelId" },
        },
      },
    ])
    .toArray();

  const voiceStats = await client.voiceStatsCollection
    .aggregate([
      { $match: { userId: user.id, guildId, ...dateFilter } },
      {
        $group: {
          _id: null,
          totalMinutes: { $sum: "$durationMinutes" },
          channelCount: { $addToSet: "$channelId" },
        },
      },
    ])
    .toArray();

  const totalMessages = messageStats[0]?.totalMessages || 0;
  const messageChannelCount = messageStats[0]?.channelCount?.length || 0;
  const totalMinutes = voiceStats[0]?.totalMinutes || 0;
  const voiceChannelCount = voiceStats[0]?.channelCount?.length || 0;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const headerSection = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📊 ${user.username} 的統計資料\n-# 統計期間：${getPeriodText(period)}`,
      ),
    )
    .setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(user.displayAvatarURL({ size: 256 }))
        .setDescription(`${user.username} avatar`),
    );

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addSectionComponents(headerSection)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**💬 訊息統計**\n` +
          `總訊息數：**${totalMessages}** 則\n` +
          `活躍頻道：**${messageChannelCount}** 個`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🎤 語音統計**\n` +
          `總時長：**${hours}** 小時 **${minutes}** 分鐘\n` +
          `語音頻道：**${voiceChannelCount}** 個`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R> 查詢`,
      ),
    );

  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function showChannelStats(client, interaction, channel, period) {
  const dateFilter = getDateFilter(period);
  const guildId = interaction.guild.id;

  const channelStats = await client.channelActivityCollection
    .aggregate([
      { $match: { channelId: channel.id, guildId, ...dateFilter } },
      {
        $group: {
          _id: null,
          totalMessages: { $sum: "$messageCount" },
          allActiveUsers: { $push: "$activeUsers" },
        },
      },
    ])
    .toArray();

  const totalMessages = channelStats[0]?.totalMessages || 0;
  const allUsers = channelStats[0]?.allActiveUsers || [];
  const uniqueUsers = new Set(allUsers.flat()).size;

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📊 #${channel.name} 的統計資料\n-# 統計期間：${getPeriodText(period)}`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**💬 訊息統計**\n總訊息數：**${totalMessages}** 則`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**👥 活躍用戶**\n活躍用戶數：**${uniqueUsers}** 人`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R> 查詢`,
      ),
    );

  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

function getDateFilter(period) {
  const now = DateTime.now().setZone("Asia/Taipei");
  switch (period) {
    case "today":
      return { date: now.toISODate() };
    case "week":
      return { date: { $gte: now.startOf("week").toISODate() } };
    case "month":
      return { date: { $gte: now.startOf("month").toISODate() } };
    case "all":
    default:
      return {};
  }
}

function getPeriodText(period) {
  switch (period) {
    case "today":
      return "今天";
    case "week":
      return "本週";
    case "month":
      return "本月";
    case "all":
      return "全部時間";
    default:
      return "今天";
  }
}
