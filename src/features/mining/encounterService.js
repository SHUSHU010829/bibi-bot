require("colors");
const { randomEncounters, dungeon, mining } = require("../../config");
const { weightedRandom } = require("./weightedRandom");
const grantCoins = require("../economy/grantCoins");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("./miningProfile");
const { COIN_EMOJI } = require("../../constants/coin");

// CD 縮短券持有上限（與商店 shop.json maxStack 一致）
const CD_TICKET_MAX = 30;

function randInt(min, max) {
  const lo = Math.ceil(min ?? 0);
  const hi = Math.floor(max ?? lo);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

// 戰鬥力 = baseAtk + 武器 ATK（與 dungeonService.playerAtk 同口徑，避免循環依賴而在此重算）。
function weaponAtk(profile) {
  const base = dungeon?.baseAtk ?? 20;
  const def = (dungeon?.weapons || {})[profile?.weapon] || {};
  return base + (def.atk || 0);
}

function weaponLabel(profile) {
  const def = (dungeon?.weapons || {})[profile?.weapon] || {};
  return `${def.emoji || "👊"} ${def.name || "赤手空拳"}`;
}

// 依情境抽一個突發事件（已套機率門檻）。回傳 def 或 null。
function pickEncounter(context) {
  const list = randomEncounters?.[context] || [];
  if (!list.length) return null;
  const weights = {};
  for (const e of list) weights[e.id] = e.weight || 0;
  const id = weightedRandom(weights);
  return list.find((e) => e.id === id) || null;
}

function coll(client) {
  return client.miningProfilesCollection;
}

// 觸發一次突發事件。context: "mining" | "dungeon"。
// baseResult 為主行為（挖礦 / 地下城）的結果，供「翻倍本次掉落」「損失本次礦石」
// 「以目前體力為基準增減」等效果參照。
// 回傳 null（沒觸發）或 { id, name, emoji, body, patch }，patch 內可含：
//   - newCooldownAt：挖礦冷卻被清除後的新值（供指令層同步顯示）
//   - staminaAfter：地下城體力變動後的值
async function trigger(client, ctx) {
  const { context, userId, guildId, member, username, baseResult } = ctx;
  if (!randomEncounters?.enabled) return null;
  if (!coll(client)) return null;

  const chance =
    context === "mining"
      ? randomEncounters.miningChance
      : randomEncounters.dungeonChance;
  if (!(Math.random() < (chance || 0))) return null;

  const enc = pickEncounter(context);
  if (!enc) return null;

  const eff = enc.effect || {};
  const lines = [];
  if (enc.text) lines.push(enc.text);
  const patch = {};

  try {
    switch (eff.type) {
      case "bonus_coins": {
        const amount = randInt(eff.min, eff.max);
        await grantCoins(client, {
          userId,
          guildId,
          username,
          amount,
          source: "encounter",
          member,
          meta: { encounter: enc.id },
        });
        lines.push(`💰 +${amount.toLocaleString()} ${COIN_EMOJI}`);
        break;
      }

      case "bonus_ore_same": {
        const ore = baseResult?.ore;
        const baseQty = baseResult?.qty || 0;
        if (ore && baseQty > 0) {
          const profile = await getOrCreate(client, userId, guildId);
          const space = Math.max(
            0,
            backpackCapacity(profile, mining) - backpackUsed(profile)
          );
          const intended = Math.floor(baseQty * (eff.mult ?? 1));
          const granted = Math.min(intended, space);
          if (granted > 0) {
            await coll(client).updateOne(
              { userId, guildId },
              {
                $inc: {
                  [`backpack.${ore}`]: granted,
                  [`lifetime_ore.${ore}`]: granted,
                },
                $set: { updatedAt: new Date() },
              }
            );
            lines.push(`${oreLabel(ore)} ×${granted}（額外獲得）`);
          }
          // 背包塞不下的部分折算成金幣，不浪費
          const overflow = intended - granted;
          if (overflow > 0) {
            const price = mining?.ores?.[ore]?.price || 0;
            const coins = overflow * price;
            if (coins > 0) {
              await grantCoins(client, {
                userId,
                guildId,
                username,
                amount: coins,
                source: "encounter",
                member,
                meta: { encounter: enc.id, overflow: true },
              });
              lines.push(
                `🎒 背包已滿，${oreLabel(ore)} ×${overflow} 折算成 +${coins.toLocaleString()} ${COIN_EMOJI}`
              );
            }
          }
        }
        break;
      }

      case "bonus_ore": {
        const ore = eff.ore || "iron";
        const profile = await getOrCreate(client, userId, guildId);
        const space = Math.max(
          0,
          backpackCapacity(profile, mining) - backpackUsed(profile)
        );
        let qty = randInt(eff.min, eff.max);
        if (qty <= space) {
          await coll(client).updateOne(
            { userId, guildId },
            {
              $inc: { [`backpack.${ore}`]: qty, [`lifetime_ore.${ore}`]: qty },
              $set: { updatedAt: new Date() },
            }
          );
          lines.push(`${oreLabel(ore)} ×${qty}（額外獲得）`);
        } else {
          // 背包滿了折算成等值金幣，避免戰利品憑空消失
          const price = mining?.ores?.[ore]?.price || 0;
          const coins = price * qty;
          if (coins > 0) {
            await grantCoins(client, {
              userId,
              guildId,
              username,
              amount: coins,
              source: "encounter",
              member,
              meta: { encounter: enc.id, overflow: true },
            });
          }
          lines.push(
            `🎒 背包已滿，${oreLabel(ore)} ×${qty} 折算成 +${coins.toLocaleString()} ${COIN_EMOJI}`
          );
        }
        break;
      }

      case "lose_ore": {
        const ore = baseResult?.ore;
        const baseQty = baseResult?.qty || 0;
        if (ore && baseQty > 0) {
          const profile = await getOrCreate(client, userId, guildId);
          const have = (profile.backpack || {})[ore] || 0;
          let lost = Math.floor(baseQty * (eff.pct ?? 0.5));
          if (lost < 1) lost = 1;
          if (lost > have) lost = have;
          if (lost > 0) {
            await coll(client).updateOne(
              { userId, guildId },
              {
                $inc: { [`backpack.${ore}`]: -lost },
                $set: { updatedAt: new Date() },
              }
            );
            lines.push(`💥 損失 ${oreLabel(ore)} ×${lost}`);
          }
        }
        break;
      }

      case "clear_cd": {
        const now = Date.now();
        await coll(client).updateOne(
          { userId, guildId },
          { $set: { mine_cooldown_at: now, updatedAt: new Date() } }
        );
        patch.newCooldownAt = now;
        break;
      }

      case "gift_potion": {
        const qty = eff.qty || 1;
        await coll(client).updateOne(
          { userId, guildId },
          { $inc: { luck_potion_uses: qty }, $set: { updatedAt: new Date() } }
        );
        lines.push(`🍀 幸運藥水 ×${qty}`);
        break;
      }

      case "gift_cd_ticket": {
        const profile = await getOrCreate(client, userId, guildId);
        const owned = profile.cd_ticket_count || 0;
        const qty = Math.min(eff.qty || 1, Math.max(0, CD_TICKET_MAX - owned));
        if (qty > 0) {
          await coll(client).updateOne(
            { userId, guildId },
            { $inc: { cd_ticket_count: qty }, $set: { updatedAt: new Date() } }
          );
          lines.push(`🎫 CD 縮短券 ×${qty}`);
        } else {
          lines.push("你的 CD 縮短券已達持有上限，這次沒拿到。");
        }
        break;
      }

      case "restore_stamina":
      case "lose_stamina": {
        const max =
          baseResult?.staminaMax ?? (dungeon?.staminaMax ?? 10);
        const cur =
          typeof baseResult?.stamina === "number" ? baseResult.stamina : max;
        const delta =
          eff.type === "restore_stamina"
            ? eff.amount || 1
            : -(eff.amount || 1);
        const next = clamp(cur + delta, 0, max);
        const set = { stamina: next, updatedAt: new Date() };
        if (next >= max) set.stamina_updated_at = 0;
        else if (cur >= max) set.stamina_updated_at = Date.now();
        await coll(client).updateOne({ userId, guildId }, { $set: set });
        patch.staminaAfter = next;
        const diff = next - cur;
        if (diff !== 0) {
          lines.push(`🔋 體力 ${diff > 0 ? "+" : ""}${diff}（${next}/${max}）`);
        }
        break;
      }

      case "gamble_coins": {
        // 詛咒祭壇：依 winChance 賭一把，勝得金幣，敗扣體力
        const won = Math.random() < (eff.winChance ?? 0.6);
        if (won) {
          const coins = randInt(eff.winMin ?? 300, eff.winMax ?? 700);
          await grantCoins(client, {
            userId,
            guildId,
            username,
            amount: coins,
            source: "encounter",
            member,
            meta: { encounter: enc.id, result: "win" },
          });
          lines.push(`⚖️ 你鼓起勇氣打開寶箱，奪得 +${coins.toLocaleString()} ${COIN_EMOJI}！`);
        } else {
          const max = baseResult?.staminaMax ?? (dungeon?.staminaMax ?? 10);
          const cur = typeof baseResult?.stamina === "number" ? baseResult.stamina : max;
          const lose = eff.loseStamina || 1;
          const next = clamp(cur - lose, 0, max);
          const set = { stamina: next, updatedAt: new Date() };
          if (cur >= max) set.stamina_updated_at = Date.now();
          await coll(client).updateOne({ userId, guildId }, { $set: set });
          patch.staminaAfter = next;
          lines.push(`⚖️ 你伸手觸碰寶箱，機關觸發！損失 ${lose} 點體力。`);
        }
        break;
      }

      case "gift_whetstone_inferior": {
        // 遺忘的鍛爐：贈送一塊劣質磨鎬石（遵守持有上限 20）
        const WHETSTONE_INFERIOR_MAX = 20;
        const profile = await getOrCreate(client, userId, guildId);
        const owned = profile.whetstone_inferior_count || 0;
        const give = Math.min(eff.qty || 1, Math.max(0, WHETSTONE_INFERIOR_MAX - owned));
        if (give > 0) {
          await coll(client).updateOne(
            { userId, guildId },
            { $inc: { whetstone_inferior_count: give }, $set: { updatedAt: new Date() } }
          );
          lines.push(`🪨 劣質磨鎬石 ×${give}（可在 /背包 使用）`);
        } else {
          lines.push("你的劣質磨鎬石已達持有上限，這次沒拿到。");
        }
        break;
      }

      case "repair_weapon": {
        const profile = await getOrCreate(client, userId, guildId);
        const wdef = (dungeon?.weapons || {})[profile.weapon] || {};
        if (profile.weapon !== "fist" && wdef.durability) {
          const max = wdef.durability;
          const cur =
            typeof profile.weapon_durability === "number"
              ? profile.weapon_durability
              : max;
          const next = eff.pct
            ? clamp(cur + Math.ceil(max * eff.pct), 0, max)
            : max;
          await coll(client).updateOne(
            { userId, guildId },
            {
              $set: {
                weapon_durability: next,
                updatedAt: new Date(),
              },
            }
          );
          if (eff.pct) {
            lines.push(
              `🛠️ ${wdef.emoji || "⚔️"} ${wdef.name} 耐久 ${cur} → ${next}/${max}`
            );
          } else {
            lines.push(
              `🛠️ ${wdef.emoji || "⚔️"} ${wdef.name} 耐久恢復至 ${max}`
            );
          }
        } else {
          lines.push("可惜你沒有需要保養的武器。");
        }
        break;
      }

      case "ambush": {
        const profile = await getOrCreate(client, userId, guildId);
        const atk = weaponAtk(profile);
        const hp = randInt(eff.monsterHpMin, eff.monsterHpMax);
        const winRate = clamp(
          atk / hp,
          dungeon?.winRateMin ?? 0.2,
          dungeon?.winRateMax ?? 0.9
        );
        const won = Math.random() < winRate;
        if (won) {
          const coins = randInt(eff.winCoinsMin, eff.winCoinsMax);
          await grantCoins(client, {
            userId,
            guildId,
            username,
            amount: coins,
            source: "encounter",
            member,
            meta: { encounter: enc.id, combat: "win" },
          });
          lines.push(
            `🦇 怪物突襲！你用 ${weaponLabel(profile)} 擊退了牠，奪得 +${coins.toLocaleString()} ${COIN_EMOJI}`
          );
        } else {
          // 落敗：被打斷採集，掉落本次部分礦石（赤手空拳更容易吃癟）
          const ore = baseResult?.ore;
          const baseQty = baseResult?.qty || 0;
          let lost = 0;
          if (ore && baseQty > 0) {
            const have = (profile.backpack || {})[ore] || 0;
            lost = Math.min(have, Math.max(1, Math.ceil(baseQty / 2)));
            if (lost > 0) {
              await coll(client).updateOne(
                { userId, guildId },
                {
                  $inc: { [`backpack.${ore}`]: -lost },
                  $set: { updatedAt: new Date() },
                }
              );
            }
          }
          const tail =
            profile.weapon === "fist"
              ? "（赤手空拳實在難以招架，去 `/合成` 打把劍吧！）"
              : "";
          lines.push(
            `🦇 怪物突襲！你不敵逃竄` +
              (lost > 0 ? `，掉落 ${oreLabel(ore)} ×${lost}` : "") +
              `。${tail}`
          );
        }
        break;
      }

      case "elite": {
        const profile = await getOrCreate(client, userId, guildId);
        const atk = weaponAtk(profile);
        const hp = randInt(eff.hpMin, eff.hpMax);
        const winRate = clamp(
          atk / hp,
          dungeon?.winRateMin ?? 0.2,
          dungeon?.winRateMax ?? 0.9
        );
        const won = Math.random() < winRate;
        if (won) {
          const coins = randInt(eff.winCoinsMin, eff.winCoinsMax);
          const inc = {};
          let frag = 0;
          if (Math.random() < (eff.fragmentChance || 0)) {
            frag = 1;
            inc.legendary_fragments = 1;
          }
          if (Object.keys(inc).length) {
            await coll(client).updateOne(
              { userId, guildId },
              { $inc: inc, $set: { updatedAt: new Date() } }
            );
          }
          await grantCoins(client, {
            userId,
            guildId,
            username,
            amount: coins,
            source: "encounter",
            member,
            meta: { encounter: enc.id, combat: "win" },
          });
          lines.push(
            `👹 精英怪現身！你擊敗了牠（HP ${hp}），奪得 +${coins.toLocaleString()} ${COIN_EMOJI}` +
              (frag ? `　✨ 傳說素材碎片 ×1` : "")
          );
        } else {
          const max = baseResult?.staminaMax ?? (dungeon?.staminaMax ?? 10);
          const cur =
            typeof baseResult?.stamina === "number"
              ? baseResult.stamina
              : max;
          const next = clamp(cur - (eff.loseStamina || 1), 0, max);
          const set = { stamina: next, updatedAt: new Date() };
          if (cur >= max) set.stamina_updated_at = Date.now();
          await coll(client).updateOne({ userId, guildId }, { $set: set });
          patch.staminaAfter = next;
          lines.push(
            `👹 精英怪現身（HP ${hp}）！你不敵敗退，損失 ${cur - next} 體力。`
          );
        }
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.log(`[WARN] 突發事件 ${enc.id} 處理失敗：${e.message}`.yellow);
    return null;
  }

  return {
    id: enc.id,
    name: enc.name,
    emoji: enc.emoji || "❗",
    body: lines.join("\n"),
    patch,
  };
}

module.exports = { trigger, pickEncounter };
