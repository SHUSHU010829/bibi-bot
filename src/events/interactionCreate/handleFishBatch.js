// 連續釣魚（批次）互動處理器。涵蓋兩種互動：
//   1. 按鈕 fish_batch_<owner>_<location>     → 驗證解鎖/券/冷卻後跳「釣幾竿」彈窗
//   2. 彈窗 fish_batch_qty_<owner>_<location> → 解析竿數 → runFishBatch 匯總結果

const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { fishing } = require("../../config");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const fishCmd = require("../../commands/fishing/fish");
const { getOrCreate, isBatchPassActive } = require("../../features/mining/miningProfile");
const { repairRodWithMaterials } = require("../../features/mining/mineService");
const { materialLabel } = require("../../features/mining/craftMaterials");

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
      const fix = fishCmd.parseFishBatchRepairId?.(interaction.customId);
      if (fix) return doRodRepair(client, interaction, fix);
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

async function doRodRepair(client, interaction, { ownerId, location }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這不是你的釣竿。");
  }
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const result = await repairRodWithMaterials(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });

  if (!result.ok) {
    if (result.reason === "insufficient") {
      const lines = (result.missing || []).map(
        (m) => `${materialLabel(m.mat, m.need)}（你有 ${m.have}，還缺 ${m.need - m.have}）`,
      );
      const errC = new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("# ❌ 材料不足，無法修理釣竿"))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 去挖礦/釣魚補材料，或手動釣最後一竿再合成新的。"),
        );
      return interaction
        .editReply({ components: [errC], flags: MessageFlags.IsComponentsV2 })
        .catch(() => {});
    }
    const messages = {
      no_rod: "🎣 竹釣竿不需要修理，先合成一支碳纖釣竿以上。",
      no_recipe: "🔧 這支釣竿沒有可用的修理配方。",
      already_full: "🎣 你的釣竿耐久已經是滿的。",
    };
    return replyEphemeral(interaction, messages[result.reason] || "🔧 修理失敗，請稍後再試。");
  }

  const loc = fishing?.locations?.[location] ? location : "stream";
  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🛠️ 釣竿已用材料修好"),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `釣竿耐久：**${result.durabilityAfter} / ${result.maxDurability}**`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 修好了！點下方繼續連續釣魚。"),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${fishCmd.FISH_BATCH_PREFIX}${interaction.user.id}_${loc}`)
          .setLabel("連續釣魚")
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Primary),
      ),
    );

  await interaction
    .editReply({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
  trackSuccess("fish-batch-repair");
}

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
  if (unlockLevel > 0 && !isBatchPassActive(profile)) {
    const userLevel = await client.userLevelsCollection
      ?.findOne({ userId: interaction.user.id, guildId: interaction.guildId })
      .catch(() => null);
    const lvl = userLevel?.level ?? 0;
    if (lvl < unlockLevel) {
      return replyEphemeralView(
        interaction,
        fishCmd.buildBatchLockedView(unlockLevel, lvl, profile.batch_pass_count || 0),
      );
    }
  }

  // 需要至少一張券才有「連續」意義；實際能釣幾竿依冷卻換算的券數由 fishBatch 逐竿夾住。
  const tickets = profile.cd_ticket_count || 0;
  if (tickets < 1) {
    return replyEphemeralView(interaction, fishCmd.buildBatchNoTicketView());
  }

  const maxCount = fishing?.batch?.maxCount || 1;
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
