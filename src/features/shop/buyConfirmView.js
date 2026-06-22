const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { isStackable, stackMax } = require("./catalog");
const { MONEY_EMOJI } = require("../../constants/coin");

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
  if (item.type === "mining_stamina_potion") return `+${item.payload?.restore || 0} 體力／瓶`;
  if (item.type === "mining_hp_potion_small" || item.type === "mining_hp_potion_medium") {
    return `+${item.payload?.restore || 0} HP／瓶`;
  }
  if (item.type === "mining_hp_potion_large") return `補滿 HP／瓶`;
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

// 組出購買確認面板（僅自己可見的 ephemeral）。可堆疊商品的數量改由 Modal 輸入，
// 這裡只負責「一次買 1 筆」的非堆疊商品確認。
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
  CONFIRM_PREFIX,
  CANCEL_ID,
};
