// 把字串中的 `<@userId>` / `<@!userId>` 換成 guild member 的 displayName，
// 避免排行榜、戰報、結算等 Top N 列表把上榜玩家通通 ping 進私人房間。
// channel mention（<#...>）、role mention（<@&...>）一律不動。
function plainifyUserMentions(guild, text) {
  if (typeof text !== "string") return text;
  return text.replace(/<@!?(\d+)>/g, (_, userId) => {
    const member = guild?.members?.cache.get(userId);
    if (member) return member.displayName;
    const user = guild?.client?.users?.cache.get(userId);
    if (user) return user.username;
    return "未知玩家";
  });
}

function resolveGuild(clientOrGuild, guildId) {
  if (!clientOrGuild) return null;
  if (clientOrGuild.members) return clientOrGuild;
  if (clientOrGuild.guilds && guildId) {
    return clientOrGuild.guilds.cache.get(guildId) || null;
  }
  return null;
}

module.exports = { plainifyUserMentions, resolveGuild };
