// 所有 buff key 對應的中文顯示標籤與格式化方式。
// UI 一律走這裡查；嚴禁直接把 buff key 印到玩家看得到的訊息。

const BUFF_META = {
  mining_qty_bonus: { label: "挖礦額外產出", unit: "+{v} 個" },
  mining_luck_pct: { label: "挖礦幸運", unit: "+{vp}%" },
  mining_cooldown_pct: { label: "挖礦冷卻", unit: "-{v}%" },
  work_income_multiplier: { label: "打工金幣", unit: "×{vplus1}" },
  dungeon_stamina_max: { label: "地下城體力上限", unit: "+{v}" },
  dungeon_damage_pct: { label: "地下城傷害", unit: "+{v}%" },
  dungeon_legendary_drop_pct: { label: "地下城傳說掉率", unit: "+{v}%" },
  dungeon_def: { label: "地下城 DEF", unit: "+{v}" },
  dungeon_hp_max: { label: "地下城 HP 上限", unit: "+{v}" },
  crit_rate_pct: { label: "暴擊率", unit: "+{v}%" },
  boss_atk_pct: { label: "世界王攻擊", unit: "+{vp}%" },
  boss_damage_pct: { label: "世界王傷害", unit: "+{v}%" },
  boss_attack_limit_bonus: { label: "世界王每場攻擊次數", unit: "+{v}" },
  fishing_success_rate_pct: { label: "釣魚成功率", unit: "+{v}%" },
  farm_yield_count_bonus: { label: "農場額外產出", unit: "+{v} 個" },
  farm_yield_pct: { label: "農場收成", unit: "+{v}%" },
  ore_sell_price_pct: { label: "礦石賣價", unit: "+{v}%" },
  fish_sell_price_pct: { label: "魚類賣價", unit: "+{v}%" },
  work_income_pct: { label: "打工收入", unit: "+{v}%" },
  dungeon_coin_pct: { label: "地下城金幣", unit: "+{v}%" },
  xp_boost_pct: { label: "經驗值", unit: "+{v}%" },
};

const labelOf = (key) => BUFF_META[key]?.label || key;

// value 的單位語意：
//   - *_pct 整數百分比 → "+5%" / "-10%"
//   - mining_luck_pct / boss_atk_pct 是小數（0.05）→ 轉成 "+5%"
//   - work_income_multiplier 0.1 → "×1.1"
const formatValue = (key, value) => {
  const meta = BUFF_META[key];
  if (!meta) return String(value);
  return meta.unit
    .replace("{vp}", Math.round((value || 0) * 100))
    .replace("{vplus1}", (1 + (value || 0)).toFixed(2))
    .replace("{v}", value);
};

const formatBuff = (key, value) => `${labelOf(key)} ${formatValue(key, value)}`;

module.exports = { labelOf, formatValue, formatBuff, BUFF_META };
