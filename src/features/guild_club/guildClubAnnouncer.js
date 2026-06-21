require("colors");
const { MessageFlags } = require("discord.js");
const { boss, guildClub } = require("../../config");
const guildClubView = require("./guildClubView");

async function resolveAnnounceChannel(client) {
  const override = guildClub?.announce?.channelIdOverride;
  if (override) {
    const ch = await client.channels.fetch(override).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }
  if (guildClub?.announce?.useBossChannel && boss?.announceChannelId) {
    const ch = await client.channels.fetch(boss.announceChannelId).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }
  return null;
}

async function announceLevelUp(client, levelUp) {
  const ch = await resolveAnnounceChannel(client);
  if (!ch) return;
  const container = guildClubView.buildLevelUpAnnouncementContainer(levelUp);
  await ch
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch((e) =>
      console.log(`[GUILD_CLUB] announceLevelUp 失敗：${e.message}`.yellow)
    );
}

async function announceQuestReward(client, payload) {
  const ch = await resolveAnnounceChannel(client);
  if (!ch) return;
  const container = guildClubView.buildQuestRewardAnnouncementContainer(payload);
  await ch
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch((e) =>
      console.log(`[GUILD_CLUB] announceQuestReward 失敗：${e.message}`.yellow)
    );
}

async function announceLargeDeposit(client, payload) {
  const ch = await resolveAnnounceChannel(client);
  if (!ch) return;
  const warehouseView = require("./warehouse/warehouseView");
  const container = warehouseView.buildLargeDepositAnnouncement(payload);
  await ch
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch((e) =>
      console.log(`[GUILD_CLUB] announceLargeDeposit 失敗：${e.message}`.yellow)
    );
}

async function announceBanquetStart(client, { club, menu, banquet, starterTag }) {
  const ch = await resolveAnnounceChannel(client);
  if (!ch) return;
  const { formatBuff } = require("../buff/buffLabels");
  const buffStr = (banquet?.buffs || [])
    .map((b) => formatBuff(b.type, b.value))
    .join("・");
  const durMin = Math.floor((menu?.durationMs || 0) / 60000);
  await ch
    .send({
      content:
        `🍽️ **${club.name}** 召開宴席！\n` +
        `主廚：${starterTag}\n` +
        `菜色：**${menu?.emoji || ""} ${menu?.name || banquet?.menu_id}**\n` +
        `效果：${buffStr}（${durMin} 分鐘，全公會生效）\n` +
        `席至 <t:${Math.floor(banquet.expires_at / 1000)}:R>`,
      allowedMentions: { parse: [] },
    })
    .catch((e) =>
      console.log(`[GUILD_CLUB] announceBanquetStart 失敗：${e.message}`.yellow)
    );
}

module.exports = {
  resolveAnnounceChannel,
  announceLevelUp,
  announceQuestReward,
  announceLargeDeposit,
  announceBanquetStart,
};
