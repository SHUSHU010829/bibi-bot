require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem } = require("../../config");
const {
  prepareEventDraft,
  buildCreateConfirmContainer,
  MAX_RANK_COUNT,
} = require("../../features/event/hostedEvent");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("活動")
    .setDescription("成員自辦活動（自掏腰包當獎金）🎉")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt.setName("名稱").setDescription("活動名稱").setRequired(true).setMaxLength(80)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("獎金")
        .setDescription("獎金池總額（會立即從你的錢包扣除並鎖定）")
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("名次數")
        .setDescription(`有幾個名次（1 ~ ${MAX_RANK_COUNT}）`)
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_RANK_COUNT)
    )
    .addStringOption((opt) =>
      opt.setName("描述").setDescription("活動說明（選填）").setRequired(false).setMaxLength(500)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("最少人數")
        .setDescription("達到此人數才能結算（預設 1）")
        .setRequired(false)
        .setMinValue(1)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("最多人數")
        .setDescription("達上限後拒絕新報名（不填則無上限）")
        .setRequired(false)
        .setMinValue(1)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.hostedEventsCollection) {
        return interaction.editReply("🔧 活動系統尚未啟動，請聯絡舒舒！");
      }

      const name = interaction.options.getString("名稱").trim();
      const prizePool = interaction.options.getInteger("獎金");
      const rankCount = interaction.options.getInteger("名次數");
      const description = interaction.options.getString("描述")?.trim() || null;
      const minParticipants = interaction.options.getInteger("最少人數") ?? 1;
      const maxParticipants = interaction.options.getInteger("最多人數") ?? null;

      const { token, draft, balance } = await prepareEventDraft(client, {
        guild: interaction.guild,
        hostId: interaction.user.id,
        name,
        description,
        prizePool,
        rankCount,
        minParticipants,
        maxParticipants,
      });

      await interaction.editReply({
        components: [buildCreateConfirmContainer(draft, balance, interaction.user.id, token)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      const msg = error?.message || String(error);
      const isUserError =
        msg.includes("餘額不足") ||
        msg.includes("名次") ||
        msg.includes("最少人數") ||
        msg.includes("最多人數") ||
        msg.includes("獎金池") ||
        msg.includes("活動發布頻道");
      if (!isUserError) {
        console.log(`[ERROR] /活動 開設:\n${error}\n${error.stack || ""}`.red);
      }
      await interaction.editReply(`❌ ${msg}`).catch(() => {});
    }
  },
};
