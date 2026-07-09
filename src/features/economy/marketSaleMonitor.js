require("colors");
const { coinSystem, bank } = require("../../config");
const itemAccess = require("../marketplace/itemAccess");
const creditService = require("../bank/creditService");

// 市集/拍賣反洗幣：記錄每筆成交單價樣本，並以「近期成交中位數」為合理價，
// 抓「買方明顯超額付款給賣方」的變相轉帳（樣本不足時退回 basePrice）。

function cfg() {
  return coinSystem?.marketAntiLaundering || {};
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function medianUnitPrice(client, guildId, itemType, itemKey) {
  const col = client.marketSalesCollection;
  if (!col) return { median: null, samples: 0 };
  const days = cfg().medianDays ?? 30;
  const since = new Date(Date.now() - days * 86400000);
  const docs = await col
    .find(
      { guildId, item_type: itemType, item_key: itemKey, settledAt: { $gte: since } },
      { projection: { unitPrice: 1 }, sort: { settledAt: -1 }, limit: 200 },
    )
    .toArray()
    .catch(() => []);
  const prices = docs.map((d) => d.unitPrice).filter((n) => typeof n === "number" && n > 0);
  return { median: median(prices), samples: prices.length };
}

async function getAlertChannel(client) {
  const channelId =
    coinSystem?.adminGrant?.auditLogChannelId || coinSystem?.dailyEconomyReport?.channelId;
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

// 成交後呼叫（非阻塞）：先比對參考價偵測溢價，再記錄本次樣本。
function recordAndCheck(client, sale) {
  Promise.resolve()
    .then(async () => {
      const col = client.marketSalesCollection;
      if (!col) return;
      const { guildId, itemType, itemKey, qty, unitPrice, totalPaid, buyerId, sellerId, listingType } = sale;
      if (!guildId || !itemType || !itemKey || !(qty > 0) || !(unitPrice > 0)) return;

      if (cfg().enabled !== false && buyerId && sellerId && buyerId !== sellerId) {
        const { median: med, samples } = await medianUnitPrice(client, guildId, itemType, itemKey);
        const minSamples = cfg().minSamples ?? 5;
        const usingMedian = samples >= minSamples && med > 0;
        const ref = usingMedian ? med : itemAccess.basePrice(itemType, itemKey);
        if (ref > 0) {
          const ratio = unitPrice / ref;
          const overpay = Math.round(totalPaid - ref * qty);
          const overpayRatio = cfg().overpayRatio ?? 5;
          const overpayAbs = cfg().overpayAbs ?? 30000;
          if (ratio >= overpayRatio && overpay >= overpayAbs) {
            if (bank?.credit?.enabled) {
              await creditService.flagSuspicious(client, buyerId, guildId).catch(() => {});
              await creditService.flagSuspicious(client, sellerId, guildId).catch(() => {});
            }
            const channel = await getAlertChannel(client);
            if (channel) {
              const label = itemAccess.itemLabel(itemType, itemKey, qty);
              const refKind = usingMedian ? `近 ${cfg().medianDays ?? 30} 天中位` : "基準";
              await channel
                .send({
                  content: [
                    "⚠️ 可疑市集成交（疑似變相轉帳）",
                    `${label}　單價 **${Math.round(unitPrice).toLocaleString()}**（${refKind}價 ${Math.round(ref).toLocaleString()}，約 ${ratio.toFixed(1)} 倍）`,
                    `買方 <@${buyerId}> → 賣方 <@${sellerId}>　溢付 **${overpay.toLocaleString()}** credits（${listingType}）`,
                  ].join("\n"),
                  allowedMentions: { parse: [] },
                })
                .catch(() => {});
            }
          }
        }
      }

      await col
        .insertOne({
          guildId,
          item_type: itemType,
          item_key: itemKey,
          qty,
          unitPrice,
          totalPaid,
          buyerId,
          sellerId,
          listingType,
          settledAt: new Date(),
        })
        .catch(() => {});
    })
    .catch((e) => console.log(`[MKT-LAUNDER] 偵測失敗: ${e?.message || e}`.red));
}

module.exports = { recordAndCheck, medianUnitPrice };
