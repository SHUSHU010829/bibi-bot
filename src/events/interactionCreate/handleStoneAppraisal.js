// 「🔍 找鑑定師賭石」按鈕處理器。
//
// 按鈕 customId = mining_appraise_<ownerId>_<mineTs>（見 commands/mining/mine.js）。
// 確認是本人後，付費把「剛挖到那次」的石頭逐顆開出，有機率變成別種礦。
// 單次性與「只認最新一次挖礦」由 stoneAppraisalService 用 pending_appraisal.ts 原子鎖保證。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { mining } = require("../../config");
const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const mineCmd = require("../../commands/mining/mine");
const appraisalService = require("../../features/mining/stoneAppraisalService");
const { buildOverflowConfirmView } = require("../../features/mining/overflowConfirm");
const { COIN_EMOJI } = require("../../constants/coin");

const APPRAISE_OVERFLOW_CONFIRM_PREFIX = "appraise_overflow_confirm_";
const APPRAISE_OVERFLOW_CANCEL_PREFIX = "appraise_overflow_cancel_";

function parseOverflowId(customId) {
  for (const prefix of [APPRAISE_OVERFLOW_CONFIRM_PREFIX, APPRAISE_OVERFLOW_CANCEL_PREFIX]) {
    if (customId.startsWith(prefix)) {
      const rest = customId.slice(prefix.length);
      const us = rest.lastIndexOf("_");
      if (us <= 0) return null;
      const ownerId = rest.slice(0, us);
      const ts = Number(rest.slice(us + 1));
      if (!ownerId || !Number.isFinite(ts)) return null;
      return { prefix, ownerId, ts };
    }
  }
  return null;
}

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

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

// 賭石開出鑽石：比照挖到鑽石的全服公告
async function announceDiamond(client, interaction) {
  if (!mining?.stoneAppraisal?.announceDiamond) return;
  const content = `🔍💎 **${interaction.user}** 賭石開出了傳說中的 **${oreLabel("diamond")}**！`;
  try {
    const channelId = mining?.announceChannelId;
    if (channelId) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch?.isTextBased()) {
        await ch.send({ content });
        return;
      }
    }
    if (interaction.channel?.isTextBased()) {
      await interaction.channel.send({ content });
    }
  } catch (e) {
    console.log(`[WARN] 賭石鑽石公告失敗：${e.message}`.yellow);
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;

    // 分支 1：賭石溢出折金幣的確認 / 取消
    const overflow = parseOverflowId(interaction.customId);
    if (overflow) {
      if (interaction.user.id !== overflow.ownerId) {
        return replyEphemeral(interaction, "🚫 這不是你的賭石。");
      }
      if (overflow.prefix === APPRAISE_OVERFLOW_CANCEL_PREFIX) {
        return interaction
          .update({ components: [], content: "已取消賭石。" })
          .catch(() => {});
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await runAppraisal(client, interaction, {
        ts: overflow.ts,
        allowOverflow: true,
      });
    }

    // 分支 2：原本的賭石按鈕
    const parsed = mineCmd.parseAppraiseId?.(interaction.customId);
    if (!parsed) return;
    const { ownerId, ts } = parsed;

    const rl = consume(interaction.user.id, "btn:stoneAppraise", {
      windowMs: 2000,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`
      );
      return;
    }

    // 只有本人能賭自己挖到的石頭
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的賭石按鈕，自己 /挖礦 挖到石頭時才能找鑑定師～"
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await runAppraisal(client, interaction, { ts, allowOverflow: false });
  } catch (err) {
    logger.error(
      {
        source: "stone-appraise",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "賭石處理失敗"
    );
    trackError("stone-appraise", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 賭石失敗，請呼叫舒舒！");
  }
};

async function runAppraisal(client, interaction, { ts, allowOverflow }) {
  try {
    const result = await appraisalService.appraise(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      username: interaction.user.username,
      ts,
      allowOverflow,
    });

    if (!result.ok) {
      if (result.reason === "backpack_full") {
        const confirm = buildOverflowConfirmView({
          title: "背包快滿，無法完整收下開出的礦",
          body: "繼續的話，會優先把高價的礦放進背包，放不下的低價礦改折成金幣入帳。",
          used: result.used,
          cap: result.cap,
          confirmCustomId: `${APPRAISE_OVERFLOW_CONFIRM_PREFIX}${interaction.user.id}_${ts}`,
          cancelCustomId: `${APPRAISE_OVERFLOW_CANCEL_PREFIX}${interaction.user.id}_${ts}`,
          confirmLabel: "繼續賭石（溢出折金幣）",
        });
        await interaction.editReply({
          components: [confirm],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      const messages = {
        disabled: "🔧 賭石系統尚未啟動！",
        no_pending:
          "⛏️ 鑑定師只看「剛挖到」的石頭。先 /挖礦 挖到石頭，再立刻找他賭一把！",
        stale:
          "⌛ 這是先前那次挖礦的按鈕，鑑定師只認你最新一次挖到的石頭。",
        expired: "⌛ 鑑定師等不及先走了，下次剛挖到石頭時手腳快一點！",
        no_stone: "🪨 你的背包沒有足夠的石頭可以賭了。",
        no_coins: `${COIN_EMOJI} 金幣不足！這次鑑定要 ${(result.fee || 0).toLocaleString()}，你只有 ${(result.balance || 0).toLocaleString()}。`,
        charge_failed: "🔧 扣款失敗，已取消這次賭石，請稍後再試。",
      };
      await replyEphemeral(
        interaction,
        messages[result.reason] || "🔧 賭石失敗，請稍後再試。"
      );
      return;
    }

    // 逐顆結果（最多列幾顆，避免過長）
    const lines = result.rolls.map((r, i) =>
      r ? `${i + 1}. ✨ 開出 ${oreLabel(r.ore)} ×${r.qty}` : `${i + 1}. 💥 碎掉了…`
    );

    const gainEntries = Object.entries(result.winnings);
    const gainSummary = gainEntries.length
      ? gainEntries
          .map(([ore, q]) => `${oreLabel(ore)} ×${q}`)
          .join("、")
      : "什麼都沒開出來…";

    const allBust = gainEntries.length === 0;
    const accent = result.gainedDiamond
      ? 0xff6ec7
      : allBust
        ? 0x95a5a6
        : 0xf1c40f;
    const title = result.gainedDiamond
      ? "💎 賭石開出鑽石！"
      : allBust
        ? "💥 賭石結果"
        : "🔍 賭石結果";

    const container = new ContainerBuilder()
      .setAccentColor(accent)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${title}\n` +
            `投入 **🪨 石頭 ×${result.count}**，鑑定費 **${result.fee.toLocaleString()}** ${COIN_EMOJI}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n")),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**開出**\n${gainSummary}`),
      );

    if (result.overflowCoins > 0) {
      const foldedSummary = Object.entries(result.foldedWinnings || {})
        .map(([ore, q]) => `${oreLabel(ore)} ×${q}`)
        .join("、");
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🎒 背包放不下：${foldedSummary} → 折成 **+${result.overflowCoins.toLocaleString()}** ${COIN_EMOJI}`,
        ),
      );
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**目前餘額**\n${(result.balanceAfter || 0).toLocaleString()} ${COIN_EMOJI}`,
      ),
    );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    if (result.gainedDiamond) {
      await announceDiamond(client, interaction).catch(() => {});
    }

    trackSuccess("stone-appraise");
  } catch (err) {
    logger.error(
      {
        source: "stone-appraise",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "賭石處理失敗"
    );
    trackError("stone-appraise", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 賭石失敗，請呼叫舒舒！");
  }
};
