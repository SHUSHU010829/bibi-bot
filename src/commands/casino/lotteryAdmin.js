// /lotteryadmin — 開發者用樂透除錯工具。

require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { runDraw, ensureNextDraw, getCurrentOpenDraw } = require("../../features/casino/lottery/runDraw");
const { announceDrawResult } = require("../../features/casino/lottery/announceResult");
const { processAllSubscriptions } = require("../../features/casino/lottery/subscriptions");
const {
  generateReminderSchedule,
} = require("../../features/casino/lottery/reminderScheduler");
const {
  announceReminder,
} = require("../../features/casino/lottery/reminderAnnouncer");
const { listLotteryTypes, getLotteryConfig } = require("../../features/casino/lottery/numbers");

const TYPE_CHOICES = [
  { name: "大樂透 6/49", value: "6_49" },
  { name: "小樂透 3/20", value: "3_20" },
  { name: "威力彩 6/38", value: "power_38_8" },
];

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("lotteryadmin")
    .setDescription("[DEV ONLY] 樂透管理工具")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("force-draw")
        .setDescription("立刻開獎當期")
        .addStringOption((o) =>
          o.setName("玩法").setDescription("玩法").setRequired(true).addChoices(...TYPE_CHOICES)
        )
    )
    .addSubcommand((s) =>
      s.setName("force-subscriptions").setDescription("立刻跑訂閱扣款")
    )
    .addSubcommand((s) =>
      s
        .setName("force-reminder")
        .setDescription("立刻觸發某期某個期中提醒")
        .addStringOption((o) =>
          o.setName("玩法").setDescription("玩法").setRequired(true).addChoices(...TYPE_CHOICES)
        )
        .addIntegerOption((o) =>
          o
            .setName("索引")
            .setDescription("scheduledReminders 陣列索引")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(5)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("regenerate-reminders")
        .setDescription("重新生成當期提醒排程")
        .addStringOption((o) =>
          o.setName("玩法").setDescription("玩法").setRequired(true).addChoices(...TYPE_CHOICES)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("ensure-next")
        .setDescription("補建當期(若不存在)")
    )
    .addSubcommand((s) =>
      s
        .setName("re-announce")
        .setDescription("重發某一期的開獎結果圖卡(用已結算資料重繪,不重抽號、不重派彩)")
        .addStringOption((o) =>
          o
            .setName("drawid")
            .setDescription("該期 drawId,例:20260702-power_38_8")
            .setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("inspect")
        .setDescription("印出當期資訊")
        .addStringOption((o) =>
          o.setName("玩法").setDescription("玩法").setRequired(true).addChoices(...TYPE_CHOICES)
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const sub = interaction.options.getSubcommand();

      if (sub === "force-draw") {
        const t = interaction.options.getString("玩法");
        const result = await runDraw(client, t);
        if (!result) return interaction.editReply("沒有 open 期可開。");
        await announceDrawResult(client, result);
        return interaction.editReply(
          `✅ 已開獎 ${result.draw.drawId},中獎號碼 ${result.draw.winningNumbers.join(",")}`
        );
      }

      if (sub === "force-subscriptions") {
        await processAllSubscriptions(client);
        return interaction.editReply("✅ 訂閱扣款已執行,看 console log。");
      }

      if (sub === "force-reminder") {
        const t = interaction.options.getString("玩法");
        const idx = interaction.options.getInteger("索引");
        const draw = await getCurrentOpenDraw(client, t);
        if (!draw) return interaction.editReply("沒有 open 期");
        const reminders = draw.scheduledReminders || [];
        if (idx >= reminders.length) {
          return interaction.editReply(`索引超出範圍(共 ${reminders.length} 個)`);
        }
        await client.lotteryDrawsCollection.updateOne(
          { _id: draw._id },
          {
            $set: {
              [`scheduledReminders.${idx}.fired`]: true,
              [`scheduledReminders.${idx}.firedAt`]: new Date(),
            },
          }
        );
        const fresh = await client.lotteryDrawsCollection.findOne({ _id: draw._id });
        await announceReminder(client, fresh);
        return interaction.editReply(`✅ 已觸發 reminder #${idx}`);
      }

      if (sub === "regenerate-reminders") {
        const t = interaction.options.getString("玩法");
        const draw = await getCurrentOpenDraw(client, t);
        if (!draw) return interaction.editReply("沒有 open 期");
        const fresh = generateReminderSchedule(draw.scheduledAt);
        await client.lotteryDrawsCollection.updateOne(
          { _id: draw._id },
          { $set: { scheduledReminders: fresh, updatedAt: new Date() } }
        );
        return interaction.editReply(`✅ 重新排程 ${fresh.length} 個提醒`);
      }

      if (sub === "ensure-next") {
        const lines = [];
        for (const t of listLotteryTypes()) {
          const d = await ensureNextDraw(client, t);
          if (d) lines.push(`${t}: ${d.drawId} (pool ${d.pool})`);
          else lines.push(`${t}: 跳過`);
        }
        return interaction.editReply(lines.join("\n") || "無動作");
      }

      if (sub === "re-announce") {
        const drawId = interaction.options.getString("drawid");
        const draw = await client.lotteryDrawsCollection.findOne({ drawId });
        if (!draw) return interaction.editReply(`找不到 drawId \`${drawId}\``);
        if (draw.status !== "settled") {
          return interaction.editReply(
            `該期尚未結算(status=${draw.status}),無法重發。`
          );
        }
        const tickets = await client.lotteryTicketsCollection
          .find({ drawId })
          .toArray();
        await announceDrawResult(client, { draw, tickets }, { skipWinnerDm: true });
        return interaction.editReply(`✅ 已重發 \`${drawId}\` 的開獎結果圖卡。`);
      }

      if (sub === "inspect") {
        const t = interaction.options.getString("玩法");
        const draw = await getCurrentOpenDraw(client, t);
        if (!draw) return interaction.editReply("沒有 open 期");
        const cfg = getLotteryConfig(t);
        const reminders = (draw.scheduledReminders || [])
          .map(
            (r, i) =>
              `  [${i}] ${new Date(r.fireAt).toISOString()} fired=${r.fired}`
          )
          .join("\n");
        return interaction.editReply(
          [
            `${cfg?.emoji} **${cfg?.label}** ${draw.drawId}`,
            `期數 #${draw.drawNumber}, 狀態 ${draw.status}`,
            `彩池 ${draw.pool}, 票數 ${draw.totalTickets || 0}, 系統底池 ${draw.systemSeedAmount}`,
            `滾入 from ${draw.rolledOverFrom || "(無)"}`,
            `已播里程碑 [${(draw.announcedMilestones || []).join(",")}]`,
            `提醒:`,
            reminders || "  (無)",
          ].join("\n")
        );
      }

      return interaction.editReply("未知子指令");
    } catch (err) {
      console.log(`[ERROR] /lotteryadmin:\n${err}\n${err.stack}`.red);
      await interaction.editReply(`🔧 失敗:\`\`\`${err.message}\`\`\``).catch(() => {});
    }
  },
};
