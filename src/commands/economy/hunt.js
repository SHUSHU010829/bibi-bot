require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const { errorContainer, huntResultContainer, broadcast } = require("../../features/theft/theftView");
const theftBoard = require("../../features/theft/theftBoard");

module.exports = {
  channelBuckets: ["theft"],
  data: new SlashCommandBuilder()
    .setName("追捕")
    .setDescription("追捕通緝犯，成功搶下他頭上的賞金 🕵️")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) =>
      o.setName("通緝犯").setDescription("要追捕的通緝對象").setRequired(true)
    ),

  run: async (client, interaction) => {
    // 追捕結果對玩家私人顯示；成功才公開推到通緝廣播頻道
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !client.wantedListCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const target = interaction.options.getUser("通緝犯");
      const result = await theftService.huntWanted(client, {
        guildId: interaction.guildId,
        hunterId: interaction.user.id,
        hunterName: interaction.member?.displayName || interaction.user.username,
        wantedUserId: target.id,
        member: interaction.member,
      });

      if (!result.ok) {
        return interaction.editReply({
          components: [huntErrorContainer(result, target)],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const resultContainer = huntResultContainer(result, interaction.user.id, target.id);
      // 抓到人 → 公開推到通緝廣播頻道；玩家本人這裡仍是私人結果
      if (result.success) {
        await broadcast(client, resultContainer);
      }
      theftBoard.refresh(client).catch(() => {});
      return interaction.editReply({
        components: [resultContainer],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /追捕:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 追捕失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

function huntErrorContainer(result, target) {
  switch (result.reason) {
    case "self":
      return errorContainer("🪞 不能追捕自己", "自首請用 /自首。");
    case "not_wanted":
      return errorContainer("🕊️ 對方沒被通緝", `${target} 目前不在通緝榜上。`, "用 /通緝榜 看看誰在逃。");
    case "daily_limit":
      return errorContainer(
        "🕵️ 今日追捕次數已用完",
        `你今天已追捕 ${result.todayCount}/${result.dailyLimit} 次。`,
        "明天（台灣時間 00:00）重置。"
      );
    case "hunt_cooldown": {
      const e = Math.floor(result.readyAt / 1000);
      return errorContainer(
        "🫥 他躲起來了",
        `${target} 剛甩開一次追捕，正躲風頭。可再次追捕：<t:${e}:R>（<t:${e}:t>）`,
        "等他探頭出來，或先去 /通緝榜 抓別人。"
      );
    }
    case "already_failed":
      return errorContainer(
        "🙅 你已經追丟過他了",
        `你這次通緝期間已經追捕 ${target} 失敗，機會用掉了。`,
        "讓其他人去抓，或等他下次再犯。"
      );
    case "race":
      return errorContainer("🌀 慢了一步", "這名通緝犯剛剛已被別人處理掉了。", "刷新 /通緝榜 看看還有誰。");
    default:
      return errorContainer("🔧 追捕失敗", "系統忙碌或未啟動。", "稍後再試或呼叫舒舒。");
  }
}
