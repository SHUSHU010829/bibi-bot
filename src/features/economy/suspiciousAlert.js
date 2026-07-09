require("colors");
const crypto = require("crypto");
const {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require("discord.js");
const { coinSystem, bank } = require("../../config");
const creditService = require("../bank/creditService");

// 可疑金流告警：扣涉事者信用分、記錄可復原的 flag、發 embed + 「誤報復原」按鈕。
// 三種來源（雙向對敲 pair / 圈狀 ring / 市集溢價 market）共用。

const KIND_META = {
  pair: { title: "⚠️ 可疑雙向轉帳", color: 0xe67e22 },
  ring: { title: "⚠️ 可疑圈狀轉帳", color: 0xe74c3c },
  market: { title: "⚠️ 可疑市集成交", color: 0xe67e22 },
};

async function alertChannel(client) {
  const channelId =
    coinSystem?.adminGrant?.auditLogChannelId || coinSystem?.dailyEconomyReport?.channelId;
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

// { guildId, kind, users:[id...], description, fields?:[{name,value}] }
async function raiseSuspicion(client, { guildId, kind, users, description, fields }) {
  const deltas = {};
  if (bank?.credit?.enabled) {
    for (const uid of users) {
      const r = await creditService.flagSuspicious(client, uid, guildId).catch(() => null);
      if (r && r.delta) deltas[uid] = r.delta; // 實際扣的分（負數）
    }
  }

  const flagId = `flag_${crypto.randomBytes(5).toString("hex")}`;
  const flag = { flagId, guildId, kind, description, fields: fields || [], deltas, restored: false, createdAt: new Date() };
  if (client.creditFlagsCollection) {
    await client.creditFlagsCollection.insertOne(flag).catch(() => {});
  }

  // 即時告警關閉時：仍扣分並記錄可復原 flag（由每日日報統一呈現），不即時發訊息。
  if (coinSystem?.suspiciousImmediateAlert === false) return { flagId, deltas };

  const channel = await alertChannel(client);
  if (!channel) return { flagId, deltas };
  const { embed, row } = buildFlagMessage(flag);
  await channel
    .send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } })
    .catch((e) => console.log(`[SUSP] 告警發送失敗: ${e?.message || e}`.yellow));
  return { flagId, deltas };
}

// 由 flag 紀錄重建告警 embed + 復原按鈕（即時告警與每日日報共用）。
function buildFlagMessage(flag) {
  const meta = KIND_META[flag.kind] || { title: "⚠️ 可疑金流", color: 0xe67e22 };
  const embed = new EmbedBuilder()
    .setColor(flag.restored ? 0x2ecc71 : meta.color)
    .setTitle(meta.title)
    .setDescription(flag.description || "")
    .setTimestamp(flag.createdAt ? new Date(flag.createdAt) : null);
  if (flag.fields?.length) embed.addFields(flag.fields);

  const deltas = flag.deltas || {};
  const docked = Object.keys(deltas).length;
  embed.addFields({
    name: "信用分扣分",
    value: docked
      ? Object.entries(deltas)
          .map(([u, d]) => `<@${u}> ${d}`)
          .join("　")
      : "（涉事者今日已扣過，本次未再扣）",
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`creditrestore_${flag.flagId}`)
      .setLabel(flag.restored ? "已復原" : "誤報，復原扣分")
      .setEmoji(flag.restored ? "✅" : "↩️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!flag.restored || docked === 0),
  );
  return { embed, row };
}

module.exports = { raiseSuspicion, alertChannel, buildFlagMessage };
