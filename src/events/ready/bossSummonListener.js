// 討伐能量：訂閱地下城事件，累積召喚能量 + 發放個人額外攻擊次數。
// 以 eventBus 訂閱方式接事件，不在 dungeonService 內互相寫死 hook。
const { boss } = require("../../config");
const bus = require("../../features/eventBus");
const bossSummon = require("../../features/boss/bossSummon");

module.exports = (client) => {
  if (!boss?.enabled || !boss?.summon?.enabled) return;

  bus.on("dungeon.cleared", (p) =>
    bossSummon.onDungeonCleared(client, p),
  );
  bus.on("dungeon.mini_boss_defeated", (p) =>
    bossSummon.onMiniBossDefeated(client, p),
  );
};
