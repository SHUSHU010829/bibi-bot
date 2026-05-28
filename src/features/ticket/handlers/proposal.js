require("colors");
const {
  PermissionFlagsBits,
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
const { finalizeProposal } = require("../../voting/finalizeProposal");

const PROPOSAL_TYPE_TO_TEMPLATE = {
  create: "game_create",
  archive: "game_archive",
};

function extractMessageId(url) {
  try {
    const match = url.match(/\/channels\/\d+\/\d+\/(\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

async function handleProposalStart(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const gameName = interaction.options.getString("game");
  const proposalType = interaction.options.getString("type");
  const templateKey = PROPOSAL_TYPE_TO_TEMPLATE[proposalType];
  const template = config.voting.templates[templateKey];

  if (!template) {
    return interaction.editReply({
      content: `❌ 找不到對應的投票模板：${templateKey}`,
    });
  }

  const proposerId = interaction.user.id;

  const votingChannelId = config.voting.votingChannelId;
  if (!votingChannelId || votingChannelId === "YOUR_VOTING_CHANNEL_ID") {
    return interaction.editReply({
      content: "❌ 投票頻道尚未設置！請在 config.json 中設置 voting.votingChannelId。",
    });
  }

  const votingChannel = await interaction.guild.channels.fetch(votingChannelId);
  if (!votingChannel) {
    return interaction.editReply({
      content: "❌ 找不到投票頻道！請檢查配置。",
    });
  }

  const proposer = await interaction.guild.members.fetch(proposerId);
  const duration =
    config.voting.voteDurationHours || config.voting.defaultDurationHours || 48;
  const title =
    proposalType === "create"
      ? `新增【${gameName}】專區`
      : `封存【${gameName}】專區`;

  const description =
    `由 ${proposer} 提出\n\n${template.description}`;

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
    .setAccentColor(proposalType === "create" ? 0x00ff00 : 0xff9900)
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
  for (const btn of template.buttons) votes[btn.id] = [];

  const proposalData = {
    voteId,
    ticketChannelId: interaction.channel.id,
    proposerId,
    title,
    gameName,
    templateKey,
    status: "VOTING",
    messageId: voteMessage.id,
    channelId: votingChannel.id,
    guildId: interaction.guild.id,
    votes,
    createdAt: new Date(),
    expiresAt,
    duration,
  };

  await client.votingProposalsCollection.insertOne(proposalData);

  await interaction.editReply({
    content: `✅ 投票已發起！\n\n🗳️ 投票連結：${voteMessage.url}\n⏰ 投票將在 ${duration} 小時後結束`,
  });

  const ticketContainer = new ContainerBuilder()
    .setAccentColor(0x0099ff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📢 投票已發起\n` +
          `${proposer}，您的提案已進入投票階段！\n\n` +
          `**遊戲名稱：** ${gameName}\n` +
          `**提案類型：** ${proposalType === "create" ? "新增頻道" : "封存頻道"}\n\n` +
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

async function handleProposalEndCommand(client, interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: "❌ 只有管理員才能使用此功能！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageUrl = interaction.options.getString("message_url");
  const messageId = extractMessageId(messageUrl);

  if (!messageId) {
    return interaction.editReply({
      content: "❌ 無效的訊息網址！請提供正確的 Discord 訊息連結。",
    });
  }

  const proposal = await client.votingProposalsCollection.findOne({
    messageId,
    status: "VOTING",
  });

  if (!proposal) {
    return interaction.editReply({
      content: "❌ 找不到進行中的投票！請確認訊息網址是否正確，或投票是否已結束。",
    });
  }

  const outcome = await finalizeProposal(client, proposal, {
    reason: "manual_end",
    endedBy: interaction.user.id,
  });

  const title = proposal.title || proposal.gameName || "提案";
  await interaction.editReply({
    content: outcome
      ? `✅ 投票已提早結束！\n**提案：** ${title}\n**結果：** ${outcome.passed ? "✅ 通過" : "❌ 未通過"}`
      : "✅ 投票已提早結束！",
  });
}

async function handleProposalCancelCommand(client, interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: "❌ 只有管理員才能使用此功能！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageUrl = interaction.options.getString("message_url");
  const messageId = extractMessageId(messageUrl);

  if (!messageId) {
    return interaction.editReply({
      content: "❌ 無效的訊息網址！請提供正確的 Discord 訊息連結。",
    });
  }

  const proposal = await client.votingProposalsCollection.findOne({
    messageId,
    status: "VOTING",
  });

  if (!proposal) {
    return interaction.editReply({
      content: "❌ 找不到進行中的投票！請確認訊息網址是否正確，或投票是否已結束。",
    });
  }

  await finalizeProposal(client, proposal, {
    reason: "cancelled",
    endedBy: interaction.user.id,
  });

  const title = proposal.title || proposal.gameName || "提案";
  await interaction.editReply({
    content: `✅ 投票已取消！\n**提案：** ${title}`,
  });
}

async function run(client, interaction) {
  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "start") {
      await handleProposalStart(client, interaction);
    } else if (subcommand === "end") {
      await handleProposalEndCommand(client, interaction);
    } else if (subcommand === "cancel") {
      await handleProposalCancelCommand(client, interaction);
    }
  } catch (error) {
    console.log(`[ERROR] proposal 指令執行時出錯：\n${error}\n${error.stack}`.red);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: "❌ 執行指令時發生錯誤！",
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "❌ 執行指令時發生錯誤！",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
}

module.exports = { run };
