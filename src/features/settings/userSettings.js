/**
 * 玩家個人偏好設定服務。
 *
 * UserSettings 集合 (userId, guildId) 唯一：
 *   publicProfile  bool   是否同意把資料顯示在公開排行榜 / 公開卡片
 *                         預設 false（隱私優先）
 *
 * 未來其他偏好（e.g. 語言、時區、預設挖礦地點…）也可以加進來。
 */

const DEFAULTS = {
  publicProfile: false,
};

function coll(client) {
  return client.userSettingsCollection || null;
}

async function get(client, userId, guildId) {
  const c = coll(client);
  if (!c) return { ...DEFAULTS };
  const doc = await c.findOne({ userId, guildId }).catch(() => null);
  return {
    publicProfile: doc?.publicProfile === true,
  };
}

async function set(client, userId, guildId, partial) {
  const c = coll(client);
  if (!c) return null;
  const $set = {};
  if (typeof partial.publicProfile === "boolean") {
    $set.publicProfile = partial.publicProfile;
  }
  if (Object.keys($set).length === 0) return get(client, userId, guildId);

  $set.updatedAt = new Date();

  await c
    .updateOne(
      { userId, guildId },
      {
        $set,
        $setOnInsert: { userId, guildId, createdAt: new Date() },
      },
      { upsert: true },
    )
    .catch(() => null);

  return get(client, userId, guildId);
}

async function togglePublicProfile(client, userId, guildId) {
  const cur = await get(client, userId, guildId);
  return set(client, userId, guildId, { publicProfile: !cur.publicProfile });
}

/**
 * 批次查多個 userId 在 guild 內的 publicProfile 設定。
 * 找不到記錄 → false（預設）。
 * 回傳 Set<userId> 表示「同意公開」的人。
 */
async function getPublicUserIds(client, guildId, userIds) {
  const c = coll(client);
  if (!c || !Array.isArray(userIds) || userIds.length === 0) {
    return new Set();
  }
  const docs = await c
    .find({
      guildId,
      userId: { $in: userIds },
      publicProfile: true,
    })
    .project({ userId: 1 })
    .toArray()
    .catch(() => []);
  return new Set(docs.map((d) => d.userId));
}

module.exports = {
  get,
  set,
  togglePublicProfile,
  getPublicUserIds,
  DEFAULTS,
};
