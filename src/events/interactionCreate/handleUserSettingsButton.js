// /個人設定 面板的按鈕處理器。
// customId 格式：usersettings_<userId>_<action>（見 features/settings/userSettingsView.js）

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const userSettings = require("../../features/settings/userSettings");
const userSettingsView = require("../../features/settings/userSettingsView");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const parsed = userSettingsView.parseCustomId(interaction.customId);
  if (!parsed) return;
  const { userId: ownerId, action } = parsed;

  if (interaction.user.id !== ownerId) {
    await interaction
      .reply({
        content: "這不是你的個人設定面板！",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const rl = consume(interaction.user.id, "btn:userSettings", {
    windowMs: 2000,
    max: 2,
  });
  if (!rl.allowed) {
    await interaction
      .reply({
        content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  if (!(await deferUpdateSafe(interaction))) return;

  try {
    if (action === "publicProfile") {
      await userSettings.togglePublicProfile(
        client,
        ownerId,
        interaction.guildId,
      );
    }

    const container = await userSettingsView.buildContainer(
      client,
      ownerId,
      interaction.guildId,
    );
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.log(`[ERROR] handleUserSettingsButton:\n${err}\n${err.stack}`);
    await interaction
      .followUp({
        content: "🔧 切換失敗，請呼叫舒舒！",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }
};
