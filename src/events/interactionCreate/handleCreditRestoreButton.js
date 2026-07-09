require("colors");
const {
  MessageFlags,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const creditService = require("../../features/bank/creditService");
const { deferUpdateSafe } = require("../../utils/safeAck");

// 可疑金流告警的「誤報，復原扣分」按鈕：管理員點擊後把扣掉的信用分補回。
module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  const cid = interaction.customId;
  if (!cid?.startsWith("creditrestore_")) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      content: "🚫 只有管理員可以復原扣分。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const flagId = cid.slice("creditrestore_".length);
  const col = client.creditFlagsCollection;
  if (!col) {
    return interaction.reply({ content: "🔧 信用分紀錄尚未啟動。", flags: MessageFlags.Ephemeral });
  }

  try {
    const flag = await col.findOne({ flagId });
    if (!flag) {
      return interaction.reply({ content: "❌ 找不到此告警紀錄（可能已過期）。", flags: MessageFlags.Ephemeral });
    }
    if (flag.restored) {
      return interaction.reply({ content: "ℹ️ 這筆已經復原過了。", flags: MessageFlags.Ephemeral });
    }

    const deltas = flag.deltas || {};
    const restoredUsers = [];
    for (const [uid, delta] of Object.entries(deltas)) {
      const res = await creditService.restore(client, uid, flag.guildId, Math.abs(delta)).catch(() => null);
      if (res) restoredUsers.push({ uid, points: Math.abs(delta) });
    }

    await col.updateOne(
      { flagId },
      { $set: { restored: true, restoredBy: interaction.user.id, restoredAt: new Date() } },
    );

    if (!(await deferUpdateSafe(interaction))) return;

    // 更新原 embed：加一欄「已復原」、停用按鈕
    const src = interaction.message.embeds?.[0];
    const embed = src ? EmbedBuilder.from(src) : new EmbedBuilder().setTitle("可疑金流");
    const restoreText = restoredUsers.length
      ? restoredUsers.map((r) => `<@${r.uid}> +${r.points}`).join("　")
      : "（無可復原的扣分）";
    embed.setColor(0x2ecc71).addFields({
      name: `✅ 已由 <@${interaction.user.id}> 標記誤報並復原`,
      value: restoreText,
    });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`creditrestore_${flagId}`)
        .setLabel("已復原")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );

    await interaction.editReply({ embeds: [embed], components: [disabledRow] });
  } catch (error) {
    console.log(`[ERROR] handleCreditRestoreButton:\n${error}\n${error.stack}`.red);
    await interaction
      .reply({ content: "🔧 復原失敗，請稍後再試。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
};
