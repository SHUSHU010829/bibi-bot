require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { questSystem } = require("../../config");
const questService = require("../../features/quests/questService");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("領錢")
    .setDescription("補領未入帳的任務獎勵（任務完成時通常會自動入帳）🪙")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!questSystem?.enabled) {
        return interaction.editReply("🔧 任務系統尚未啟動！");
      }
      if (!client.questProgressCollection) {
        return interaction.editReply("🔧 任務系統尚未啟動，請聯絡舒舒！");
      }

      const result = await questService.claimAll(
        client,
        interaction.user.id,
        interaction.guildId,
        interaction.member,
        interaction.user.username
      );

      if (!result.claimed || result.claimed.length === 0) {
        return interaction.editReply(
          `📭 目前沒有待入帳的任務獎勵。任務完成時通常會自動入帳，用 \`/逼幣任務\` 看看進度！`
        );
      }

      const lines = result.claimed.map((q) => {
        const tag = q.period === "weekly" ? "📅 週常" : "🌞 每日";
        return `${tag} ・ **${q.name}** ・ +**${q.reward.toLocaleString()}** 🪙`;
      });

      const container = new ContainerBuilder()
        .setAccentColor(0x4caf50)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🪙 任務獎勵到手\n共補領 **${result.claimed.length}** 筆任務 ・ **+${result.total.toLocaleString()}** 🪙`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(lines.join("\n"))
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /領錢:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 領取失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
