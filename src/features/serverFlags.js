require("colors");

// 全服永久旗標（例：主線活動達標後開放深層礦脈）。
// 不用 buff 存是因為 buff 會過期，旗標一旦寫入就永久生效。
// ServerFlags 的 (guildId, key) 是 unique index。

async function isSet(client, guildId, key) {
  if (!client?.serverFlagsCollection) return false;
  const doc = await client.serverFlagsCollection
    .findOne({ guildId, key })
    .catch(() => null);
  return !!doc?.value;
}

// 一次取回整個伺服器已開啟的旗標，供 config 的 requiresFlag 過濾用。
async function allSet(client, guildId) {
  if (!client?.serverFlagsCollection) return {};
  const docs = await client.serverFlagsCollection
    .find({ guildId, value: true })
    .toArray()
    .catch(() => []);
  return Object.fromEntries(docs.map((d) => [d.key, true]));
}

async function set(client, guildId, key) {
  if (!client?.serverFlagsCollection) return { ok: false, reason: "disabled" };
  await client.serverFlagsCollection.updateOne(
    { guildId, key },
    { $set: { value: true, unlocked_at: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}

module.exports = { isSet, allSet, set };
