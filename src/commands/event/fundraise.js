require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, eventFundraise } = require("../../config");
const fundraiseService = require("../../features/event/fundraiseService");
const split = require("../../features/event/fundraiseSplit");
const view = require("../../features/event/fundraiseView");

const cfg = eventFundraise || {};
const MIN_GOAL = cfg.minGoal ?? 1000;
const MAX_GOAL = cfg.maxGoal ?? 3000000;
const MIN_DAYS = cfg.minFundDays ?? 1;
const MAX_DAYS = cfg.maxFundDays ?? 14;
const DEFAULT_DAYS = cfg.defaultFundDays ?? 7;
const MAX_RETENTION_PCT = cfg.maxHostRetentionPct ?? 10;
const MAX_RANKS = split.maxRankCount();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("募資活動")
    .setDescription("申請一個由大家出錢出物的活動，通過審核後開放募資 🎁")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt.setName("名稱").setDescription("活動名稱").setRequired(true).setMaxLength(80),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("名次數")
        .setDescription(`有幾個名次（1 ~ ${MAX_RANKS}，獎金與物品照固定比例分配）`)
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_RANKS),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("募資目標")
        .setDescription(`進度條的目標金額（${MIN_GOAL} ~ ${MAX_GOAL}；不填則不設目標）`)
        .setRequired(false)
        .setMinValue(MIN_GOAL)
        .setMaxValue(MAX_GOAL),
    )
    .addStringOption((opt) =>
      opt.setName("描述").setDescription("活動說明（選填）").setRequired(false).setMaxLength(500),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("募資天數")
        .setDescription(`開放募資幾天（${MIN_DAYS} ~ ${MAX_DAYS}，預設 ${DEFAULT_DAYS}）`)
        .setRequired(false)
        .setMinValue(MIN_DAYS)
        .setMaxValue(MAX_DAYS),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("保留比例")
        .setDescription(`你可保留的募款％（0 ~ ${MAX_RETENTION_PCT}，其餘必須全數發成獎金）`)
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(MAX_RETENTION_PCT),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("最少人數")
        .setDescription("達到此人數才能結算（預設 1）")
        .setRequired(false)
        .setMinValue(1),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("最多人數")
        .setDescription("達上限後拒絕新報名（不填則無上限）")
        .setRequired(false)
        .setMinValue(1),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply({
          components: [
            view.buildNotice({ title: "🔧 金幣系統尚未啟動", body: "現在還不能開募資活動。", kind: "warn" }),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      const result = await fundraiseService.applyFundraise(client, {
        guild: interaction.guild,
        host: interaction.user,
        member: interaction.member,
        name: interaction.options.getString("名稱").trim(),
        description: interaction.options.getString("描述")?.trim() || null,
        goal: interaction.options.getInteger("募資目標") ?? null,
        rankCount: interaction.options.getInteger("名次數"),
        days: interaction.options.getInteger("募資天數") ?? DEFAULT_DAYS,
        retentionPct: interaction.options.getInteger("保留比例") ?? 0,
        minParticipants: interaction.options.getInteger("最少人數") ?? 1,
        maxParticipants: interaction.options.getInteger("最多人數") ?? null,
      });

      if (!result.ok) {
        return interaction.editReply({
          components: [view.buildNotice({ ...result.error, kind: "bad" })],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      const { doc } = result;
      await interaction.editReply({
        components: [
          view.buildNotice({
            title: "📨 申請已送出，等待審核",
            body:
              `**${doc.name}**\n` +
              `募資目標：${doc.funding.goal ? `${doc.funding.goal.toLocaleString()} credits` : "未設定"}\n` +
              `募資天數：${doc.funding.days} 天\n` +
              `名次分配：${doc.rankCount} 名（${split.percentLabel(doc.rankCount)}）\n` +
              `你的保留比例：${doc.funding.hostRetentionPct}%\n` +
              `活動 ID：\`${doc.eventId}\``,
            hint: "舒舒按下「通過」後就會在活動頻道開放募資，通過與否都會在這裡的審核訊息上留下紀錄。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /募資活動:\n${error}\n${error.stack || ""}`.red);
      await interaction
        .editReply({
          components: [
            view.buildNotice({
              title: "❌ 申請失敗",
              body: "送出申請時發生錯誤，沒有建立任何活動。",
              hint: "稍後再試一次，若持續失敗請聯絡舒舒。",
              kind: "bad",
            }),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  },
};
