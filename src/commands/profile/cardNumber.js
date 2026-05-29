require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const {
  MAX_LEN,
  groupBy4,
  setCustomCardNumber,
} = require("../../features/donation/customCardNumber");

// /卡號 = 贊助限定卡面（donor）專屬：自訂錢包卡上的浮雕卡號。
//   - 設定：輸入卡號（限英數、最多 20 字），存進 UserLevels.customCardNumber
//   - 清除：移除自訂，回到系統預設（依 userId 衍生）
// 權限與驗證邏輯集中在 features/donation/customCardNumber.js，與背包彈窗共用。

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("卡號")
    .setDescription("自訂你贊助限定卡面上的卡號 💳")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("設定")
        .setDescription(`設定卡號（限英文與數字，最多 ${MAX_LEN} 字）`)
        .addStringOption((opt) =>
          opt
            .setName("編號")
            .setDescription(`只能用英文與數字，最多 ${MAX_LEN} 字`)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MAX_LEN)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("清除").setDescription("移除自訂卡號，回到系統預設")
    ),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    const raw = sub === "清除" ? "" : interaction.options.getString("編號") || "";

    const result = await setCustomCardNumber(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      raw,
    });

    if (!result.ok) {
      const content =
        result.error === "locked"
          ? "🔒 自訂卡號是「贊助限定卡面」專屬功能，抖內解鎖卡面後即可使用！"
          : `❌ 卡號格式不符：${result.error}。`;
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    if (result.cleared) {
      return interaction.reply({
        content: "✅ 已清除自訂卡號，卡面將顯示系統預設編號。",
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: `✅ 卡號已設定為：\`${groupBy4(result.value)}\`\n-# 用 /檔案 或錢包指令查看你的贊助限定卡面 ✨`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
