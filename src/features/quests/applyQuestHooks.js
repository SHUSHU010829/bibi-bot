require("colors");
const questService = require("./questService");
const notifyQuestClaim = require("./notifyQuestClaim");

// 在指令層套用一組任務進度，並對「自動入帳」的任務送出通知。
//
// ctx：{ interaction, user, userId, guildId, member, username }
//   - interaction 供 notifyQuestClaim 以 ephemeral 私人回覆（無 interaction 則靜默不通知）
//   - guildId / member / username 供任務發幣
// hooks：[{ questId, type?, delta?, key? }]
//   - type 'meta'：累計型，呼叫 addMetaValue(key, delta)
//   - 其餘：次數型，呼叫 incrementProgress(delta，預設 1)
//
// 全程非阻塞、失敗靜默，不影響主指令流程。
module.exports = async (client, ctx, hooks) => {
  if (!Array.isArray(hooks) || hooks.length === 0) return;
  if (!client.questProgressCollection) return;

  const { userId, guildId, member, username } = ctx || {};
  if (!userId || !guildId) return;
  const claimCtx = { member, username };

  for (const hook of hooks) {
    try {
      let res = null;
      if (hook.type === "meta") {
        res = await questService
          .addMetaValue(
            client,
            userId,
            guildId,
            hook.questId,
            hook.key,
            hook.delta || 0,
            claimCtx
          )
          .catch(() => null);
      } else {
        res = await questService
          .incrementProgress(
            client,
            userId,
            guildId,
            hook.questId,
            hook.delta ?? 1,
            claimCtx
          )
          .catch(() => null);
      }
      if (res?.autoClaimed) {
        await notifyQuestClaim(client, ctx, res.autoClaimed);
      }
    } catch (e) {
      console.log(`[ERROR] applyQuestHooks ${hook?.questId}: ${e}`.red);
    }
  }
};
