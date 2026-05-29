require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { donation } = require("../../config");

// /卡號 = 贊助限定卡面（donor）專屬：自訂錢包卡上的浮雕卡號。
//   - 設定：輸入卡號（限英數、最多 20 字），存進 UserLevels.customCardNumber
//   - 清除：移除自訂，回到系統預設（依 userId 衍生）
// 權限：需擁有「贊助限定卡面」（UserInventory type=wallet_theme itemId=theme_donor）。

const MAX_LEN = 20;
const VALID_RE = /^[A-Za-z0-9]{1,20}$/;
const DONOR_THEME_ITEM_ID = donation?.themes?.donor || "theme_donor";

// 每 4 字一組以空白分隔（與卡面顯示一致）。
function groupBy4(s) {
  return s.match(/.{1,4}/g).join(" ");
}

// 是否擁有贊助限定卡面（永久 perk）。
async function ownsDonorCard(client, userId, guildId) {
  if (!client.userInventoryCollection) return false;
  const item = await client.userInventoryCollection
    .findOne({
      userId,
      guildId,
      type: "wallet_theme",
      itemId: DONOR_THEME_ITEM_ID,
    })
    .catch(() => null);
  return !!item;
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("卡號")
    .setDescription("自訂你贊助限定卡面上的卡號 💳")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("設定")
        .setDescription("設定卡號（限英文與數字，最多 20 字）")
        .addStringOption((opt) =>
          opt
            .setName("編號")
            .setDescription("只能用英文與數字，最多 20 字")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MAX_LEN)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("清除").setDescription("移除自訂卡號，回到系統預設")
    ),

  run: async (client, interaction) => {
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    if (!client.userLevelsCollection) {
      return interaction.reply({
        content: "🔧 系統尚未就緒，請稍後再試！",
        flags: MessageFlags.Ephemeral,
      });
    }

    // 權限判定：必須擁有贊助限定卡面
    if (!(await ownsDonorCard(client, userId, guildId))) {
      return interaction.reply({
        content:
          "🔒 自訂卡號是「贊助限定卡面」專屬功能，抖內解鎖卡面後即可使用！",
        flags: MessageFlags.Ephemeral,
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "清除") {
      await client.userLevelsCollection.updateOne(
        { userId, guildId },
        { $set: { customCardNumber: null, updatedAt: new Date() } },
        { upsert: true }
      );
      return interaction.reply({
        content: "✅ 已清除自訂卡號，卡面將顯示系統預設編號。",
        flags: MessageFlags.Ephemeral,
      });
    }

    // sub === "設定"
    const raw = (interaction.options.getString("編號") || "").trim();

    if (!VALID_RE.test(raw)) {
      const reason =
        raw.length > MAX_LEN
          ? `最多 ${MAX_LEN} 字（目前 ${raw.length} 字）`
          : "只能使用英文（A–Z）與數字（0–9），不能有空白或符號";
      return interaction.reply({
        content: `❌ 卡號格式不符：${reason}。`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const value = raw.toUpperCase();
    await client.userLevelsCollection.updateOne(
      { userId, guildId },
      { $set: { customCardNumber: value, updatedAt: new Date() } },
      { upsert: true }
    );

    return interaction.reply({
      content: `✅ 卡號已設定為：\`${groupBy4(value)}\`\n-# 用 /檔案 或錢包指令查看你的贊助限定卡面 ✨`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
