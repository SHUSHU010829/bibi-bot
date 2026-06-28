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
const { getItem, isStackable } = require("../../features/shop/catalog");
const { getStackInfo } = require("../../features/shop/stackInfo");
const {
  buildBackpackView,
  UNIFIED_EQUIP_ID,
} = require("../../features/shop/backpackView");
const { buildShopView } = require("../../features/shop/shopView");
const {
  buildBuyConfirmView,
  CONFIRM_PREFIX,
  CANCEL_ID,
} = require("../../features/shop/buyConfirmView");
const { MONEY_EMOJI } = require("../../constants/coin");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");
const {
  MAX_LEN,
  CARDNO_OPEN_ID,
  CARDNO_MODAL_ID,
  groupBy4,
  ownsDonorCard,
  setCustomCardNumber,
} = require("../../features/donation/customCardNumber");

const EQUIP_BTN_PREFIX = "shop_equip_btn_";
const TITLE_OPEN_PREFIX = "shop_title_open_";
const TITLE_MODAL_PREFIX = "shop_title_modal_";
const EQUIP_SELECT_PREFIX = "shop_equip_select_";
const TITLE_SELECT_ID = "shop_title_select";
const CAT_SELECT_ID = "shop_cat";
const NAV_PREFIX = "shop_nav_";
const BUY_PREFIX = "shop_buy_";
const QTY_BUY_MODAL_PREFIX = "shop_qtybuy_";
const CUSTOM_COLOR_MODAL_ID = "shop_custom_color_modal";

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

// 可堆疊商品的「輸入購買數量」Modal。label 帶限購／持有資訊，placeholder 給可輸入範圍。
function buildQtyModal(item, info) {
  const { max, maxStack, dailyLimit, owned, boughtToday, unit, maxBuyNow } = info;
  const labelParts = ["數量"];
  if (owned != null) {
    labelParts.push(maxStack != null ? `持有 ${owned}/${maxStack}` : `持有 ${owned}${unit}`);
  }
  if (dailyLimit != null) labelParts.push(`今日 ${boughtToday}/${dailyLimit}`);
  let label = labelParts.join("｜");
  if (label.length > 45) label = label.slice(0, 45);

  const upper = maxBuyNow > 0 ? maxBuyNow : max;
  const modal = new ModalBuilder()
    .setCustomId(`${QTY_BUY_MODAL_PREFIX}${item.id}`)
    .setTitle(`購買 ${item.name}`.slice(0, 45));
  const input = new TextInputBuilder()
    .setCustomId("qty")
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(4)
    .setPlaceholder(`輸入 1～${upper}，本次最多 ${upper} ${unit}`);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function buildCustomColorModal(item) {
  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_COLOR_MODAL_ID)
    .setTitle(`自訂顏色（${item.price.toLocaleString()} 金幣・30 天）`);
  const input = new TextInputBuilder()
    .setCustomId("hex_color")
    .setLabel("HEX 色碼（送出即確認購買）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(7)
    .setPlaceholder("#RRGGBB，例：#FF5733");
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function buildCardNumberModal() {
  const modal = new ModalBuilder()
    .setCustomId(CARDNO_MODAL_ID)
    .setTitle("設定贊助卡號");
  const input = new TextInputBuilder()
    .setCustomId("cardno_text")
    .setLabel(`卡號（英文/數字/空白，最多 ${MAX_LEN} 字）`)
    .setPlaceholder("留空並送出＝清除自訂卡號")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(MAX_LEN);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function handleCardNumberModalSubmit(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const raw = interaction.fields.getTextInputValue("cardno_text");
  const result = await setCustomCardNumber(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    raw,
  });
  if (!result.ok) {
    return interaction.editReply(
      result.error === "locked"
        ? "🔒 自訂卡號是「贊助限定卡面」專屬功能。"
        : `❌ 卡號格式不符：${result.error}。`
    );
  }
  if (result.cleared) {
    return interaction.editReply("✅ 已清除自訂卡號，卡面將顯示系統預設編號。");
  }
  return interaction.editReply(`✅ 卡號已設定為：\`${groupBy4(result.value)}\``);
}

// 切換分類 → 回到該分類第 1 頁（直接更新公開面板）
async function handleCategorySelect(client, interaction) {
  if (!(await deferUpdateSafe(interaction))) return;
  const catIndex = parseInt(interaction.values?.[0], 10) || 0;
  const view = await buildShopView(catIndex, 0, {
    client,
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  await interaction.editReply(view);
}

// 分頁：customId = shop_nav_<catIndex>_<page>_<action>
async function handleNav(client, interaction) {
  const parts = interaction.customId.split("_"); // shop nav cat page action
  const catIndex = parseInt(parts[2], 10) || 0;
  const page = parseInt(parts[3], 10) || 0;
  const action = parts[4];

  if (!(await deferUpdateSafe(interaction))) return;

  let target = page;
  if (action === "first") target = 0;
  else if (action === "prev") target = page - 1;
  else if (action === "refresh") target = page;
  else if (action === "next") target = page + 1;
  else if (action === "last") target = Number.MAX_SAFE_INTEGER; // buildShopView 會夾到最後一頁

  const view = await buildShopView(catIndex, target, {
    client,
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  await interaction.editReply(view);
}

// 購買鈕：customId = shop_buy_<itemId>。
// - 可堆疊商品：彈出 Modal 讓玩家直接輸入數量（label 顯示限購／持有資訊）。
// - role_color_custom：彈出 Modal 輸入 HEX 色碼。
// - 其餘（一次買 1 筆）：跳出僅自己可見的確認面板防誤觸。
async function handleBuyButton(client, interaction, itemId) {
  const item = getItem(itemId);
  if (!item) {
    return interaction.reply({ content: "❌ 找不到該商品", flags: MessageFlags.Ephemeral });
  }
  if (item.type === "role_color_custom") {
    return interaction.showModal(buildCustomColorModal(item));
  }
  if (isStackable(item)) {
    const info = await getStackInfo(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      item,
    });
    if (info.maxBuyNow <= 0) {
      const reason =
        info.dailyLimit != null && info.boughtToday >= info.dailyLimit
          ? `今日已達購買上限（${info.boughtToday}/${info.dailyLimit}）`
          : `已達持有上限（${info.owned}/${info.maxStack}）`;
      return interaction.reply({
        content: `🚫 「${item.name}」${reason}，暫時無法再購買。`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(buildQtyModal(item, info));
  }
  const view = buildBuyConfirmView(item, 1);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
}

// 自訂顏色 Modal 送出：驗證 HEX → 扣款 → 存入背包 → 提供裝備按鈕
async function handleCustomColorModalSubmit(client, interaction) {
  const rl = consume(interaction.user.id, "shop:buy", { windowMs: 2500, max: 1 });
  if (!rl.allowed) {
    return interaction.reply({
      content: `⏳ 別急，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const hexRaw = interaction.fields.getTextInputValue("hex_color").trim();
  const match = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.exec(hexRaw);
  if (!match) {
    return interaction.reply({
      content: "❌ 無效的 Hex 色碼，請使用 `#RRGGBB` 格式（例：`#FF5733`）",
      flags: MessageFlags.Ephemeral,
    });
  }

  let hexDigits = match[1].toUpperCase();
  if (hexDigits.length === 3) {
    hexDigits = hexDigits[0]+hexDigits[0]+hexDigits[1]+hexDigits[1]+hexDigits[2]+hexDigits[2];
  }
  const hex = `#${hexDigits}`;

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const item = getItem("color_custom");
  if (!item) return interaction.editReply({ content: "❌ 找不到商品設定" });

  const result = await buyItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
    itemId: "color_custom",
    quantity: 1,
    overridePayload: { hex, roleName: `🎨 ${hex}` },
  });

  if (!result.ok) return interaction.editReply({ content: `❌ ${result.error}`, components: [] });

  const lines = [
    `✅ 已購買 **自訂顏色** — \`${hex}\``,
    `・花費：${(result.totalPrice || item.price).toLocaleString()} ${MONEY_EMOJI}`,
    `・剩餘餘額：${(result.balanceAfter || 0).toLocaleString()} ${MONEY_EMOJI}`,
  ];
  if (result.expiresAt) {
    const ts = Math.floor(new Date(result.expiresAt).getTime() / 1000);
    lines.push(`・有效期限：<t:${ts}:f>（<t:${ts}:R>）`);
  }

  const invId = result.inventoryDoc?.insertedId ? String(result.inventoryDoc.insertedId) : null;
  const components = [];
  if (invId) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${EQUIP_BTN_PREFIX}${invId}`)
          .setLabel("🎨 立即裝備顏色")
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  await interaction.editReply({ content: lines.join("\n"), components });
}

// 購買成功的回覆內容（確認鈕與數量 Modal 共用）。
function renderPurchaseResult(item, result) {
  const boughtQty = result.quantity || 1;
  const lines = [
    `✅ 已購買 **${item.name}**${boughtQty > 1 ? ` ×${boughtQty}` : ""}`,
    `・花費：${(result.totalPrice || item.price).toLocaleString()} ${MONEY_EMOJI}`,
    `・剩餘餘額：${(result.balanceAfter || 0).toLocaleString()} ${MONEY_EMOJI}`,
  ];
  if (result.expiresAt) {
    const ts = Math.floor(new Date(result.expiresAt).getTime() / 1000);
    lines.push(`・有效期限：<t:${ts}:f>（<t:${ts}:R>）`);
  }
  if (item.type === "xp_boost" || item.type === "coin_boost") {
    lines.push("・效果：已自動套用，可用 `/背包` 查看剩餘時間");
  }
  if (item.type === "mining_stamina_potion") {
    lines.push("・已加入背包，到 `/背包` 點「使用」即可恢復體力");
  }

  const invId = result.inventoryDoc?.insertedId
    ? String(result.inventoryDoc.insertedId)
    : null;
  const components = [];
  if (
    invId &&
    (item.type === "role_color" ||
      item.type === "wallet_theme" ||
      item.type === "card_accent")
  ) {
    const label =
      item.type === "role_color"
        ? "🎨 立即裝備顏色"
        : item.type === "wallet_theme"
          ? "🎴 立即套用卡面"
          : "🌈 立即套用顏色";
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

  return { content: lines.join("\n"), components };
}

// 數量 Modal 送出：customId = shop_qtybuy_<itemId>。解析輸入數量 → 扣款。
async function handleQtyBuyModalSubmit(client, interaction, itemId) {
  const item = getItem(itemId);
  if (!item) {
    return interaction.reply({ content: "❌ 找不到該商品", flags: MessageFlags.Ephemeral });
  }
  const raw = (interaction.fields.getTextInputValue("qty") || "").trim();
  const qty = Math.floor(Number(raw));
  if (!Number.isFinite(qty) || qty < 1) {
    return interaction.reply({
      content: "❌ 請輸入大於 0 的整數數量。",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const result = await buyItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
    itemId,
    quantity: qty,
  });
  if (!result.ok) return interaction.editReply({ content: `❌ ${result.error}`, components: [] });
  await interaction.editReply(renderPurchaseResult(item, result));
}

// 確認購買：customId = shop_confirm_<qty>_<itemId>。真正扣款發生在這裡。
async function handleConfirmButton(client, interaction, qty, itemId) {
  const item = getItem(itemId);
  if (!item) {
    return interaction.update({ content: "❌ 找不到該商品", components: [] });
  }

  // 真正的購買：先把確認面板鎖住（移除按鈕）再扣款，避免重複送出
  await interaction.update({ content: "⏳ 購買處理中…", components: [] });

  const result = await buyItem(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.user.username,
    member: interaction.member,
    itemId,
    quantity: qty,
  });

  if (!result.ok) return interaction.editReply({ content: `❌ ${result.error}`, components: [] });

  await interaction.editReply(renderPurchaseResult(item, result));
}

// 取消購買：把確認面板收掉。
async function handleCancelButton(client, interaction) {
  await interaction.update({ content: "🛒 已取消購買。", components: [] });
}

async function handleEquipButton(client, interaction, inventoryId) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
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
  if (!(await deferUpdateSafe(interaction))) return;
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
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
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
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
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
      cid.startsWith(QTY_BUY_MODAL_PREFIX) ||
      cid.startsWith(CONFIRM_PREFIX) ||
      cid === CANCEL_ID ||
      cid.startsWith(EQUIP_BTN_PREFIX) ||
      cid.startsWith(TITLE_OPEN_PREFIX) ||
      cid.startsWith(EQUIP_SELECT_PREFIX) ||
      cid === UNIFIED_EQUIP_ID ||
      cid === TITLE_SELECT_ID ||
      cid.startsWith(TITLE_MODAL_PREFIX) ||
      cid === CARDNO_OPEN_ID ||
      cid === CARDNO_MODAL_ID ||
      cid === CUSTOM_COLOR_MODAL_ID;
    if (!isShopInteraction) return;

    // 防連點：面板瀏覽 / 開啟購買確認限流（購買後的裝備、設定稱號等下游動作不限流）
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

    // 防重複扣款：確認購買 / 數量 Modal 送出做較嚴格的限流
    if (
      (interaction.isButton() && cid.startsWith(CONFIRM_PREFIX)) ||
      (interaction.isModalSubmit() && cid.startsWith(QTY_BUY_MODAL_PREFIX))
    ) {
      const rl = consume(interaction.user.id, "shop:buy", { windowMs: 2500, max: 1 });
      if (!rl.allowed) {
        try {
          await interaction.reply({
            content: `⏳ 別急，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (_) {
          /* noop */
        }
        return;
      }
    }

    // 商店瀏覽：切換分類 / 分頁
    if (interaction.isStringSelectMenu() && cid === CAT_SELECT_ID) {
      return handleCategorySelect(client, interaction);
    }
    if (interaction.isButton() && cid.startsWith(NAV_PREFIX)) {
      return handleNav(client, interaction);
    }

    // 購買流程：可堆疊商品開數量 Modal；其餘開確認面板 → 確認 / 取消
    if (interaction.isButton() && cid.startsWith(BUY_PREFIX)) {
      return handleBuyButton(client, interaction, cid.slice(BUY_PREFIX.length));
    }
    if (interaction.isModalSubmit() && cid.startsWith(QTY_BUY_MODAL_PREFIX)) {
      return handleQtyBuyModalSubmit(client, interaction, cid.slice(QTY_BUY_MODAL_PREFIX.length));
    }
    if (interaction.isButton() && cid.startsWith(CONFIRM_PREFIX)) {
      const rest = cid.slice(CONFIRM_PREFIX.length); // <qty>_<itemId>
      const us = rest.indexOf("_");
      const qty = parseInt(rest.slice(0, us), 10) || 1;
      const itemId = rest.slice(us + 1);
      return handleConfirmButton(client, interaction, qty, itemId);
    }
    if (interaction.isButton() && cid === CANCEL_ID) {
      return handleCancelButton(client, interaction);
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

    // 統一裝備選單：value = `<type>:<inventoryId>`。自訂稱號開彈窗設定文字，其餘直接裝備。
    if (interaction.isStringSelectMenu() && interaction.customId === UNIFIED_EQUIP_ID) {
      const raw = interaction.values?.[0] || "";
      const sep = raw.indexOf(":");
      const type = sep > 0 ? raw.slice(0, sep) : "";
      const invId = sep > 0 ? raw.slice(sep + 1) : "";
      if (!isValidObjectId(invId)) return replyInvalidId(interaction);
      if (type === "custom_title") {
        return interaction.showModal(buildTitleModal(invId));
      }
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

    // 自訂卡號：按鈕開彈窗（需擁有贊助限定卡面）→ 送出寫入
    if (interaction.isButton() && cid === CARDNO_OPEN_ID) {
      if (
        !(await ownsDonorCard(client, interaction.user.id, interaction.guildId))
      ) {
        return interaction.reply({
          content: "🔒 自訂卡號是「贊助限定卡面」專屬功能。",
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.showModal(buildCardNumberModal());
    }
    if (interaction.isModalSubmit() && cid === CARDNO_MODAL_ID) {
      return handleCardNumberModalSubmit(client, interaction);
    }

    if (interaction.isModalSubmit() && cid === CUSTOM_COLOR_MODAL_ID) {
      return handleCustomColorModalSubmit(client, interaction);
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
