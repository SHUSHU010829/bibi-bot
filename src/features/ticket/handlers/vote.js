require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { randomUUID } = require("crypto");
const config = require("../../../config");

function getTemplateColor(templateKey) {
  const colors = {
    game_create: 0x00ff00,
    game_archive: 0xff9900,
    event: 0x9b59b6,
    rule_change: 0x3498db,
    general: 0x95a5a6,
  };
  return colors[templateKey] || 0x0099ff;
}

async function handleVoteCreate(client, interaction) {
  try {
    const templateKey = interaction.options.getString("template");
    const title = interaction.options.getString("title");
    const customDescription = interaction.options.getString("description");
    const duration = interaction.options.getInteger("duration") || config.voting.defaultDurationHours;
    const customChannel = interaction.options.getChannel("channel");
    const showVoters = interaction.options.getBoolean("show_voters") || false;

    const template = config.voting.templates[templateKey];
    if (!template) {
      return interaction.reply({
        content: "❌ 找不到指定的投票模板！",
        flags: MessageFlags.Ephemeral,
      });
    }

    let votingChannel;
    if (customChannel) {
      votingChannel = customChannel;
    } else {
      const votingChannelId = config.voting.votingChannelId;
      if (!votingChannelId || votingChannelId === "YOUR_VOTING_CHANNEL_ID") {
        return interaction.reply({
          content: "❌ 投票頻道尚未設置！請在 config.json 中設置 voting.votingChannelId 或使用 channel 參數指定頻道。",
          flags: MessageFlags.Ephemeral,
        });
      }
      votingChannel = await interaction.guild.channels.fetch(votingChannelId);
    }

    if (!votingChannel) {
      return interaction.reply({
        content: "❌ 找不到投票頻道！請檢查配置。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const isTicketChannel = interaction.channel.name.startsWith("ticket-");
    let ticketChannelId = null;
    let proposerId = interaction.user.id;

    if (isTicketChannel) {
      ticketChannelId = interaction.channel.id;
      const ticketCreatorMatch = interaction.channel.topic?.match(/票務創建者：(\d+)/);
      if (ticketCreatorMatch) {
        proposerId = ticketCreatorMatch[1];
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const proposer = await interaction.guild.members.fetch(proposerId);
    const embedColor = getTemplateColor(templateKey);

    let description = customDescription || template.description;
    description = `由 ${proposer} 提出\n\n${description}`;

    const buttons = new ActionRowBuilder();
    for (const btn of template.buttons) {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_${templateKey}_${btn.id}`)
          .setLabel(btn.label)
          .setEmoji(btn.emoji)
          .setStyle(ButtonStyle[btn.style])
      );
    }

    const votingContainer = new ContainerBuilder()
      .setAccentColor(embedColor)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${template.emoji} 提案：${title}\n${description}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**📋 投票類型**：${template.name}\n` +
            `**⏰ 投票時間**：${duration} 小時\n` +
            `**📅 截止時間**：<t:${Math.floor(Date.now() / 1000) + duration * 3600}:R>`,
        ),
      )
      .addActionRowComponents(buttons)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 提案人：${proposer.user.tag} ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
        ),
      );

    const voteMessage = await votingChannel.send({
      components: [votingContainer],
      flags: MessageFlags.IsComponentsV2,
    });

    const voteId = randomUUID();
    const expiresAt = new Date(Date.now() + duration * 60 * 60 * 1000);

    const votes = {};
    for (const btn of template.buttons) {
      votes[btn.id] = [];
    }

    const proposalData = {
      voteId,
      ticketChannelId,
      proposerId,
      title,
      templateKey,
      customDescription,
      status: "VOTING",
      messageId: voteMessage.id,
      channelId: votingChannel.id,
      guildId: interaction.guild.id,
      votes,
      showVoters,
      createdAt: new Date(),
      expiresAt,
      duration,
    };

    await client.votingProposalsCollection.insertOne(proposalData);

    let replyContent = `✅ 投票已發起！\n\n🗳️ 投票連結：${voteMessage.url}\n⏰ 投票將在 ${duration} 小時後結束`;

    await interaction.editReply({
      content: replyContent,
    });

    if (isTicketChannel) {
      const ticketContainer = new ContainerBuilder()
        .setAccentColor(0x0099ff)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 📢 投票已發起\n` +
              `${proposer}，您的提案已進入投票階段！\n\n` +
              `**提案標題：** ${title}\n` +
              `**投票類型：** ${template.name}\n\n` +
              `[點擊此處前往投票](${voteMessage.url})`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.channel.send({
        components: [ticketContainer],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } catch (error) {
    console.log(`[ERROR] 發起投票時出錯：\n${error}\n${error.stack}`.red);
    throw error;
  }
}

async function run(client, interaction) {
  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "create") {
      await handleVoteCreate(client, interaction);
    }
  } catch (error) {
    console.log(`[ERROR] vote 指令執行時出錯：\n${error}\n${error.stack}`.red);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ 執行指令時發生錯誤！",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

module.exports = { run };
