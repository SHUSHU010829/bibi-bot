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
        text: "用 /公會 資訊 點「待審 N」按鈕處理｜不想再收到提醒？/通知設定 即可關閉",
      });

    await user.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.log(`[GUILD_CLUB] notifyNewApplication 失敗：${e.message}`.yellow);
  }
}

async function notifyLeaverCooldown(
  client,
  { leaverId, guildId, clubName, rejoinReadyAt }
) {
  if (!leaverId || !guildId) return;
  try {
    const masterOn = await notifyPrefs.isMasterEnabled(client, leaverId, guildId);
    if (!masterOn) return;

    const user = await client.users.fetch(leaverId).catch(() => null);
    if (!user) return;

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle("👋 你已退出公會")
      .setDescription(`你已退出公會「${clubName}」。`);

    if (rejoinReadyAt) {
      embed.addFields({
        name: "🧊 加入新公會冷卻",
        value: `<t:${Math.floor(rejoinReadyAt / 1000)}:R>（<t:${Math.floor(
          rejoinReadyAt / 1000
        )}:F>）後才能加入或申請其他公會。`,
      });
    }

    embed.setFooter({ text: "不想再收到提醒？/通知設定 即可關閉" });

    await user.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.log(`[GUILD_CLUB] notifyLeaverCooldown 失敗：${e.message}`.yellow);
  }
}

async function notifyManagersOfLeave(
  client,
  { managerIds, guildId, leaverId, clubName }
) {
  if (!guildId || !Array.isArray(managerIds) || managerIds.length === 0) return;
  await Promise.all(
    managerIds.map(async (managerId) => {
      try {
        const masterOn = await notifyPrefs.isMasterEnabled(
          client,
          managerId,
          guildId
        );
        if (!masterOn) return;

        const user = await client.users.fetch(managerId).catch(() => null);
        if (!user) return;

        const embed = new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle("👋 公會成員退出")
          .setDescription(`<@${leaverId}> 退出了你的公會「${clubName}」`)
          .setFooter({
            text: "不想再收到提醒？/通知設定 即可關閉",
          });

        await user.send({ embeds: [embed] }).catch(() => {});
      } catch (e) {
        console.log(
          `[GUILD_CLUB] notifyManagersOfLeave 失敗（${managerId}）：${e.message}`
            .yellow
        );
      }
    })
  );
}

module.exports = {
  notifyNewApplication,
  notifyLeaverCooldown,
  notifyManagersOfLeave,
};
