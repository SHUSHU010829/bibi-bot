// 從 /背包 探險道具區點「使用 1 張」藏寶圖
// customId: use_treasure_map_<ownerId>

require("colors");
const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const {
  USE_TREASURE_MAP_PREFIX,
  parseUseTreasureMapId,
  buildBackpackView,
} = require("../../features/shop/backpackView");
const treasureMapService = require("../../features/treasure/treasureMapService");
const { appendNav } = require("../../features/playerStatus/statusNav");
const { deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId?.startsWith(USE_TREASURE_MAP_PREFIX)) return;

  const ownerId = parseUseTreasureMapId(interaction.customId);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的背包！",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferUpdateSafe(interaction))) return;

  try {
    const result = await treasureMapService.useMap(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.user.username,
      member: interaction.member,
    });

    if (!result.ok) {
      if (result.reason === "no_map") {
        await interaction.followUp({
          content: `❌ 你沒有完整的藏寶圖（碎片：${result.fragments || 0} / 6）。集滿到工坊「合成」分頁打造。`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.followUp({
          content: "🔧 使用失敗，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    const { event, lines, mapsAfter } = result;
    const accent = event.id === "treasure_chest"
      ? 0xf1c40f
      : event.id === "mimic"
        ? 0xc0392b
        : event.id === "stamina_potion"
          ? 0x2ecc71
          : 0x95a5a6;
    const c = new ContainerBuilder()
      .setAccentColor(accent)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${event.emoji || "🗺️"} ${event.name}`),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(event.text || ""))
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n") || "-# （無獎勵）"),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 你還有 **${mapsAfter}** 張藏寶圖`),
      );

    await interaction.followUp({
      components: [c],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    // 主訊息（背包）重抓 → 反映扣掉的藏寶圖
    const view = await buildBackpackView(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
      category: "explore",
    });
    appendNav(view, interaction.user.id, "backpack");
    await interaction.editReply(view).catch(() => {});
  } catch (err) {
    console.log(`[ERROR] use_treasure_map handler:\n${err}\n${err.stack}`.red);
    await interaction.followUp({
      content: "🔧 使用失敗，請呼叫舒舒！",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
};
