// 交易所按鈕：
//   barter_accept_<viewerId>_<listingId>          — 點擊「接受交易」→ 顯示二次確認面板
//   barter_confirmAccept_<listingId>              — 二次確認後真正成交
//   barter_abort                                  — 二次確認中止
//   barter_cancel_<viewerId>_<listingId>          — 下架自己的掛單
//
// 注意：customId 裡的 viewerId 是「點擊者」的鎖定 owner（在某些 ephemeral 視圖才有意義）。
// 對於公開列表的「接受」按鈕，我們不檢查 viewerId（任何人都能接受別人的單），
// 而是改檢查「不是自己上架的」+ 掛單擁有者是否為當前使用者（接受時）。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { barter } = require("../../config");
const barterService = require("../../features/barter/barterService");
const { computeFee } = require("../../features/barter/barterService");
const { buildBoardContainer, errorContainer } = require("../../features/barter/barterView");
const { getItemDef } = require("../../features/barter/itemCatalog");
const { isGameRoom } = require("../../features/gameRoom/service");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");

function statusPanel(text) {
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton?.()) return;
  if (!interaction.customId?.startsWith("barter_")) return;

  // 頻道守門（遊戲房豁免，與指令層 / 全域頻道分流一致）
  if (
    barter?.allowedChannelId &&
    interaction.channelId !== barter.allowedChannelId &&
    !isGameRoom(interaction.channelId)
  ) {
    return interaction.reply({
      components: [
        errorContainer(
          "🚫 這裡不能操作交易所",
          `請到 <#${barter.allowedChannelId}> 操作 \`/交易所\`。`,
          "限定頻道是為了讓交易資訊集中",
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  try {
    // 二次確認：中止
    if (interaction.customId === "barter_abort") {
      return interaction.update({
        components: [statusPanel("✖️ 已取消操作。")],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // 列表翻頁：barter_page_<viewerId>_<page>
    if (interaction.customId.startsWith("barter_page_")) {
      return handlePage(client, interaction);
    }

    // 二次確認：確定接受
    if (interaction.customId.startsWith("barter_confirmAccept_")) {
      const listingId = Number.parseInt(
        interaction.customId.slice("barter_confirmAccept_".length),
        10,
      );
      if (!Number.isFinite(listingId)) return;
      return handleConfirmAccept(client, interaction, listingId);
    }

    const parts = interaction.customId.split("_");
    if (parts.length < 4) return;
    const action = parts[1];
    const listingId = Number.parseInt(parts[parts.length - 1], 10);
    if (!Number.isFinite(listingId)) return;

    if (action === "accept") return handleAccept(client, interaction, listingId);
    if (action === "cancel") return handleCancel(client, interaction, listingId);
  } catch (error) {
    console.log(`[ERROR] handleBarterButton:\n${error}\n${error.stack}`.red);
    const reply = {
      components: [errorContainer("🔧 操作失敗", "發生未預期錯誤。", "請呼叫舒舒！")],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
};

async function handleAccept(client, interaction, listingId) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const existing = await barterService.getListing(client, interaction.guildId, listingId);
  if (!existing) {
    return interaction.editReply({
      components: [errorContainer("❌ 找不到掛單", `編號 #${listingId} 不存在或已下架。`, "用 `/交易所 列表` 重新整理")],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  if (existing.seller_id === interaction.user.id) {
    return interaction.editReply({
      components: [errorContainer("❌ 不能接自己的單", "這是你自己上架的交易。", "")],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const offerDef = getItemDef(existing.offer.type, existing.offer.key);
  const wantDef = getItemDef(existing.want.type, existing.want.key);
  if (!offerDef || !wantDef) {
    return interaction.editReply({
      components: [errorContainer("❌ 物品異常", "找不到掛單上的物品定義。", "請呼叫舒舒！")],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const fee = computeFee(offerDef, existing.offer.qty, wantDef, existing.want.qty);

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 確認接受交易？\n` +
          `**#${listingId}**\n` +
          `你付出 ${wantDef.emoji} **${wantDef.name}** ×${existing.want.qty}\n` +
          `換到 ${offerDef.emoji} **${offerDef.name}** ×${existing.offer.qty}\n` +
          `-# 手續費 **${fee}** 🪙（成交時從你的金幣扣除）`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`barter_confirmAccept_${listingId}`)
          .setLabel("✅ 確定")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("barter_abort")
          .setLabel("❌ 取消")
          .setStyle(ButtonStyle.Secondary),
      ),
    );

  return interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleConfirmAccept(client, interaction, listingId) {
  await interaction.update({
    components: [statusPanel("⏳ 處理中…")],
    flags: MessageFlags.IsComponentsV2,
  });

  const result = await barterService.acceptListing(client, {
    listingId,
    guildId: interaction.guildId,
    acceptorId: interaction.user.id,
    acceptorName: interaction.user.username,
    member: interaction.member,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [acceptErrorOf(result, listingId)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const { listing, offerDef, wantDef, fee } = result;
  const c = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🤝 交易成功 #${listingId}\n` +
          `你用 ${wantDef.emoji} **${wantDef.name}** ×${listing.want.qty} ` +
          `從 <@${listing.seller_id}> 換到 ${offerDef.emoji} **${offerDef.name}** ×${listing.offer.qty}\n` +
          `-# 手續費：**${fee}** 🪙`,
      ),
    );
  await interaction.editReply({
    components: [c],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [listing.seller_id] },
  });
}

function acceptErrorOf(result, listingId) {
  if (result.reason === "not_found") {
    return errorContainer("❌ 找不到掛單", `編號 #${listingId} 不存在或已下架。`, "用 `/交易所 列表` 重新整理");
  }
  if (result.reason === "not_active") {
    return errorContainer("❌ 已被接走", "這筆交易已經成交或取消。", "看看其他掛單吧");
  }
  if (result.reason === "own_listing") {
    return errorContainer("❌ 不能接自己的單", "這是你自己上架的交易。", "");
  }
  if (result.reason === "expired") {
    return errorContainer("⏱️ 已過期", "這筆掛單已過期。", "託管物品會自動退給上架者");
  }
  if (result.reason === "insufficient_want") {
    return errorContainer(
      "❌ 物品不足",
      `需要 ${result.wantDef.emoji} **${result.wantDef.name}** ×${result.need}，你只有 **${result.have}**。`,
      "去蒐集足夠的物品再來",
    );
  }
  if (result.reason === "acceptor_full") {
    return errorContainer(
      "🎒 你的背包快滿了",
      `背包 ${result.used}/${result.cap}，裝不下這筆交易。`,
      "賣掉一些礦石再來",
    );
  }
  if (result.reason === "insufficient_fee") {
    return errorContainer(
      "❌ 手續費不足",
      `需要 **${result.fee}** 🪙，你只有 **${result.balance}** 🪙。`,
      "去 /打工 /挖礦 賺點錢",
    );
  }
  if (result.reason === "race") {
    return errorContainer("⚠️ 有人比你快", "另一位玩家剛剛接走了這筆。", "看看其他掛單");
  }
  return errorContainer("🔧 接受失敗", `原因：\`${result.reason}\``, "請稍後再試");
}

async function handleCancel(client, interaction, listingId) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const result = await barterService.cancelListing(client, {
    listingId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });
  if (!result.ok) {
    const map = {
      not_found: ["❌ 找不到掛單", `編號 #${listingId} 不存在。`, ""],
      not_owner: ["❌ 不是你的掛單", "你只能下架自己的。", ""],
      not_active: ["❌ 已不在售", "這筆掛單已成交、過期或取消。", ""],
      race: ["⚠️ 競態", "操作衝突，請再試一次。", ""],
    };
    const [t, b, h] = map[result.reason] || ["🔧 下架失敗", `原因：\`${result.reason}\``, ""];
    return interaction.editReply({
      components: [errorContainer(t, b, h)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
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
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function handlePage(client, interaction) {
  const parts = interaction.customId.split("_");
  const viewerId = parts[2];
  const page = Number.parseInt(parts[3], 10);
  if (interaction.user.id !== viewerId) {
    return interaction.reply({
      components: [
        errorContainer("❌ 不是你的列表", "這個列表是別人開的。", "用 `/交易所 列表` 自己開一份"),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  if (!Number.isFinite(page) || page < 1) return;

  if (!(await deferUpdateSafe(interaction))) return;
  const cfg = barterService.cfg();
  const pageSize = cfg.pageSize ?? 5;
  const { listings, total } = await barterService.listActive(client, interaction.guildId, {
    limit: pageSize,
    skip: (page - 1) * pageSize,
  });
  const container = buildBoardContainer({
    listings,
    viewerId: interaction.user.id,
    total,
    page,
    pageSize,
  });
  await interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports.handleAccept = handleAccept;
module.exports.handleCancel = handleCancel;
