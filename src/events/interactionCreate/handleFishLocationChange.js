// 冷卻訊息上的「切換下一竿地點」下拉選單處理器。
//
// customId = fish_loc_change_<ownerId>（見 commands/fishing/fish.js）。
// 玩家挑選地點後，原地重繪冷卻訊息（更新 CD 縮短券按鈕內嵌的 location，
// 用券或冷卻歸零自動再釣時就會用新地點）。
//
// 地點解鎖（等級／地下城）這裡不檢查——若玩家挑了還沒解鎖的地點，
// 真的開釣時 fishService 會回 level_locked / dungeon_locked，由 fish.js
// 的錯誤分支呈現解鎖條件，玩家可再切回有解鎖的地點。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { fishing } = require("../../config");
const {
  buildCooldownView,
  parseFishLocChangeId,
} = require("../../commands/fishing/fish");
const { getFishingProfile } = require("../../features/fishing/fishService");
const reminder = require("../../features/reminders/cooldownReminderService");

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
  try {
    if (!interaction.isStringSelectMenu()) return;
    const parsed = parseFishLocChangeId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:fishLocChange", {
      windowMs: 1500,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
      );
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的釣魚訊息，請呼叫自己的 /釣魚～",
      );
      return;
    }

    const newLocation = interaction.values?.[0];
    if (!newLocation || !fishing?.locations?.[newLocation]) {
      await replyEphemeral(interaction, "🔧 無效的地點選擇。");
      return;
    }

    await interaction.deferUpdate();

    const profile = await getFishingProfile(client, interaction.user.id, interaction.guildId);
    const now = Date.now();
    const cooldownAt = profile.fish_cooldown_at || 0;
    if (cooldownAt <= now) {
      await replyEphemeral(
        interaction,
        "✅ 冷卻已經結束了，直接打 `/釣魚` 選地點吧！",
      );
      return;
    }

    const { DateTime } = require("luxon");
    const today = DateTime.now().setZone("Asia/Taipei").toISODate();
    const dailyLimit = fishing?.cdTicketDailyUseLimit || 0;
    const usedToday =
      profile.cd_ticket_used_date === today ? profile.cd_ticket_used_count || 0 : 0;

    const notifyState = await reminder.getState(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      type: "fish",
    });

    const container = buildCooldownView({
      ownerId: interaction.user.id,
      location: newLocation,
      readyAt: cooldownAt,
      cdTickets: profile.cd_ticket_count || 0,
      cdTicketUsedToday: usedToday,
      cdTicketDailyLimit: dailyLimit,
      cdTicketReductionMs: fishing?.cdTicketReductionMs || 0,
      notifyEnabled: !!notifyState?.enabled,
      rodKey: profile.fishing_rod || "bamboo",
      rodDurability: profile.rod_durability,
      rodMaxDurability: profile.rod_max_durability,
    });

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    trackSuccess("fish-loc-change");
  } catch (err) {
    logger.error(
      {
        source: "fish-loc-change",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "切換釣魚地點時出錯",
    );
    trackError("fish-loc-change", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 切換地點失敗，請呼叫舒舒！");
  }
};
