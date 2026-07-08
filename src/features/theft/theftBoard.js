// 頻道置頂「即時通緝看板」：由 bot 維護一則置頂訊息，通緝狀態一變就重繪。
// 倒數用 <t:…:R>（Discord 客戶端自動更新），故僅在通緝集合/狀態改變時才 edit。
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { theft } = require("../../config");
const theftService = require("./theftService");

const MAX_SHOWN = 7;

function boardKey(guildId) {
  return `theftBoard:${guildId}`;
}

async function render(client, guildId) {
  const rows = await theftService.listWanted(client, guildId);
  const clearAt = theft?.hunt?.escapeClearCount ?? 5;

  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("# 🚨 逼逼鎮・即時通緝看板"));

  if (!rows.length) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 目前海清河晏，無人在逃。"));
  } else {
    for (const w of rows.slice(0, MAX_SHOWN)) {
      const ttl = Math.floor(new Date(w.expires_at).getTime() / 1000);
      const hiding = w.hunt_cooldown_until && Date.now() < w.hunt_cooldown_until;
      const statusLine = hiding
        ? `🫥 躲藏中 — <t:${Math.floor(w.hunt_cooldown_until / 1000)}:R> 後可追捕`
        : "🎯 可追捕";
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `🔴 <@${w.userId}>\n` +
              `賞金 **${w.bounty.toLocaleString()}** 🪙　|　通緝到期 <t:${ttl}:R>\n` +
              `${statusLine}　|　已躲過 ${w.escape_count || 0}/${clearAt} 次`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`theft_hunt_${w.userId}`)
              .setLabel("追捕")
              .setEmoji("🕵️")
              .setStyle(ButtonStyle.Danger)
              .setDisabled(!!hiding)
          )
        );
    }
    if (rows.length > MAX_SHOWN) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 還有 ${rows.length - MAX_SHOWN} 名在逃（賞金由高至低）。`)
      );
    }
  }

  const fund = await theftService.getFund(client, guildId).catch(() => 0);
  if (fund > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🏦 **治安基金**：${fund.toLocaleString()} 🪙\n-# 每週日 21:00 發給本週賞金收入最高的獵人`
        )
      );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# 即時更新 · `/偷竊` 犯案、點上方「追捕」鈕領賞、`/自首` 脫身")
  );
  return container;
}

// 重繪置頂看板（沒有就建立並置頂）。derive guildId 自廣播頻道，單一頻道即可。
async function refresh(client) {
  try {
    const chId = theft?.announceChannelId;
    if (!chId || !client.countersCollection) return;
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const guildId = ch.guildId || ch.guild?.id;
    if (!guildId) return;

    const payload = {
      components: [await render(client, guildId)],
      flags: MessageFlags.IsComponentsV2,
    };

    const rec = await client.countersCollection.findOne({ _id: boardKey(guildId) }).catch(() => null);
    if (rec?.messageId) {
      const msg = await ch.messages.fetch(rec.messageId).catch(() => null);
      if (msg) {
        await msg.edit(payload).catch(() => {});
        return;
      }
    }
    const msg = await ch.send(payload).catch(() => null);
    if (msg) {
      await msg.pin().catch(() => {});
      await client.countersCollection
        .updateOne(
          { _id: boardKey(guildId) },
          { $set: { channelId: chId, messageId: msg.id, updatedAt: new Date() } },
          { upsert: true }
        )
        .catch(() => {});
    }
  } catch (_) {
    /* 看板是輔助功能，失敗不影響主流程 */
  }
}

module.exports = { refresh };
