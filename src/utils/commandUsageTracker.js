require("colors");

// 指令使用量追蹤：記憶體計數 + 定時 flush 到 MongoDB。
// 設計目標是「最低 DB 負擔」：每次指令呼叫只動記憶體，
// 每 10 分鐘把所有 commandName -> count 用 bulkWrite($inc) 一次寫進
// commandStats collection（27 個指令最多 27 次 upsert / 10 min）。

const counts = new Map();
const lastUsedAt = new Map();

function recordUsage(name) {
  if (!name) return;
  counts.set(name, (counts.get(name) || 0) + 1);
  lastUsedAt.set(name, new Date());
}

async function flush(client) {
  if (!client?.commandStatsCollection) return { flushed: 0, total: 0 };
  if (counts.size === 0) return { flushed: 0, total: 0 };

  const snapshot = Array.from(counts.entries());
  const snapshotTimes = new Map(lastUsedAt);
  const total = snapshot.reduce((s, [, c]) => s + c, 0);
  counts.clear();
  lastUsedAt.clear();

  const now = new Date();
  const ops = snapshot.map(([name, count]) => ({
    updateOne: {
      filter: { name },
      update: {
        $inc: { count },
        $set: { lastUsedAt: snapshotTimes.get(name) || now },
        $setOnInsert: { firstUsedAt: now },
      },
      upsert: true,
    },
  }));

  try {
    await client.commandStatsCollection.bulkWrite(ops, { ordered: false });
    return { flushed: snapshot.length, total };
  } catch (err) {
    for (const [name, count] of snapshot) {
      counts.set(name, (counts.get(name) || 0) + count);
      const t = snapshotTimes.get(name);
      if (t && (!lastUsedAt.get(name) || lastUsedAt.get(name) < t)) {
        lastUsedAt.set(name, t);
      }
    }
    throw err;
  }
}

function pendingSize() {
  return counts.size;
}

module.exports = { recordUsage, flush, pendingSize };
