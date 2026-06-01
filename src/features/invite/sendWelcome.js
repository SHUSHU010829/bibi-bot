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

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 公告開場白（隨機，讓每次入群不一樣）
const CHANNEL_TAGLINES = [
  "來啦，全體起立鼓掌 👏",
  "閃亮登場，麻煩掌聲伺候 🌟",
  "新血加入，全村士氣 +10 💪",
  "又有人被騙…呃我是說，被邀請進來了 🎣",
  "貴客到，紅毯鋪起來 🎩",
  "歡迎這位勇者降臨本服 ⚔️",
  "嗶嗶！偵測到一位可愛的新成員 🚨",
  "恭喜本服喜獲新成員一枚 🎁",
];

// 私訊開場白（{name} 會換成顯示名稱）
const DM_GREETINGS = [
  "嗨 {name}，很高興你來，先喝杯歡迎飲料 🥤",
  "{name} 你終於來了，這裡的座位幫你留好了 🪑",
  "歡迎 {name}！江湖險惡，但這裡有錢可以賺 💰",
  "{name} 上線！準備好開啟你的發財之路了嗎 🚀",
  "哈囉 {name}，先別急著潛水，玩法可多了 🤿",
];

function buildChannelContainer({ invitee, inviter, welcomeAmount }) {
  const container = new ContainerBuilder().setAccentColor(ACCENT);

  const header = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎉 歡迎新成員加入！\n<@${invitee.id}> ${pick(CHANNEL_TAGLINES)}`
    )
  );
  const avatarUrl = invitee.displayAvatarURL?.({ extension: "png", size: 256 });
  if (avatarUrl) {
    header.setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl));
  }
  container.addSectionComponents(header);

  container.addSeparatorComponents(new SeparatorBuilder());
  const lines = [`🔗 牽線人：<@${inviter.id}>，記得回頭謝謝他 🙏`];
  if (welcomeAmount > 0) {
    lines.push(`${COIN_EMOJI} 入坑禮金 **+${welcomeAmount.toLocaleString()}** 已直接入帳`);
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n"))
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 不知道從哪開始？輸入 `/help`，玩法、賺幣、發財套路一次看懂 🚀"
    )
  );
  return container;
}

function buildDmContainer({ guild, member, invitee, inviter, welcomeAmount }) {
  const displayName = member?.displayName || invitee.username;
  const container = new ContainerBuilder().setAccentColor(ACCENT);

  const header = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎉 歡迎加入 ${guild.name}！\n${pick(DM_GREETINGS).replace("{name}", displayName)}`
    )
  );
  const iconUrl = guild.iconURL?.({ extension: "png", size: 256 });
  if (iconUrl) {
    header.setThumbnailAccessory(new ThumbnailBuilder().setURL(iconUrl));
  }
  container.addSectionComponents(header);

  container.addSeparatorComponents(new SeparatorBuilder());
  const lines = [`🔗 把你拐進來的是 **${inviter.username}**（要謝謝他 😏）`];
  if (welcomeAmount > 0) {
    lines.push(`${COIN_EMOJI} 入坑禮金 **+${welcomeAmount.toLocaleString()}** 已經放進你口袋`);
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n"))
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 在伺服器輸入 `/help`，馬上開始賺你的第一桶金 🚀"
    )
  );
  return container;
}

function buildInviterDmContainer({
  guild,
  inviteeName,
  inviterReward,
  position,
  cappedByDaily,
}) {
  const container = new ContainerBuilder().setAccentColor(ACCENT);

  const header = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎊 邀請成功！\n你邀請的 **${inviteeName}** 剛剛加入了 ${guild.name}`
    )
  );
  const iconUrl = guild.iconURL?.({ extension: "png", size: 256 });
  if (iconUrl) {
    header.setThumbnailAccessory(new ThumbnailBuilder().setURL(iconUrl));
  }
  container.addSectionComponents(header);

  container.addSeparatorComponents(new SeparatorBuilder());
  const lines = [];
  if (cappedByDaily || inviterReward <= 0) {
    lines.push("🪙 今日邀請獎勵已達上限，這位暫時沒有獎勵金");
    lines.push(`🏅 這是你邀請的第 **${position}** 位（仍計入邀請數）`);
  } else {
    lines.push(`${COIN_EMOJI} 你獲得邀請獎勵 **+${inviterReward.toLocaleString()}**`);
    lines.push(`🏅 這是你邀請的第 **${position}** 位`);
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join("\n"))
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      cappedByDaily
        ? "-# 明天上限會重置，再揪人就有獎勵囉 ⏰"
        : "-# 邀請越多人，下一位的獎勵金越高 💰 用 `/邀請` 看你的戰績"
    )
  );
  return container;
}

module.exports = async (
  client,
  { guild, member, invitee, inviter, welcomeAmount, inviterReward, activeCount, cappedByDaily }
) => {
  if (!welcomeSystem?.enabled) return;
  if (!guild || !invitee || !inviter) return;
  const amount = Math.max(0, Math.floor(welcomeAmount || 0));
  const dmOn = welcomeSystem.dm !== false;

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

  if (!dmOn) return;

  // 私訊新成員
  const inviteeMasterOn = await notifyPrefs
    .isMasterEnabled(client, invitee.id, guild.id)
    .catch(() => true);
  if (inviteeMasterOn) {
    await invitee
      .send({
        components: [
          buildDmContainer({ guild, member, invitee, inviter, welcomeAmount: amount }),
        ],
        flags: MessageFlags.IsComponentsV2,
      })
      .catch(() => {});
  }

  // 私訊邀請人：入帳明細 + 目前第幾位
  const inviterMasterOn = await notifyPrefs
    .isMasterEnabled(client, inviter.id, guild.id)
    .catch(() => true);
  if (inviterMasterOn) {
    await inviter
      .send({
        components: [
          buildInviterDmContainer({
            guild,
            inviteeName: member?.displayName || invitee.username,
            inviterReward: Math.max(0, Math.floor(inviterReward || 0)),
            position: Math.max(0, Math.floor(activeCount || 0)) + 1,
            cappedByDaily: !!cappedByDaily,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      })
      .catch(() => {});
  }
};
