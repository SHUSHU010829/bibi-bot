require("colors");
require("dotenv").config();

const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const miningCfg = require("../src/config/mining.json");
const fishingCfg = require("../src/config/fishing.json");
const farmingCfg = require("../src/config/farming.json");
const shopCfg = require("../src/config/shop.json");

/**
 * 把超出 backpackExpansion.maxSlots 的玩家背包容量下修到上限，並補償：
 *   1. 退還多買的格數所花的金幣（按舊制固定單價，見 refundFor）
 *   2. 三袋（礦石／魚袋／菜籃）因為容量縮小而放不下的物品，轉進 MarketplaceMailbox，
 *      玩家用 /信箱 自行領回
 *
 * 執行：
 *   node scripts/capBackpackSlots.js          # dry-run，只列出將被更動的玩家
 *   node scripts/capBackpackSlots.js apply    # 實際寫入
 */

const mining = miningCfg.mining || miningCfg;
const fishing = fishingCfg.fishing || fishingCfg;
const farming = farmingCfg.farming || farmingCfg;
const shop = shopCfg.shop || shopCfg;

const EXPANSION = mining.backpackExpansion || {};
const MAX_SLOTS = EXPANSION.maxSlots;
const BASE_SLOTS = mining.backpackBaseSlots ?? 100;
const EXPAND_ITEM = (shop.items || []).find((i) => i.type === "mining_backpack");
const SLOTS_PER_CHUNK = EXPAND_ITEM?.payload?.slots || 5;
const BASE_PRICE = EXPAND_ITEM?.price || 2000;

// 退款金額用「舊制固定單價」計算，不能用新的遞增曲線：
// 目前超出上限的玩家，那些格數全是在舊制（固定 BASE_PRICE / SLOTS_PER_CHUNK 格）買的。
// 用新曲線反推會退出天文數字（例：25,000 格的玩家實付約 1,000 萬，新曲線卻算出 13 億）。
function refundFor(excessSlots) {
  return Math.ceil(excessSlots / SLOTS_PER_CHUNK) * BASE_PRICE;
}

const BAGS = [
  { field: "backpack", itemType: "ore", label: "礦石袋", keys: Object.keys(mining.ores || {}), prices: mining.ores },
  { field: "fish_bag", itemType: "fish", label: "魚袋", keys: Object.keys(fishing.fish || {}), prices: fishing.fish },
  { field: "veggie_bag", itemType: "veggie", label: "菜籃", keys: Object.keys(farming.crops || {}), prices: farming.crops },
];

// 容量縮小時挑哪些送進信箱：從單價最低的開始移，讓玩家留下值錢的。
function planOverflow(bag, keys, prices, capacity) {
  const used = keys.reduce((sum, k) => sum + (bag?.[k] || 0), 0);
  let overflow = used - capacity;
  if (overflow <= 0) return { used, moves: [] };

  // 作物沒有 price 欄位，用 payout 下界當排序依據。
  const unitPrice = (k) => prices?.[k]?.price ?? prices?.[k]?.payout?.[0] ?? 0;
  const sorted = [...keys].sort((a, b) => unitPrice(a) - unitPrice(b));
  const moves = [];
  for (const key of sorted) {
    if (overflow <= 0) break;
    const have = bag?.[key] || 0;
    if (have <= 0) continue;
    const take = Math.min(have, overflow);
    moves.push({ key, qty: take });
    overflow -= take;
  }
  return { used, moves };
}

async function main() {
  const apply = process.argv[2] === "apply";
  if (!(MAX_SLOTS > 0)) {
    console.log("[SKIP] mining.backpackExpansion.maxSlots 未設定，沒有上限要套用。".yellow);
    return;
  }
  const maxBonus = MAX_SLOTS - BASE_SLOTS;

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] 缺少 MONGO_URI 環境變數".red);
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db("MorningBot");
  const profiles = db.collection("MiningProfiles");
  const coins = db.collection("UserCoins");
  const mailbox = db.collection("MarketplaceMailbox");

  const targets = await profiles.find({ backpack_bonus_slots: { $gt: maxBonus } }).toArray();
  console.log(
    `上限 ${MAX_SLOTS.toLocaleString()} 格（bonus 上限 ${maxBonus.toLocaleString()}）｜超出的玩家：${targets.length} 人`.cyan,
  );

  let totalRefund = 0;
  let totalMails = 0;

  for (const p of targets) {
    const oldBonus = p.backpack_bonus_slots || 0;
    const oldCapacity = BASE_SLOTS + oldBonus;
    const refund = refundFor(oldCapacity - MAX_SLOTS);
    totalRefund += refund;

    const mails = [];
    for (const bag of BAGS) {
      const { used, moves } = planOverflow(p[bag.field], bag.keys, bag.prices, MAX_SLOTS);
      if (moves.length === 0) continue;
      for (const m of moves) {
        mails.push({ bag, ...m });
      }
      console.log(
        `  ${p.userId}／${bag.label}：${used.toLocaleString()} → 上限 ${MAX_SLOTS.toLocaleString()}，`
          + `移入信箱 ${moves.map((m) => `${m.key}×${m.qty}`).join("、")}`.gray,
      );
    }
    totalMails += mails.length;

    console.log(
      `  ${p.userId}：容量 ${oldCapacity.toLocaleString()} → ${MAX_SLOTS.toLocaleString()}`
        + `，退還 ${refund.toLocaleString()} 金幣，信箱 ${mails.length} 筆`,
    );

    if (!apply) continue;

    const now = new Date();
    const dec = {};
    for (const m of mails) dec[`${m.bag.field}.${m.key}`] = -m.qty;

    await profiles.updateOne(
      { userId: p.userId, guildId: p.guildId },
      {
        $set: { backpack_bonus_slots: maxBonus, updatedAt: now },
        ...(Object.keys(dec).length ? { $inc: dec } : {}),
      },
    );

    if (refund > 0) {
      await coins.updateOne(
        { userId: p.userId, guildId: p.guildId },
        { $inc: { totalCoins: refund }, $set: { updatedAt: now } },
        { upsert: true },
      );
    }

    for (const m of mails) {
      await mailbox.insertOne({
        mail_id: crypto.randomBytes(6).toString("hex").toUpperCase(),
        user_id: p.userId,
        guild_id: p.guildId,
        source: "backpack_cap",
        item_type: m.bag.itemType,
        item_key: m.key,
        qty: m.qty,
        listing_id: null,
        listing_type: null,
        reason: "capacity_reduced",
        created_at: now,
      });
    }
  }

  console.log(
    `\n${apply ? "已寫入" : "dry-run"}：${targets.length} 人｜退款合計 ${totalRefund.toLocaleString()} 金幣｜信箱 ${totalMails} 筆`
      .green,
  );
  if (!apply) console.log("加上 apply 參數才會實際寫入：node scripts/capBackpackSlots.js apply".yellow);

  await client.close();
}

main().catch((e) => {
  console.log(`[ERROR] ${e.stack || e}`.red);
  process.exit(1);
});
