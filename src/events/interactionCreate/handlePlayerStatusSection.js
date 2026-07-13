// 狀態面板分類下拉切換：customId 為 pStatSec_<userId>，value 為 section id。
require("colors");
const { MessageFlags } = require("discord.js");

const { buildStatusView } = require("../../features/buff/buffView");
const {
  appendNav,
  SEC_PREFIX,
  SECTIONS,
} = require("../../features/playerStatus/statusNav");
const { deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  if (!interaction.isStringSelectMenu?.()) return;
  const { customId } = interaction;
  if (!customId || !customId.startsWith(SEC_PREFIX)) return;

  const ownerId = customId.slice(SEC_PREFIX.length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的狀態面板！",
      flags: MessageFlags.Ephemeral,
    });
  }

  const section = interaction.values?.[0];
  if (!SECTIONS.some((s) => s.id === section)) return;

  if (!(await deferUpdateSafe(interaction))) return;

  try {
    const view = await buildStatusView(client, {
      userId: ownerId,
      guildId: interaction.guildId,
      member: interaction.member,
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
      section,
    });
    appendNav(view, ownerId, "buff");
    await interaction.editReply(view);
  } catch (err) {
    console.log(`[ERROR] pStatSec handler:\n${err}\n${err.stack}`.red);
    await interaction.followUp({
      content: "🔧 切換失敗，請稍後再試。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
};
