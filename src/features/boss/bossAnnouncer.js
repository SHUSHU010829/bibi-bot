require("colors");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { boss } = require("../../config");
const { buildSettlementContainer } = require("./bossView");
const bossBoard = require("./bossBoard");

function pickFrom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function resolveChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

// 招喚場「出場預告」：魔王甦醒但還沒登場，一小時後才正式出場。
async function announcePreview(client, bossDoc, opts = {}) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const spawnAt = Math.floor((bossDoc.spawn_at || Date.now()) / 1000);
  const intro = boss?.summon?.previewIntro || "討伐能量集滿，一隻魔王正在甦醒——";
  const flavor = pickFrom(boss?.summon?.previewIntros);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🔮 出場預告：${bossDoc.emoji} ${bossDoc.name} 即將現身！`)
    .setDescription(flavor ? `${intro}\n\n${flavor}` : intro)
    .addFields(
      { name: "⏰ 正式出場", value: `<t:${spawnAt}:R>（<t:${spawnAt}:t>）`, inline: false },
      { name: "🗡️ 討伐準備", value: "趁現在 /合成 強化武器、/烹飪 備 buff，出場後就能立刻開打！", inline: false },
    )
    .setFooter({
      text: `由社群 ${opts.contributorCount || 0} 位冒險者的地下城探索喚醒 · 出場後 /魔王 攻擊 一起討伐！`,
    });

  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function announceSpawn(client, bossDoc, opts = {}) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const endsAt = Math.floor(bossDoc.ends_at / 1000);
  const onlineSuffix = bossDoc.online_count != null
    ? `\n-# 依當前 ${bossDoc.online_count} 名線上玩家決定`
    : "";
  const limit = boss?.attackLimitPerPlayer ?? 5;
  const intro = opts.summon
    ? (boss?.summon?.summonIntro || "討伐能量集滿，魔王被喚醒了！")
    : (pickFrom(boss?.spawnIntros) || "傳說中的存在現身了！");
  const titlePrefix = opts.summon ? "🔮 " : "";

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`${titlePrefix}${bossDoc.emoji} ${bossDoc.name} 出現！`)
    .setDescription(intro)
    .addFields(
      {
        name: "💖 血量",
        value: `${bossDoc.max_hp.toLocaleString()}${onlineSuffix}`,
        inline: false,
      },
      { name: "⏳ 戰鬥結束", value: `<t:${endsAt}:R>`, inline: true },
      { name: "⚔️ 攻擊上限", value: `每人 ${limit} 次`, inline: true },
    )
    .setFooter({
      text: opts.summon
        ? `由社群 ${opts.contributorCount || 0} 位冒險者的地下城探索喚醒 · /魔王 攻擊 一起討伐！`
        : "輸入 /魔王 攻擊 一起討伐！",
    });

  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});

  // 召喚後立即建立置頂即時看板
  bossBoard.scheduleRefresh(client, bossDoc.guild_id, true);
}

async function announcePhase(client, bossDoc, newPhase) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const tpl = boss?.phaseAnnouncements?.[newPhase];
  if (!tpl) return;
  const text = tpl.replace(/\{name\}/g, bossDoc.name);
  await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function announceCombo(client, bossDoc, userId) {
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  const tpl = boss?.comboAnnouncement || "⚡ Combo 滿格！（<@{user}>）";
  const text = tpl.replace(/\{user\}/g, userId).replace(/\{name\}/g, bossDoc.name);
  await ch.send({ content: text, allowedMentions: { users: [userId] } }).catch(() => {});
}

async function announceSettlement(client, settlement) {
  const guild = settlement?.bossDoc?.guild_id
    ? client.guilds.cache.get(settlement.bossDoc.guild_id)
    : null;
  const container = buildSettlementContainer({ ...settlement, guild });
  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
  const liveCh = await resolveChannel(client, boss?.announceChannelId);
  if (liveCh) await liveCh.send(payload).catch(() => {});
  if (boss?.chronicleChannelId && boss.chronicleChannelId !== boss.announceChannelId) {
    const chronicleCh = await resolveChannel(client, boss.chronicleChannelId);
    if (chronicleCh) await chronicleCh.send(payload).catch(() => {});
  }

  // 戰鬥結束：移除置頂看板（結算公告已取代它）
  if (settlement?.bossDoc?.guild_id) {
    await bossBoard.finalize(client, settlement.bossDoc.guild_id);
  }
}

module.exports = {
  announcePreview,
  announceSpawn,
  announcePhase,
  announceCombo,
  announceSettlement,
};
