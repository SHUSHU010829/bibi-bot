// Phase H+ 樓層 / 副本主題解鎖檢查與查詢
//
// 純函式（不碰 DB）：輸入「玩家 profile + level」+ config，輸出「可以走哪些主題 / 樓層 / 為什麼鎖」。
// 命令層用這個產 select menu，戰鬥前用 isFloorUnlocked() 二次驗證。

const { dungeon } = require("../../config");

function clearsFor(profile, theme, floor) {
  return profile?.floor_unlocks?.[theme]?.clears?.[String(floor)] || 0;
}

function maxFloorFor(profile, theme) {
  return profile?.floor_unlocks?.[theme]?.max_floor || 0;
}

function themeUnlockState(profile, level, themeId) {
  const t = (dungeon?.themes || []).find((x) => x.id === themeId);
  if (!t) return { unlocked: false, reason: "unknown_theme" };
  if (!t.unlock) return { unlocked: true, theme: t };

  const need = t.unlock;
  const playerLevel = level || 0;
  if (playerLevel < (need.level || 0)) {
    return {
      unlocked: false,
      reason: "level",
      theme: t,
      requirement: need,
      progress: { level: playerLevel },
    };
  }
  if (need.prereqFloor) {
    for (const [preTheme, preFloor] of Object.entries(need.prereqFloor)) {
      const cleared = clearsFor(profile, preTheme, preFloor);
      if (cleared < (need.prereqClears || 0)) {
        return {
          unlocked: false,
          reason: "prereq_clears",
          theme: t,
          requirement: need,
          progress: { preTheme, preFloor, cleared },
        };
      }
    }
  }
  return { unlocked: true, theme: t };
}

function listThemes(profile, level) {
  return (dungeon?.themes || []).map((t) => themeUnlockState(profile, level, t.id));
}

function floorUnlockState(profile, level, themeId, floorNum) {
  const themeState = themeUnlockState(profile, level, themeId);
  if (!themeState.unlocked) {
    return { unlocked: false, reason: "theme_locked", themeState };
  }
  const f = (dungeon?.floors || []).find((x) => x.floor === floorNum);
  if (!f) return { unlocked: false, reason: "unknown_floor" };

  const playerLevel = level || 0;
  if (playerLevel < (f.unlockLevel || 0)) {
    return {
      unlocked: false,
      reason: "level",
      floor: f,
      requirement: { level: f.unlockLevel },
      progress: { level: playerLevel },
    };
  }
  if (f.prereqClears) {
    const need = f.prereqClears;
    const cleared = clearsFor(profile, themeId, need.floor);
    if (cleared < (need.count || 0)) {
      return {
        unlocked: false,
        reason: "prereq_clears",
        floor: f,
        requirement: need,
        progress: { theme: themeId, floor: need.floor, cleared },
      };
    }
  }
  return { unlocked: true, floor: f };
}

function listFloors(profile, level, themeId) {
  return (dungeon?.floors || []).map((f) =>
    floorUnlockState(profile, level, themeId, f.floor),
  );
}

function miniBossUnlockState(profile, level, themeId) {
  const f5 = (dungeon?.floors || []).find((x) => x.floor === 5);
  if (!f5?.miniBossUnlock) return { unlocked: false, reason: "not_configured" };
  // mini-BOSS 必須先解鎖 5F 本身
  const f5State = floorUnlockState(profile, level, themeId, 5);
  if (!f5State.unlocked) {
    return { unlocked: false, reason: "floor_locked", floorState: f5State };
  }
  const need = f5.miniBossUnlock;
  const cleared = clearsFor(profile, themeId, need.floor);
  if (cleared < (need.clears || 0)) {
    return {
      unlocked: false,
      reason: "prereq_clears",
      requirement: need,
      progress: { theme: themeId, floor: need.floor, cleared },
    };
  }
  const def = dungeon?.miniBosses?.[themeId];
  if (!def) return { unlocked: false, reason: "not_configured" };
  return { unlocked: true, miniBoss: def };
}

// 戰鬥成功後呼叫：把 floor_unlocks 推進。回傳要寫到 $inc / $set 的 mongo update fragments。
// - clears[theme][floor] += 1
// - 如果該樓層通關數達到下一樓的 prereqClears，把 max_floor 抬高（並 emit floor_unlocked event）
function buildClearedUpdate(profile, themeId, floorNum) {
  const inc = {};
  const set = {};
  const events = [];

  inc[`floor_unlocks.${themeId}.clears.${floorNum}`] = 1;

  const currentMax = maxFloorFor(profile, themeId);
  const beforeCleared = clearsFor(profile, themeId, floorNum);
  const afterCleared = beforeCleared + 1;

  // 看看下一樓需要多少通關次數
  const nextFloor = (dungeon?.floors || []).find((f) => f.floor === floorNum + 1);
  if (nextFloor?.prereqClears?.floor === floorNum) {
    if (
      afterCleared >= (nextFloor.prereqClears.count || 0) &&
      currentMax < nextFloor.floor
    ) {
      set[`floor_unlocks.${themeId}.max_floor`] = nextFloor.floor;
      events.push({ type: "floor_unlocked", theme: themeId, floor: nextFloor.floor });
    }
  }
  return { inc, set, events };
}

module.exports = {
  themeUnlockState,
  listThemes,
  floorUnlockState,
  listFloors,
  miniBossUnlockState,
  buildClearedUpdate,
  clearsFor,
  maxFloorFor,
};
