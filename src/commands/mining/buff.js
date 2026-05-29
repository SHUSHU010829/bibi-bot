require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const buffResolver = require("../../features/buff/buffResolver");

function pct(mult) {
  return `${Math.round((mult - 1) * 100)}%`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("加成")
    .setDescription("查看你目前生效中的各種加成（攻擊 / 幸運 / 金幣 / 經驗）✨")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const s = await buffResolver.summary(
        client,
        interaction.user.id,
        interaction.guildId,
        interaction.member
      );

      const cdMin = s.miningCdMs ? Math.round((s.miningCdMs / 60000) * 10) / 10 : null;

      const incomeLines = [];
      if (s.income.twitch?.multiplier > 1) {
        incomeLines.push(`• ${s.income.twitch.name || "Twitch 訂閱"}：+${pct(s.income.twitch.multiplier)}`);
      }
      if (s.income.serverBoost?.multiplier > 1) {
        incomeLines.push(`• ${s.income.serverBoost.name || "伺服器加成"}：+${pct(s.income.serverBoost.multiplier)}`);
      }
      if (s.income.coinBoost > 1) {
        incomeLines.push(`• 金幣 buff：+${pct(s.income.coinBoost)}`);
      }
      if (!incomeLines.length) incomeLines.push("• 無金幣加成");

      const container = new ContainerBuilder()
        .setAccentColor(0x1abc9c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ✨ ${interaction.member?.displayName || interaction.user.username} 的加成總覽`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**⚔️ 攻擊力**：${s.atk}\n` +
              `**🍀 挖礦幸運**：+${Math.round(s.luckBonus * 100)}%\n` +
              `**⛏️ 挖礦數量加成**：+${s.qtyBonus}\n` +
              (cdMin != null ? `**⏱️ 挖礦冷卻**：${cdMin} 分鐘\n` : "")
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**🪙 金幣加成**\n${incomeLines.join("\n")}`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**📈 經驗加成**：${s.xpBoost > 1 ? `+${pct(s.xpBoost)}` : "無"}`
          )
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 加成來源：鎬子 / 幸運藥水 / Twitch 訂閱 / 伺服器加成 / 抖內 / 商店 buff"
          )
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /加成:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查詢加成失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
