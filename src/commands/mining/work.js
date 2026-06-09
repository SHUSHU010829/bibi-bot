require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { work } = require("../../config");
const workService = require("../../features/work/workService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");
const { COIN_EMOJI } = require("../../constants/coin");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("打工")
    .setDescription("打工賺取穩定收入 💼（有冷卻時間，每日次數有上限）")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const result = await workService.doWork(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        username: interaction.user.username,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 打工系統尚未啟動！");
        }
        if (result.reason === "cooldown") {
          const readyEpoch = Math.floor(result.readyAt / 1000);
          return interaction.editReply(
            `💼 你還在休息！下次可打工：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`
          );
        }
        if (result.reason === "daily_limit") {
          return interaction.editReply(
            `💼 今天已經打工 ${result.claimsToday}/${result.maxClaims} 次，達上限了！\n` +
              `明天再來：<t:${result.resetEpoch}:R>`
          );
        }
        return interaction.editReply("🔧 打工失敗，請稍後再試。");
      }

      const readyEpoch = Math.floor(result.newCooldownAt / 1000);

      // 等級顯示
      const levelLine = result.level != null
        ? `Lv.${result.level} **${result.levelName}**`
        : "—";
      const progressLine = result.toNext != null
        ? `-# 距下一級（${result.nextLevelName}）還需 ${result.toNext} 次`
        : result.level != null
          ? "-# 已達最高等級 🎉"
          : "";

      const container = new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 💼 打工完成\n你${result.job}，獲得了 **+${result.amount.toLocaleString()}** ${COIN_EMOJI}` +
            (result.foodWorkBonus > 0 ? ` （食物加成 +${Math.round(result.foodWorkBonus * 100)}%）` : "") +
            (result.guildWorkBonus > 0 ? ` （公會加成 +${Math.round(result.guildWorkBonus * 100)}%）` : ""),
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**打工等級**\n${levelLine}\n${progressLine}`,
          ),
        );

      if (result.foodBuffLines?.length) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🍽️ 食物加成**\n${result.foodBuffLines.join("\n")}`,
          ),
        );
      }

      container
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**目前餘額**\n${result.balance.toLocaleString()} ${COIN_EMOJI}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**今日次數**\n${result.claimsToday}/${result.maxClaims}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**下次可打工**\n<t:${readyEpoch}:R>`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 想要更高報酬？試試 /挖礦 吧！",
          ),
        );

      // 到點通知改由 /通知設定 集中管理；這裡只負責把「已訂閱」者的冷卻時間更新到最新。
      const notifyState = await reminder.getState(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "work",
      });
      const notifyEnabled = !!notifyState?.enabled;
      if (notifyEnabled) {
        await reminder.refreshIfEnabled(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "work",
          readyAt: result.newCooldownAt,
        });
      }

      if (!notifyEnabled) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 🔔 想冷卻結束時收到提醒？用 `/通知設定` 開啟打工到點通知。",
          ),
        );
      }

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      // 打工任務進度（非阻塞）
      await applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        [{ questId: "daily_work" }]
      );
    } catch (error) {
      console.log(`[ERROR] /打工:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 打工失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
