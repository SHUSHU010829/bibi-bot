require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const { errorContainer } = require("../../features/theft/theftView");
const { COIN_EMOJI } = require("../../constants/coin");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("報案")
    .setDescription("花錢委託偵探，查出近期是誰偷了你的錢 🔎")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !client.theftLogsCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const result = await theftService.report(client, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.username,
      });

      if (!result.ok) {
        if (result.reason === "insufficient") {
          return interaction.editReply({
            components: [
              errorContainer(
                "💸 委託費不足",
                `委託偵探需要 **${result.fee.toLocaleString()}** ${COIN_EMOJI}，你只有 **${result.have.toLocaleString()}**。`,
                "先賺點錢再來報案。"
              ),
            ],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply({
          components: [errorContainer("🔧 報案失敗", "系統忙碌或未啟動。", "稍後再試或呼叫舒舒。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (result.noCase) {
        return interaction.editReply({
          components: [
            new ContainerBuilder()
              .setAccentColor(0x2ecc71)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  "# 🔎 沒有案件\n近期沒人偷過你，偵探費用不收。"
                )
              ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const container = new ContainerBuilder().setAccentColor(0x9b59b6);

      if (!result.found) {
        container
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 🔎 查無結果\n偵探收了 **${result.fee.toLocaleString()}** ${COIN_EMOJI}，` +
                `近期有 ${result.totalCases} 起竊案，但線索太少查不出兇手…` +
                (result.refunded ? "\n（已退還委託費）" : "")
            )
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("-# 兇手很專業。之後再委託碰碰運氣。")
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🔎 偵探回報\n花了 **${result.fee.toLocaleString()}** ${COIN_EMOJI}，查出以下嫌犯：`
        )
      );
      for (const c of result.culprits) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `<@${c.actorId}>　偷了你 **${c.amount.toLocaleString()}** ${COIN_EMOJI}（${c.count} 次）`
            )
          );
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 討回公道？可以找他 /決鬥 一雪前恥。")
      );

      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /報案:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 報案失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
