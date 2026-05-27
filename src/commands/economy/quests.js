require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { questSystem } = require("../../config");
const questService = require("../../features/quests/questService");
const { COIN_EMOJI } = require("../../constants/coin");

const PROGRESS_BAR_LEN = 10;
const STATE_EMOJI = {
  pending: "⬜",
  in_progress: "🟡",
  ready: "✅",
  claimed: COIN_EMOJI,
};
const STATE_LABEL = {
  pending: "未開始",
  in_progress: "進行中",
  ready: "待入帳",
  claimed: "已領取",
};

const renderBar = (progress, target) => {
  const ratio = target > 0 ? Math.min(1, progress / target) : 0;
  const filled = Math.round(ratio * PROGRESS_BAR_LEN);
  return "▰".repeat(filled) + "▱".repeat(PROGRESS_BAR_LEN - filled);
};

const renderQuestLine = (q) => {
  const bar = renderBar(q.progress, q.target);
  return [
    `${STATE_EMOJI[q.state]} **${q.name}** ・ ${STATE_LABEL[q.state]}`,
    `-# ${q.description}`,
    `\`${bar}\` ${q.progress}/${q.target} ・ 獎勵 **${q.reward}** ${COIN_EMOJI}`,
  ].join("\n");
};

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("逼幣任務")
    .setDescription("查看每日／週常任務進度 📜")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!questSystem?.enabled) {
        return interaction.editReply("🔧 任務系統尚未啟動！");
      }
      if (!client.questProgressCollection) {
        return interaction.editReply("🔧 任務系統尚未啟動，請聯絡舒舒！");
      }

      const status = await questService.getStatus(
        client,
        interaction.user.id,
        interaction.guildId
      );

      const readyCount =
        status.daily.filter((q) => q.state === "ready").length +
        status.weekly.filter((q) => q.state === "ready").length;

      const container = new ContainerBuilder()
        .setAccentColor(readyCount > 0 ? 0xffa726 : 0x607d8b)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 📜 逼幣任務${
              readyCount > 0
                ? ` ・ 有 **${readyCount}** 個任務剛完成等入帳`
                : ""
            }`
          )
        );

      if (status.daily.length > 0) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `### 🌞 每日任務\n${status.daily.map(renderQuestLine).join("\n\n")}`
            )
          );
      }
      if (status.weekly.length > 0) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `### 📅 週常任務\n${status.weekly.map(renderQuestLine).join("\n\n")}`
            )
          );
      }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 任務完成會自動入帳並私訊通知；若有「待入帳」未到帳，可用 \`/領錢\` 補領。`
        )
      );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /逼幣任務:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 任務查詢失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
