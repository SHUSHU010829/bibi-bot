require("colors");

const cron = require("node-cron");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const { DateTime } = require("luxon");

const { twitchPerks, twitchSync, serverId } = require("../../config");
const { getItem } = require("../../features/shop/catalog");

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3;

function tier3RoleId() {
  return twitchSync?.tierRoleIds?.tier3 || "";
}

// 已在本月發過免費稱號就跳過（idempotent）。
async function alreadyGrantedThisMonth(client, userId, guildId, source, tz) {
  const monthStart = DateTime.now().setZone(tz).startOf("month").toJSDate();
  const existing = await client.userInventoryCollection
    .findOne({
      userId,
      guildId,
      type: "custom_title",
      source,
      acquiredAt: { $gte: monthStart },
    })
    .catch(() => null);
  return !!existing;
}

async function grantFreeTitle(client, member, cfg) {
  const userId = member.id;
  const guildId = member.guild.id;
  const source = cfg.source || "twitch_tier3_monthly";

  if (await alreadyGrantedThisMonth(client, userId, guildId, source, cfg.timezone)) {
    return false;
  }

  const item = getItem(cfg.itemId) || {
    name: "自訂稱號（30 天）",
    type: "custom_title",
    payload: {},
  };
  const durationDays = cfg.durationDays || item.durationDays || 30;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await client.userInventoryCollection.insertOne({
    userId,
    guildId,
    itemId: cfg.itemId,
    name: item.name,
    type: "custom_title",
    payload: item.payload || {},
    equipped: false,
    expiresAt,
    acquiredAt: now,
    updatedAt: now,
    source,
    freeGrant: true,
  });

  const expEpoch = Math.floor(expiresAt.getTime() / 1000);
  const container = new ContainerBuilder()
    .setAccentColor(0x9146ff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🪪 Tier 3 訂閱者每月好禮\n` +
          "感謝你的 **Twitch Tier 3** 訂閱！這個月的免費 **自訂稱號（30 天）** 已送到你的背包。\n" +
          "到 `/商店` 的背包選單就能設定你想顯示的稱號文字。",
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**有效期限**\n<t:${expEpoch}:R>（<t:${expEpoch}:f>）`,
      ),
    );

  await member
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    })
    .catch(() => {});
  return true;
}

async function runMonthlyTitle(client) {
  if (!twitchPerks?.enabled) return;
  if (!twitchPerks?.tiers?.tier3?.monthlyFreeTitleEnabled) return;
  if (!client.userInventoryCollection) return;

  const roleId = tier3RoleId();
  if (!roleId) {
    console.log(`[TWITCH_PERK] 未設定 Tier3 角色 ID，跳過每月稱號`.yellow);
    return;
  }

  const guildId = twitchSync?.guildId || serverId;
  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  await guild.members.fetch().catch(() => {});
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    console.log(`[TWITCH_PERK] 找不到 Tier3 角色 ${roleId}`.yellow);
    return;
  }

  const cfg = twitchPerks.monthlyTitle || {};
  let granted = 0;
  for (const member of role.members.values()) {
    const ok = await grantFreeTitle(client, member, cfg).catch((e) => {
      console.log(`[TWITCH_PERK] 發放失敗 user=${member.id}: ${e.message}`.yellow);
      return false;
    });
    if (ok) granted += 1;
  }
  console.log(
    `[TWITCH_PERK] Tier3 每月稱號發放完成：${granted}/${role.members.size} 位`.cyan
  );
}

module.exports = async (client) => {
  if (task) return;
  if (!twitchPerks?.enabled) return;
  if (!twitchPerks?.tiers?.tier3?.monthlyFreeTitleEnabled) return;

  const cfg = twitchPerks.monthlyTitle || {};
  const schedule = cfg.cronSchedule || "0 9 1 * *";
  const tz = cfg.timezone || "Asia/Taipei";

  task = cron.schedule(
    schedule,
    async () => {
      try {
        await runMonthlyTitle(client);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        console.log(
          `[ERROR] twitchMonthlyTitle failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log(`[ERROR] 連續錯誤過多，停止 Tier3 每月稱號 cron`.red);
          task.stop();
        }
      }
    },
    { timezone: tz }
  );

  console.log(`[TWITCH_PERK] Tier3 每月稱號排程已啟動：${schedule} (${tz})`.cyan);
};
