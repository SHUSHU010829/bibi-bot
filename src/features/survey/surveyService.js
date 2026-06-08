require("colors");
const { survey } = require("../../config");
const grantCoins = require("../economy/grantCoins");

function getWindowStatus(now = new Date()) {
  const startAt = survey.startAt ? new Date(survey.startAt) : null;
  const endAt = survey.endAt ? new Date(survey.endAt) : null;
  if (startAt && now < startAt) {
    return { open: false, reason: "not_started", startAt, endAt };
  }
  if (endAt && now > endAt) {
    return { open: false, reason: "ended", startAt, endAt };
  }
  return { open: true, startAt, endAt };
}

async function getResponse(client, userId, guildId) {
  if (!client.surveyResponsesCollection) return null;
  return client.surveyResponsesCollection.findOne({ userId, guildId });
}

async function ensureDoc(client, userId, guildId) {
  const now = new Date();
  await client.surveyResponsesCollection.updateOne(
    { userId, guildId },
    {
      $setOnInsert: {
        userId,
        guildId,
        version: survey.version,
        answers: {},
        openAnswers: {},
        completedAt: null,
        rewardedAt: null,
        rewardAmount: null,
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );
  return getResponse(client, userId, guildId);
}

async function saveSelectAnswer(client, userId, guildId, questionId, values) {
  if (!client.surveyResponsesCollection) return null;
  const def = survey.selectQuestions.find((q) => q.id === questionId);
  if (!def) return null;
  const allowed = new Set(def.options.map((o) => o.value));
  const filtered = (values || []).filter((v) => allowed.has(v)).slice(0, def.max);
  await client.surveyResponsesCollection.updateOne(
    { userId, guildId, completedAt: null },
    {
      $set: {
        [`answers.${questionId}`]: filtered,
        updatedAt: new Date(),
      },
    },
  );
  return getResponse(client, userId, guildId);
}

async function saveOpenAnswers(client, userId, guildId, answers) {
  if (!client.surveyResponsesCollection) return null;
  const set = { updatedAt: new Date() };
  for (const q of survey.openQuestions) {
    const v = answers?.[q.id];
    if (typeof v === "string") {
      set[`openAnswers.${q.id}`] = v.slice(0, q.max);
    }
  }
  await client.surveyResponsesCollection.updateOne(
    { userId, guildId, completedAt: null },
    { $set: set },
  );
  return getResponse(client, userId, guildId);
}

function validateRequired(doc) {
  const missing = [];
  for (const q of survey.selectQuestions) {
    if (!q.required) continue;
    const v = doc?.answers?.[q.id];
    if (!Array.isArray(v) || v.length < (q.min || 1)) missing.push(q);
  }
  return missing;
}

async function submit(client, userId, guildId, member, username) {
  const window = getWindowStatus();
  if (!window.open) return { ok: false, reason: "closed", window };

  const doc = await getResponse(client, userId, guildId);
  if (!doc) return { ok: false, reason: "no_doc" };
  if (doc.completedAt) return { ok: false, reason: "already_completed", doc };

  const missing = validateRequired(doc);
  if (missing.length > 0) return { ok: false, reason: "missing", missing };

  const now = new Date();
  // 先 mark completed 防併發雙領（filter 含 completedAt: null）
  const updated = await client.surveyResponsesCollection.findOneAndUpdate(
    { userId, guildId, completedAt: null },
    { $set: { completedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  const after = updated?.value || updated;
  if (!after || !after.completedAt) {
    return { ok: false, reason: "race_lost" };
  }

  const reward = survey.reward || 0;
  const grant = await grantCoins(client, {
    userId,
    guildId,
    member,
    username,
    amount: reward,
    source: survey.rewardSource || "survey",
    meta: { version: survey.version },
  });

  await client.surveyResponsesCollection.updateOne(
    { userId, guildId },
    {
      $set: {
        rewardedAt: new Date(),
        rewardAmount: grant?.granted ?? reward,
      },
    },
  );

  return {
    ok: true,
    reward: grant?.granted ?? reward,
    newBalance: grant?.doc?.totalCoins ?? null,
    doc: after,
  };
}

module.exports = {
  getWindowStatus,
  getResponse,
  ensureDoc,
  saveSelectAnswer,
  saveOpenAnswers,
  validateRequired,
  submit,
};
