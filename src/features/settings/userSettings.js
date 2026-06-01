/**
 * 玩家個人偏好設定服務。
 *
 * UserSettings 集合 (userId, guildId) 唯一：
 *   publicProfile  bool   是否同意把資料顯示在公開排行榜 / 公開卡片
 *                         **預設 true**（社群型 Discord bot 慣例：公開為主，
 *                         想隱身要主動關閉）。明確存成 false 才算關閉。
 *
 * 未來其他偏好（e.g. 語言、時區、預設挖礦地點…）也可以加進來。
 */

const DEFAULTS = {
  publicProfile: true,
};

function coll(client) {
  return client.userSettingsCollection || null;
}

async function get(client, userId, guildId) {
  const c = coll(client);
  if (!c) return { ...DEFAULTS };
  const doc = await c.findOne({ userId, guildId }).catch(() => null);
  // 沒紀錄 → 預設公開；只有明確 false 才算關閉
  return {
    publicProfile: doc?.publicProfile !== false,
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
 * 規則跟 get() 一致：沒紀錄 → 公開；明確 false → 隱藏。
 * 回傳 Set<userId> 表示「不希望公開」的人（用 inverse 語意是因為大部分人都會
 * 是預設公開，反向集合通常更小）。
 */
async function getHiddenUserIds(client, guildId, userIds) {
  const c = coll(client);
  if (!c || !Array.isArray(userIds) || userIds.length === 0) {
    return new Set();
  }
  const docs = await c
    .find({
      guildId,
      userId: { $in: userIds },
      publicProfile: false,
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
  getHiddenUserIds,
  DEFAULTS,
};
