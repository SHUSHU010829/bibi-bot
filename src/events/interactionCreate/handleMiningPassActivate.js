// 從 /背包 挖礦道具區點「啟用」連續挖礦通行證
// customId: mining_activate_pass_<ownerId>

require("colors");
const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const {
  ACTIVATE_MINING_PASS_PREFIX,
  parseActivateMiningPassId,
  buildBackpackView,
} = require("../../features/shop/backpackView");
const mineService = require("../../features/mining/mineService");
const { appendNav } = require("../../features/playerStatus/statusNav");
const { deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId?.startsWith(ACTIVATE_MINING_PASS_PREFIX)) return;

  const ownerId = parseActivateMiningPassId(interaction.customId);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的背包！",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferUpdateSafe(interaction))) return;

  try {
    const result = await mineService.activateMiningPass(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (!result.ok) {
      const c = new ContainerBuilder().setAccentColor(0xe74c3c);
      if (result.reason === "already_active") {
        c.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 🎟️ 通行證已在生效中"),
        )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `目前的連續挖礦通行證 <t:${Math.floor(result.expiresAt / 1000)}:R> 才到期，先用完再啟用下一張。`,
            ),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("-# 直接去 `/挖礦` 按「連續挖礦」吧！"),
          );
      } else if (result.reason === "no_pass") {
        c.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 🎟️ 沒有連續挖礦通行證"),
        )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("你目前沒有可啟用的連續挖礦通行證。"),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 可到贊助頁購買，啟用後 1 小時內無視等級連續挖礦。",
            ),
          );
      } else {
        c.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 🔧 啟用失敗"),
        )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("操作衝突，請再試一次。"),
          );
      }
      await interaction.followUp({
        components: [c],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    const c = new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("# 🎟️ 連續挖礦通行證 已啟用"),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `生效到 <t:${Math.floor(result.expiresAt / 1000)}:R>，這段期間無視等級即可連續挖礦。`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 剩餘通行證 ×${result.passesLeft}・連續挖礦仍照冷卻扣 CD 縮短券，記得備券！`,
        ),
      );

    await interaction.followUp({
      components: [c],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    const view = await buildBackpackView(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
      category: "mine",
    });
    appendNav(view, interaction.user.id, "backpack");
    await interaction.editReply(view).catch(() => {});
  } catch (err) {
    console.log(`[ERROR] mining_activate_pass handler:\n${err}\n${err.stack}`.red);
    await interaction
      .followUp({
        content: "🔧 啟用失敗，請呼叫舒舒！",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }
};
