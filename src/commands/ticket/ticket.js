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
            .setDescription("建議面板標題（留空使用預設）")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("建議面板說明（留空使用預設）")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("category_id")
            .setDescription("建議分類頻道 ID（留空使用預設）")
            .setRequired(false)
        )
        .addRoleOption((option) =>
          option
            .setName("support_role")
            .setDescription("客服團隊身份組（留空使用預設）")
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
            .setDescription("發起遊戲頻道提案投票")
            .addStringOption((option) =>
              option
                .setName("game")
                .setDescription("遊戲名稱")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("type")
                .setDescription("提案類型")
                .setRequired(true)
                .addChoices(
                  { name: "新增頻道", value: "create" },
                  { name: "封存頻道", value: "archive" }
                )
            )
            .addBooleanOption((option) =>
              option
                .setName("show_voters")
                .setDescription("公開名單：通過後在結果頻道列出「我會玩」的投票人員（預設關閉）")
                .setRequired(false)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("end")
            .setDescription("⏭️ 提早結束進行中的投票（僅限管理員）")
            .addStringOption((option) =>
              option
                .setName("message_url")
                .setDescription("投票訊息的連結網址")
                .setRequired(true)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("cancel")
            .setDescription("🗑️ 取消進行中的投票（僅限管理員）")
            .addStringOption((option) =>
              option
                .setName("message_url")
                .setDescription("投票訊息的連結網址")
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
            .setDescription("發起一則新投票")
            .addStringOption((option) =>
              option
                .setName("template")
                .setDescription("選擇投票模板")
                .setRequired(true)
                .addChoices(
                  { name: "🎮 遊戲頻道：新增", value: "game_create" },
                  { name: "📦 遊戲頻道：封存", value: "game_archive" },
                  { name: "🕹️ 遊戲伺服器：開設", value: "game_server" },
                  { name: "🎉 活動提案", value: "event" },
                  { name: "📜 規則修改", value: "rule_change" },
                  { name: "💡 一般提案", value: "general" }
                )
            )
            .addStringOption((option) =>
              option
                .setName("title")
                .setDescription("投票標題（例如遊戲名稱、活動名稱、規則摘要）")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("description")
                .setDescription("投票說明（選填）")
                .setRequired(false)
            )
            .addIntegerOption((option) =>
              option
                .setName("duration")
                .setDescription("投票持續時數（預設 48 小時）")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(168)
            )
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("指定投票頻道（選填，預設為設定檔中的頻道）")
                .setRequired(false)
            )
            .addBooleanOption((option) =>
              option
                .setName("show_voters")
                .setDescription("公開名單：通過後在結果頻道列出「我會玩」的投票人員（預設關閉）")
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
