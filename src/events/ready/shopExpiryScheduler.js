require("colors");

const { registerCron } = require("../../utils/cronRegistry");

// 每 10 分鐘掃過期 inventory：
// - role_color: 拔掉 Discord 身份組 + 標記 inventory expired
// - 其他 type: 標記 expired

async function sweepOnce(client) {
  if (!client.userInventoryCollection) return { expired: 0 };

  const now = new Date();
  const cursor = client.userInventoryCollection.find({
    expiresAt: { $lte: now },
    expired: { $ne: true },
  });

  let expired = 0;
  while (await cursor.hasNext()) {
    const inv = await cursor.next();
    try {
      if (inv.type === "role_color" && inv.equipped && inv.payload?.hex) {
        const guild = client.guilds.cache.get(inv.guildId);
        const member = guild
          ? await guild.members.fetch(inv.userId).catch(() => null)
          : null;
        if (guild && member && client.shopRoleCacheCollection) {
          const cached = await client.shopRoleCacheCollection
            .findOne({ guildId: inv.guildId, hex: inv.payload.hex })
            .catch(() => null);
          if (cached?.roleId) {
            await member.roles.remove(cached.roleId).catch(() => {});
          }
        }
      }
      if (inv.type === "custom_title" && inv.equipped) {
        if (client.userLevelsCollection) {
          await client.userLevelsCollection
            .updateOne(
              { userId: inv.userId, guildId: inv.guildId, title: { $exists: true } },
              { $set: { title: null, updatedAt: new Date() } },
            )
            .catch(() => {});
        }
      }

      await client.userInventoryCollection.updateOne(
        { _id: inv._id },
        {
          $set: {
            expired: true,
            equipped: false,
            updatedAt: new Date(),
          },
        },
      );

      expired += 1;
      console.log(
        `[SHOP] 過期道具：user=${inv.userId} item=${inv.itemId} type=${inv.type}`.gray,
      );
    } catch (e) {
      console.log(`[ERROR] shop expiry handle inv ${inv._id}: ${e}`.red);
    }
  }
  return { expired };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "shop.expiry",
    label: "商店道具過期清理",
    schedule: "*/10 * * * *",
    runner: () => sweepOnce(client),
  });
};
