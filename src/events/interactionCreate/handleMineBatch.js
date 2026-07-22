// 連續挖礦（批次）互動處理器。涵蓋四種互動：
//   1. 按鈕 mine_batch_<owner>       → 驗證解鎖/券/冷卻後跳「挖幾次」彈窗
//   2. 彈窗 mine_batch_qty_<owner>   → 解析次數 → runMineBatch 匯總結果
//   3. 按鈕 mine_bappr_<owner>_<ts>  → 跳「賭幾顆」彈窗（批次賭石）
//   4. 彈窗 mine_bappr_qty_<owner>_<ts> → 解析顆數 → 依指定顆數賭石並呈現

const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { mining } = require("../../config");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const mineCmd = require("../../commands/mining/mine");
const mineService = require("../../features/mining/mineService");
const appraisalService = require("../../features/mining/stoneAppraisalService");
const diamondAnnouncer = require("../../features/mining/diamondAnnouncer");
const { getOrCreate } = require("../../features/mining/miningProfile");
const { buildAppraisalResultContainer } = require("./handleStoneAppraisal");
const { COIN_EMOJI } = require("../../constants/coin");

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
      // 分支 1：連續挖礦入口
      const batch = mineCmd.parseMineBatchId?.(interaction.customId);
      if (batch) return openBatchCountModal(client, interaction, batch);

      // 分支 3：批次賭石入口
      const bappr = mineCmd.parseBatchAppraiseId?.(interaction.customId);
      if (bappr) return openBatchAppraiseModal(client, interaction, bappr);

      // 分支 5：低耐久停止時，直接用維修工具修理鎬子
      const fix = mineCmd.parseMineBatchRepairId?.(interaction.customId);
      if (fix) return doBatchRepair(client, interaction, fix);
      return;
    }

    if (interaction.isModalSubmit()) {
      // 分支 2：連續挖礦次數送出
      const batchModal = mineCmd.parseMineBatchModalId?.(interaction.customId);
      if (batchModal) return submitBatchCount(client, interaction, batchModal);

      // 分支 4：批次賭石顆數送出
      const bapprModal = mineCmd.parseBatchAppraiseModalId?.(interaction.customId);
      if (bapprModal) return submitBatchAppraise(client, interaction, bapprModal);
      return;
    }
  } catch (err) {
    logger.error(
      {
        source: "mine-batch",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "連續挖礦互動處理失敗",
    );
    trackError("mine-batch", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 連續挖礦失敗，請呼叫舒舒！");
  }
};

async function doBatchRepair(client, interaction, { ownerId, tier }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這不是你的鎬子。");
  }
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const result = await mineService.useRepairTool(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    tier,
  });

  if (!result.ok) {
    const messages = {
      no_tool: "🔧 你已經沒有這階維修工具了。",
      no_pickaxe: "🔧 木鎬不需要修理，先合成一把鐵鎬以上。",
      max_too_low: "🔧 這把鎬子最大耐久太低，改用更高階工具或到 `/合成` 材料修理。",
      retry: "⚠️ 操作衝突，請再試一次。",
    };
    return replyEphemeral(interaction, messages[result.reason] || "🔧 修理失敗，請稍後再試。");
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ 已使用 ${result.def.name} 修理鎬子`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `鎬子耐久：**${result.durabilityAfter} / ${result.maxAfter}**\n` +
          `${result.def.emoji || "🔧"} ${result.def.name} 剩餘 **${result.toolsLeft}** 個`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 修好了！點下方繼續連續挖礦。"),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${mineCmd.MINE_BATCH_PREFIX}${interaction.user.id}`)
          .setLabel("連續挖礦")
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Primary),
      ),
    );

  await interaction
    .editReply({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
  trackSuccess("mine-batch-repair");
}

async function openBatchCountModal(client, interaction, { ownerId }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這是別人的挖礦訊息按鈕，請呼叫自己的 /挖礦～");
  }

  const rl = consume(interaction.user.id, "btn:mineBatch", { windowMs: 1500, max: 1 });
  if (!rl.allowed) {
    return replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
  }

  const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);

  // 解鎖等級（持有生效中的連續挖礦通行證則無視等級門檻）
  const unlockLevel = mineCmd.batchUnlockLevel();
  if (unlockLevel > 0 && !mineService.isBatchPassActive(profile)) {
    const userLevel = await client.userLevelsCollection
      ?.findOne({ userId: interaction.user.id, guildId: interaction.guildId })
      .catch(() => null);
    const lvl = userLevel?.level ?? 0;
    if (lvl < unlockLevel) {
      return replyEphemeralView(
        interaction,
        mineCmd.buildBatchLockedView(unlockLevel, lvl, profile.mining_pass_count || 0),
      );
    }
  }

  // 需要至少一張券才有「連續」意義；實際能挖幾次依冷卻換算的券數由 mineBatch 逐次夾住。
  const tickets = profile.cd_ticket_count || 0;
  if (tickets < 1) {
    return replyEphemeralView(interaction, mineCmd.buildBatchNoTicketView());
  }

  const maxCount = mining?.batch?.maxCount || 1;
  return interaction.showModal(
    mineCmd.buildBatchCountModal({ ownerId: interaction.user.id, maxCount }),
  );
}

async function submitBatchCount(client, interaction, { ownerId }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這不是你的連續挖礦。");
  }
  const raw = (interaction.fields.getTextInputValue("count") || "").trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return replyEphemeral(interaction, `❌ 次數無效：「${raw}」。請輸入正整數。`);
  }
  if (!(await deferReplySafe(interaction))) return;
  await mineCmd.runMineBatch(client, interaction, { count: n });
  trackSuccess("mine-batch");
}

async function openBatchAppraiseModal(client, interaction, { ownerId, ts }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這是別人的賭石按鈕。");
  }
  const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
  const pending = profile.pending_appraisal;
  if (!pending || pending.ts !== ts) {
    return replyEphemeral(interaction, "⌛ 這批石頭已經賭過或過期了，下次連續挖礦後再賭～");
  }
  const haveStone = profile.backpack?.stone || 0;
  const maxQty = Math.max(0, Math.min(Math.floor(pending.qty || 0), haveStone));
  if (maxQty <= 0) {
    return replyEphemeral(interaction, "🪨 背包沒有足夠的石頭可以賭了。");
  }
  return interaction.showModal(
    mineCmd.buildBatchAppraiseModal({ ownerId: interaction.user.id, ts, maxQty }),
  );
}

async function submitBatchAppraise(client, interaction, { ownerId, ts }) {
  if (interaction.user.id !== ownerId) {
    return replyEphemeral(interaction, "🚫 這不是你的賭石。");
  }
  const raw = (interaction.fields.getTextInputValue("qty") || "").trim();
  let requestedCount;
  if (/^(all|全部|max|最大)$/i.test(raw)) {
    requestedCount = null; // 交由 service 依 pending 上限賭滿
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return replyEphemeral(interaction, `❌ 顆數無效：「${raw}」。請輸入正整數，或 all 全賭。`);
    }
    requestedCount = n;
  }

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const result = await appraisalService.appraise(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    username: interaction.user.username,
    ts,
    allowOverflow: true,
    requestedCount,
  });

  if (!result.ok) {
    const messages = {
      disabled: "🔧 賭石系統尚未啟動！",
      no_pending: "⛏️ 這批石頭已經賭過或過期了。",
      stale: "⌛ 這批石頭已經賭過了。",
      expired: "⌛ 鑑定師等不及先走了，下次連續挖礦後手腳快一點！",
      no_stone: "🪨 你的背包沒有足夠的石頭可以賭了。",
      no_coins: `${COIN_EMOJI} 金幣不足！這次鑑定要 ${(result.fee || 0).toLocaleString()}，你只有 ${(result.balance || 0).toLocaleString()}。`,
      charge_failed: "🔧 扣款失敗，已取消這次賭石，請稍後再試。",
    };
    return replyEphemeral(interaction, messages[result.reason] || "🔧 賭石失敗，請稍後再試。");
  }

  const appraiserName = interaction.member?.displayName || interaction.user.username;
  const container = buildAppraisalResultContainer(result, { appraiserName });

  const publicTarget = interaction.channel;
  if (publicTarget?.send) {
    await publicTarget.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
    await interaction.deleteReply().catch(() => {});
  } else {
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // 賭石後把批次結果訊息上的賭石按鈕收掉，避免重複點到失效按鈕
  if (interaction.message?.components?.length) {
    try {
      const components = interaction.message.components.map((top) => {
        const json = top.toJSON();
        if (Array.isArray(json.components)) {
          json.components = json.components.filter((child) => {
            if (child.type !== 1 || !Array.isArray(child.components)) return true;
            return !child.components.some(
              (b) =>
                typeof b.custom_id === "string" &&
                b.custom_id.startsWith(mineCmd.MINE_BATCH_APPRAISE_PREFIX),
            );
          });
        }
        return json;
      });
      await interaction.message
        .edit({ components, flags: MessageFlags.IsComponentsV2 })
        .catch(() => {});
    } catch (_) {
      /* noop */
    }
  }

  if (result.gainedDiamond && mining?.stoneAppraisal?.announceDiamond) {
    await diamondAnnouncer
      .announceDiamond(client, {
        user: interaction.user,
        guildId: interaction.guildId,
        source: "appraise",
        qty: result.winnings?.diamond || 1,
        fallbackChannel: interaction.channel,
      })
      .catch(() => {});
  }

  trackSuccess("mine-batch-appraise");
}
