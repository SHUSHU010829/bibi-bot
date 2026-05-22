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

const findUsedInvite = async (client, guild) => {
  const guildMap = ensureGuildMap(guild.id);
  const before = new Map(guildMap);

  let invites = null;
  try {
    invites = await guild.invites.fetch();
  } catch (e) {
    console.log(`[INVITE] re-fetch invites failed: ${e.message}`.yellow);
    return null;
  }

  const candidates = [];
  const seen = new Set();

  for (const invite of invites.values()) {
    seen.add(invite.code);
    const prev = before.get(invite.code);
    const prevUses = prev?.uses ?? 0;
    const curUses = invite.uses ?? 0;
    if (curUses > prevUses) {
      candidates.push({
        code: invite.code,
        inviterId: invite.inviter?.id || prev?.inviterId || null,
        inviter: invite.inviter || null,
        delta: curUses - prevUses,
      });
    }
    guildMap.set(invite.code, {
      uses: curUses,
      inviterId: invite.inviter?.id || null,
    });
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
      guildMap.delete(code);
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
      if (curUses > prevUses) {
        candidates.push({
          code: guild.vanityURLCode,
          inviterId: null,
          inviter: null,
          vanity: true,
          delta: curUses - prevUses,
        });
      }
      guildMap.set(vKey, { uses: curUses, inviterId: null, vanity: true });
    }
  } catch {
    // ignore
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
  }

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.log(
      `[INVITE] ambiguous: ${candidates.length} invites changed for guild ${guild.id}, skipping reward`.yellow
    );
    return null;
  }
  return candidates[0];
};

module.exports = {
  primeCache,
  setInviteUses,
  removeInvite,
  findUsedInvite,
  getGuildCache,
};
