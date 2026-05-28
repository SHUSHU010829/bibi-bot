// /檔案 分頁切換按鈕：點擊後 interaction.update() 換頁，沿用原訊息的 ephemeral 狀態。
require("colors");
const { MessageFlags } = require("discord.js");

const {
  parseCustomId,
  CUSTOM_ID_PREFIX,
  renderTab,
} = require("../../features/profile/render");
const logger = require("../../utils/logger");
const { trackError } = require("../../utils/errorTracker");

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const cid = interaction.customId;
  if (!cid || !cid.startsWith(CUSTOM_ID_PREFIX)) return;

  const parsed = parseCustomId(cid);
  if (!parsed) return;

  const { tabKey, targetUid, ephemeral } = parsed;

  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (err?.code === 10062) return; // 互動已逾期
    throw err;
  }

  try {
    const target = await client.users.fetch(targetUid).catch(() => null);
    if (!target) {
      await interaction
        .editReply({ content: "❌ 找不到該使用者", components: [], files: [] })
        .catch(() => {});
      return;
    }

    const member = await interaction.guild.members
      .fetch(targetUid)
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
    logger.error(
      {
        source: "profile-tab",
        customId: cid,
        err: error.message,
        stack: error.stack,
      },
      "切換 /檔案 分頁失敗"
    );
    trackError("profile-tab", error, { customId: cid });
    await interaction
      .editReply({
        content: "🔧 切換分頁失敗，請重試或重新呼叫 `/檔案`",
        components: [],
        files: [],
        flags: ephemeral ? MessageFlags.Ephemeral : 0,
      })
      .catch(() => {});
  }
};
