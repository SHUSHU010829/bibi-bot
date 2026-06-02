require("colors");
const crypto = require("crypto");
const { mining } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("../mining/miningProfile");

// 退款信箱：當市集 / 交易所退還礦石、但玩家背包已滿時，把溢出的礦石暫存到這裡，
// 由玩家用 /信箱 自行領取。fish / coin / 作物等沒有容量上限的物品不會走這裡。

function genMailId() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

// 把整筆物品丟進信箱（呼叫端已決定要走信箱）
async function deposit(client, {
  userId, guildId, source, itemType, itemKey, qty,
  listingId = null, listingType = null, reason = "overflow",
}) {
  if (!client.marketplaceMailboxCollection) return null;
  if (!qty || qty <= 0) return null;
  const mail = {
    mail_id: genMailId(),
    user_id: userId,
    guild_id: guildId,
    source,
    item_type: itemType,
    item_key: itemKey,
    qty,
    listing_id: listingId,
    listing_type: listingType,
    reason,
    created_at: new Date(),
  };
  await client.marketplaceMailboxCollection.insertOne(mail);
  return mail;
}

// 嘗試退還礦石，背包放不下的部分寫進信箱。
// 回傳 { delivered, mailed, mail }。delivered + mailed === qty。
async function refundOreWithOverflow(client, {
  userId, guildId, ore, qty, source, listingId, listingType, reason = "expired",
}) {
  if (!qty || qty <= 0) return { delivered: 0, mailed: 0, mail: null };

  const profile = await getOrCreate(client, userId, guildId);
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  const free = Math.max(0, cap - used);
  const delivered = Math.min(free, qty);
  const mailedQty = qty - delivered;

  if (delivered > 0) {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [`backpack.${ore}`]: delivered }, $set: { updatedAt: new Date() } }
    );
  }

  let mail = null;
  if (mailedQty > 0) {
    mail = await deposit(client, {
      userId, guildId, source,
      itemType: "ore", itemKey: ore, qty: mailedQty,
      listingId, listingType, reason,
    });
  }

  return { delivered, mailed: mailedQty, mail, cap, used };
}

async function listMail(client, userId, guildId) {
  if (!client.marketplaceMailboxCollection) return [];
  return client.marketplaceMailboxCollection
    .find({ user_id: userId, guild_id: guildId })
    .sort({ created_at: 1 })
    .toArray();
}

async function getMail(client, mailId, guildId) {
  if (!client.marketplaceMailboxCollection) return null;
  return client.marketplaceMailboxCollection.findOne({ mail_id: mailId, guild_id: guildId });
}

// 嘗試領取一筆信箱物品。背包放不下時退一個明確的 reason。
// 部分領取：可以放多少就放多少，剩下的更新 qty 留在信箱。
async function claimMail(client, { mailId, userId, guildId }) {
  if (!client.marketplaceMailboxCollection) return { ok: false, reason: "disabled" };

  const mail = await client.marketplaceMailboxCollection.findOne({
    mail_id: mailId,
    guild_id: guildId,
  });
  if (!mail) return { ok: false, reason: "not_found" };
  if (mail.user_id !== userId) return { ok: false, reason: "not_owner" };

  if (mail.item_type !== "ore") {
    await client.marketplaceMailboxCollection.deleteOne({ mail_id: mailId });
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [`${mail.item_type === "fish" ? "fish_bag" : "veggie_bag"}.${mail.item_key}`]: mail.qty },
        $set: { updatedAt: new Date() } }
    ).catch(() => {});
    return { ok: true, claimed: mail.qty, remaining: 0, mail };
  }

  const profile = await getOrCreate(client, userId, guildId);
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  const free = Math.max(0, cap - used);
  if (free <= 0) return { ok: false, reason: "backpack_full", cap, used, mail };

  const claimed = Math.min(free, mail.qty);
  const remaining = mail.qty - claimed;

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [`backpack.${mail.item_key}`]: claimed }, $set: { updatedAt: new Date() } }
  );

  if (remaining > 0) {
    await client.marketplaceMailboxCollection.updateOne(
      { mail_id: mailId },
      { $set: { qty: remaining, updated_at: new Date() } }
    );
  } else {
    await client.marketplaceMailboxCollection.deleteOne({ mail_id: mailId });
  }

  return { ok: true, claimed, remaining, mail, cap, used };
}

async function countMail(client, userId, guildId) {
  if (!client.marketplaceMailboxCollection) return 0;
  return client.marketplaceMailboxCollection.countDocuments({ user_id: userId, guild_id: guildId });
}

module.exports = {
  deposit,
  refundOreWithOverflow,
  listMail,
  getMail,
  claimMail,
  countMail,
};
