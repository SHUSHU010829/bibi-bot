// 打工「選工作類型」按鈕處理器。
//
// customId = workpick_<ownerId>_<workTypeKey>（見 features/work/workView.js PICK_PREFIX）。
// 玩家在 /打工 的選項訊息點下類型後，這裡實際執行打工、擲隨機事件，並把原訊息改寫成結果。

require("colors");
const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const workService = require("../../features/work/workService");
const workView = require("../../features/work/workView");
const reminder = require("../../features/reminders/cooldownReminderService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

const { PICK_PREFIX } = workView;

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;
  if (!customId.startsWith(PICK_PREFIX)) return;

  const rest = customId.slice(PICK_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx < 0) return;
  const ownerId = rest.slice(0, sepIdx);
  const workTypeKey = rest.slice(sepIdx + 1);

  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這不是你的打工！用 /打工 開始自己的吧～");
  }

  const rl = consume(interaction.user.id, "btn:workPick", { windowMs: 2000, max: 1 });
  if (!rl.allowed) {
    return replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
  }

  // 先確認互動（deferUpdate 不動原訊息），避免後續 DB 操作超過 3 秒 token 視窗。
  if (!(await deferUpdateSafe(interaction))) return;

  try {
    const result = await workService.doWork(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      username: interaction.user.username,
      workTypeKey,
    });

    if (!result.ok) {
      if (result.reason === "cooldown") {
        return interaction.editReply(workView.buildCooldownMessage(result.readyAt));
      }
      if (result.reason === "daily_limit") {
        return interaction.editReply(workView.buildDailyLimitMessage(result));
      }
      return interaction.editReply(workView.buildDisabledMessage());
    }

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

    await interaction.editReply(workView.buildResultMessage(result, { notifyEnabled }));

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
    console.log(`[ERROR] workpick button:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 打工失敗，請呼叫舒舒！").catch(() => {});
  }
};
