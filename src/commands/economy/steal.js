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
const {
  errorContainer,
  infoContainer,
  broadcast,
  fleeChaseContainer,
  wantedAnnounceContainer,
  watchdogDistractionLine,
} = require("../../features/theft/theftView");
const theftBoard = require("../../features/theft/theftBoard");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");

module.exports = {
  channelBuckets: ["theft"],
  data: new SlashCommandBuilder()
    .setName("偷竊")
    .setDescription("潛入其他玩家的錢包偷金幣，失風會被全鎮通緝 🥷")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("對象").setDescription("要下手的目標").setRequired(true)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !client.wantedListCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const target = interaction.options.getUser("對象");
      if (target.bot) {
        return interaction.editReply({
          components: [errorContainer("🤖 偷不了機器人", "機器人的口袋比臉還乾淨。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (target.id === interaction.user.id) {
        return interaction.editReply({
          components: [errorContainer("🪞 不能偷自己", "左手偷右手沒有意義啦。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const result = await theftService.steal(client, {
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        actorName: interaction.member?.displayName || interaction.user.username,
        targetId: target.id,
        targetName: target.username,
        member: interaction.member,
      });

      if (!result.ok) {
        return interaction.editReply({
          components: [stealErrorContainer(result, target)],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      // 成功：僅小偷自己可見（潛行），不驚動任何人
      if (result.success) {
        const notoLine = result.cappedByNotoriety
          ? `-# 🥷 這是肥羊！他錢包更多，但你名聲太小（惡名 ${result.notoriety}），一次只偷得走 ${result.stealCap.toLocaleString()}。多偷幾次讓惡名變高，就能偷更多（惡名每 +1、一次多偷 300，最高偷 12,000）。`
          : `-# 🥷 你的惡名 ${result.notoriety}，現在一次最多能偷 ${result.stealCap.toLocaleString()}。惡名越高偷越多（每 +1 多偷 300，最高 12,000）。`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`theft_bank_${interaction.user.id}`)
            .setLabel("把錢存進銀行")
            .setEmoji("💰")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`theft_noto_${interaction.user.id}`)
            .setLabel("查看我的惡名")
            .setEmoji("🥷")
            .setStyle(ButtonStyle.Secondary)
        );
        const container = new ContainerBuilder()
          .setAccentColor(0x2ecc71)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 🥷 得手！\n` +
                (result.watchdogDistracted ? `${watchdogDistractionLine(result.watchdogDistracted)}\n` : "") +
                `你神不知鬼不覺地摸走了 ${target} 的 **${result.stolen.toLocaleString()}** ${COIN_EMOJI}。\n` +
                `黑市抽成 ${result.rake.toLocaleString()}，實際入袋 **${result.net.toLocaleString()}** ${COIN_EMOJI}` +
                (result.usedCloak ? "\n🕶️ 夜行衣已消耗" : "")
            )
          )
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(notoLine))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(row)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 對方不會收到通知，但可花錢 /報案 查兇手。把贓款存進銀行才不會被反偷！"
            )
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      // 失手 → 立刻進入追逃：ephemeral 顯示逃跑畫面，甩開就清白、被逮才上通緝榜
      if (result.fleeing) {
        const components = [];
        if (result.stung) {
          components.push(
            infoContainer(0x2ecc71, `🎣 你踩到 ${target} 的偵探設下的**釣魚執法**陷阱，當場失風！`)
          );
        }
        components.push(
          fleeChaseContainer(interaction.user.id, result.token, result.stage, result.bounty)
        );
        return interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });
      }

      // 逃亡系統未啟用的退路：維持舊行為，直接通緝並公開
      await interaction.editReply({
        components: [
          errorContainer(
            "🚨 失風被逮！",
            `你偷 ${target} 時失手，遭全鎮通緝。\n頭上賞金 **${result.bounty.toLocaleString()}** ${COIN_EMOJI}（已從你錢包凍結託管）。`,
            "潛伏熬過時效可取回賞金；或用 /自首 花保釋金提早脫身。"
          ),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      const announce = wantedAnnounceContainer(interaction.user.id, result.bounty, result.expiresAt);
      const broadcasted = await broadcast(client, announce);
      if (!broadcasted) {
        await interaction.channel
          ?.send({ components: [announce], flags: MessageFlags.IsComponentsV2 })
          .catch(() => {});
      }
      theftBoard.refresh(client).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /偷竊:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 偷竊失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

function stealErrorContainer(result, target) {
  switch (result.reason) {
    case "self_wanted":
      return errorContainer(
        "🚨 你正在通緝中",
        "身為在逃通緝犯還想偷東西？先把自己的事處理完。",
        "用 /自首 或潛伏熬過通緝時效。"
      );
    case "parole": {
      const e = Math.floor(result.until / 1000);
      return errorContainer(
        "🚔 假釋觀察期",
        `你剛自首過，警方還盯著你。可再次下手：<t:${e}:R>（<t:${e}:t>）`,
        "觀察期內先金盆洗手，別急著再犯。"
      );
    }
    case "no_bounty_funds":
      return errorContainer(
        "💸 本錢不足",
        `當賊要先備妥失風的賞金保證金：需要 **${result.need.toLocaleString()}**，你錢包只有 **${result.have.toLocaleString()}**。`,
        "先賺點錢，或從銀行提領一些到錢包。"
      );
    case "daily_limit":
      return errorContainer(
        "🥷 今日已收手",
        `今天的偷竊次數已用完（${result.todayCount}/${result.dailyLimit}）。`,
        "明天（台灣時間 00:00）重置。"
      );
    case "pair_cooldown": {
      const e = Math.floor(result.readyAt / 1000);
      return errorContainer(
        "⏳ 同一目標冷卻中",
        `你剛偷過 ${target}，風頭正緊。可再次下手：<t:${e}:R>（<t:${e}:t>）`,
        "換個目標，或等冷卻結束。"
      );
    }
    case "target_newbie":
      return errorContainer("🛡️ 目標受新手保護", `${target} 還是新來的，暫時偷不了。`, "找入服久一點的老手吧。");
    case "target_poor":
      return errorContainer(
        "🪹 目標沒油水",
        `${target} 錢包不到 **${result.minWallet.toLocaleString()}**，別欺負窮人。`,
        "挑錢包飽一點的目標。"
      );
    case "target_watchdog": {
      const cd = result.pairReadyAt
        ? `可再對他下手：<t:${Math.floor(result.pairReadyAt / 1000)}:R>（<t:${Math.floor(result.pairReadyAt / 1000)}:t>）。`
        : "";
      return errorContainer(
        "🐕 被看門狗擋下",
        `${target} 養了看門狗，這次偷竊被擋下（狗也累了消耗一次）。\n不過這仍算你出手一次：計入今日偷竊次數，並對 ${target} 進入冷卻。${cd}`,
        "先換個目標，或等冷卻結束再回頭。"
      );
    }
    case "target_maxed":
      return errorContainer("🚧 目標今日已被偷太多次", `${target} 今天已被偷到上限，暫時受保護。`, "明天再來，或換目標。");
    case "race":
      return errorContainer("🌀 慢了一步", "目標的錢包狀態剛剛變動，這次沒偷成。", "稍後再試。");
    default:
      return errorContainer("🔧 偷竊失敗", "系統忙碌或未啟動。", "稍後再試或呼叫舒舒。");
  }
}
