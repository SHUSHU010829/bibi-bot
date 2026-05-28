require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const {
  TABS,
  TAB_BY_KEY,
  DEFAULT_TAB,
  mustForceEphemeral,
} = require("../../features/profile/tabs");
const { renderTab } = require("../../features/profile/render");

// /檔案 是個人資料的統一入口：等級卡、礦工檔案、錢包、背包、賭場紀錄、持股、成就
// 預設打開等級卡分頁，使用者可從按鈕切換。敏感分頁（含金錢資訊）會自動強制 ephemeral。
module.exports = {
  // 標記為 ephemeral 以豁免頻道限制（實際 ephemeral 由 run 決定）
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("檔案")
    .setDescription("查看你或他人的個人檔案：等級卡、礦工、錢包、背包、賭場、持股、成就 📇")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) => {
      opt
        .setName("分頁")
        .setDescription("要先打開哪個分頁（預設等級卡）")
        .setRequired(false);
      for (const t of TABS) {
        opt.addChoices({ name: `${t.emoji} ${t.label}`, value: t.key });
      }
      return opt;
    })
    .addUserOption((opt) =>
      opt
        .setName("用戶")
        .setDescription("不填預設查自己（部分分頁僅限本人）")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("私密")
        .setDescription("只有你看得到（敏感分頁會自動強制私密）")
        .setRequired(false)
    ),

  run: async (client, interaction) => {
    const tabKey = interaction.options.getString("分頁") || DEFAULT_TAB;
    const target = interaction.options.getUser("用戶") || interaction.user;
    const requestedEphemeral =
      interaction.options.getBoolean("私密") ?? false;

    const tab = TAB_BY_KEY.get(tabKey);
    if (!tab) {
      return interaction.reply({
        content: "❌ 找不到該分頁",
        flags: MessageFlags.Ephemeral,
      });
    }

    const isSelf = target.id === interaction.user.id;

    // 不允許看他人的私人分頁，直接擋掉
    if (!isSelf && !tab.viewOther) {
      return interaction.reply({
        content: `🔒 「${tab.emoji} ${tab.label}」只能查看自己的資料`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 敏感分頁自動強制 ephemeral，避免無意間在公開頻道暴露金錢資料
    const ephemeral = requestedEphemeral || mustForceEphemeral(tabKey);

    await interaction.deferReply({
      flags: ephemeral ? MessageFlags.Ephemeral : 0,
    });

    try {
      const member = await interaction.guild.members
        .fetch(target.id)
        .catch(() => null);

      const payload = await renderTab(client, {
        tabKey,
        target,
        viewer: interaction.user,
        member,
        guildId: interaction.guildId,
        ephemeral,
      });

      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /檔案:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply({ content: "🔧 載入檔案失敗，請呼叫舒舒！", flags: 0 })
        .catch(() => {});
    }
  },
};
