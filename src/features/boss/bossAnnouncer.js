require("colors");
const { MessageFlags } = require("discord.js");
const { boss } = require("../../config");
const { buildSettlementContainer } = require("./bossView");

async function resolveChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

async function announceSpawn(client, bossDoc) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const endsAt = Math.floor(bossDoc.ends_at / 1000);
  const onlineSuffix = bossDoc.online_count != null
    ? `（依當前 ${bossDoc.online_count} 名線上玩家決定）`
    : "";
  const text =
    `# ${bossDoc.emoji} **${bossDoc.name}** 出現！\n` +
    `血量 ${bossDoc.max_hp.toLocaleString()}${onlineSuffix}　戰鬥結束：<t:${endsAt}:R>\n` +
    `輸入 **/攻擊** 一起討伐，每人每場最多 ${boss?.attackLimitPerPlayer ?? 5} 次！`;
  await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function announcePhase(client, bossDoc, newPhase) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const tpl = boss?.phaseAnnouncements?.[newPhase];
  if (!tpl) return;
  const text = tpl.replace(/\{name\}/g, bossDoc.name);
  await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function announceCombo(client, bossDoc, userId) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const tpl = boss?.comboAnnouncement || "⚡ Combo 滿格！（<@{user}>）";
  const text = tpl.replace(/\{user\}/g, userId).replace(/\{name\}/g, bossDoc.name);
  await ch.send({ content: text, allowedMentions: { users: [userId] } }).catch(() => {});
}

async function announceSettlement(client, settlement) {
  const container = buildSettlementContainer(settlement);
  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
  const liveCh = await resolveChannel(client, boss?.announceChannelId);
  if (liveCh) await liveCh.send(payload).catch(() => {});
  if (boss?.chronicleChannelId && boss.chronicleChannelId !== boss.announceChannelId) {
    const chronicleCh = await resolveChannel(client, boss.chronicleChannelId);
    if (chronicleCh) await chronicleCh.send(payload).catch(() => {});
  }
}

module.exports = {
  announceSpawn,
  announcePhase,
  announceCombo,
  announceSettlement,
};
