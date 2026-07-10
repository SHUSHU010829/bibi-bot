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

const { dungeon } = require("../../config");
const duelService = require("../../features/mining/duelService");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");

const DUEL_MIN_BET = dungeon?.duel?.minBet ?? 100;
const DUEL_MAX_BET = dungeon?.duel?.maxBet ?? 50000;

module.exports = {
  channelBuckets: ["mining", "theft", "duel"],
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
        .setDescription(
          `雙方各押的金幣數（${DUEL_MIN_BET.toLocaleString()} ~ ${DUEL_MAX_BET.toLocaleString()}）`
        )
        .setRequired(true)
        .setMinValue(DUEL_MIN_BET)
        .setMaxValue(DUEL_MAX_BET)
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
        if (result.reason === "daily_limit") {
          return interaction.editReply(
            `⚔️ 今天發起的決鬥已達上限（${result.todayCount}/${result.dailyLimit}），明天再來吧！`
          );
        }
        if (result.reason === "pair_cooldown") {
          const readyEpoch = Math.floor(result.readyAt / 1000);
          return interaction.editReply(
            `⚔️ 你剛跟 ${target} 決鬥過，冷卻中！可再戰時間：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`
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
      const rakePct = c.systemRakePct ?? 0;
      const winnerTake = Math.floor(bet * 2 * (1 - rakePct));

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

      const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${target}\n# ⚔️ 決鬥邀請\n` +
              `${interaction.user} 向 ${target} 發起決鬥！\n` +
              `賭注：**${bet.toLocaleString()}** ${COIN_EMOJI}（雙方各押，勝者贏走 **${winnerTake.toLocaleString()}**${rakePct > 0 ? `，系統抽 ${Math.round(rakePct * 100)}%` : ""}）\n\n` +
              `${target}，你接受嗎？<t:${expiresEpoch}:R> 前未回應將自動取消。`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 接受後進行多回合對戰，攻擊力、武器防禦與爆擊率＋隨機事件決定勝負，弱者也有翻盤機會！",
          ),
        );

      const msg = await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: [target.id] },
      });

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
