require("colors");
const { coinSystem } = require("../../config");
const itemAccess = require("../marketplace/itemAccess");
const { raiseSuspicion } = require("./suspiciousAlert");

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

// 上架前的行情/風險評估（唯讀，不記錄樣本）：用「近期成交中位」判斷單價偏離程度，
// 並沿用反洗幣同一組閾值，預測「若以此價成交是否會被判定為變相轉帳」。
async function assessListingPrice(client, { guildId, itemType, itemKey, unitPrice, qty }) {
  const { median: med, samples } = await medianUnitPrice(client, guildId, itemType, itemKey);
  const minSamples = cfg().minSamples ?? 5;
  const usingMedian = samples >= minSamples && med > 0;
  const overpayRatio = cfg().overpayRatio ?? 5;
  const overpayAbs = cfg().overpayAbs ?? 30000;
  let ratio = null;
  let overpay = null;
  let wouldFlag = false;
  if (usingMedian && unitPrice > 0 && qty > 0) {
    ratio = unitPrice / med;
    overpay = Math.round(unitPrice * qty - med * qty);
    wouldFlag = cfg().enabled !== false && ratio >= overpayRatio && overpay >= overpayAbs;
  }
  return {
    median: med,
    samples,
    usingMedian,
    ratio,
    overpay,
    wouldFlag,
    overpayRatio,
    medianDays: cfg().medianDays ?? 30,
  };
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
        // 樣本不足時不判定：basePrice（NPC 基礎價）常遠低於玩家市場行情，
        // 拿它當參考價會把正常成交誤判成洗幣。只信任「真實成交中位數」路徑。
        const ref = usingMedian ? med : 0;
        if (ref > 0) {
          const ratio = unitPrice / ref;
          const overpay = Math.round(totalPaid - ref * qty);
          const overpayRatio = cfg().overpayRatio ?? 5;
          const overpayAbs = cfg().overpayAbs ?? 30000;
          if (ratio >= overpayRatio && overpay >= overpayAbs) {
            const label = itemAccess.itemLabel(itemType, itemKey, qty);
            const refKind = `近 ${cfg().medianDays ?? 30} 天中位`;
            await raiseSuspicion(client, {
              guildId,
              kind: "market",
              users: [buyerId, sellerId],
              description: `買方 <@${buyerId}> 以高價向賣方 <@${sellerId}> 買入（${listingType}），疑似變相轉帳。`,
              fields: [
                {
                  name: label,
                  value: `單價 **${Math.round(unitPrice).toLocaleString()}**（${refKind}價 ${Math.round(ref).toLocaleString()}，約 ${ratio.toFixed(1)} 倍）`,
                },
                { name: "溢付金額", value: `**${overpay.toLocaleString()}** credits` },
              ],
            });
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

// 物物交換：以系統基礎價（basePrice）估兩邊總價值，偵測「嚴重不對等」的變相贈與／轉帳。
// 兩件物品之間的相對價值用 basePrice 衡量是公允的（不像金幣單價需要玩家市場中位）。
function assessSwapValue({ giveType, giveKey, giveQty, wantType, wantKey, wantQty }) {
  const giveUnit = itemAccess.basePrice(giveType, giveKey);
  const wantUnit = itemAccess.basePrice(wantType, wantKey);
  const giveValue = giveUnit * (giveQty || 0);
  const wantValue = wantUnit * (wantQty || 0);
  const overpayRatio = cfg().overpayRatio ?? 5;
  const overpayAbs = cfg().overpayAbs ?? 30000;
  let ratio = null;
  let diff = null;
  let wouldFlag = false;
  let direction = null; // creator_gives：發起方付出價值遠高於換得；fulfiller_gives：接單方付出遠高於換得
  if (giveValue > 0 && wantValue > 0) {
    if (giveValue >= wantValue) { ratio = giveValue / wantValue; diff = giveValue - wantValue; direction = "creator_gives"; }
    else { ratio = wantValue / giveValue; diff = wantValue - giveValue; direction = "fulfiller_gives"; }
    wouldFlag = cfg().enabled !== false && ratio >= overpayRatio && diff >= overpayAbs;
  }
  return { giveValue, wantValue, ratio, diff, wouldFlag, direction, overpayRatio };
}

// 物物交換成交後呼叫（非阻塞）：價值嚴重不對等時向管理員回報疑似變相轉帳。
// give/want 傳「本次成交的實際數量」（分批成交時只判本批）。
function checkSwapTransfer(client, { guildId, creatorId, fulfillerId, giveType, giveKey, giveQty, wantType, wantKey, wantQty }) {
  Promise.resolve()
    .then(async () => {
      if (cfg().enabled === false) return;
      if (!guildId || !creatorId || !fulfillerId || creatorId === fulfillerId) return;
      const a = assessSwapValue({ giveType, giveKey, giveQty, wantType, wantKey, wantQty });
      if (!a.wouldFlag) return;
      // 付出價值遠高於換得的一方＝把價值轉出者；另一方＝受益者
      const [payer, payee] = a.direction === "creator_gives" ? [creatorId, fulfillerId] : [fulfillerId, creatorId];
      const giveLabel = itemAccess.itemLabel(giveType, giveKey, giveQty);
      const wantLabel = itemAccess.itemLabel(wantType, wantKey, wantQty);
      await raiseSuspicion(client, {
        guildId,
        kind: "market",
        users: [creatorId, fulfillerId],
        description: `物物交換價值嚴重不對等（約 ${a.ratio.toFixed(1)} 倍），<@${payer}> 疑似變相把價值轉給 <@${payee}>。`,
        fields: [
          { name: "發起方付出", value: `${giveLabel}（估值 ${Math.round(a.giveValue).toLocaleString()}）` },
          { name: "換得", value: `${wantLabel}（估值 ${Math.round(a.wantValue).toLocaleString()}）` },
          { name: "價值差", value: `**${Math.round(a.diff).toLocaleString()}** credits` },
        ],
      });
    })
    .catch((e) => console.log(`[MKT-LAUNDER] swap 偵測失敗: ${e?.message || e}`.red));
}

module.exports = { recordAndCheck, medianUnitPrice, assessListingPrice, assessSwapValue, checkSwapTransfer };
