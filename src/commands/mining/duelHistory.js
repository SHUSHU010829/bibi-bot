require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { dungeon } = require("../../config");
const duelService = require("../../features/mining/duelService");
const { COIN_EMOJI } = require("../../constants/coin");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("決鬥紀錄")
    .setDescription("查看你的決鬥戰績與最近 10 場結果 ⚔️")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("查看其他玩家的戰績（預設自己）").setRequired(false)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const c = dungeon?.duel || {};
      if (!dungeon?.enabled || !c.enabled || !client.duelGamesCollection) {
        return interaction.editReply("🔧 決鬥系統尚未啟動！");
      }

      const target = interaction.options.getUser("對象") || interaction.user;
      const { recent, wins, losses, total } = await duelService.getHistory(client, {
        guildId: interaction.guildId,
        userId: target.id,
        limit: 10,
      });

      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

      const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ⚔️ 決鬥戰績 ・ ${target}\n` +
              `**${wins}** 勝 **${losses}** 負（共 ${total} 場，勝率 **${winRate}%**）`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder());

      if (recent.length === 0) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "📊 還沒有完成過任何決鬥，快用 `/決鬥` 開戰！"
          )
        );
      } else {
        const lines = recent.map((d) => {
          const isWin = d.winner_id === target.id;
          const isChallenger = d.challenger_id === target.id;
          const oppId = isChallenger ? d.opponent_id : d.challenger_id;
          const epoch = Math.floor(
            new Date(d.completed_at || d.updated_at || Date.now()).getTime() / 1000
          );
          const tag = isWin ? "🏆 勝" : "💀 負";
          const bet = d.bet || 0;
          const pot = d.pot ?? bet * 2; // 舊紀錄未存 pot，回退為全額彩池
          const amount = isWin
            ? `+${(pot - bet).toLocaleString()}`
            : `-${bet.toLocaleString()}`;
          return `${tag} vs <@${oppId}> ・ 賭注 ${(d.bet || 0).toLocaleString()} ・ ${amount} ${COIN_EMOJI} ・ <t:${epoch}:R>`;
        });
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**最近 ${recent.length} 場**\n${lines.join("\n")}`)
        );
      }

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.log(`[ERROR] /決鬥紀錄:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查詢決鬥紀錄失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
