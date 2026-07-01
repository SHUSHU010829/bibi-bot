// 地下城「選擇事件」：戰後有機率出現一個帶選項的事件，玩家點選後才擲骰結算。
//
// 與 encounterService（自動結算的突發事件）互補：這裡的事件先給選項按鈕，
// 玩家做選擇 → 該選項底下依 weight 擲一個 outcome → 才套用效果。
// 例：神秘藥水 → 喝下（可能中毒扣血 / 可能回滿體力）或 收起來變賣（穩拿金幣）。
//
// 設計原則：
// - 純 config 驅動（dungeon.choiceEvents）。事件 / 選項 / 各 outcome 的機率與效果都寫在 config。
// - outcome 在「按下選項」的當下才擲（handler 呼叫 resolveOption），不預先決定、不外洩給前端。
// - 效果套用只碰 miningProfiles + 金幣，狀態（體力 / HP 上限）由呼叫端帶入的 status 提供，
//   避免和 dungeonService 互相 require 形成循環。

require("colors");
const { dungeon } = require("../../config");
const { weightedRandom } = require("./../mining/weightedRandom");
const grantCoins = require("../economy/grantCoins");
const { getOrCreate } = require("../mining/miningProfile");
const { COIN_EMOJI } = require("../../constants/coin");

function cfg() {
  return dungeon?.choiceEvents || {};
}

function randInt(min, max) {
  const lo = Math.ceil(min ?? 0);
  const hi = Math.floor(max ?? lo);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function getEvent(id) {
  return (cfg().events || []).find((e) => e.id === id) || null;
}

// 戰後嘗試抽一個選擇事件。gate（機率）由呼叫端決定要不要呼叫；這裡只負責加權挑一個。
// 回傳「給前端顯示用」的精簡結構（不含 outcomes，避免洩漏機率）。
function pickChoiceEvent() {
  const events = cfg().events || [];
  if (!events.length) return null;
  const weights = {};
  for (const e of events) weights[e.id] = e.weight || 1;
  const id = weightedRandom(weights);
  const ev = events.find((e) => e.id === id);
  if (!ev) return null;
  return {
    id: ev.id,
    emoji: ev.emoji || "❓",
    name: ev.name,
    text: ev.text || "",
    options: (ev.options || []).map((o) => ({ id: o.id, label: o.label, emoji: o.emoji || "" })),
  };
}

// 依 weight 從某選項的 outcomes 擲一個。
function rollOutcome(option) {
  const outs = option?.outcomes || [];
  if (!outs.length) return null;
  const weights = {};
  outs.forEach((o, i) => { weights[String(i)] = o.weight || 1; });
  const idx = parseInt(weightedRandom(weights), 10);
  return outs[Number.isFinite(idx) ? idx : 0] || outs[0];
}

// 套用一個 outcome 的效果。status 需含 { stamina, staminaMax, hp, hpMax, profile }。
// 回傳結算摘要行（給結果面板顯示）。
async function applyEffect(client, { userId, guildId, member, username }, eff, status) {
  const coll = client.miningProfilesCollection;
  const lines = [];
  const type = eff?.type || "nothing";

  if (type === "bonus_coins") {
    const amount = randInt(eff.min, eff.max);
    if (amount > 0) {
      await grantCoins(client, { userId, guildId, username, amount, source: "encounter", member, meta: { choice: true } });
      lines.push(`💰 +${amount.toLocaleString()} ${COIN_EMOJI}`);
    }
    return lines;
  }

  if (type === "lose_coins") {
    const amount = randInt(eff.min, eff.max);
    if (amount > 0) {
      await grantCoins(client, { userId, guildId, username, amount: -amount, source: "admin", member, meta: { choice: true, loss: true } });
      lines.push(`💸 -${amount.toLocaleString()} ${COIN_EMOJI}`);
    }
    return lines;
  }

  if (type === "restore_full_stamina" || type === "restore_stamina" || type === "lose_stamina") {
    const max = status.staminaMax ?? (dungeon?.staminaMax ?? 12);
    const cur = typeof status.stamina === "number" ? status.stamina : max;
    let next;
    if (type === "restore_full_stamina") next = max;
    else if (type === "restore_stamina") next = clamp(cur + (eff.amount || 1), 0, max);
    else next = clamp(cur - (eff.amount || 1), 0, max);
    const set = { stamina: next, updatedAt: new Date() };
    if (next >= max) set.stamina_updated_at = 0;
    else if (cur >= max) set.stamina_updated_at = Date.now();
    await coll.updateOne({ userId, guildId }, { $set: set });
    const diff = next - cur;
    lines.push(`🔋 體力 ${diff >= 0 ? "+" : ""}${diff}（${next}/${max}）`);
    return lines;
  }

  if (type === "restore_hp_full" || type === "restore_hp_pct" || type === "lose_hp_pct") {
    const hpMax = status.hpMax || 100;
    const profile = status.profile || (await getOrCreate(client, userId, guildId));
    const cur = typeof status.hp === "number" ? status.hp : (profile.hp_current ?? hpMax);
    let next;
    if (type === "restore_hp_full") next = hpMax;
    else if (type === "restore_hp_pct") next = clamp(cur + Math.ceil(hpMax * (eff.pct || 0.3)), 0, hpMax);
    else next = clamp(cur - Math.ceil(hpMax * (eff.pct || 0.3)), 0, hpMax);
    await coll.updateOne(
      { userId, guildId },
      { $set: { hp_current: next, hp_updated_at: next >= hpMax ? 0 : Date.now(), updatedAt: new Date() } },
    );
    const diff = next - cur;
    lines.push(`❤️ HP ${diff >= 0 ? "+" : ""}${diff}（${next}/${hpMax}）`);
    return lines;
  }

  if (type === "gift_hp_potion") {
    const tier = ["small", "medium", "large"].includes(eff.tier) ? eff.tier : "small";
    const field = `hp_potion_${tier}`;
    const qty = Math.max(1, eff.qty || 1);
    await coll.updateOne({ userId, guildId }, { $inc: { [field]: qty }, $set: { updatedAt: new Date() } });
    const name = dungeon?.hpPotions?.[tier]?.name || `生命藥水（${tier}）`;
    lines.push(`💊 ${name} ×${qty}`);
    return lines;
  }

  if (type === "gift_stamina_potion") {
    const tier = ["small", "medium", "large"].includes(eff.tier) ? eff.tier : "small";
    const field = tier === "small" ? "stamina_potion_count" : `stamina_potion_${tier}_count`;
    const qty = Math.max(1, eff.qty || 1);
    await coll.updateOne({ userId, guildId }, { $inc: { [field]: qty }, $set: { updatedAt: new Date() } });
    lines.push(`🥤 體力藥水（${{ small: "小", medium: "中", large: "大" }[tier]}）×${qty}`);
    return lines;
  }

  // nothing
  return lines;
}

// 玩家點了某事件的某選項 → 擲 outcome、套效果、回傳結算。
// status：呼叫端（handler）先用 getDungeonStatus 取得，帶入避免循環 require。
async function resolveOption(client, { userId, guildId, member, username, eventId, optionId, status }) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };
  if (!client?.miningProfilesCollection) return { ok: false, reason: "disabled" };
  const event = getEvent(eventId);
  if (!event) return { ok: false, reason: "unknown_event" };
  const option = (event.options || []).find((o) => o.id === optionId);
  if (!option) return { ok: false, reason: "unknown_option" };

  const outcome = rollOutcome(option);
  if (!outcome) return { ok: false, reason: "no_outcome" };

  let lines = [];
  try {
    lines = await applyEffect(client, { userId, guildId, member, username }, outcome.effect || {}, status);
  } catch (e) {
    console.log(`[WARN] 選擇事件 ${eventId}/${optionId} 套用失敗：${e.message}`.yellow);
    return { ok: false, reason: "apply_failed" };
  }

  return {
    ok: true,
    event: { id: event.id, emoji: event.emoji || "❓", name: event.name },
    option: { id: option.id, label: option.label, emoji: option.emoji || "" },
    outcomeText: outcome.text || "",
    resultLines: lines,
  };
}

module.exports = { pickChoiceEvent, getEvent, resolveOption };
