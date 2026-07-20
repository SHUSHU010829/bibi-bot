require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { registerCron } = require("../../utils/cronRegistry");
const { marketplace } = require("../../config");
const marketplaceService = require("../../features/marketplace/marketplaceService");
const { RENEW_PREFIX } = require("../../features/marketplace/marketplaceView");

// 每 5 分鐘掃過期市集掛單：
// - 首次到期且可續租（收購 / 賣單 / 物物交換 / 無人出價的競標）→ 先 DM 賣家問是否續租，
//   延後 renewGraceMs 再結算；賣家可點續租按鈕付費延長。
// - 二次到期（已問過續租）或不可續租 → 依 settleListing 結算：
//   auction 有得標者撥款交貨，其餘退回託管。

const RENEWABLE = new Set(["bulk", "bulk_sell", "swap"]);

function isRenewable(listing) {
  if (RENEWABLE.has(listing.listing_type)) return true;
  if (listing.listing_type === "auction" && !listing.bidder_id) return true;
  return false;
}

const TYPE_NAME = { bulk: "收購", bulk_sell: "賣單", swap: "物物交換", auction: "競標" };

function buildRenewDm(listing) {
  const ld = marketplace?.listingDuration || {};
  const feePerDay = ld.renewFeePerDay ?? 100;
  const tiers = ld.tiers || [{ days: 1 }, { days: 3 }, { days: 7 }];
  const graceHrs = Math.round((ld.renewGraceMs ?? 21600000) / 3600000);
  const typeName = TYPE_NAME[listing.listing_type] || "掛單";

  const container = new ContainerBuilder()
    .setAccentColor(0xf39c12)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⏰ 掛單即將到期\n` +
          `你的${typeName}單 **#${listing.listing_id}**` +
          (listing.title ? `（${listing.title}）` : "") +
          ` 已到期。\n` +
          `要續租嗎？選一個天數付費延長，未回應將在 **${graceHrs} 小時**後自動結算並退回託管。`,
      ),
    );

  const row = new ActionRowBuilder();
  for (const t of tiers) {
    const fee = Math.max(0, Math.floor(t.days * feePerDay));
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${RENEW_PREFIX}${listing.seller_id}_${listing.guild_id}_${listing.listing_id}_${t.days}`)
        .setLabel(`續 ${t.days} 天（${fee} 幣）`)
        .setEmoji("♻️")
        .setStyle(ButtonStyle.Primary),
    );
  }
  return { components: [container, row], flags: MessageFlags.IsComponentsV2 };
}

async function sweepOnce(client) {
  if (!client.marketListingsCollection) return { settled: 0, offered: 0 };

  const now = new Date();
  const cursor = client.marketListingsCollection.find({
    status: "active",
    expires_at: { $lte: now },
  });

  let settled = 0;
  let offered = 0;
  while (await cursor.hasNext()) {
    const listing = await cursor.next();
    try {
      // 首次到期且可續租 → 延後 grace，DM 問續租，本輪不結算
      if (!listing.renew_offered && isRenewable(listing)) {
        const graceMs = (marketplace?.listingDuration || {}).renewGraceMs ?? 21600000;
        const upd = await client.marketListingsCollection.findOneAndUpdate(
          { listing_id: listing.listing_id, guild_id: listing.guild_id, status: "active", renew_offered: { $ne: true } },
          { $set: { renew_offered: true, expires_at: new Date(now.getTime() + graceMs), updated_at: now } },
          { returnDocument: "after" },
        );
        if (upd?.value || upd) {
          try {
            const user = await client.users.fetch(listing.seller_id);
            await user.send(buildRenewDm(listing));
          } catch (e) {
            console.log(`[WARN] 續租 DM 失敗（${listing.seller_id}）：${e?.message || e}`.yellow);
          }
          offered += 1;
        }
        continue;
      }

      const res = await marketplaceService.settleListing(client, listing);
      if (res) {
        settled += 1;
        console.log(`[MARKET] 結算 #${listing.listing_id}(${listing.listing_type}) → ${res.outcome}`.gray);
      }
    } catch (e) {
      console.log(`[ERROR] market settle ${listing.listing_id}: ${e}`.red);
    }
  }
  return { settled, offered };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "marketplace.expiry",
    label: "市集掛單到期結算",
    schedule: "*/5 * * * *",
    runner: () => sweepOnce(client),
  });
};
