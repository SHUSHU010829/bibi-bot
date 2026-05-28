require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, craft } = require("../../config");
const craftService = require("../../features/mining/craftService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");

function recipeChoices() {
  return (craft?.recipes || []).map((r) => ({ name: r.name, value: r.id }));
}

function matLabel(mat, qty) {
  const def = mining?.ores?.[mat] || {};
  return `${def.emoji || "⛏️"} ${def.name || mat} ×${qty}`;
}

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("合成")
    .setDescription("用礦石合成更好的鎬子 🔨")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("裝備")
        .setDescription("要合成的裝備")
        .setRequired(true)
        .addChoices(...recipeChoices())
    )
    .addBooleanOption((o) =>
      o
        .setName("確認")
        .setDescription("確認替換目前仍可用的鎬子")
        .setRequired(false)
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const recipeId = interaction.options.getString("裝備");
      const confirm = interaction.options.getBoolean("確認") || false;

      const result = await craftService.craftItem(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        recipeId,
        confirm,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 合成系統尚未啟動！");
        }
        if (result.reason === "no_recipe") {
          return interaction.editReply("❌ 找不到這個配方。");
        }
        if (result.reason === "insufficient") {
          const lines = result.missing.map(
            (m) =>
              `${matLabel(m.mat, m.need)}（你有 ${m.have}，還缺 ${m.need - m.have}）`
          );
          return interaction.editReply(
            `❌ 材料不足，無法合成 **${result.recipe.name}**：\n${lines.join("\n")}`
          );
        }
        if (result.reason === "confirm_needed") {
          return interaction.editReply(
            `⚠️ 你目前的 **${pickaxeLabel(result.current.pickaxe)}** 還有 ${result.current.durability} 次耐久，` +
              `合成 **${result.recipe.name}** 會直接替換掉它。\n` +
              `確定要換，請再執行一次並把 \`確認\` 設為 \`true\`。`
          );
        }
        return interaction.editReply("🔧 合成失敗，請稍後再試。");
      }

      const matLines = Object.entries(result.recipe.materials).map(([mat, qty]) =>
        matLabel(mat, qty)
      );

      const container = new ContainerBuilder()
        .setAccentColor(0x9b59b6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🔨 合成成功\n你打造出了 **${pickaxeLabel(result.pickaxe)}**！`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**消耗材料**\n${matLines.join("\n")}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**耐久**\n${result.durability == null ? "永久" : `${result.durability} 次`}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**累積合成**\n${result.craftCountTotal} 件`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 用 /裝備 查看裝備，/挖礦 開挖！",
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      gameTitleService
        .check(
          client,
          {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            member: interaction.member,
          },
          ["mining"]
        )
        .catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /合成:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 合成失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
