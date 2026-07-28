// 一場地下城探索要補登的任務鉤點。
//
// 兩條探索路徑（HP 面板的 raid 按鈕、舊版 /地下城 executeDungeon）共用同一份清單，
// 各自維護會漏任務——daily_cd_dungeon 就曾只掛在舊路徑上而永遠沒進度。
module.exports = function dungeonQuestHooks(result) {
  const hooks = [
    { questId: "daily_dungeon_10" },
    { questId: "weekly_dungeon" },
    { questId: "daily_cd_dungeon" },
  ];
  if (result?.won) {
    hooks.push({ questId: "daily_dungeon_win" });
    hooks.push({ questId: "weekly_dungeon_win" });
    if (result.floor >= 3) hooks.push({ questId: "daily_dungeon_floor3" });
    if (result.isMiniBoss) hooks.push({ questId: "weekly_mini_boss" });
    if (result.theme === "ice") hooks.push({ questId: "weekly_dungeon_ice" });
  }
  return hooks;
};
