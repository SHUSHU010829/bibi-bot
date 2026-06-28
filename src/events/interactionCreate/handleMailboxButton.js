require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { mining } = require("../../config");
const mailbox = require("../../features/marketplace/marketplaceMailbox");
const { getOrCreate, backpackCapacity, backpackUsed } = require("../../features/mining/miningProfile");
const { buildMailboxView } = require("../../commands/economy/mailbox");
const { deferReplySafe } = require("../../utils/safeAck");

const CLAIM_PREFIX = "mailbox_claim_";

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const cid = interaction.customId || "";
  if (!cid.startsWith(CLAIM_PREFIX)) return;

  try {
    if (!client.marketplaceMailboxCollection) {
      return interaction.reply({
        content: "🔧 信箱系統尚未啟動！",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    const rest = cid.slice(CLAIM_PREFIX.length);
    const sepIdx = rest.indexOf("_");
    if (sepIdx < 0) return;
    const ownerId = rest.slice(0, sepIdx);
    const mailId = rest.slice(sepIdx + 1);

    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "📭 這不是你的信箱！",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) {
      return;
    }

    const result = await mailbox.claimMail(client, {
      mailId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (!result.ok) {
      if (result.reason === "not_found") {
        return interaction.editReply({
          content: "📭 這封信件已經領過或已不存在。",
        });
      }
      if (result.reason === "backpack_full") {
        const oreName =
          mining?.ores?.[result.mail?.item_key]?.name || result.mail?.item_key || "物品";
        const need = result.mail?.qty || 0;
        const container = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# ❌ 背包已滿\n無法領取 **${oreName} ×${need}**`
            )
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `目前 **${result.used}/${result.cap}**，已無空格。\n` +
                `-# 先用 \`/賣礦\`、\`/合成\` 或 \`/市集 賣礦\` 騰出空間，再回來領。`
            )
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }
      return interaction.editReply({ content: "🔧 領取失敗，請稍後再試。" });
    }

    // 成功：顯示領取結果 + 重新整理過的信箱
    const oreName =
      mining?.ores?.[result.mail?.item_key]?.name || result.mail?.item_key || "物品";
    const partialNote = result.remaining > 0
      ? `\n-# 背包空間不足，剩餘 **${oreName} ×${result.remaining}** 仍在信箱裡。`
      : "";

    const [mails, profile] = await Promise.all([
      mailbox.listMail(client, interaction.user.id, interaction.guildId),
      getOrCreate(client, interaction.user.id, interaction.guildId),
    ]);
    const cap = backpackCapacity(profile, mining);
    const used = backpackUsed(profile);

    const successContainer = new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 📥 已領取 ${oreName} ×${result.claimed}\n` +
            `背包：**${used}/${cap}**${partialNote}`
        )
      );

    const { container: mailboxContainer } = buildMailboxView(mails, profile);

    await interaction.editReply({
      components: [successContainer, mailboxContainer],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] handleMailboxButton:\n${error}\n${error.stack}`.red);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: "🔧 領取失敗，請呼叫舒舒！" }).catch(() => {});
    } else {
      await interaction.reply({ content: "🔧 領取失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
};
