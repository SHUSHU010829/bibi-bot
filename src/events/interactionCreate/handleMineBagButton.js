// 挖礦成功訊息上「🎒 查看背包」按鈕處理器。
//
// 按鈕 customId = mine_bag_<ownerId>（見 commands/mining/mine.js）。
// 以 ephemeral follow-up 顯示礦石分類的背包，不覆蓋原本的挖礦結果訊息。

require("colors");
const { MessageFlags } = require("discord.js");

const { parseMineBagId } = require("../../commands/mining/mine");
const { buildBackpackView } = require("../../features/shop/backpackView");
const { deferReplySafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const parsed = parseMineBagId(interaction.customId);
  if (!parsed) return;
  const { ownerId } = parsed;

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的背包！",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  try {
    const view = await buildBackpackView(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
      category: "ore",
    });
    await interaction.editReply(view);
  } catch (err) {
    console.log(`[ERROR] mine_bag button:\n${err}`.red);
    await interaction.editReply("🔧 查詢失敗，請稍後再試。").catch(() => {});
  }
};
