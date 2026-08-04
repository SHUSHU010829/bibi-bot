require("colors");
const goldService = require("./goldService");

// 金庫容量上限上線時，既有持有者一定有人已經超出上限。不直接沒收 / 折現，
// 而是給一段寬限期：先通知，期限內自己處理（賣出或提升信用評等擴容），
// 期限到還超出的部分才按當日賣出價強制折現進錢包。
//
// 狀態存在 GoldHoldings doc 上（overCapDeadline / overCapNotifiedAt / overCapRemindedAt）——
// 這是「這個金庫自己的處理期限」，不是玩家當前狀態換算出來的加成，所以存欄位是對的；
// 容量本身仍然是 compute-on-read。

function graceCfg() {
  return goldService.vaultCfg().grace || {};
}

function graceDays() {
  return graceCfg().days ?? 3;
}

function remindIntervalMs() {
  return (graceCfg().remindIntervalHours ?? 20) * 3600000;
}

async function clearFlags(col, userId, guildId) {
  await col
    .updateOne(
      { userId, guildId },
      { $unset: { overCapDeadline: "", overCapNotifiedAt: "", overCapRemindedAt: "" } },
    )
    .catch(() => {});
}

// 粗篩用的容量：不帶 member（沒有年資加成）→ 只會低估容量，寧可多抓再精算，
// 也不要對每個持有者都打一次 members.fetch。
async function resolveMember(client, guildId, userId) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

// 掃出所有「現在就有超出容量、且賣得掉」的金庫。
async function scan(client) {
  const col = client.goldHoldingsCollection;
  if (!col) return [];

  const found = [];
  const cursor = col.find({ units: { $gt: 0 } });
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const { userId, guildId } = doc;

    const rough = await goldService.getVaultStatus(client, userId, guildId, null);
    if (!rough.limited) continue;
    if (!rough.over) {
      if (doc.overCapDeadline) await clearFlags(col, userId, guildId);
      continue;
    }

    // 抓不到 member 就跳過這輪：年資加成算不出來會低估容量，寧可延後也不要誤判超額。
    const member = await resolveMember(client, guildId, userId);
    if (!member) continue;

    const status = await goldService.getVaultStatus(client, userId, guildId, member);
    // 超出的部分全鎖在定存 → 現在無從處理，等定存到期時 claimTerm 會自動折現。
    if (!status.over || status.overSellable <= 0) {
      if (doc.overCapDeadline) await clearFlags(col, userId, guildId);
      continue;
    }

    found.push({
      userId,
      guildId,
      username: doc.username || member?.displayName,
      member,
      status,
      deadline: doc.overCapDeadline ? new Date(doc.overCapDeadline) : null,
      remindedAt: doc.overCapRemindedAt ? new Date(doc.overCapRemindedAt) : null,
    });
  }
  return found;
}

// 對單一超額金庫決定這輪要做什麼：開寬限期 / 提醒 / 到期折現 / 什麼都不做。
async function step(client, entry) {
  const col = client.goldHoldingsCollection;
  const { userId, guildId, member, status } = entry;
  const now = new Date();

  if (!entry.deadline) {
    const deadline = new Date(now.getTime() + graceDays() * 86400000);
    await col.updateOne(
      { userId, guildId },
      { $set: { overCapDeadline: deadline, overCapNotifiedAt: now, overCapRemindedAt: now } },
    );
    return { action: "notice", deadline, status, entry };
  }

  if (now < entry.deadline) {
    const last = entry.remindedAt?.getTime() || 0;
    if (now.getTime() - last < remindIntervalMs()) return { action: "wait", entry };
    await col.updateOne({ userId, guildId }, { $set: { overCapRemindedAt: now } });
    return { action: "remind", deadline: entry.deadline, status, entry };
  }

  const res = await goldService.liquidate(client, {
    userId,
    guildId,
    username: entry.username,
    member,
    units: status.overSellable,
    reason: "overcap_grace",
  });
  if (!res.ok) return { action: "failed", entry, reason: res.reason };

  await clearFlags(col, userId, guildId);
  return {
    action: "liquidated",
    entry,
    status,
    units: res.units,
    gain: res.gain,
    prices: res.prices,
    holding: res.holding,
    // 賣不掉的（鎖在定存）超額克數：定存到期領回時才會自動折現。
    lockedOver: status.overUnits - res.units,
  };
}

async function sweep(client, onResult) {
  if (graceCfg().enabled === false) return { skipped: "disabled" };
  const entries = await scan(client);
  const results = [];
  for (const entry of entries) {
    const res = await step(client, entry).catch((e) => {
      console.log(`[GOLD-CAP] ${entry.userId} 處理失敗：${e.message}`.red);
      return { action: "failed", entry, reason: "error" };
    });
    results.push(res);
    if (onResult && res.action !== "wait") {
      try {
        await onResult(res);
      } catch (e) {
        console.log(`[GOLD-CAP] ${entry.userId} 通知失敗：${e.message}`.yellow);
      }
    }
  }
  return { results, scanned: entries.length };
}

module.exports = { graceCfg, graceDays, scan, step, sweep };
