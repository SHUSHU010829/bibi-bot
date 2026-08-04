require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { mining } = require("../../config");
const deepMineService = require("../../features/mining/deepMineService");

const COLOR_OK = 0x8e44ad;
const COLOR_ERR = 0xe74c3c;

const err = (title, body, hint) => {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_ERR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
};

function errorView(r) {
  const dv = mining?.deepVein || {};
  if (r.reason === "locked_server") {
    return err(
      "🔒 深層礦脈尚未開通",
      "**深層礦脈** 需要全服完成主線活動「🛤️ 礦車軌道」才會開放。\n"
        + "解鎖條件：全服共建進度達 100%\n"
        + "目前：軌道尚未鋪設完成",
      "用 `/世界事件` 查看進度並投入資源",
    );
  }
  if (r.reason === "locked_level") {
    return err(
      "🔒 深層礦脈 尚未解鎖！",
      `**深層礦脈** 需要一定等級才進得去。\n解鎖條件：等級 ${r.need}\n目前：Lv.${r.have}`,
      "多挖礦、釣魚、打工累積經驗值",
    );
  }
  if (r.reason === "no_stamina") {
    const next = r.nextRegenAt ? `<t:${Math.floor(r.nextRegenAt / 1000)}:R>` : "稍後";
    return err(
      "😮‍💨 體力用完了",
      `深層礦脈體力：**${r.stamina} / ${r.max}**\n下一點回復：${next}`,
      `每 ${Math.round((dv.staminaRegenMs || 10800000) / 3600000)} 小時回 1 點，離線也會累積`,
    );
  }
  if (r.reason === "backpack_full") {
    return err(
      "🎒 背包滿了",
      `目前 **${r.used} / ${r.cap}**，沒有空間放新礦石。`,
      "先用 `/賣出` 清掉石頭或煤炭，或到 `/商店` 買背包擴充",
    );
  }
  return err("🔧 深挖失敗", "這次沒能挖到東西，請再試一次。", "若持續發生請呼叫舒舒");
}

module.exports = {
  channelBuckets: ["general", "mining"],

  data: new SlashCommandBuilder()
    .setName("深挖")
    .setDescription("深入魔王居所底層的深層礦脈開採魔晶礦 🔮")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    try {
      await interaction.deferReply();
      return await execute(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /深挖: ${error}\n${error.stack}`.red);
      return interaction
        .editReply({ content: "🔧 指令執行失敗，請稍後再試。" })
        .catch(() => {});
    }
  },

  execute,
};

// 已 defer 的互動共用這段（指令走 deferReply、「再挖一次」按鈕走 deferUpdate）
async function execute(client, interaction) {
  const result = await deepMineService.deepMine(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    username: interaction.user.username,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [errorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const def = result.oreDef;
  const nextTxt = result.nextRegenAt
    ? `　・　下一點 <t:${Math.floor(result.nextRegenAt / 1000)}:R>`
    : "　・　已滿";
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_OK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔮 深層礦脈\n${interaction.member?.displayName || interaction.user.username} 挖到了 ${def.emoji || ""} **${def.name}** ×${result.qty}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**體力**　${result.stamina} / ${result.staminaMax}${nextTxt}\n`
          + `**背包**　${result.backpackUsed} / ${result.backpackCap}`
          + (result.xpGained ? `\n**經驗值**　+${result.xpGained}` : ""),
      ),
    );

  if (result.stamina > 0) {
    c.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`deepmine_again_${interaction.user.id}`)
          .setLabel(`再挖一次（剩 ${result.stamina} 體力）`)
          .setEmoji("🔮")
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  return interaction.editReply({
    components: [c],
    flags: MessageFlags.IsComponentsV2,
  });
}
