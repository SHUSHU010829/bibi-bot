require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const { COIN_EMOJI } = require("../../constants/coin");

const MAX_SHOWN = 6;

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("通緝榜")
    .setDescription("查看本鎮目前的通緝犯與賞金，出手追捕領賞 🕵️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !client.wantedListCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const rows = await theftService.listWanted(client, interaction.guildId);

      const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 🕵️ 通緝榜")
        );

      if (!rows.length) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("-# 本鎮目前海清河晏，無人在逃。")
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const shown = rows.slice(0, MAX_SHOWN);
      for (const w of shown) {
        const expiresEpoch = Math.floor(new Date(w.expires_at).getTime() / 1000);
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `<@${w.userId}>\n` +
                `賞金 **${w.bounty.toLocaleString()}** ${COIN_EMOJI}　|　錢包 ${w.wallet.toLocaleString()}　|　時效 <t:${expiresEpoch}:R>`
            )
          )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`theft_hunt_${w.userId}`)
                .setLabel("追捕")
                .setEmoji("🕵️")
                .setStyle(ButtonStyle.Danger)
            )
          );
      }

      if (rows.length > MAX_SHOWN) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 還有 ${rows.length - MAX_SHOWN} 名通緝犯未顯示（賞金由高至低）。`
          )
        );
      }

      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /通緝榜:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查詢通緝榜失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
