// 修補「guildId 夾帶空白」造成的抖內回饋未發放問題並補發。
//
// 背景：
//   PRIMARY_GUILD_ID env 夾帶前導空白 → bot session 存了 guildId=" 1174…" →
//   發放時所有以 {userId, guildId} 為鍵的 Mongo 回饋（金幣 / 道具 / luck 加成 /
//   卡面 / 稱號）都寫進「空白 guildId」這個對不到使用者的孤兒桶，使用者實際上
//   什麼都沒拿到，但 DonationRecords 的旗標卻是 true（寫入本身有成功）。
//   DM 與公告不靠 guildId，所以正常送出；身分組走 Discord API 也正常掛上。
//
// 本腳本的修補方式是「搬移」而非「重發」：把孤兒桶（含空白 guildId）裡的回饋
// 資料搬到 trim 後的正確 guildId，金額/到期日完全比照原本發放結果，最忠實也最
// 不會重複計算。完成後刪除孤兒文件，並把 DonationRecords 的 guildId 校正、標記
// guildSpaceFixedAt。不重發 DM、不重發公告、不動身分組。
//
// 冪等：修補後 record.guildId 已不含空白，重跑不會再被選中；另有 guildSpaceFixedAt
// 旗標雙重保護。
//
// 用法：
//   node src/scripts/fixDonationGuildSpace.js                 # dry-run，只列出會做什麼
//   node src/scripts/fixDonationGuildSpace.js --apply         # 實際寫入
//   node src/scripts/fixDonationGuildSpace.js --apply --trade=2605291926457278,2605292013010823

require("dotenv/config");
require("colors");

const { MongoClient } = require("mongodb");

function parseArgs(argv) {
  const args = { apply: false, trades: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--trade=")) {
      args.trades = a
        .slice(8)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return args;
}

// 與 grantDonationPerks 相同的 luck buff 取捨規則（永久 > 限時；bonus 高 > 低；
// 同 bonus 取較晚到期）。target 為目的桶現況，incoming 為孤兒桶要搬入的值。
function pickLuck(target, incoming) {
  const tBonus = Number(target?.donation_luck_bonus || 0);
  const tExpiry = target?.donation_luck_expires_at ?? null; // Date | null（null=永久）
  const iBonus = Number(incoming?.donation_luck_bonus || 0);
  const iExpiry = incoming?.donation_luck_expires_at ?? null;
  if (iBonus <= 0) return null; // 沒有要搬的 buff

  let shouldUpdate;
  if (tBonus <= 0) {
    shouldUpdate = true; // 目的桶沒有 buff → 直接套用
  } else if (tExpiry === null) {
    shouldUpdate = iExpiry === null && iBonus > tBonus; // 既有永久，只有更高的永久能蓋
  } else if (iExpiry === null) {
    shouldUpdate = true; // 新的是永久 → 一定蓋
  } else {
    shouldUpdate =
      iBonus > tBonus ||
      (iBonus === tBonus && new Date(iExpiry) > new Date(tExpiry));
  }
  if (!shouldUpdate) return null;
  return { donation_luck_bonus: iBonus, donation_luck_expires_at: iExpiry };
}

const ITEM_FIELDS = ["luck_potion_uses", "cd_ticket_count"];
const COIN_MOVE_FIELDS = ["totalCoins", "lifetimeCoins", "lifetimeSpent"];

async function main() {
  const args = parseArgs(process.argv);

  if (!process.env.MONGO_PASSWORD) {
    console.log("[ERROR] MONGO_PASSWORD 未設定，無法連線。".red);
    process.exit(1);
  }

  const mode = args.apply ? "APPLY（會寫入）".red : "DRY-RUN（不寫入）".green;
  console.log(`\n=== 抖內 guildId 空白修補 — ${mode} ===\n`.cyan);

  const uri = `mongodb+srv://SHUSHU:${process.env.MONGO_PASSWORD}@morningbot.ar55cbn.mongodb.net/?retryWrites=true&w=majority`;
  const mongo = new MongoClient(uri);
  await mongo.connect();
  const db = mongo.db("MorningBot");

  const Records = db.collection("DonationRecords");
  const UserCoins = db.collection("UserCoins");
  const CoinTx = db.collection("CoinTransactions");
  const Mining = db.collection("MiningProfiles");
  const Inventory = db.collection("UserInventory");

  // 選出 guildId 含空白、且尚未修補過的 record
  const query = {
    guildId: { $regex: /\s/ },
    guildSpaceFixedAt: { $exists: false },
  };
  if (args.trades) query.tradeNo = { $in: args.trades };

  const records = await Records.find(query).toArray();
  const affected = records.filter(
    (r) => typeof r.guildId === "string" && r.guildId !== r.guildId.trim(),
  );

  if (affected.length === 0) {
    console.log("沒有需要修補的紀錄。".green);
    await mongo.close();
    return;
  }

  console.log(`找到 ${affected.length} 筆需要修補：\n`.yellow);

  for (const rec of affected) {
    const dirty = rec.guildId;
    const clean = rec.guildId.trim();
    const userId = rec.userId;
    console.log(
      `• tradeNo=${rec.tradeNo} user=${userId} tier=${rec.tierId} ` +
        `guildId="${dirty}" → "${clean}"`.gray,
    );

    // ── 1. 金幣：把孤兒桶的金幣計數搬進正確桶，搬完刪孤兒 ──────────────────
    const orphanCoins = await UserCoins.findOne({ userId, guildId: dirty });
    if (orphanCoins) {
      const inc = {};
      for (const f of COIN_MOVE_FIELDS) {
        if (typeof orphanCoins[f] === "number" && orphanCoins[f] !== 0) {
          inc[f] = orphanCoins[f];
        }
      }
      for (const [k, v] of Object.entries(orphanCoins)) {
        if (k.startsWith("coinsFrom_") && typeof v === "number" && v !== 0) {
          inc[k] = v;
        }
      }
      console.log(`    金幣搬移 +${JSON.stringify(inc)}`.green);
      const txCount = await CoinTx.countDocuments({ userId, guildId: dirty });
      console.log(`    CoinTransactions 改 guildId：${txCount} 筆`.green);
      if (args.apply) {
        await UserCoins.updateOne(
          { userId, guildId: clean },
          {
            $inc: inc,
            $setOnInsert: { userId, guildId: clean, createdAt: new Date() },
            $set: { updatedAt: new Date() },
          },
          { upsert: true },
        );
        await UserCoins.deleteOne({ _id: orphanCoins._id });
        await CoinTx.updateMany(
          { userId, guildId: dirty },
          { $set: { guildId: clean } },
        );
      }
    } else {
      console.log("    （孤兒桶無金幣文件）".gray);
    }

    // ── 2. 挖礦：道具數量 $inc、luck buff 依規則搬移，搬完刪孤兒 ────────────
    const orphanMining = await Mining.findOne({ userId, guildId: dirty });
    if (orphanMining) {
      const targetMining = await Mining.findOne({ userId, guildId: clean });
      const inc = {};
      for (const f of ITEM_FIELDS) {
        if (typeof orphanMining[f] === "number" && orphanMining[f] !== 0) {
          inc[f] = orphanMining[f];
        }
      }
      const luck = pickLuck(targetMining, orphanMining);
      const set = { updatedAt: new Date() };
      if (luck) Object.assign(set, luck);
      console.log(
        `    挖礦搬移 inc=${JSON.stringify(inc)} luck=${luck ? JSON.stringify(luck) : "（不變）"}`
          .green,
      );
      if (args.apply) {
        const update = { $set: set, $setOnInsert: { userId, guildId: clean } };
        if (Object.keys(inc).length > 0) update.$inc = inc;
        await Mining.updateOne({ userId, guildId: clean }, update, {
          upsert: true,
        });
        await Mining.deleteOne({ _id: orphanMining._id });
      }
    } else {
      console.log("    （孤兒桶無挖礦文件）".gray);
    }

    // ── 3. 背包（卡面 / 稱號等）：無同型則整筆改 guildId；有同型則保守跳過 ──
    const orphanItems = await Inventory.find({ userId, guildId: dirty }).toArray();
    for (const item of orphanItems) {
      const conflict = await Inventory.findOne({
        userId,
        guildId: clean,
        type: item.type,
        ...(item.type === "custom_title" ? {} : { itemId: item.itemId }),
      });
      if (!conflict) {
        console.log(`    背包搬移 type=${item.type} itemId=${item.itemId}`.green);
        if (args.apply) {
          await Inventory.updateOne(
            { _id: item._id },
            { $set: { guildId: clean, updatedAt: new Date() } },
          );
        }
      } else {
        console.log(
          `    ⚠ 背包 type=${item.type} itemId=${item.itemId} 目的桶已有同型，` +
            `保守跳過（請人工確認是否需合併到期日）`.yellow,
        );
      }
    }

    // ── 4. 校正 record.guildId + 標記已修補 ───────────────────────────────
    if (args.apply) {
      await Records.updateOne(
        { _id: rec._id },
        { $set: { guildId: clean, guildSpaceFixedAt: new Date() } },
      );
    }
    console.log("");
  }

  console.log(
    args.apply
      ? `完成：已修補並補發 ${affected.length} 筆。`.green
      : `以上為預演結果，加 --apply 才會實際寫入。`.yellow,
  );

  await mongo.close();
}

main().catch((err) => {
  console.error("[FATAL]".red, err);
  process.exit(1);
});
