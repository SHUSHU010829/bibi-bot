const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { isStackable, stackMax } = require("./catalog");
const { MONEY_EMOJI } = require("../../constants/coin");

const QTY_SELECT_PREFIX = "shop_qty_";
const CONFIRM_PREFIX = "shop_confirm_";
const CANCEL_ID = "shop_cancel";

// 同 shopView 的效期 / 數量提示（這裡僅複製需要的判斷，避免循環相依）。
function itemMeta(item) {
  if (item.type === "wallet_theme" || item.type === "mining_backpack") return "永久";
  if (item.durationDays) return `${item.durationDays} 天`;
  const m = item.payload?.durationMinutes;
  if (m) {
    if (m % 1440 === 0) return `${m / 1440} 天`;
    if (m % 60 === 0) return `${m / 60} 小時`;
    return `${m} 分鐘`;
  }
  if (item.type === "mining_luck_potion") return `${item.payload?.uses || 0} 次`;
  if (item.type === "mining_stamina_potion") return `+${item.payload?.restore || 0} 體力`;
  return null;
}

// 把選擇數量夾在 [1, max] 內。
function clampQty(item, qty) {
  const max = stackMax(item);
  let q = Math.floor(Number(qty) || 1);
  if (q < 1) q = 1;
  if (q > max) q = max;
  return q;
}

// 數量下拉選單的選項（1 起跳的常用級距，最後補上上限）。
function qtyOptions(item, selected) {
  const max = stackMax(item);
  const base = [1, 2, 3, 5, 10, 20, 30, 50];
  const list = base.filter((n) => n <= max);
  if (!list.includes(max)) list.push(max);
  return list.slice(0, 25).map((n) => ({
    label: `${n} 個`,
    value: String(n),
    default: n === selected,
  }));
}

// 組出購買確認面板（僅自己可見的 ephemeral）。可堆疊商品會多一排數量選單。
function buildBuyConfirmView(item, qty = 1) {
  const stackable = isStackable(item);
  const quantity = stackable ? clampQty(item, qty) : 1;
  const subtotal = item.price * quantity;
  const meta = itemMeta(item);

  const lines = [
    "🛒 **確認購買**",
    `**${item.name}**${meta ? `（${meta}）` : ""}`,
    item.description,
    "",
    `・單價：${item.price.toLocaleString()} ${MONEY_EMOJI}`,
  ];
  if (stackable) {
    lines.push(`・數量：${quantity} 個`);
    lines.push(`・小計：**${subtotal.toLocaleString()}** ${MONEY_EMOJI}`);
  }

  const components = [];

  if (stackable) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${QTY_SELECT_PREFIX}${item.id}`)
      .setPlaceholder("選擇購買數量…")
      .addOptions(qtyOptions(item, quantity));
    components.push(new ActionRowBuilder().addComponents(select));
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_PREFIX}${quantity}_${item.id}`)
        .setLabel(`確認購買・${subtotal.toLocaleString()} 金幣`)
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(CANCEL_ID)
        .setLabel("取消")
        .setEmoji("✖️")
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return { content: lines.join("\n"), components };
}

module.exports = {
  buildBuyConfirmView,
  clampQty,
  QTY_SELECT_PREFIX,
  CONFIRM_PREFIX,
  CANCEL_ID,
};
