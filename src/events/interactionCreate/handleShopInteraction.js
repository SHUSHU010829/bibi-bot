require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");
const { ObjectId } = require("mongodb");

const equipItem = require("../../features/shop/equipItem");
const buyItem = require("../../features/shop/buyItem");
const { getItem } = require("../../features/shop/catalog");
const { buildBackpackView } = require("../../features/shop/backpackView");
const { buildShopView } = require("../../features/shop/shopView");
const { MONEY_EMOJI } = require("../../constants/coin");
const { consume } = require("../../utils/rateLimiter");

const EQUIP_BTN_PREFIX = "shop_equip_btn_";
const TITLE_OPEN_PREFIX = "shop_title_open_";
const TITLE_MODAL_PREFIX = "shop_title_modal_";
const EQUIP_SELECT_PREFIX = "shop_equip_select_";
const TITLE_SELECT_ID = "shop_title_select";
const CAT_SELECT_ID = "shop_cat";
const NAV_PREFIX = "shop_nav_";
const BUY_PREFIX = "shop_buy_";

function isValidObjectId(id) {
  if (typeof id !== "string") return false;
  try {
    return new ObjectId(id).toString() === id;
  } catch (_) {
    return false;
  }
}

function buildTitleModal(inventoryId) {
  const modal = new ModalBuilder()
    .setCustomId(`${TITLE_MODAL_PREFIX}${inventoryId}`)
    .setTitle("設定自訂稱號");
  const input = new TextInputBuilder()
    .setCustomId("title_text")
    .setLabel("稱號文字（最多 24 字）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(24);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// 切換分類 → 回到該分類第 1 頁（直接更新公開面板）
async function handleCategorySelect(client, interaction) {
  const catIndex = parseInt(interaction.values?.[0], 10) || 0;
  await interaction.update(buildShopView(catIndex, 0));
}

// 分頁：customId = shop_nav_<catIndex>_<page>_<action>
async function handleNav(client, interaction) {
  const parts = interaction.customId.split("_"); // shop nav cat page action
  const catIndex = parseInt(parts[2], 10) || 0;
  const page = parseInt(parts[3], 10) || 0;
  const action = parts[4];

  let target = page;
  if (action === "first") target = 0;
  else if (action === "prev") target = page - 1;
  else if (action === "refresh") target = page;
  else if (action === "next") target = page + 1;
  else if (action === "last") target = Number.MAX_SAFE_INTEGER; // buildShopView 會夾到最後一頁

  await interaction.update(buildShopView(catIndex, target));
}

// 購買：customId = shop_buy_<itemId>（itemId 可能含底線，直接取前綴之後）
async function handleBuyButton(client, interaction, itemId) {
  const item = getItem(itemId);
  if (!item) {
    return interaction.reply({ content: "❌ 找不到該商品", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await buyItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
    itemId,
  });

  if (!result.ok) return interaction.editReply(`❌ ${result.error}`);

  const lines = [
    `✅ 已購買 **${item.name}**`,
    `・花費：${item.price.toLocaleString()} ${MONEY_EMOJI}`,
    `・剩餘餘額：${(result.balanceAfter || 0).toLocaleString()} ${MONEY_EMOJI}`,
  ];
  if (result.expiresAt) {
    const ts = Math.floor(new Date(result.expiresAt).getTime() / 1000);
    lines.push(`・有效期限：<t:${ts}:f>（<t:${ts}:R>）`);
  }
  if (item.type === "xp_boost" || item.type === "coin_boost") {
    lines.push("・效果：已自動套用，可用 `/背包` 查看剩餘時間");
  }

  const invId = result.inventoryDoc?.insertedId
    ? String(result.inventoryDoc.insertedId)
    : null;
  const components = [];
  if (invId && (item.type === "role_color" || item.type === "wallet_theme")) {
    const label = item.type === "role_color" ? "🎨 立即裝備顏色" : "🎴 立即套用卡面";
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${EQUIP_BTN_PREFIX}${invId}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Primary)
      )
    );
  } else if (invId && item.type === "custom_title") {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${TITLE_OPEN_PREFIX}${invId}`)
          .setLabel("🪪 設定稱號文字")
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  await interaction.editReply({ content: lines.join("\n"), components });
}

async function handleEquipButton(client, interaction, inventoryId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await equipItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    guild: interaction.guild,
    inventoryId,
  });
  if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
  await interaction.editReply(`✅ 已裝備 **${result.item.name}**`);
}

async function handleEquipFromInventorySelect(client, interaction, inventoryId) {
  await interaction.deferUpdate();
  const result = await equipItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    guild: interaction.guild,
    inventoryId,
  });

  if (!result.ok) {
    return interaction.followUp({
      content: `❌ ${result.error}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const view = await buildBackpackView(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.user.username,
    });
    await interaction.editReply(view);
  } catch (err) {
    console.log(`[ERROR] refresh backpack view: ${err}`.red);
  }

  await interaction
    .followUp({
      content: `✅ 已裝備 **${result.item.name}**`,
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

async function handleTitleModalSubmit(client, interaction, inventoryId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = interaction.fields.getTextInputValue("title_text");
  if (!text || !text.trim()) {
    return interaction.editReply("❌ 稱號不可為空");
  }
  const result = await equipItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    guild: interaction.guild,
    inventoryId,
    titleText: text,
  });
  if (!result.ok) return interaction.editReply(`❌ ${result.error}`);
  await interaction.editReply(
    `✅ 已將稱號設為「${text.trim().slice(0, 24)}」`,
  );
}

async function replyInvalidId(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return;
    await interaction.reply({
      content: "❌ 道具識別碼無效",
      flags: MessageFlags.Ephemeral,
    });
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!client.userInventoryCollection) return;

    const cid = interaction.customId || "";
    const isShopInteraction =
      cid === CAT_SELECT_ID ||
      cid.startsWith(NAV_PREFIX) ||
      cid.startsWith(BUY_PREFIX) ||
      cid.startsWith(EQUIP_BTN_PREFIX) ||
      cid.startsWith(TITLE_OPEN_PREFIX) ||
      cid.startsWith(EQUIP_SELECT_PREFIX) ||
      cid === TITLE_SELECT_ID ||
      cid.startsWith(TITLE_MODAL_PREFIX);
    if (!isShopInteraction) return;

    // 防連點：只對面板瀏覽 / 購買限流（購買後的裝備、設定稱號等下游動作不限流）
    const isBrowseOrBuy =
      cid === CAT_SELECT_ID || cid.startsWith(NAV_PREFIX) || cid.startsWith(BUY_PREFIX);
    if (isBrowseOrBuy) {
      const rl = consume(interaction.user.id, "shop:browse", { windowMs: 1000, max: 1 });
      if (!rl.allowed) {
        try {
          await interaction.reply({
            content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (_) {
          /* noop */
        }
        return;
      }
    }

    // 商店瀏覽：切換分類 / 分頁 / 購買
    if (interaction.isStringSelectMenu() && cid === CAT_SELECT_ID) {
      return handleCategorySelect(client, interaction);
    }
    if (interaction.isButton() && cid.startsWith(NAV_PREFIX)) {
      return handleNav(client, interaction);
    }
    if (interaction.isButton() && cid.startsWith(BUY_PREFIX)) {
      return handleBuyButton(client, interaction, cid.slice(BUY_PREFIX.length));
    }

    if (
      interaction.isButton() &&
      interaction.customId?.startsWith(EQUIP_BTN_PREFIX)
    ) {
      const invId = interaction.customId.slice(EQUIP_BTN_PREFIX.length);
      if (!isValidObjectId(invId)) return replyInvalidId(interaction);
      return handleEquipButton(client, interaction, invId);
    }

    if (
      interaction.isButton() &&
      interaction.customId?.startsWith(TITLE_OPEN_PREFIX)
    ) {
      const invId = interaction.customId.slice(TITLE_OPEN_PREFIX.length);
      if (!isValidObjectId(invId)) return replyInvalidId(interaction);
      return interaction.showModal(buildTitleModal(invId));
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId?.startsWith(EQUIP_SELECT_PREFIX)
    ) {
      const invId = interaction.values?.[0];
      if (!isValidObjectId(invId)) return replyInvalidId(interaction);
      return handleEquipFromInventorySelect(client, interaction, invId);
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === TITLE_SELECT_ID
    ) {
      const invId = interaction.values?.[0];
      if (!isValidObjectId(invId)) return replyInvalidId(interaction);
      return interaction.showModal(buildTitleModal(invId));
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId?.startsWith(TITLE_MODAL_PREFIX)
    ) {
      const invId = interaction.customId.slice(TITLE_MODAL_PREFIX.length);
      if (!isValidObjectId(invId)) return replyInvalidId(interaction);
      return handleTitleModalSubmit(client, interaction, invId);
    }
  } catch (error) {
    console.log(`[ERROR] handleShopInteraction:\n${error}\n${error.stack}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "🔧 處理商店互動時發生錯誤" });
      } else if (
        interaction.isModalSubmit?.() ||
        interaction.isMessageComponent?.()
      ) {
        await interaction.reply({
          content: "🔧 處理商店互動時發生錯誤",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
