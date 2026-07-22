require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const logger = require("../../utils/logger");
const { trackError } = require("../../utils/errorTracker");

// SKU 的 item → MiningProfiles 欄位對照。獨立小額商品發放走這裡，不碰依金額換算的方案回饋。
const SKU_ITEM_FIELD = {
  batch_pass: "batch_pass_count",
};

/**
 * 發放獨立商品（SKU）。目前僅有「連續通行證」。
 * 呼叫端已保證：tradeNo 冪等、實付金額 ≥ skuDef.minAmount、session 已翻 completed。
 * 回傳 record updates（哪些欄位翻 true）。
 */
module.exports = async function grantSkuPerks(client, { record, skuDef }) {
  const updates = {};
  const { userId, guildId } = record;

  const field = SKU_ITEM_FIELD[skuDef.item];
  if (field && skuDef.qty > 0 && client.miningProfilesCollection) {
    try {
      await client.miningProfilesCollection.updateOne(
        { userId, guildId },
        { $inc: { [field]: skuDef.qty }, $set: { updatedAt: new Date() } },
        { upsert: true },
      );
      updates.itemsGranted = true;
    } catch (err) {
      logger.error(
        { source: "donation-grant", phase: "sku-items", tradeNo: record.tradeNo, err: err.message },
        "sku item grant failed",
      );
      trackError("donation-grant", err, { phase: "sku-items", tradeNo: record.tradeNo });
    }
  }

  try {
    await sendSkuDm(client, record, skuDef);
    updates.dmSent = true;
  } catch (err) {
    logger.warn(
      { source: "donation-grant", phase: "sku-dm", tradeNo: record.tradeNo, err: err.message },
      "sku DM failed (user may have DMs off)",
    );
  }

  return updates;
};

async function sendSkuDm(client, record, skuDef) {
  const user =
    client.users.cache.get(record.userId) ||
    (await client.users.fetch(record.userId).catch(() => null));
  if (!user) throw new Error(`user ${record.userId} not fetchable`);

  const THANKFUL_EMOJI = "<:thankful:1509781026761736282>";
  const lines = [
    `# ${THANKFUL_EMOJI} 購買成功，謝謝你的支持！`,
    "",
    `金額：**NT$${record.amountNtd}**　·　平台：${record.platform === "ecpay" ? "綠界" : "歐付寶"}`,
    `交易編號：\`${record.tradeNo}\``,
    "",
    `## 🎟️ ${skuDef.name}`,
    `- 已放入你的背包 ×${skuDef.qty}`,
    "",
    "到 `/背包` 挖礦道具區按「啟用」，啟用後 1 小時內無視等級即可連續挖礦與連續釣魚。",
    "-# 連續操作仍照冷卻扣 CD 縮短券，記得先備好券！",
  ];

  const container = new ContainerBuilder()
    .setAccentColor(0xd8e3c4)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));

  await user.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

module.exports.SKU_ITEM_FIELD = SKU_ITEM_FIELD;
