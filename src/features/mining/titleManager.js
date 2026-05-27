require("colors");
const { EmbedBuilder } = require("discord.js");
const { mining, commandChannels } = require("../../config");
const { getOrCreate } = require("./miningProfile");

function titlesCfg() {
  return mining?.titles || {};
}

function titleDefs() {
  return titlesCfg().defs || {};
}

function titleDef(id) {
  return titleDefs()[id] || null;
}

function titleOrder() {
  const order = titlesCfg().order;
  if (Array.isArray(order) && order.length) return order;
  return Object.keys(titleDefs());
}

// 欄位名稱 / footer 不會渲染自訂 emoji，但稱號 emoji 都是 unicode，可安全內嵌。
function titleLabel(id) {
  const d = titleDef(id);
  if (!d) return id;
  return `${d.emoji || ""} ${d.name || id}`.trim();
}

function allTitleRoleIds() {
  return Object.values(titleDefs())
    .map((d) => d?.roleId)
    .filter((r) => typeof r === "string" && r.length > 0);
}

async function addTitleRole(member, def) {
  if (!titlesCfg().roleSyncEnabled) return;
  if (!member?.roles?.add || !def?.roleId) return;
  await member.roles.add(def.roleId).catch((e) => {
    console.log(`[TITLE] add role ${def.roleId} failed: ${e.message}`.yellow);
  });
}

// 解鎖一個稱號：寫進 unlocked_titles（idempotent）並同步身分組。
async function grantTitle(client, { userId, guildId, member, titleId }) {
  const def = titleDef(titleId);
  if (!def) return { ok: false, reason: "no_title" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $addToSet: { unlocked_titles: titleId },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  );
  const newlyAdded = (res.modifiedCount || 0) > 0 || (res.upsertedCount || 0) > 0;

  await addTitleRole(member, def);

  return { ok: true, newlyAdded, def };
}

// 切換展示稱號：先移除 member 身上所有稱號角色，再加上選定的。
async function setActiveTitle(client, { userId, guildId, member, titleId }) {
  const def = titleDef(titleId);
  if (!def) return { ok: false, reason: "no_title" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const unlocked = profile.unlocked_titles || [];
  if (!unlocked.includes(titleId)) {
    return { ok: false, reason: "locked", def };
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $set: { active_title: titleId, updatedAt: new Date() } }
  );

  // 身分組同步：移除所有稱號角色 → 加回選定的
  if (titlesCfg().roleSyncEnabled && member?.roles) {
    const roleIds = allTitleRoleIds();
    const toRemove = roleIds.filter(
      (rid) => rid !== def.roleId && member.roles.cache?.has(rid)
    );
    for (const rid of toRemove) {
      await member.roles.remove(rid).catch(() => {});
    }
    await addTitleRole(member, def);
  }

  return { ok: true, def };
}

// 移除一個稱號（週冠更替時用）：從 unlocked_titles 移除、卸身分組，
// 若該稱號正被展示則退回預設稱號。
async function revokeTitle(client, { userId, guildId, member, titleId }) {
  const def = titleDef(titleId);
  if (!def || !client.miningProfilesCollection) return;

  const profile = await client.miningProfilesCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  const set = { updatedAt: new Date() };
  if (profile?.active_title === titleId) set.active_title = "novice_miner";

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $pull: { unlocked_titles: titleId }, $set: set }
  );

  if (titlesCfg().roleSyncEnabled && member?.roles?.remove && def.roleId) {
    await member.roles.remove(def.roleId).catch(() => {});
  }
}

function announceChannelId() {
  return (
    titlesCfg().announceChannelId ||
    mining?.announceChannelId ||
    commandChannels?.mining?.[0] ||
    ""
  );
}

// 公告新解鎖的稱號。member 用來組 mention 與決定 guild。
async function announceTitle(client, { member, userId, titleId }) {
  const def = titleDef(titleId);
  if (!def) return;
  const channelId = announceChannelId();
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const mention = member?.user ? `${member.user}` : `<@${userId}>`;
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("🏅 解鎖新稱號！")
    .setDescription(
      `${mention} 解鎖了稱號 **${titleLabel(titleId)}**！\n` +
        `用 \`/稱號 設定\` 把它掛上展示吧。`
    )
    .setFooter({ text: def.desc || "" });

  await channel.send({ embeds: [embed] }).catch(() => {});
}

module.exports = {
  titlesCfg,
  titleDefs,
  titleDef,
  titleOrder,
  titleLabel,
  allTitleRoleIds,
  grantTitle,
  setActiveTitle,
  revokeTitle,
  announceTitle,
  announceChannelId,
};
