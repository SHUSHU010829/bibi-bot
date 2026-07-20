require("colors");
const { MessageFlags } = require("discord.js");
const listingConfirm = require("../../features/marketplace/listingConfirm");
const marketplaceService = require("../../features/marketplace/marketplaceService");

const {
  CONFIRM_PREFIX,
  EDIT_PREFIX,
  CANCEL_PREFIX,
  EDIT_MODAL_PREFIX,
} = listingConfirm;

const V2 = MessageFlags.IsComponentsV2;

function parseOwnerToken(cid, prefix) {
  const rest = cid.slice(prefix.length);
  const i = rest.indexOf("_");
  if (i < 0) return null;
  return { ownerId: rest.slice(0, i), token: rest.slice(i + 1) };
}

function notOwner(interaction) {
  return interaction.reply({ content: "🚫 這不是你的上架確認！", flags: MessageFlags.Ephemeral });
}

function expired(interaction, viaModal) {
  const container = listingConfirm.simpleContainer(
    0x95a5a6,
    "# ⌛ 確認已逾時\n這筆上架預覽已失效，請重新用 `/市集` 指令上架。",
  );
  if (viaModal) return interaction.reply({ components: [container], flags: V2 | MessageFlags.Ephemeral });
  return interaction.update({ components: [container], flags: V2 });
}

// /市集 上架二次確認：確認上架 / 改價格數量（Modal）/ 取消。原地更新 ephemeral 預覽。
module.exports = async (client, interaction) => {
  const isButton = interaction.isButton?.();
  const isModal = interaction.isModalSubmit?.();
  if (!isButton && !isModal) return;
  const cid = interaction.customId;
  if (!cid?.startsWith("mktlist_")) return;

  try {
    // ── 改價格數量 Modal 送出 ──
    if (isModal && cid.startsWith(EDIT_MODAL_PREFIX)) {
      const parsed = parseOwnerToken(cid, EDIT_MODAL_PREFIX);
      if (!parsed) return;
      if (interaction.user.id !== parsed.ownerId) return notOwner(interaction);
      const pending = listingConfirm.getPending(parsed.token);
      if (!pending) return expired(interaction, true);

      const fields = {
        price: interaction.fields.getTextInputValue("price"),
        qty: interaction.fields.getTextInputValue("qty"),
        buyout: pending.kind === "auction" ? interaction.fields.getTextInputValue("buyout") : undefined,
      };
      const res = listingConfirm.applyEdit(pending, fields);
      if (!res.ok) return interaction.reply({ content: res.note, flags: MessageFlags.Ephemeral });
      const { container } = await listingConfirm.buildPreview(client, pending);
      return interaction.update({ components: [container], flags: V2 });
    }

    if (!isButton) return;

    // ── 確認上架 ──
    if (cid.startsWith(CONFIRM_PREFIX)) {
      const parsed = parseOwnerToken(cid, CONFIRM_PREFIX);
      if (!parsed) return;
      if (interaction.user.id !== parsed.ownerId) return notOwner(interaction);
      const pending = listingConfirm.getPending(parsed.token);
      if (!pending) return expired(interaction);

      await interaction.deferUpdate();
      const fin = await listingConfirm.finalize(client, pending);
      if (!fin.ok) {
        return interaction.editReply({
          components: [
            listingConfirm.simpleContainer(
              0xe74c3c,
              `# ❌ 上架未完成\n${fin.errorText}\n-# 這筆預覽已保留，修正後可重新用 \`/市集\` 上架。`,
            ),
          ],
          flags: V2,
        });
      }
      listingConfirm.drop(parsed.token);
      await interaction.editReply({
        components: [listingConfirm.simpleContainer(0x2ecc71, `# ${fin.ackText}`)],
        flags: V2,
      });
      // 公開掛單卡（含成交按鈕）發到頻道，確保所有人看得到、可成交。
      const target = interaction.channel;
      const publicMsg = { components: [fin.publicCard], flags: V2 };
      const sent = await (target?.send ? target.send(publicMsg) : interaction.followUp(publicMsg)).catch((e) => {
        console.log(`[ERROR] listing public card: ${e.message}`.red);
        return null;
      });
      // 有進度的單型記下訊息位置，之後成交/收滿/下架時就地更新這張公開卡
      if (fin.live && sent?.id) {
        await marketplaceService.setListingCardRef(client, {
          guildId: fin.guildId,
          listingId: fin.listingId,
          channelId: sent.channelId || target?.id,
          messageId: sent.id,
        }).catch(() => {});
      }
      return;
    }

    // ── 改價格數量（開 Modal）──
    if (cid.startsWith(EDIT_PREFIX)) {
      const parsed = parseOwnerToken(cid, EDIT_PREFIX);
      if (!parsed) return;
      if (interaction.user.id !== parsed.ownerId) return notOwner(interaction);
      const pending = listingConfirm.getPending(parsed.token);
      if (!pending) return expired(interaction);
      return interaction.showModal(listingConfirm.buildEditModal(pending)).catch((e) => {
        console.log(`[ERROR] listing edit modal: ${e.message}`.red);
      });
    }

    // ── 取消 ──
    if (cid.startsWith(CANCEL_PREFIX)) {
      const parsed = parseOwnerToken(cid, CANCEL_PREFIX);
      if (!parsed) return;
      if (interaction.user.id !== parsed.ownerId) return notOwner(interaction);
      listingConfirm.drop(parsed.token);
      return interaction.update({
        components: [listingConfirm.simpleContainer(0x95a5a6, "# ↩️ 已取消\n未建立任何掛單，物品/金幣未被託管。")],
        flags: V2,
      });
    }
  } catch (error) {
    console.log(`[ERROR] handleMarketListingConfirm:\n${error}\n${error.stack}`.red);
    if (interaction.isButton?.() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "🔧 操作失敗，請稍後再試。", flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.followUp?.({ content: "🔧 操作失敗，請稍後再試。", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
};
