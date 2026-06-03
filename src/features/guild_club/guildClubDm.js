require("colors");
const { EmbedBuilder } = require("discord.js");
const notifyPrefs = require("../reminders/notifyPrefs");

async function notifyNewApplication(
  client,
  { leaderId, guildId, applicantId, clubName, message }
) {
  if (!leaderId || !guildId) return;
  try {
    const masterOn = await notifyPrefs.isMasterEnabled(client, leaderId, guildId);
    if (!masterOn) return;

    const user = await client.users.fetch(leaderId).catch(() => null);
    if (!user) return;

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle("📬 收到公會申請")
      .setDescription(
        `<@${applicantId}> 申請加入你的公會「${clubName}」`
      )
      .addFields({
        name: "申請理由",
        value: message ? message.slice(0, 1000) : "（未填）",
      })
      .setFooter({
        text: "用 /公會 申請列表 處理｜不想再收到提醒？/通知設定 即可關閉",
      });

    await user.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.log(`[GUILD_CLUB] notifyNewApplication 失敗：${e.message}`.yellow);
  }
}

module.exports = {
  notifyNewApplication,
};
