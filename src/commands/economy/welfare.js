require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { welfareSystem } = require("../../config");
const welfareService = require("../../features/welfare/welfareService");
const { checkAccountAge } = require("../../features/economy/eligibility");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("乞討")
    .setDescription("破產時領取救濟金，符合資格直接發放，否則顯示狀態 🪙")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!welfareSystem?.enabled) {
        return interaction.editReply("🔧 救濟金系統尚未啟動！");
      }
      if (!client.welfareClaimsCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 救濟金系統尚未啟動，請聯絡舒舒！");
      }

      const accountAge = checkAccountAge(interaction.user);
      if (!accountAge.ok) {
        return interaction.editReply(accountAge.message);
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      // 嘗試領取
      const result = await welfareService.claim(
        client,
        userId,
        guildId,
        interaction.member,
        interaction.user.username
      );

      if (result.ok) {
        return replyClaimSuccess(interaction, result);
      }

      // 系統錯誤類：直接回錯誤
      if (result.reason === "disabled" || result.reason === "system_unready") {
        return interaction.editReply("🔧 救濟金系統尚未啟動，請聯絡舒舒！");
      }
      if (result.reason === "grant_failed") {
        return interaction.editReply(
          "🔧 系統發放失敗，請稍後再試或聯絡舒舒。"
        );
      }

      // above_threshold / already_claimed / race_lost / has_stocks → 一律改顯示狀態
      return showStatus(client, interaction, userId, guildId);
    } catch (error) {
      console.log(`[ERROR] /乞討:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 領取失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};

function replyClaimSuccess(interaction, result) {
  const container = new ContainerBuilder()
    .setAccentColor(0xc9302c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${COIN_EMOJI} 救濟金到手\n**+${result.amount.toLocaleString()}** ${MONEY_EMOJI} ・ 連續 **${result.streak}** 天`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `目前餘額：**${(result.newBalance ?? 0).toLocaleString()}** ${COIN_EMOJI}\n下次可領：<t:${result.resetEpoch}:R>（<t:${result.resetEpoch}:t>）`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 救濟金不會無限發給你，記得連續來領才能拿加成（最高 800/日）。`
      )
    );

  return interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function showStatus(client, interaction, userId, guildId) {
  const status = await welfareService.getStatus(client, userId, guildId);
  const eligible =
    status.eligibleByBalance && !status.claimedToday && !status.hasStocks;

  const assetLine =
    status.depositTotal > 0
      ? `錢包：**${status.balance.toLocaleString()}** ${COIN_EMOJI} ・ 存款本金：**${status.depositTotal.toLocaleString()}** ${COIN_EMOJI} ・ 總資產：**${status.totalAssets.toLocaleString()}** ${COIN_EMOJI}（門檻 ≤ ${status.threshold}）`
      : `目前餘額：**${status.balance.toLocaleString()}** ${COIN_EMOJI}（門檻 ≤ ${status.threshold}）`;

  const lines = [
    `## ${COIN_EMOJI} 救濟金狀態`,
    assetLine,
    `連續天數：**${status.streak}** 天 ・ 歷史最高：${status.longestStreak} 天 ・ 累計領取：${status.totalClaims} 次`,
  ];

  if (status.hasStocks) {
    const symList = status.stockSymbols.slice(0, 5).map((s) => `\`${s}\``).join("、");
    lines.push(
      `\n📈 持有 **${status.stockShares.toLocaleString()}** 股股票（${symList}${status.stockSymbols.length > 5 ? "…" : ""}），不算破產，先 \`/賣股\` 清倉再來乞討。`
    );
  } else if (status.claimedToday) {
    lines.push(
      `\n✅ 今日已領取，下次可領：<t:${status.resetEpoch}:R>（<t:${status.resetEpoch}:t>）`
    );
  } else if (!status.eligibleByBalance) {
    if (status.depositTotal > 0) {
      lines.push(
        `\n${MONEY_EMOJI} 總資產（含存款）超過救濟線，先 \`/領回\` 存款或 \`/錢包\` 看看再說。`
      );
    } else {
      lines.push(`\n${MONEY_EMOJI} 目前金幣超過救濟線，先去玩玩看吧。`);
    }
  } else {
    lines.push(
      `\n✅ **可領取** ${status.nextAmount.toLocaleString()} ${COIN_EMOJI}（連續第 ${status.nextStreak} 天）`
    );
  }

  const container = new ContainerBuilder()
    .setAccentColor(eligible ? 0x4caf50 : 0x9e9e9e)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n"))
    );

  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}
