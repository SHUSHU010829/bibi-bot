require("colors");
const { treasureMap } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const { weightedRandom } = require("../mining/weightedRandom");
const grantCoins = require("../economy/grantCoins");
const dungeonService = require("../mining/dungeonService");

function cfg() {
  return treasureMap || {};
}

async function broadcastNeighborPrank(client, { userId, count, threshold, unlockedAchievement }) {
  const channelId = cfg().announceChannelId;
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const userTag = `<@${userId}>`;
    const flavors = Array.isArray(cfg().neighborPrankFlavors) ? cfg().neighborPrankFlavors : [];
    const template = flavors.length > 0
      ? flavors[Math.floor(Math.random() * flavors.length)]
      : "又被隔壁村民耍了（第 {count} 張，集 {threshold} 張可拿成就）";
    const filled = template
      .replace(/\{count\}/g, String(count))
      .replace(/\{threshold\}/g, String(threshold));
    const lines = [`📜 ${userTag} ${filled}`];
    if (unlockedAchievement) {
      lines.push(`🏆 ${userTag} 達成成就 **「哈哈我是 SB」** — 集滿 ${threshold} 張隔壁村民惡作劇紙條`);
    }
    await ch.send({
      content: lines.join("\n"),
      allowedMentions: { parse: ["users"] },
    });
  } catch (err) {
    console.log(`[WARN] treasureMap 廣播失敗：${err?.message || err}`.yellow);
  }
}

function rollEvent() {
  const events = Array.isArray(cfg().events) ? cfg().events : [];
  const weights = {};
  events.forEach((e, i) => {
    weights[String(i)] = e.weight || 0;
  });
  const idx = weightedRandom(weights);
  if (idx == null) return null;
  return events[Number(idx)];
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// 使用一張藏寶圖：先扣 1 張，roll event，套用效果，回傳結果供呈現。
async function useMap(client, { userId, guildId, username, member }) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  if ((profile.treasure_maps || 0) <= 0) {
    return {
      ok: false,
      reason: "no_map",
      fragments: profile.treasure_map_fragments || 0,
    };
  }

  // 先扣 1 張藏寶圖（atomic）
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, treasure_maps: { $gte: 1 } },
    { $inc: { treasure_maps: -1 }, $set: { updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "race" };

  const event = rollEvent();
  if (!event) {
    return { ok: false, reason: "no_event" };
  }

  const eff = event.effect || {};
  const lines = [];
  const patch = {};

  if (eff.type === "bonus_coins") {
    const coins = randInt(eff.min || 0, eff.max || 0);
    if (coins > 0) {
      await grantCoins(client, {
        userId, guildId, username, member,
        amount: coins,
        source: "treasure_map",
        meta: { event: event.id },
      }).catch(() => {});
      lines.push(`💰 +${coins} 逼幣`);
      patch.coins = coins;
    }
  } else if (eff.type === "restore_stamina") {
    const amount = Math.max(0, Math.floor(eff.amount || 0));
    if (amount > 0) {
      const restored = await dungeonService.restoreStamina(client, {
        userId, guildId, member, amount,
      });
      const after = restored.staminaAfter ?? restored.staminaBefore ?? 0;
      const max = restored.max ?? 0;
      const gained = restored.restored ?? 0;
      if (restored.full) {
        lines.push(`🔋 體力已滿（${after} / ${max}），藥水沒派上用場 🥲`);
      } else {
        lines.push(`🔋 體力 +${gained}（${after} / ${max}）`);
      }
      patch.staminaAfter = after;
    }
  } else if (eff.type === "mimic") {
    const hasWeapon = profile.weapon && profile.weapon !== "fist";
    if (hasWeapon) {
      const coins = randInt(eff.winCoinsMin || 0, eff.winCoinsMax || 0);
      const slime = Math.max(0, eff.slimeReward || 0);
      const inc = {};
      if (slime > 0) inc["backpack.monster_slime"] = slime;
      if (Object.keys(inc).length > 0) {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId },
          { $inc: inc, $set: { updatedAt: new Date() } },
        );
      }
      if (coins > 0) {
        await grantCoins(client, {
          userId, guildId, username, member,
          amount: coins,
          source: "treasure_map",
          meta: { event: event.id, won: true },
        }).catch(() => {});
      }
      lines.push(`⚔️ 你拔出武器擊退了寶箱怪！+${coins} 逼幣` + (slime > 0 ? `、💧 怪物黏液 ×${slime}` : ""));
      patch.coins = coins;
    } else {
      const loseStamina = Math.max(0, eff.loseStamina || 1);
      const club = await dungeonService.getMemberClub(client, userId, guildId);
      const max = dungeonService.staminaMax(member, club);
      const st = dungeonService.resolveStamina(profile, max);
      const after = Math.max(0, st.stamina - loseStamina);
      const newUpdatedAt = after >= max ? 0 : st.updatedAt || Date.now();
      await client.miningProfilesCollection.updateOne(
        { userId, guildId },
        { $set: { stamina: after, stamina_updated_at: newUpdatedAt, updatedAt: new Date() } },
      );
      lines.push(`👊 你赤手空拳被寶箱怪揍了一頓，體力 -${st.stamina - after}（${after} / ${max}）`);
      patch.staminaAfter = after;
    }
  } else if (eff.type === "prank") {
    // 純 flavor，無任何獎勵 / 扣除
    lines.push(`📜 紙條上寫著：「哈哈你被騙了」（沒有任何獎勵）`);
  } else if (eff.type === "prank_achievement") {
    const upd = await client.miningProfilesCollection.findOneAndUpdate(
      { userId, guildId },
      { $inc: { neighbor_prank_count: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    const after = (upd?.value || upd)?.neighbor_prank_count ?? ((profile.neighbor_prank_count || 0) + 1);
    const threshold = cfg().neighborPrankAchievementThreshold ?? 5;
    lines.push(`📜 紙條：「哈哈你被騙了！— 隔壁村民」（成就計數：**${after} / ${threshold}**）`);
    const unlocked = after === threshold;
    if (after >= threshold) {
      lines.push(`🏆 成就解鎖：**哈哈我是 SB**（集滿 ${threshold} 張隔壁村民惡作劇紙條）`);
    }
    patch.prankAfter = after;
    broadcastNeighborPrank(client, {
      userId, count: after, threshold, unlockedAchievement: unlocked,
    }).catch(() => {});
  }

  return {
    ok: true,
    event,
    lines,
    patch,
    mapsAfter: (profile.treasure_maps || 0) - 1,
  };
}

module.exports = { useMap, rollEvent };
