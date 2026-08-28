require("dotenv/config");
require("colors");
const { MongoClient } = require("mongodb");
const { EQUIP_SLOTS } = require("../features/mining/equipDurability");

// 一次性修正：把玩家「現在身上」裝備累積的上限磨損（*_max_durability_bonus 負值）清成 0。
//
// 背景：磨損原本會跟著換裝備一路帶著走，改成「只有升級配方才沿用」之後，舊玩家手上那把
// 仍揹著改版前累積的負值。這支腳本把負值歸零、上限回到 config 原始值；
// 維修工具養出來的正值（+N）不動，當前耐久也不補（不是免費修裝，只是把上限還回去）。
//
// 用法：
//   node ./src/scripts/resetEquipWear.js                  # dry-run，只印會改哪些
//   node ./src/scripts/resetEquipWear.js --apply           # 實際寫入
//   node ./src/scripts/resetEquipWear.js --guild=123 --apply

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const guildArg = args.find((a) => a.startsWith("--guild="));
const GUILD_ID = guildArg ? guildArg.slice("--guild=".length) : null;

const SLOTS = Object.entries(EQUIP_SLOTS);

// 舊文件（欄位還沒拆成 base + bonus）的 *_max_durability 是混合值：
// 減掉 config 原始上限就還原出當初累積的 delta，比照 miningProfile.normalize()。
// 裝備已打壞（max 是 null）或根本沒裝時，殘留的 bonus 算不進任何上限、也會被下次打造覆蓋，
// 不在這裡動它，免得統計灌水。
function readSlot(doc, spec) {
  const equippedId = doc[spec.idField];
  const storedMax = doc[spec.maxField];
  if (!equippedId || equippedId === spec.none || typeof storedMax !== "number") {
    return { active: false, bonus: 0 };
  }
  const configMax = spec.defs()[equippedId]?.durability ?? null;
  if (typeof doc[spec.bonusField] === "number") {
    return { active: true, bonus: doc[spec.bonusField], configMax, legacy: false };
  }
  if (configMax == null) return { active: false, bonus: 0 };
  return { active: true, bonus: storedMax - configMax, configMax, legacy: true };
}

function gearName(spec, id) {
  const def = spec.defs()[id] || {};
  return `${def.emoji || spec.emoji} ${def.name || "（未裝備）"}`;
}

(async () => {
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] 沒有 MONGO_URI，請先設好 .env".red);
    process.exit(1);
  }

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const coll = mongo.db("MorningBot").collection("MiningProfiles");

  const filter = GUILD_ID ? { guildId: GUILD_ID } : {};
  const projection = { userId: 1, guildId: 1 };
  for (const [, spec] of SLOTS) {
    projection[spec.idField] = 1;
    projection[spec.maxField] = 1;
    projection[spec.bonusField] = 1;
  }

  const ops = [];
  const perSlot = Object.fromEntries(SLOTS.map(([slot]) => [slot, 0]));
  const samples = [];
  let scanned = 0;

  const cursor = coll.find(filter, { projection });
  for await (const doc of cursor) {
    scanned += 1;
    const set = {};
    for (const [slot, spec] of SLOTS) {
      const { active, bonus, configMax, legacy } = readSlot(doc, spec);
      if (!active || bonus >= 0) continue;
      set[spec.bonusField] = 0;
      // 舊文件的磨損是烘進 base 的，光把 bonus 設 0 沒用，base 也要還原成 config 原始上限。
      if (legacy && configMax != null) set[spec.maxField] = configMax;
      perSlot[slot] += 1;
      if (samples.length < 15) {
        samples.push(
          `${doc.guildId}/${doc.userId}　${gearName(spec, doc[spec.idField])}　上限磨損 ${bonus} → 0`,
        );
      }
    }
    if (Object.keys(set).length === 0) continue;
    set.updatedAt = new Date();
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
  }

  console.log(`\n掃描 ${scanned} 筆玩家資料${GUILD_ID ? `（僅 guild ${GUILD_ID}）` : ""}`.cyan);
  for (const [slot, spec] of SLOTS) {
    console.log(`  ${spec.emoji} ${spec.label}：${perSlot[slot]} 筆有磨損要清`);
  }
  console.log(`  共 ${ops.length} 筆文件需要更新\n`);
  if (samples.length > 0) {
    console.log("範例：".gray);
    for (const line of samples) console.log(`  ${line}`.gray);
    console.log("");
  }

  if (!APPLY) {
    console.log("這是 dry-run，什麼都沒寫入。確認沒問題後加 --apply 再跑一次。".yellow);
    await mongo.close();
    return;
  }

  if (ops.length > 0) {
    const res = await coll.bulkWrite(ops, { ordered: false });
    console.log(`✅ 已更新 ${res.modifiedCount} 筆`.green);
  } else {
    console.log("✅ 沒有需要更新的資料".green);
  }
  await mongo.close();
})().catch((err) => {
  console.log(`[ERROR] resetEquipWear:\n${err}\n${err.stack}`.red);
  process.exit(1);
});
