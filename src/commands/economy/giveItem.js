require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  InteractionContextType,
} = require("discord.js");

const { coinSystem } = require("../../config");
const itemRegistry = require("../../features/economy/itemRegistry");
const { getOrCreate } = require("../../features/mining/miningProfile");
const { buildChoices, respondChoices, resolveChoice } = require("../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../utils/choiceErrorContainer");

function itemChoices() {
  return buildChoices(itemRegistry.listAll(), (r) => ({ name: r.name, value: r.value }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("give-item")
    .setDescription("[ADMIN] Grant items to a member（礦石／魚／作物／道具／碎片）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Member receiving the items").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("item")
        .setDescription("要給的物品（從自動完成清單選擇）")
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("qty")
        .setDescription("數量")
        .setMinValue(1)
        .setRequired(true),
    )
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  autocomplete: async (client, interaction) => {
    await respondChoices(interaction, itemChoices(), interaction.options.getFocused());
  },

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.miningProfilesCollection) {
        return interaction.editReply("🔧 物品系統尚未啟動！");
      }

      const targetUser = interaction.options.getUser("user");
      const itemValue = interaction.options.getString("item");
      const qty = interaction.options.getInteger("qty");

      if (!qty || qty <= 0) {
        return interaction.editReply("數量必須是正整數。");
      }

      const picked = resolveChoice(itemValue, itemChoices());
      if (!picked.ok) {
        return interaction.editReply({
          components: [buildChoiceErrorContainer(picked, { what: "物品" })],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const item = itemRegistry.resolve(picked.value);
      if (!item) {
        return interaction.editReply("❌ 找不到這個物品，請從自動完成清單選擇。");
      }

      // 確保玩家 profile 存在且已 normalize（避免 upsert 出殘缺文件）
      await getOrCreate(client, targetUser.id, interaction.guildId);

      await itemRegistry.grant(client, targetUser.id, interaction.guildId, itemValue, qty);

      await interaction.editReply(
        `✅ 已給 ${targetUser} **${item.label} ×${qty.toLocaleString()}**`,
      );

      // Audit log：沿用 admin 發錢的稽核頻道
      const auditChannelId = coinSystem?.adminGrant?.auditLogChannelId;
      if (auditChannelId) {
        try {
          const auditChannel = await client.channels.fetch(auditChannelId).catch(() => null);
          if (auditChannel?.isTextBased?.()) {
            const container = new ContainerBuilder()
              .setAccentColor(0x57f287)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("# 🛡️ Admin 物品發放紀錄"),
              )
              .addSeparatorComponents(new SeparatorBuilder())
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**操作者**\n<@${interaction.user.id}>`),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**對象**\n<@${targetUser.id}>`),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**物品**\n${item.label} ×${qty.toLocaleString()}`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# <t:${Math.floor(Date.now() / 1000)}:f>`),
              );
            await auditChannel
              .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
              .catch(() => {});
          }
        } catch (e) {
          console.log(`[ERROR] give-item audit log: ${e}`.red);
        }
      }
    } catch (error) {
      console.log(`[ERROR] /give-item:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 給物品失敗，看 console").catch(() => {});
    }
  },
};
