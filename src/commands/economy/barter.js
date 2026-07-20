require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { barter } = require("../../config");
const barterService = require("../../features/barter/barterService");
const { isGameRoom } = require("../../features/gameRoom/service");
const {
  buildOwnerContainer,
  errorContainer,
} = require("../../features/barter/barterView");

function channelGuard(interaction) {
  const allowed = barter?.allowedChannelId;
  if (!allowed) return true;
  if (isGameRoom(interaction.channelId)) return true;
  return interaction.channelId === allowed;
}

function notAllowedHere(allowedId) {
  return errorContainer(
    "🚫 這裡不能用交易所",
    `請到 <#${allowedId}> 使用 \`/交易所\` 指令。`,
    "限定頻道是為了讓交易資訊集中、避免洗版",
  );
}

// 交易所已整合進 /市集 的「物物交換」訂單。此指令只保留查看／下架舊掛單。
function movedNotice() {
  return new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔄 交易所已搬家\n` +
          `物物交換已整合進 **/市集**！\n` +
          `・上架：\`/市集 物物交換\`（付出 X 收 Y，可分批成交）\n` +
          `・瀏覽：\`/市集 逛攤\` → 篩選「物物交換」\n` +
          `-# 你在舊交易所的掛單仍可用 \`/交易所 我的\` 查看、\`/交易所 取消\` 下架。`,
      ),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("交易所")
    .setDescription("（已整合進 /市集）查看 / 下架舊的物物交換掛單 🔁")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("列表").setDescription("交易所已搬家，看這裡怎麼用"))
    .addSubcommand((s) => s.setName("我的").setDescription("查看 / 下架自己在舊交易所的掛單"))
    .addSubcommand((s) =>
      s
        .setName("取消")
        .setDescription("用編號取消自己在舊交易所的掛單")
        .addIntegerOption((o) =>
          o.setName("編號").setDescription("掛單編號").setRequired(true).setMinValue(1),
        ),
    ),

  run: async (client, interaction) => {
    if (!barter?.enabled) {
      return interaction.reply({ content: "🔧 交易所尚未啟動", flags: MessageFlags.Ephemeral });
    }
    if (!channelGuard(interaction)) {
      return interaction.reply({
        components: [notAllowedHere(barter.allowedChannelId)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "列表") return runList(client, interaction);
      if (sub === "我的") return runMine(client, interaction);
      if (sub === "取消") return runCancel(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /交易所 ${sub}:\n${error}\n${error.stack}`.red);
      const reply = {
        content: "🔧 操作失敗，請呼叫舒舒！",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
  channelBuckets: ["marketplace"],
};

async function runList(client, interaction) {
  await interaction.reply({
    components: [movedNotice()],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function runMine(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const listings = await barterService.listByOwner(client, interaction.guildId, interaction.user.id);
  if (!listings.length) {
    return interaction.editReply({
      components: [movedNotice()],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  const container = buildOwnerContainer({ listings, viewerId: interaction.user.id });
  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function runCancel(client, interaction) {
  await interaction.deferReply();
  const listingId = interaction.options.getInteger("編號");
  const result = await barterService.cancelListing(client, {
    listingId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });
  if (!result.ok) {
    const map = {
      not_found: ["❌ 找不到掛單", `編號 #${listingId} 不存在。`, "用 `/交易所 我的` 看你的掛單"],
      not_owner: ["❌ 不是你的掛單", "你只能下架自己的掛單。", ""],
      not_active: ["❌ 已不在售", "這筆掛單已經成交、過期或取消。", ""],
      race: ["⚠️ 競態", "操作衝突，請再試一次。", ""],
    };
    const [t, b, h] = map[result.reason] || ["🔧 取消失敗", `原因：\`${result.reason}\``, ""];
    return interaction.editReply({
      components: [errorContainer(t, b, h)],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const c = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🗑️ 已下架 #${listingId}\n託管物品已退回你的袋子。`,
      ),
    );
  await interaction.editReply({
    components: [c],
    flags: MessageFlags.IsComponentsV2,
  });
}
