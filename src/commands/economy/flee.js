require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const { errorContainer, fleeChaseContainer } = require("../../features/theft/theftView");

module.exports = {
  channelBuckets: ["theft"],
  data: new SlashCommandBuilder()
    .setName("潛逃")
    .setDescription("賭一把主動逃亡：逐關選路線甩開追捕，躲到終點全額拿回賞金，被逮全充公 🏃")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !theft?.escapeRun?.enabled || !client.wantedListCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const result = await theftService.startFlee(client, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });

      if (!result.ok) {
        const map = {
          not_wanted: ["🕊️ 你目前沒被通緝", "清白之身，無處可逃。", null],
          already_fleeing: [
            "🏃 你正在逃亡中",
            "上一場逃亡還沒結束，回去原本的訊息繼續選路線。",
            "找不到的話，等它逾時（約 10 分鐘）自動還原成通緝，再重跑一次。",
          ],
        };
        const [t, b, h] = map[result.reason] || ["🔧 逃亡失敗", "系統忙碌或未啟動。", "稍後再試。"];
        return interaction.editReply({
          components: [errorContainer(t, b, h)],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      return interaction.editReply({
        components: [
          fleeChaseContainer(interaction.user.id, result.token, result.stage, result.bounty),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /潛逃:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 逃亡失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
