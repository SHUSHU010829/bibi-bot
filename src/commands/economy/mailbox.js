require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, fishing } = require("../../config");
const mailbox = require("../../features/marketplace/marketplaceMailbox");
const { getOrCreate, backpackCapacity, backpackUsed } = require("../../features/mining/miningProfile");

function sourceLabel(source) {
  if (source === "marketplace") return "市集";
  if (source === "barter") return "交易所";
  return source || "?";
}

function itemLabel(mail) {
  if (mail.item_type === "fish") {
    const def = fishing?.fish?.[mail.item_key] || {};
    return `${def.emoji || "🐟"} ${def.name || mail.item_key}`;
  }
  if (mail.item_type === "crop") {
    return `🌾 ${mail.item_key}`;
  }
  const def = mining?.ores?.[mail.item_key] || {};
  return `${def.emoji || "⛏️"} ${def.name || mail.item_key}`;
}

function buildMailboxView(mails, profile) {
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  const free = Math.max(0, cap - used);

  if (mails.length === 0) {
    const container = new ContainerBuilder()
      .setAccentColor(0x95a5a6)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 📭 信箱\n目前沒有待領取的物品。\n-# 當市集 / 交易所退款時背包剛好滿了，東西會暫存到這裡。`
        )
      );
    return { container };
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xf39c12)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📬 信箱\n共 **${mails.length}** 筆待領取 ・ 背包空間 **${used}/${cap}**（剩 ${free} 格）`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );

  mails.forEach((m, idx) => {
    const createdEpoch = Math.floor(new Date(m.created_at).getTime() / 1000);
    const listingTag = m.listing_id ? `#${m.listing_id} ・ ` : "";
    const text =
      `**${sourceLabel(m.source)}** ・ ${listingTag}<t:${createdEpoch}:R>\n` +
      `${itemLabel(m)} ×${m.qty}`;

    const btn = new ButtonBuilder()
      .setCustomId(`mailbox_claim_${m.user_id}_${m.mail_id}`)
      .setLabel("領取")
      .setEmoji("📥")
      .setStyle(ButtonStyle.Success);

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
        .setButtonAccessory(btn)
    );

    if (idx < mails.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }
  });

  if (free <= 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 背包已滿，請先 \`/賣礦\` 或 \`/合成\` 騰出空間再來領取。`
      )
    );
  }

  return { container };
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("信箱")
    .setDescription("查看市集 / 交易所退款時放不下背包的物品 📬")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!client.marketplaceMailboxCollection) {
        return interaction.editReply("🔧 信箱系統尚未啟動！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const [mails, profile] = await Promise.all([
        mailbox.listMail(client, userId, guildId),
        getOrCreate(client, userId, guildId),
      ]);

      const { container } = buildMailboxView(mails, profile);
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /信箱:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看信箱失敗，請呼叫舒舒！").catch(() => {});
    }
  },

  buildMailboxView,
};
