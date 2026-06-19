// Phase H+ 多回合 HP 戰鬥引擎（純函式）
//
// 設計原則：
// - 完全純函式：不碰 DB、不發 event；輸入「玩家+怪物+選項」，輸出「戰鬥日誌+結算狀態」。
//   呼叫端（dungeonService）負責持久化、發 event、發禮物。
// - v1 開放：HP/DEF/暴擊、盾的「格擋」、狀態效果（中毒/暈眩/護甲/燃燒/麻痺）、寵物協戰。
// - v2 預留 hook：盾反射（reflectRate）、異常抗性（statusImmunity）— 戰鬥引擎內已實作，
//   只要 config 把對應數值打開就會生效。
//
// 戰鬥日誌格式（每回合一個物件，呈現層自行 format）：
// { turn, type: 'player_attack' | 'monster_attack' | 'status_tick' | 'pet_assist' | 'note',
//   actor, target, damage, crit, blocked, reflected, hp_after, shield_after, note }

const { dungeon } = require("../../config");

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function randInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

// 受擊後實際扣血：套用 DEF、護甲狀態、格擋
function resolveIncomingDamage(rawDamage, ctx, log) {
  const { player } = ctx;
  let dmg = rawDamage;
  let blocked = false;
  let blockedShield = 0;
  let reflected = 0;

  // 1) 護甲狀態：先削減 50%（v1 規格 statusEffects.armor.damageReductionPct = 0.5）
  if (player.status.armor?.turns > 0) {
    const reduction = dungeon?.statusEffects?.armor?.damageReductionPct ?? 0.5;
    dmg = Math.floor(dmg * (1 - reduction));
  }

  // 公會鐵匠鋪 Lv.5：盾扣耐前骰省耐機率。
  const savePct = player.combatDurabilitySavePct || 0;
  const rollSave = () => savePct > 0 && Math.random() < savePct / 100;

  // 2) 格擋判定：受擊「前」判定（盾未壞才有資格）
  const shieldOk = player.shieldDef.blockRate > 0
    && player.shield_durability > 0
    && player.shield_capUsed < player.shield_cap;
  if (shieldOk && Math.random() < player.shieldDef.blockRate) {
    blocked = true;
    dmg = Math.floor(dmg * 0.5);
    if (!rollSave()) {
      player.shield_durability -= 1;
      player.shield_capUsed += 1;
    }
    blockedShield = player.shield_durability;
  }

  // 3) DEF 減傷：weapon.def + shield.def + foodBuff + petBuff
  dmg = Math.max(1, dmg - player.def);

  // 4) v2 反射 hook：受擊後判定，命中 → 對怪物造成 受傷害 ÷ 3 反彈傷害
  if (player.shieldDef.reflectRate > 0
      && player.shield_durability > 0
      && player.shield_capUsed < player.shield_cap
      && Math.random() < player.shieldDef.reflectRate) {
    reflected = Math.floor(dmg / 3);
    if (reflected > 0) {
      ctx.monster.hp = Math.max(0, ctx.monster.hp - reflected);
      if (!rollSave()) {
        player.shield_durability -= 1;
        player.shield_capUsed += 1;
      }
      log.push({
        turn: ctx.turn,
        type: "shield_reflect",
        damage: reflected,
        target: "monster",
        hp_after: ctx.monster.hp,
        shield_after: player.shield_durability,
      });
    }
  }

  return { dmg, blocked, blockedShield, reflected };
}

// 嘗試在玩家身上施加狀態：v2 異常抗性（盾的 statusImmunity）會擋掉。
function applyStatusToPlayer(player, statusKey, log, turn) {
  if (statusKey === "armor") {
    // 護甲是玩家方 buff（來自隱士庇護等），這裡保留 hook
    const def = dungeon?.statusEffects?.armor || {};
    player.status.armor = { turns: def.turns || 2 };
    return true;
  }
  const immunity = player.shieldDef?.statusImmunity || [];
  if (immunity.includes(statusKey)) {
    log.push({
      turn,
      type: "status_immunity",
      status: statusKey,
      note: `${dungeon?.shields?.[player.shield]?.name || "盾"}光輝抵擋了${dungeon?.statusEffects?.[statusKey]?.name || statusKey}！`,
    });
    return false;
  }
  const def = dungeon?.statusEffects?.[statusKey] || {};
  if (statusKey === "stun") {
    player.status.stun = { skipTurns: def.skipTurns || 1 };
  } else if (statusKey === "poison" || statusKey === "burn") {
    // 同狀態 refresh = 重置為新時長（不疊加）
    player.status[statusKey] = { turns: def.turns || 2 };
  } else if (statusKey === "paralyze") {
    player.status.paralyze = { turns: def.turns || 3 };
  }
  log.push({
    turn,
    type: "status_apply",
    target: "player",
    status: statusKey,
    note: `你陷入${def.name || statusKey}（${player.status[statusKey]?.turns || def.skipTurns || 1} 回合）`,
  });
  return true;
}

// 玩家狀態 tick：扣中毒/燃燒、倒數
function tickPlayerStatus(player, log, turn) {
  // 中毒：扣 HP_max 的 5%
  if (player.status.poison?.turns > 0) {
    const def = dungeon?.statusEffects?.poison || {};
    const tick = Math.max(1, Math.floor(player.hp_max * (def.tickPct ?? 0.05)));
    player.hp_current = Math.max(0, player.hp_current - tick);
    player.status.poison.turns -= 1;
    log.push({
      turn,
      type: "status_tick",
      status: "poison",
      damage: tick,
      hp_after: player.hp_current,
    });
    if (player.status.poison.turns <= 0) delete player.status.poison;
  }
  // 燃燒：扣固定 8
  if (player.status.burn?.turns > 0) {
    const def = dungeon?.statusEffects?.burn || {};
    const tick = def.tickFlat ?? 8;
    player.hp_current = Math.max(0, player.hp_current - tick);
    player.status.burn.turns -= 1;
    log.push({
      turn,
      type: "status_tick",
      status: "burn",
      damage: tick,
      hp_after: player.hp_current,
    });
    if (player.status.burn.turns <= 0) delete player.status.burn;
  }
  // 護甲倒數
  if (player.status.armor?.turns > 0) {
    player.status.armor.turns -= 1;
    if (player.status.armor.turns <= 0) delete player.status.armor;
  }
  // 麻痺倒數
  if (player.status.paralyze?.turns > 0) {
    player.status.paralyze.turns -= 1;
    if (player.status.paralyze.turns <= 0) delete player.status.paralyze;
  }
  // 暈眩 1 回合即消（resolveAction 用過就清）
  delete player.status.stun;
}

// 怪物技能判定：每回合攻擊後依 skills[] 決定是否施加狀態
function rollMonsterSkill(monster) {
  const skills = monster.skills || [];
  if (!skills.length) return null;
  // 30% 機率觸發其中一個（簡化）
  if (Math.random() > 0.3) return null;
  return skills[Math.floor(Math.random() * skills.length)];
}

// 寵物協戰：依類型決定行為
function rollPetAssist(petType, ctx, log, turn) {
  if (!petType || petType === "none") return null;
  const cfg = dungeon?.petAssist?.[petType];
  if (!cfg?.triggerChance) return null;
  if (Math.random() >= cfg.triggerChance) return null;

  if (petType === "combat") {
    const dmg = Math.floor(ctx.player.atk * (cfg.extraDamagePct || 0.5));
    ctx.monster.hp = Math.max(0, ctx.monster.hp - dmg);
    log.push({
      turn,
      type: "pet_assist",
      kind: "combat",
      damage: dmg,
      target: "monster",
      hp_after: ctx.monster.hp,
    });
    return { kind: "combat", damage: dmg };
  }
  if (petType === "healer") {
    const heal = randInt(cfg.healMin || 5, cfg.healMax || 10);
    ctx.player.hp_current = Math.min(ctx.player.hp_max, ctx.player.hp_current + heal);
    log.push({
      turn,
      type: "pet_assist",
      kind: "healer",
      heal,
      hp_after: ctx.player.hp_current,
    });
    return { kind: "healer", heal };
  }
  return null;
}

// 重傷 debuff：HP < 20% 時 ATK ×0.8、暴擊率 ×0.5
function woundedMultipliers(player) {
  const ratio = player.hp_current / player.hp_max;
  const criticalRatio = dungeon?.hp?.criticalHpRatio ?? 0.2;
  if (ratio < criticalRatio) {
    return { atkMult: 0.8, critMult: 0.5, wounded: true };
  }
  return { atkMult: 1.0, critMult: 1.0, wounded: false };
}

// 自動藥水判定：HP ≤ 30% 時觸發。
// 依玩家偏好 (player.autoPotion / player.potionTier) 決定是否吃 / 吃哪瓶。
// potionTier:
//   - "smallest"（預設）：依小→中→大，先用最小可用瓶（最省）
//   - "largest"          ：依大→中→小，優先大瓶救急
//   - "small"/"medium"/"large"：只吃指定瓶
function tryAutoPotion(player, log, turn) {
  if (player.autoPotion === false) return false;
  const trigger = dungeon?.hp?.autoPotionTriggerRatio ?? 0.3;
  if (player.hp_current / player.hp_max > trigger) return false;
  const pref = player.potionTier || "smallest";
  let order;
  if (pref === "largest") order = ["large", "medium", "small"];
  else if (pref === "small" || pref === "medium" || pref === "large") order = [pref];
  else order = ["small", "medium", "large"]; // smallest（預設）
  for (const tier of order) {
    if ((player.potions[tier] || 0) > 0) {
      const def = dungeon?.hpPotions?.[tier];
      const restore = def?.restore || 20;
      const before = player.hp_current;
      player.hp_current = Math.min(player.hp_max, player.hp_current + restore);
      player.potions[tier] -= 1;
      log.push({
        turn,
        type: "potion_auto",
        tier,
        heal: player.hp_current - before,
        hp_after: player.hp_current,
      });
      return true;
    }
  }
  return false;
}

/**
 * 模擬一場戰鬥（後端跑完整場）。
 *
 * @param {Object} opts
 * @param {Object} opts.player     — { atk, def, critRate, hp_max, hp_current, weapon, shield, shield_durability,
 *                                      potions: { small, medium, large }, petType }
 * @param {Object} opts.monster    — { id, name, emoji, hp, atk, skills?, def? }
 * @param {Object} [opts.miniBoss] — { phase2HpRatio, phase2AtkMult, armorTurns, paralyzeChance }
 * @returns {{
 *   result: 'win' | 'lose' | 'draw',
 *   turns: number,
 *   log: Array,
 *   playerEnd: { hp_current, shield_durability, potions, status },
 *   monsterEnd: { hp, name },
 *   damageDealt: number,
 *   damageTaken: number,
 *   shieldBreaks: number,    // 戰鬥中觸發格擋次數
 *   reflectHits: number,
 *   critCount: number,
 *   blockCount: number,
 * }}
 */
function simulate({ player, monster, miniBoss = null }) {
  // 防呆：deep clone 輸入以免污染呼叫端
  const p = {
    ...player,
    status: {},
    potions: { ...(player.potions || { small: 0, medium: 0, large: 0 }) },
    shieldDef: dungeon?.shields?.[player.shield] || { def: 0, blockRate: 0, reflectRate: 0, statusImmunity: [] },
    shield_capUsed: 0,
    shield_cap: miniBoss
      ? (dungeon?.shieldDurability?.maxConsumePerMiniBoss ?? 8)
      : (dungeon?.shieldDurability?.maxConsumePerBattle ?? 5),
    combatDurabilitySavePct: player.combatDurabilitySavePct || 0,
  };
  const m = { ...monster, hp_max: monster.hp };
  const log = [];

  const maxTurns = dungeon?.maxBattleTurns ?? 20;
  let damageDealt = 0;
  let damageTaken = 0;
  let critCount = 0;
  let blockCount = 0;
  let reflectHits = 0;
  let phase2Triggered = false;
  let armorTurnsLeft = miniBoss?.armorTurns || 0;

  // 盾破損提示（一次）
  if (p.shield && p.shield_durability <= 0) {
    log.push({ turn: 0, type: "note", note: "⚠️ 你的盾已破損，無法格擋！" });
  }

  let turn = 0;
  for (turn = 1; turn <= maxTurns; turn += 1) {
    if (p.hp_current <= 0 || m.hp <= 0) break;
    const ctx = { turn, player: p, monster: m };

    // -- 1) 玩家攻擊（除非暈眩跳過）
    if (p.status.stun?.skipTurns > 0) {
      log.push({ turn, type: "player_stunned" });
      p.status.stun.skipTurns -= 1;
    } else {
      const wounded = woundedMultipliers(p);
      const critRate = p.critRate * wounded.critMult;
      const crit = Math.random() < critRate;
      // 暴擊穿透護甲 50%（spec：暴擊與狀態互動）
      let pAtk = p.atk * wounded.atkMult;
      if (crit) pAtk *= 1.5;
      let dmg = Math.max(1, Math.floor(pAtk) - (m.def || 0));

      // mini-BOSS 永眠守衛護甲 3 回合內無法打破
      if (miniBoss && armorTurnsLeft > 0) {
        dmg = crit ? Math.floor(dmg * 0.5) : 1;
        armorTurnsLeft -= 1;
      }

      m.hp = Math.max(0, m.hp - dmg);
      damageDealt += dmg;
      if (crit) critCount += 1;

      log.push({
        turn,
        type: "player_attack",
        damage: dmg,
        crit,
        wounded: wounded.wounded || undefined,
        hp_after: m.hp,
      });

      // mini-BOSS Phase 2：HP 跨過 phase2HpRatio 觸發攻擊力倍率
      if (miniBoss?.phase2HpRatio && !phase2Triggered) {
        if (m.hp / m.hp_max <= miniBoss.phase2HpRatio) {
          m.atk = Math.floor(m.atk * (miniBoss.phase2AtkMult || 2));
          phase2Triggered = true;
          log.push({
            turn,
            type: "note",
            note: `⚠️ ${m.name} 進入第二階段！攻擊力大幅提升`,
          });
        }
      }
    }

    // -- 2) 寵物協戰（玩家攻擊後、怪物攻擊前）
    rollPetAssist(p.petType, ctx, log, turn);

    if (m.hp <= 0) break;

    // -- 3) 怪物攻擊
    const monsterRawDamage = Math.max(1, m.atk + randInt(-2, 2));
    const dmgInfo = resolveIncomingDamage(monsterRawDamage, ctx, log);
    p.hp_current = Math.max(0, p.hp_current - dmgInfo.dmg);
    damageTaken += dmgInfo.dmg;
    if (dmgInfo.blocked) blockCount += 1;
    if (dmgInfo.reflected) reflectHits += 1;

    log.push({
      turn,
      type: "monster_attack",
      raw_damage: monsterRawDamage,
      damage: dmgInfo.dmg,
      blocked: dmgInfo.blocked || undefined,
      hp_after: p.hp_current,
      shield_after: p.shield_durability,
    });

    // -- 4) 怪物技能（中毒 / 燃燒 / 暈眩 / 麻痺）
    const skill = rollMonsterSkill(m);
    if (skill) applyStatusToPlayer(p, skill, log, turn);

    // mini-BOSS 冰晶女王：每回合 30% 機率麻痺玩家
    if (miniBoss?.paralyzeChance && Math.random() < miniBoss.paralyzeChance) {
      applyStatusToPlayer(p, "paralyze", log, turn);
    }

    // H4：怪物攻擊後立刻試藥水（HP ≤ 30% 時自動觸發，避免下一回合大傷直接送命）
    tryAutoPotion(p, log, turn);

    if (p.hp_current <= 0) break;

    // -- 5) 玩家狀態 tick（中毒、燃燒、護甲倒數）
    tickPlayerStatus(p, log, turn);

    // H4：tick 致命前再試一次藥水（中毒 / 燃燒 tick 可能把已低 HP 玩家直接打到 0）
    tryAutoPotion(p, log, turn);

    if (p.hp_current <= 0) break;
  }

  let result;
  if (m.hp <= 0 && p.hp_current > 0) result = "win";
  else if (p.hp_current <= 0) result = "lose";
  else result = "draw"; // 20 回合上限 → draw 視同失敗

  return {
    result,
    turns: turn > maxTurns ? maxTurns : turn,
    log,
    playerEnd: {
      hp_current: p.hp_current,
      shield_durability: p.shield_durability,
      potions: p.potions,
      status: p.status,
    },
    monsterEnd: { hp: m.hp, name: m.name, hp_max: m.hp_max },
    damageDealt,
    damageTaken,
    shieldBreaks: blockCount + reflectHits,
    reflectHits,
    critCount,
    blockCount,
  };
}

module.exports = {
  simulate,
  // exposed for unit tests / future hooks
  resolveIncomingDamage,
  applyStatusToPlayer,
  tickPlayerStatus,
  rollMonsterSkill,
  rollPetAssist,
  woundedMultipliers,
  tryAutoPotion,
};
