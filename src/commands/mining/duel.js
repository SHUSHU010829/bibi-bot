require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
} = require("discord.js");

const { dungeon } = require("../../config");
const duelService = require("../../features/mining/duelService");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("決鬥")
    .setDescription("向其他玩家發起 1v1 金幣決鬥，勝者通吃彩池 ⚔️")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("要挑戰的玩家").setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("賭注")
        .setDescription("雙方各押的金幣數")
        .setRequired(true)
        .setMinValue(1)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const c = dungeon?.duel || {};
      if (!dungeon?.enabled || !c.enabled || !client.duelGamesCollection) {
        return interaction.editReply("🔧 決鬥系統尚未啟動！");
      }

      const target = interaction.options.getUser("對象");
      const bet = interaction.options.getInteger("賭注");

      if (target.bot) return interaction.editReply("❌ 不能跟 bot 決鬥啦。");
      if (target.id === interaction.user.id) {
        return interaction.editReply("❌ 不能跟自己決鬥。");
      }

      const result = await duelService.createDuel(client, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        challengerId: interaction.user.id,
        challengerName: interaction.member?.displayName || interaction.user.username,
        opponentId: target.id,
        opponentName: target.username,
        bet,
        member: interaction.member,
      });

      if (!result.ok) {
        if (result.reason === "bad_bet") {
          return interaction.editReply(
            `❌ 賭注需在 **${result.minBet.toLocaleString()}** ~ **${result.maxBet.toLocaleString()}** 之間。`
          );
        }
        if (result.reason === "already_pending") {
          return interaction.editReply(
            "⚔️ 你已經有一場決鬥邀請還在等待回應，等它結束再發起新的吧。"
          );
        }
        if (result.reason === "insufficient") {
          return interaction.editReply(
            `${MONEY_EMOJI} 餘額不足！你目前 **${(result.balance ?? 0).toLocaleString()}** ${COIN_EMOJI}，無法押 ${bet.toLocaleString()}。`
          );
        }
        return interaction.editReply("🔧 發起決鬥失敗，請稍後再試。");
      }

      const expiresEpoch = Math.floor(result.expiresAt / 1000);
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle("⚔️ 決鬥邀請")
        .setDescription(
          `${interaction.user} 向 ${target} 發起決鬥！\n` +
            `賭注：**${bet.toLocaleString()}** ${COIN_EMOJI}（雙方各押，勝者通吃 **${(bet * 2).toLocaleString()}**）\n\n` +
            `${target}，你接受嗎？<t:${expiresEpoch}:R> 前未回應將自動取消。`
        )
        .setFooter({ text: "勝率由雙方鎬子攻擊力決定，裝備越好越有優勢！" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`duel_accept_${result.duelId}`)
          .setLabel("接受決鬥")
          .setEmoji("⚔️")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`duel_decline_${result.duelId}`)
          .setLabel("拒絕 / 取消")
          .setStyle(ButtonStyle.Secondary)
      );

      const msg = await interaction.editReply({
        content: `${target}`,
        embeds: [embed],
        components: [row],
      });

      // 記錄訊息 ID 供按鈕處理後編輯
      await client.duelGamesCollection
        .updateOne(
          { duel_id: result.duelId },
          { $set: { message_id: msg.id, updated_at: new Date() } }
        )
        .catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /決鬥:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 決鬥失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
