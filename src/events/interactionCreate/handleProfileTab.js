// /檔案 分頁切換按鈕：只允許原呼叫者點擊，更新訊息切到該分頁。
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

  const { tabKey, ownerUid } = parsed;

  // 不是本人按的就提示一下，不換頁
  if (interaction.user.id !== ownerUid) {
    return interaction
      .reply({
        content: "🔒 這不是你的個人檔案。你可以自己用 `/檔案` 看自己的喔～",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (err?.code === 10062) return; // 互動已逾期
    throw err;
  }

  try {
    const member = interaction.member;
    const payload = await renderTab(client, {
      tabKey,
      target: interaction.user,
      member,
      guildId: interaction.guildId,
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
      })
      .catch(() => {});
  }
};
