// 斷劍王雙週結算：每月 1 號 / 16 號 00:05 統計「上一期」把傳說之劍砍斷最多次的人，
// 封為斷劍王並授予「亡靈制」加成（效期到下一個結算切點）；同 guild 舊持有者自動卸任。
//
// 亡靈制一律 compute-on-read（只存 expires_at），過期即自動失效，不靠排程清欄位。
// 純結算類 cron，失敗只 log，不影響玩家流程。

require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { dungeon } = require("../../config");
const swordBreakService = require("../../features/dungeon/swordBreakService");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const MEDALS = swordBreakService.MEDALS;

async function announceChampion(client, guildId, winnerId, ranking, window, expiresAt) {
  const channelId = dungeon?.swordBreaker?.announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const guild = client.guilds.cache.get(guildId);
  const nameOf = (id) => plainifyUserMentions(guild, `<@${id}>`);

  const top = ranking
    .slice(0, 3)
    .map((r, i) => `${MEDALS[i]} ${nameOf(r.userId)} — **${r.breaks.toLocaleString()}** 次`)
    .join("\n");

  const u = dungeon?.undead || {};
  const c = u.curse || {};
  const perks = [
    `⚔️ 地下城傷害 −${u.atkPenaltyPct || 0}%`,
    `🗡️ 武器每場多扣耐久 −${u.extraDurabilityCost || 0}（兵刃更快崩壞）`,
    `👻 亡靈軍團作祟（勝利時有機率被奪走金幣、吸走 ${c.hpLossPct || 0}% HP）`,
  ];

  const container = new ContainerBuilder()
    .setAccentColor(0x992d22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ☠️ ${window.label} 斷劍王出爐！`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${nameOf(winnerId)} 本期把 ${swordBreakService.swordLabel()} 砍斷了 **${ranking[0].breaks}** 次，慘遭封為 **☠️ 斷劍王**！\n` +
          `無數斷劍的怨靈反噬其身——即刻起被烙上「**亡靈制**」詛咒，效期至 <t:${Math.floor(expiresAt / 1000)}:R>。`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 亡靈制詛咒（debuff）\n${perks.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 本期斷劍榜\n${top || "—"}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 下一期重新統計——愛惜你的 🔥 傳說之劍，別讓自己再戴上這頂亡靈王冠！",
      ),
    );

  await channel
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

async function processGuild(client, guildId, window, expiresAt) {
  const ranking = await swordBreakService.rankByWindow(client, guildId, window, 10);
  if (!ranking.length) return null;

  const winnerId = ranking[0].userId;

  await swordBreakService.grantUndead(client, {
    userId: winnerId,
    guildId,
    expiresAt,
    cycleLabel: window.label,
  });
  await swordBreakService.revokeUndeadExcept(client, guildId, winnerId);

  await announceChampion(client, guildId, winnerId, ranking, window, expiresAt);

  try {
    const winner = await client.users.fetch(winnerId).catch(() => null);
    if (winner) {
      await winner
        .send(
          `☠️ 你被封為 **${window.label} 斷劍王**！本期把傳說之劍砍斷 ${ranking[0].breaks} 次（最多）。\n` +
            `斷劍怨靈纏上了你——「亡靈制」詛咒生效：地下城傷害 −${dungeon?.undead?.atkPenaltyPct || 0}%、武器每場多扣耐久、亡靈軍團作祟（奪金幣 / 吸 HP），效期至 <t:${Math.floor(expiresAt / 1000)}:R>。\n` +
            `-# 詛咒狀態可在 /加成 → 時效狀態 查看。少砍斷幾把劍就能擺脫它。`,
        )
        .catch(() => {});
    }
  } catch (_) {
    /* noop */
  }

  console.log(
    `[DUNGEON] 斷劍王結算 guild=${guildId} winner=${winnerId} breaks=${ranking[0].breaks}（${window.label}）`.cyan,
  );
  return { guildId, winnerId, breaks: ranking[0].breaks };
}

async function runSwordBreakerRank(client) {
  const window = swordBreakService.previousWindow();
  // 亡靈制效期到下一個結算切點（現在所屬視窗的結束）。
  const expiresAt = swordBreakService.currentWindow().end.getTime();
  const guildIds = await swordBreakService.guildsWithBreaks(client, window);
  if (!guildIds.length) {
    console.log(`[DUNGEON] ${window.label} 無斷劍紀錄，跳過斷劍王結算`.gray);
    return { processed: 0 };
  }
  let processed = 0;
  for (const guildId of guildIds) {
    try {
      const r = await processGuild(client, guildId, window, expiresAt);
      if (r) processed += 1;
    } catch (e) {
      console.log(`[DUNGEON] 斷劍王結算失敗 guild=${guildId}: ${e.message}`.yellow);
    }
  }
  return { processed };
}

module.exports = async (client) => {
  if (!dungeon?.enabled || !dungeon?.swordBreaker?.enabled) return;

  const cfg = dungeon.swordBreaker;
  registerCron(client, {
    name: "dungeon.swordBreakerRank",
    label: "斷劍王雙週結算",
    schedule: cfg.cronSchedule || "5 0 1,16 * *",
    timezone: cfg.timezone || "Asia/Taipei",
    runner: () => runSwordBreakerRank(client),
  });
};
