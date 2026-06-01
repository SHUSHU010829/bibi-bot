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
const { getActiveFoodBuffs } = require("../../features/fishing/cookService");
const { getOrCreate: getMiningProfile } = require("../../features/mining/miningProfile");
const { fishing } = require("../../config");

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

      const farmLine = s.farmYieldBonus > 0
        ? `**🌾 農場收成**：+${Math.round(s.farmYieldBonus * 100)}%\n`
        : "";

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
              (cdMin != null ? `**⏱️ 挖礦冷卻**：${cdMin} 分鐘\n` : "") +
              farmLine
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
        );

      if (s.events && s.events.length > 0) {
        const eventLines = s.events.map((e) => {
          const bits = [];
          if (e.luck > 0) bits.push(`幸運 +${Math.round(e.luck * 100)}%`);
          if (e.qty > 0) bits.push(`數量 +${e.qty}`);
          return `• ${e.name}${bits.length ? `：${bits.join(" ・ ")}` : ""}`;
        });
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**🎉 限時活動**\n${eventLines.join("\n")}`
            )
          );
      }

      // 食物 buff（Phase S4）
      try {
        const miningProfile = await getMiningProfile(
          client, interaction.user.id, interaction.guildId
        ).catch(() => null);
        if (miningProfile) {
          const foodBuffs = getActiveFoodBuffs(miningProfile);
          if (foodBuffs.length > 0) {
            const recipes = fishing?.recipes || {};
            const foodLines = foodBuffs.map((b) => {
              const recipe = Object.values(recipes).find(
                (r) => r.buff?.type === b.type || r.coalBuff?.type === b.type
              );
              const name = recipe?.name || b.type;
              const emoji = recipe?.emoji || "🍽️";
              let desc = "";
              if (b.type === "work_income") desc = `打工收入 +${Math.round(b.value * 100)}%`;
              else if (b.type === "dungeon_atk") desc = `地下城 ATK +${b.value}`;
              else if (b.type === "mine_luck") desc = `挖礦幸運 +${Math.round(b.value * 100)}%`;
              else if (b.type === "all_boost") desc = `全屬性 +${Math.round(b.value * 100)}%`;
              else if (b.type === "fish_fortune") desc = `釣魚成功率 +${Math.round(b.value * 100)}% ・ 稀有度提升`;
              else if (b.type === "farm_yield") desc = `農場收成 +${Math.round(b.value * 100)}%`;
              else desc = `${b.type}`;
              let expire = "";
              if (b.uses_left !== null && b.uses_left !== undefined) {
                expire = `（剩餘 ${b.uses_left} 次）`;
              } else if (b.expires_at) {
                expire = `（<t:${Math.floor(b.expires_at / 1000)}:R>）`;
              }
              return `• ${emoji} **${name}**：${desc}${expire}`;
            });
            container
              .addSeparatorComponents(new SeparatorBuilder())
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**🍽️ 食物 Buff**\n${foodLines.join("\n")}`
                )
              );
          }
        }
      } catch { /* 讀取食物 buff 失敗不影響主流程 */ }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 加成來源：鎬子 / 幸運藥水 / Twitch 訂閱 / 伺服器加成 / 抖內 / 商店 buff / 限時活動 / 食物"
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
