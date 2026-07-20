// 連續釣魚（批次）互動處理器。涵蓋兩種互動：
//   1. 按鈕 fish_batch_<owner>_<location>     → 驗證解鎖/券/冷卻後跳「釣幾竿」彈窗
//   2. 彈窗 fish_batch_qty_<owner>_<location> → 解析竿數 → runFishBatch 匯總結果

const { MessageFlags } = require("discord.js");

const { fishing } = require("../../config");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const fishCmd = require("../../commands/fishing/fish");
const { getOrCreate } = require("../../features/mining/miningProfile");

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

async function replyEphemeralView(interaction, container) {
  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (interaction.isButton()) {
      const batch = fishCmd.parseFishBatchId?.(interaction.customId);
      if (batch) return openBatchCountModal(client, interaction, batch);
      return;
    }
    if (interaction.isModalSubmit()) {
      const batchModal = fishCmd.parseFishBatchModalId?.(interaction.customId);
      if (batchModal) return submitBatchCount(client, interaction, batchModal);
      return;
    }
  } catch (err) {
    logger.error(
      {
        source: "fish-batch",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "連續釣魚互動處理失敗",
    );
    trackError("fish-batch", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 連續釣魚失敗，請呼叫舒舒！");
  }
};

async function openBatchCountModal(client, interaction, { ownerId, location }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這是別人的釣魚訊息按鈕，請呼叫自己的 /釣魚～");
  }

  const rl = consume(interaction.user.id, "btn:fishBatch", { windowMs: 1500, max: 1 });
  if (!rl.allowed) {
    return replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
  }

  const loc = fishing?.locations?.[location] ? location : "stream";
  const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);

  const unlockLevel = fishCmd.batchUnlockLevel();
  if (unlockLevel > 0) {
    const userLevel = await client.userLevelsCollection
      ?.findOne({ userId: interaction.user.id, guildId: interaction.guildId })
      .catch(() => null);
    const lvl = userLevel?.level ?? 0;
    if (lvl < unlockLevel) {
      return replyEphemeralView(interaction, fishCmd.buildBatchLockedView(unlockLevel, lvl));
    }
  }

  // 冷卻中：每竿都吃一張券（含第一竿，清掉當前冷卻）；已可釣：第一竿免費。
  const onCooldown = (profile.fish_cooldown_at || 0) > Date.now();
  const tickets = profile.cd_ticket_count || 0;
  if (tickets < 1) {
    return replyEphemeralView(interaction, fishCmd.buildBatchNoTicketView());
  }

  const maxCount = Math.min(
    fishing?.batch?.maxCount || 1,
    onCooldown ? tickets : tickets + 1,
  );
  return interaction.showModal(
    fishCmd.buildBatchCountModal({ ownerId: interaction.user.id, location: loc, maxCount }),
  );
}

async function submitBatchCount(client, interaction, { ownerId, location }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這不是你的連續釣魚。");
  }
  const raw = (interaction.fields.getTextInputValue("count") || "").trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return replyEphemeral(interaction, `❌ 竿數無效：「${raw}」。請輸入正整數。`);
  }
  const loc = fishing?.locations?.[location] ? location : "stream";
  if (!(await deferReplySafe(interaction))) return;
  await fishCmd.runFishBatch(client, interaction, { location: loc, count: n });
  trackSuccess("fish-batch");
}
