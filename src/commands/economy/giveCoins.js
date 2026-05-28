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
const { DateTime } = require("luxon");

const grantCoins = require("../../features/economy/grantCoins");
const { coinSystem } = require("../../config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("give-coins")
    .setDescription("[ADMIN] Grant coins to a member (use a negative amount to deduct)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Member receiving the coins")
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("amount")
        .setDescription("Amount of coins to grant (negative to deduct)")
        .setMinValue(-1000000)
        .setMaxValue(1000000)
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Reason (logged in the transaction history)")
        .setRequired(false),
    )
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.userCoinsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }

      const targetUser = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      const reason = interaction.options.getString("reason") || null;

      if (amount === 0) {
        return interaction.editReply("金額不能為 0");
      }

      // Admin daily cap：以發出者 (operatorId) 為單位，當日累計 |amount| 限額
      const dailyCap = coinSystem?.adminGrant?.dailyCapPerAdmin ?? 0;
      if (dailyCap > 0 && client.coinTransactionsCollection) {
        const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
        const today = DateTime.now().setZone(tz).toISODate();
        const agg = await client.coinTransactionsCollection
          .aggregate([
            {
              $match: {
                guildId: interaction.guildId,
                source: "admin",
                "meta.operatorId": interaction.user.id,
                date: today,
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: { $abs: "$amount" } },
              },
            },
          ])
          .toArray()
          .catch(() => []);
        const usedToday = agg[0]?.total || 0;
        if (usedToday + Math.abs(amount) > dailyCap) {
          return interaction.editReply(
            `❌ 已超過今日 admin 發放上限\n・上限：${dailyCap.toLocaleString()}\n・已用：${usedToday.toLocaleString()}\n・本次：${Math.abs(amount).toLocaleString()}`,
          );
        }
      }

      const member = await interaction.guild.members
        .fetch(targetUser.id)
        .catch(() => null);

      const result = await grantCoins(client, {
        userId: targetUser.id,
        guildId: interaction.guildId,
        username: targetUser.username,
        avatarHash: targetUser.avatar,
        amount,
        source: "admin",
        member,
        meta: {
          reason,
          operatorId: interaction.user.id,
        },
      });

      if (!result) {
        return interaction.editReply("🔧 給金幣失敗（可能 grantCoins 回傳 null）");
      }

      const after = result.doc?.totalCoins ?? "?";
      const verb = amount >= 0 ? "+" : "";
      await interaction.editReply(
        `✅ 已給 ${targetUser} **${verb}${amount}** 金幣\n・目前餘額：**${after.toLocaleString?.() ?? after}**${
          reason ? `\n・原因：${reason}` : ""
        }`,
      );

      // Audit log：將管理員操作公告到指定頻道
      const auditChannelId = coinSystem?.adminGrant?.auditLogChannelId;
      if (auditChannelId) {
        try {
          const auditChannel = await client.channels
            .fetch(auditChannelId)
            .catch(() => null);
          if (auditChannel?.isTextBased?.()) {
            const container = new ContainerBuilder()
              .setAccentColor(amount >= 0 ? 0x57f287 : 0xed4245)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("# 🛡️ Admin 金幣發放紀錄"),
              )
              .addSeparatorComponents(new SeparatorBuilder())
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**操作者**\n<@${interaction.user.id}>`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**對象**\n<@${targetUser.id}>`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**金額**\n**${verb}${amount.toLocaleString()}**`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**餘額**\n${after.toLocaleString?.() ?? after}`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**原因**\n${reason || "（未填）"}`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `-# <t:${Math.floor(Date.now() / 1000)}:f>`,
                ),
              );
            await auditChannel
              .send({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
              })
              .catch(() => {});
          }
        } catch (e) {
          console.log(`[ERROR] admin audit log: ${e}`.red);
        }
      }
    } catch (error) {
      console.log(`[ERROR] /give-coins:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 給金幣失敗，看 console")
        .catch(() => {});
    }
  },
};
