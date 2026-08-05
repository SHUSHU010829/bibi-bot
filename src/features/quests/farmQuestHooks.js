// 一次收成要補登的任務鉤點。
//
// 兩條收成路徑（農場面板的 harvest / harvestall 按鈕、/收成 指令）共用同一份清單，
// 各自維護會漏任務——weekly_cd_farm（豐收季）就曾只掛在指令路徑上，
// 從面板按鈕收成的玩家永遠沒進度。
module.exports = function farmHarvestQuestHooks(result) {
  const hooks = [
    { questId: "daily_farm_harvest" },
    { questId: "weekly_farm_harvest" },
    { questId: "weekly_cd_farm" },
  ];
  if (result?.crop === "black_rose") {
    hooks.push({ questId: "weekly_farm_rose" });
  }
  return hooks;
};
