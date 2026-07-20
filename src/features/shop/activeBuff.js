// 取得使用者目前生效的 buff（xp_boost / coin_boost）。
// Buff 儲存在 userCoinsCollection.activeBuffs，型別：
// { type: "xp_boost"|"coin_boost", multiplier: number, expiresAt: Date, source: itemId }

async function getActiveBuffMultiplier(client, userId, guildId, type) {
  if (!client.userCoinsCollection) return 1;
  const doc = await client.userCoinsCollection
    .findOne({ userId, guildId }, { projection: { activeBuffs: 1 } })
    .catch(() => null);
  const buffs = doc?.activeBuffs || [];
  const now = Date.now();
  let best = 1;
  for (const b of buffs) {
    if (b?.type !== type) continue;
    const exp = b.expiresAt ? new Date(b.expiresAt).getTime() : 0;
    if (exp <= now) continue;
    if ((b.multiplier || 1) > best) best = b.multiplier;
  }
  return best;
}

// 發放 / 延長加成 buff。
// 規則：
//   - 同 type + 同倍率 → 時效內重買會「累積天數」：從現有到期時間（若已過期則從現在）往後延長。
//   - 不同倍率各自累積成獨立條目；效果判定（getActiveBuffMultiplier）永遠取當下有效的最高倍率。
//   - qty：一次買多瓶，時長 = durationMinutes × qty 一次加上去。
// 回傳延長 / 新建後的該條目（含累積後的 expiresAt），供購買訊息顯示生效時間。
async function addBuff(client, { userId, guildId, type, multiplier, durationMinutes, qty = 1, source }) {
  if (!client.userCoinsCollection) return null;
  const now = Date.now();
  const addMs = durationMinutes * 60 * 1000 * Math.max(1, Math.floor(qty) || 1);

  const doc = await client.userCoinsCollection
    .findOne({ userId, guildId }, { projection: { activeBuffs: 1 } })
    .catch(() => null);

  // 讀出現有 buff，順手清掉已過期的（避免陣列長期膨脹，也確保只跟「有效」條目累積）
  const buffs = (Array.isArray(doc?.activeBuffs) ? doc.activeBuffs : []).filter((b) => {
    const exp = b?.expiresAt ? new Date(b.expiresAt).getTime() : 0;
    return exp > now;
  });

  const idx = buffs.findIndex(
    (b) => b.type === type && (b.multiplier || 1) === multiplier,
  );
  let entry;
  if (idx >= 0) {
    const base = Math.max(now, new Date(buffs[idx].expiresAt).getTime());
    entry = { ...buffs[idx], expiresAt: new Date(base + addMs), source: source || buffs[idx].source || null };
    buffs[idx] = entry;
  } else {
    entry = { type, multiplier, expiresAt: new Date(now + addMs), source: source || null };
    buffs.push(entry);
  }

  await client.userCoinsCollection.updateOne(
    { userId, guildId },
    {
      $set: { activeBuffs: buffs, updatedAt: new Date() },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
    },
    { upsert: true },
  );
  return entry;
}

module.exports = { getActiveBuffMultiplier, addBuff };
