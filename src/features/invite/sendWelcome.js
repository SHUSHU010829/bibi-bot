require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  MessageFlags,
} = require("discord.js");
const { welcomeSystem } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const notifyPrefs = require("../reminders/notifyPrefs");

const ACCENT = welcomeSystem?.accentColor ?? 0x57f287;

function buildChannelContainer({ invitee, inviter, welcomeAmount }) {
  const container = new ContainerBuilder().setAccentColor(ACCENT);

  const header = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎉 歡迎新成員加入！\n<@${invitee.id}> 來啦，給點掌聲 👏`
    )
  );
  const avatarUrl = invitee.displayAvatarURL?.({ extension: "png", size: 256 });
  if (avatarUrl) {
    header.setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl));
  }
  container.addSectionComponents(header);

  container.addSeparatorComponents(new SeparatorBuilder());
  const lines = [`🔗 邀請人：<@${inviter.id}>`];
  if (welcomeAmount > 0) {
    lines.push(`${COIN_EMOJI} 獲得歡迎金 **+${welcomeAmount.toLocaleString()}**`);
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n"))
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 輸入 `/help` 看看有哪些指令、玩法和賺幣方式 🚀"
    )
  );
  return container;
}

function buildDmContainer({ guild, member, invitee, inviter, welcomeAmount }) {
  const displayName = member?.displayName || invitee.username;
  const container = new ContainerBuilder().setAccentColor(ACCENT);

  const header = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎉 歡迎加入 ${guild.name}！\n嗨 ${displayName}，很高興你來 👋`
    )
  );
  const iconUrl = guild.iconURL?.({ extension: "png", size: 256 });
  if (iconUrl) {
    header.setThumbnailAccessory(new ThumbnailBuilder().setURL(iconUrl));
  }
  container.addSectionComponents(header);

  container.addSeparatorComponents(new SeparatorBuilder());
  const lines = [`🔗 邀請你的是 **${inviter.username}**`];
  if (welcomeAmount > 0) {
    lines.push(`${COIN_EMOJI} 你已獲得歡迎金 **+${welcomeAmount.toLocaleString()}**`);
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n"))
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 在伺服器輸入 `/help` 就能看到所有玩法，開始賺你的第一桶金 🚀"
    )
  );
  return container;
}

module.exports = async (client, { guild, member, invitee, inviter, welcomeAmount }) => {
  if (!welcomeSystem?.enabled) return;
  if (!guild || !invitee || !inviter) return;
  const amount = Math.max(0, Math.floor(welcomeAmount || 0));

  const channelId = welcomeSystem.announceChannelId;
  if (channelId) {
    const channel =
      client.channels.cache.get(channelId) ||
      (await client.channels.fetch(channelId).catch(() => null));
    if (channel?.isTextBased?.()) {
      await channel
        .send({
          components: [
            buildChannelContainer({ invitee, inviter, welcomeAmount: amount }),
          ],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [invitee.id, inviter.id] },
        })
        .catch((e) =>
          console.log(`[INVITE] welcome announce failed: ${e.message}`.yellow)
        );
    }
  }

  if (welcomeSystem.dm !== false) {
    const masterOn = await notifyPrefs
      .isMasterEnabled(client, invitee.id, guild.id)
      .catch(() => true);
    if (masterOn) {
      await invitee
        .send({
          components: [
            buildDmContainer({ guild, member, invitee, inviter, welcomeAmount: amount }),
          ],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    }
  }
};
