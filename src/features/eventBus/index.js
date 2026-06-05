require("colors");

// 極輕量跨系統事件匯流排。新玩法（圖鑑 / 寵物 / 賽季通行證…）以訂閱方式接事件，
// 不在各 service 裡互相寫死 hook。
//
// 設計合約：
// - 同步呼叫；emit 不 await。listener 拋錯由 bus 吞掉，不影響呼叫端主流程。
// - listener 回傳 Promise 也接受，但 bus 不等；listener 自負錯誤處理。
// - emit 只在「DB 寫入完成、結果已確定」之後呼叫，subscriber 讀到的狀態才一致。
//
// 標準事件與 payload：
//   coin.delta       { userId, guildId, delta, source, meta }
//   item.gained      { userId, guildId, itemType, itemId, qty, source }
//   item.consumed    { userId, guildId, itemType, itemId, qty, sink }
//   mine.done        { userId, guildId, ore, qty, mineCountTotal }
//   fish.done        { userId, guildId, caught, fish?, location, fishCountTotal }
//   harvest.done     { userId, guildId, crop, coins, plotIndex }
//   boss.attacked    { userId, guildId, bossId, damage, isCounter, phaseAfter }
//   boss.killed      { userId, guildId, bossId }
//   dungeon.cleared  { userId, guildId, won, monster, dungeonCount }

const handlers = new Map();

function on(event, fn) {
  if (typeof fn !== "function") return () => {};
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => off(event, fn);
}

function off(event, fn) {
  handlers.get(event)?.delete(fn);
}

function emit(event, payload) {
  const set = handlers.get(event);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      const r = fn(payload);
      if (r && typeof r.catch === "function") {
        r.catch((e) =>
          console.log(`[eventBus] async listener ${event} rejected: ${e}`.red)
        );
      }
    } catch (e) {
      console.log(`[eventBus] listener ${event} threw: ${e}`.red);
    }
  }
}

function listenerCount(event) {
  return handlers.get(event)?.size || 0;
}

module.exports = { on, off, emit, listenerCount };
