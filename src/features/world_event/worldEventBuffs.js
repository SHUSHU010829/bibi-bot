// 取目前 state="buffing" 的世界事件，把 rewards.buffs 疊加成一個 buff map。
// 給 buffResolver 引用以套用到全服所有玩家。
// 設計：每分鐘 schedulerjs 會檢查 ends_at 過期事件並轉成 state="ended"，
// 所以這裡直接讀 DB 即可，沒有額外快取需求。

const { worldEvents } = require("../../config");

const getActiveBuffs = async (client) => {
  if (!worldEvents?.enabled) return {};
  if (!client?.worldEventsCollection) return {};
  const docs = await client.worldEventsCollection
    .find({ state: "buffing" })
    .toArray()
    .catch(() => []);
  const out = {};
  const now = Date.now();
  for (const d of docs) {
    if (d.ends_at && new Date(d.ends_at).getTime() < now) continue;
    const buffs = d.rewards?.buffs || {};
    for (const [k, v] of Object.entries(buffs)) {
      out[k] = (out[k] || 0) + (v || 0);
    }
  }
  return out;
};

// 純讀 cache 的同步版本。在 hot path（每次挖礦 / 釣魚 / 收成）使用。
// scheduler 每分鐘 refresh。
let _cache = { buffs: {}, list: [], at: 0 };
const refreshCache = async (client) => {
  const docs = client?.worldEventsCollection
    ? await client.worldEventsCollection
        .find({ state: "buffing" })
        .toArray()
        .catch(() => [])
    : [];
  const out = {};
  const list = [];
  const now = Date.now();
  for (const d of docs) {
    if (d.ends_at && new Date(d.ends_at).getTime() < now) continue;
    const buffs = d.rewards?.buffs || {};
    for (const [k, v] of Object.entries(buffs)) {
      out[k] = (out[k] || 0) + (v || 0);
    }
    list.push({ event_id: d.event_id, ends_at: d.ends_at, buffs });
  }
  _cache = { buffs: out, list, at: Date.now() };
  return _cache;
};
const getCachedBuffs = () => _cache.buffs;
const getCachedList = () => _cache.list;

module.exports = { getActiveBuffs, refreshCache, getCachedBuffs, getCachedList };
