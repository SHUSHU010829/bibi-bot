require("colors");

const memoryCache = new Map();

const ensureGuildMap = (guildId) => {
  let m = memoryCache.get(guildId);
  if (!m) {
    m = new Map();
    memoryCache.set(guildId, m);
  }
  return m;
};

const getGuildCache = (guildId) => memoryCache.get(guildId) || null;

const primeCache = async (client, guild) => {
  const guildMap = ensureGuildMap(guild.id);
  guildMap.clear();

  let invites = null;
  try {
    invites = await guild.invites.fetch();
  } catch (e) {
    console.log(`[INVITE] fetch invites failed for guild ${guild.id}: ${e.message}`.yellow);
  }

  if (invites) {
    for (const invite of invites.values()) {
      guildMap.set(invite.code, {
        uses: invite.uses ?? 0,
        inviterId: invite.inviter?.id || null,
      });
    }
  }

  let vanityUses = null;
  try {
    if (guild.vanityURLCode) {
      const vanity = await guild.fetchVanityData().catch(() => null);
      if (vanity) {
        vanityUses = vanity.uses ?? 0;
        guildMap.set(`__vanity__:${guild.vanityURLCode}`, {
          uses: vanityUses,
          inviterId: null,
          vanity: true,
        });
      }
    }
  } catch {
    // ignore
  }

  if (client.inviteCacheCollection) {
    try {
      const ops = [];
      for (const [code, info] of guildMap.entries()) {
        ops.push({
          updateOne: {
            filter: { guildId: guild.id, code },
            update: {
              $set: {
                guildId: guild.id,
                code,
                uses: info.uses,
                inviterId: info.inviterId,
                vanity: !!info.vanity,
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
      if (ops.length) await client.inviteCacheCollection.bulkWrite(ops, { ordered: false });
      const codes = [...guildMap.keys()];
      await client.inviteCacheCollection.deleteMany({
        guildId: guild.id,
        code: { $nin: codes },
      });
    } catch (e) {
      console.log(`[INVITE] persist cache failed: ${e.message}`.yellow);
    }
  }

  console.log(`[INVITE] cache primed for guild ${guild.id} (${guildMap.size} codes)`.cyan);
};

const setInviteUses = async (client, invite) => {
  if (!invite?.guild) return;
  const guildMap = ensureGuildMap(invite.guild.id);
  guildMap.set(invite.code, {
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id || null,
  });
  if (client.inviteCacheCollection) {
    await client.inviteCacheCollection
      .updateOne(
        { guildId: invite.guild.id, code: invite.code },
        {
          $set: {
            guildId: invite.guild.id,
            code: invite.code,
            uses: invite.uses ?? 0,
            inviterId: invite.inviter?.id || null,
            vanity: false,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      )
      .catch((e) => console.log(`[INVITE] setInviteUses persist failed: ${e.message}`.yellow));
  }
};

const removeInvite = async (client, invite) => {
  const guildId = invite?.guild?.id || invite?.guildId;
  if (!guildId) return;
  const guildMap = getGuildCache(guildId);
  if (guildMap) guildMap.delete(invite.code);
  if (client.inviteCacheCollection) {
    await client.inviteCacheCollection
      .deleteOne({ guildId, code: invite.code })
      .catch((e) => console.log(`[INVITE] removeInvite persist failed: ${e.message}`.yellow));
  }
};

// 同 guild 的偵測必須序列化：短時間內多人加入時，前一個事件要先把
// cache 推進完，後一個事件才能在正確的基準上算 delta。
const guildLocks = new Map();

const runExclusive = (guildId, fn) => {
  const prev = guildLocks.get(guildId) || Promise.resolve();
  const next = prev.then(fn, fn);
  guildLocks.set(
    guildId,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
};

const detectUsedInvite = async (client, guild, ctx = {}) => {
  const guildMap = ensureGuildMap(guild.id);
  const before = new Map(guildMap);
  const who = ctx.inviteeId ? ` invitee=${ctx.inviteeId}` : "";

  let invites = null;
  try {
    invites = await guild.invites.fetch();
  } catch (e) {
    console.log(
      `[INVITE] re-fetch invites failed${who} guild=${guild.id}: ${e.message}`.red
    );
    return null;
  }

  const candidates = [];
  const seen = new Set();
  const nextUses = new Map();

  for (const invite of invites.values()) {
    seen.add(invite.code);
    const prev = before.get(invite.code);
    const prevUses = prev?.uses ?? 0;
    const curUses = invite.uses ?? 0;
    const inviterId = invite.inviter?.id || prev?.inviterId || null;
    nextUses.set(invite.code, { uses: curUses, inviterId });
    if (curUses > prevUses) {
      candidates.push({
        code: invite.code,
        inviterId,
        inviter: invite.inviter || null,
        delta: curUses - prevUses,
        prevUses,
      });
    }
  }

  // 已用完即時消失的單次邀請：cache 有、fetch 沒有 → 視為這張用掉了
  for (const [code, info] of before.entries()) {
    if (code.startsWith("__vanity__:")) continue;
    if (!seen.has(code)) {
      candidates.push({
        code,
        inviterId: info.inviterId,
        inviter: null,
        delta: 1,
        vanished: true,
      });
    }
  }

  // vanity URL 使用次數變化
  try {
    if (guild.vanityURLCode) {
      const vanity = await guild.fetchVanityData().catch(() => null);
      const vKey = `__vanity__:${guild.vanityURLCode}`;
      const prev = before.get(vKey);
      const prevUses = prev?.uses ?? 0;
      const curUses = vanity?.uses ?? 0;
      nextUses.set(vKey, { uses: curUses, inviterId: null, vanity: true });
      if (curUses > prevUses) {
        candidates.push({
          code: guild.vanityURLCode,
          inviterId: null,
          inviter: null,
          vanity: true,
          delta: curUses - prevUses,
          prevUses,
        });
      }
    }
  } catch {
    // ignore
  }

  let winner = null;
  if (candidates.length === 1) {
    winner = candidates[0];
  } else if (candidates.length > 1) {
    const uniqueInviters = new Set(candidates.map((c) => c.inviterId || ""));
    const allSameInviter =
      uniqueInviters.size === 1 && [...uniqueInviters][0] !== "";
    if (allSameInviter) {
      const nonVanity = candidates.find((c) => !c.vanity) || candidates[0];
      winner = nonVanity;
      console.log(
        `[INVITE] ${candidates.length} candidates但 inviter 一致 (${winner.inviterId})${who}，仍歸因到 code=${winner.code}`.cyan
      );
    } else {
      const dump = candidates
        .map((c) => `${c.code}:${c.inviterId || "vanity"}`)
        .join(", ");
      console.log(
        `[INVITE] ambiguous${who} guild=${guild.id} candidates=[${dump}], skipping reward`.red
      );
    }
  }

  // 重建 cache：勝出的邀請每次只「消耗」一次使用，把多出的 delta
  // 留給後續排隊的入群事件各自歸因（同碼同時多人加入時不漏發）。
  guildMap.clear();
  for (const [code, info] of nextUses.entries()) {
    let uses = info.uses;
    if (winner && !winner.vanished && winner.code === code && winner.delta > 1) {
      uses = winner.prevUses + 1;
    }
    const entry = { uses, inviterId: info.inviterId };
    if (info.vanity) entry.vanity = true;
    guildMap.set(code, entry);
  }

  if (client.inviteCacheCollection) {
    const ops = [];
    for (const [code, info] of guildMap.entries()) {
      ops.push({
        updateOne: {
          filter: { guildId: guild.id, code },
          update: {
            $set: {
              guildId: guild.id,
              code,
              uses: info.uses,
              inviterId: info.inviterId,
              vanity: !!info.vanity,
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) {
      client.inviteCacheCollection
        .bulkWrite(ops, { ordered: false })
        .catch((e) => console.log(`[INVITE] cache persist failed: ${e.message}`.yellow));
    }
    client.inviteCacheCollection
      .deleteMany({ guildId: guild.id, code: { $nin: [...guildMap.keys()] } })
      .catch((e) => console.log(`[INVITE] cache prune failed: ${e.message}`.yellow));
  }

  return winner;
};

const findUsedInvite = (client, guild, ctx) =>
  runExclusive(guild.id, () => detectUsedInvite(client, guild, ctx));

module.exports = {
  primeCache,
  setInviteUses,
  removeInvite,
  findUsedInvite,
  getGuildCache,
};
