require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
} = require("discord.js");

const suggestionSetupHandler = require("../../features/ticket/handlers/suggestionSetup");
const proposalHandler = require("../../features/ticket/handlers/proposal");
const voteHandler = require("../../features/ticket/handlers/vote");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("[ADMIN] 建議票務、提案投票管理 🎫")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("suggestion-setup")
        .setDescription("💡 設置建議系統面板")
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Suggestion panel title (leave empty for default)")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Suggestion panel description (leave empty for default)")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("category_id")
            .setDescription("Suggestion category ID (leave empty for default)")
            .setRequired(false)
        )
        .addRoleOption((option) =>
          option
            .setName("support_role")
            .setDescription("Support team role (leave empty for default)")
            .setRequired(false)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("proposal")
        .setDescription("🗳️ 遊戲頻道提案投票管理")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("start")
            .setDescription("Start a new game-channel proposal vote")
            .addStringOption((option) =>
              option
                .setName("game")
                .setDescription("Game name")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("type")
                .setDescription("Proposal type")
                .setRequired(true)
                .addChoices(
                  { name: "Create channel", value: "create" },
                  { name: "Archive channel", value: "archive" }
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("end")
            .setDescription("⏭️ End an ongoing vote early (admin only)")
            .addStringOption((option) =>
              option
                .setName("message_url")
                .setDescription("URL of the vote message")
                .setRequired(true)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("cancel")
            .setDescription("🗑️ Cancel an ongoing vote (admin only)")
            .addStringOption((option) =>
              option
                .setName("message_url")
                .setDescription("URL of the vote message")
                .setRequired(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("vote")
        .setDescription("🗳️ 發起投票提案")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("create")
            .setDescription("Create a new vote")
            .addStringOption((option) =>
              option
                .setName("template")
                .setDescription("Pick a vote template")
                .setRequired(true)
                .addChoices(
                  { name: "🎮 Game channel: create", value: "game_create" },
                  { name: "📦 Game channel: archive", value: "game_archive" },
                  { name: "🎉 Event proposal", value: "event" },
                  { name: "📜 Rule change", value: "rule_change" },
                  { name: "💡 General proposal", value: "general" }
                )
            )
            .addStringOption((option) =>
              option
                .setName("title")
                .setDescription("Vote title (e.g. game name, event name, rule summary)")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("description")
                .setDescription("Vote details (optional)")
                .setRequired(false)
            )
            .addIntegerOption((option) =>
              option
                .setName("duration")
                .setDescription("Vote duration in hours (default 24)")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(168)
            )
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("Override the vote channel (optional, defaults to configured channel)")
                .setRequired(false)
            )
        )
    ),

  run: async (client, interaction) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!group) {
      switch (sub) {
        case "suggestion-setup":
          return suggestionSetupHandler.run(client, interaction);
      }
      return;
    }

    if (group === "proposal") {
      return proposalHandler.run(client, interaction);
    }
    if (group === "vote") {
      return voteHandler.run(client, interaction);
    }
  },
};
