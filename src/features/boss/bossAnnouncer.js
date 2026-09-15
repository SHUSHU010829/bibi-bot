require("colors");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { boss } = require("../../config");
const { buildSettlementContainer } = require("./bossView");
const bossBoard = require("./bossBoard");
const bossEngine = require("./bossEngine");

function pickFrom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function resolveChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

function noticeCfg() {
  return boss?.preNotice || {};
}

function fillNotice(tpl, { spawnAt, minutes, contributorCount }) {
  const sec = Math.floor(spawnAt / 1000);
  return tpl
    .replace(/\{time\}/g, `<t:${sec}:t>`)
    .replace(/\{relative\}/g, `<t:${sec}:R>`)
    .replace(/\{minutes\}/g, String(minutes ?? 0))
    .replace(/\{contributors\}/g, String(contributorCount ?? 0));
}

// 出沒預告專用頻道（跟戰鬥頻道分開，只放「幾點會出現」這種小通知）。
async function sendNotice(client, content) {
  const nc = noticeCfg();
  if (!nc.enabled || !content) return;
  const ch = await resolveChannel(client, nc.channelId || boss?.announceChannelId);
  if (!ch) return;
  await ch.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

// 能量集滿的當下：先講「魔王被喚醒了，幾點會來」，不然玩家只看到能量條歸零會以為壞掉。
async function announceSummonReserved(client, { spawnAt, contributorCount }) {
  const tpl = pickFrom(noticeCfg().reserveMessages);
  if (!tpl) return;
  await sendNotice(client, fillNotice(tpl, {
    spawnAt,
    minutes: noticeCfg().minutesBefore ?? 0,
    contributorCount,
  }));
}

// 出沒前 minutesBefore 分鐘的小通知（召喚場與週六固定場共用）。
async function announcePreNotice(client, { spawnAt, source, contributorCount }) {
  const nc = noticeCfg();
  const tpl = pickFrom(source === "saturday" ? nc.saturdayMessages : nc.summonMessages);
  if (!tpl) return;
  const minutes = Math.max(1, Math.round((spawnAt - Date.now()) / 60000));
  await sendNotice(client, fillNotice(tpl, { spawnAt, minutes, contributorCount }));
}

// 出場公告刻意只講「開打前要知道的三件事」：牠多硬、打到什麼時候、每人能砍幾刀。
// 技能 / 事件 / 號角併成一塊「戰場變數」，獎勵只寫最高檔與分潤規則——
// 完整的檔位表在戰鬥中的攻擊結果與結算公告都會再出現，出場公告再列一次只會洗掉重點。
function statField(bossDoc) {
  const basis = bossDoc.participant_basis != null
    ? `\n-# 依 ${bossDoc.participant_basis} 名預估參戰者 × 社群平均戰力換算`
    : "";
  return {
    name: "💖 血量",
    value: `**${bossDoc.max_hp.toLocaleString()}**${basis}`,
    inline: true,
  };
}

function deadlineField(bossDoc) {
  // ends_at 為 null＝無時限場（招喚場 durationMinutes 設 0 時），待到被擊殺為止。
  return bossDoc.ends_at != null
    ? { name: "⏳ 戰鬥結束", value: `<t:${Math.floor(bossDoc.ends_at / 1000)}:R>`, inline: true }
    : { name: "⏳ 討伐期限", value: "無時限，待到被擊殺", inline: true };
}

function attackField(bossDoc) {
  const limit = bossEngine.baseAttackLimitFor(bossDoc);
  const cdSec = boss?.attackCooldownSec ?? 0;
  return {
    name: "⚔️ 出刀",
    value: cdSec > 0 ? `每人 **${limit}** 次\n-# 每刀間隔 ${cdSec} 秒` : `每人 **${limit}** 次`,
    inline: true,
  };
}

// 戰場變數＝戰鬥中會突然改寫規則的三件事，各一行講完就好。
function battlefieldField(bossDoc) {
  const lines = [];
  const skills = (boss?.skills?.enabled ? boss.skills.list || [] : [])
    .map((s) => `${s.emoji} ${s.name}`)
    .join("・");
  if (skills) lines.push(`**魔王技能**　${skills}`);

  const events = (boss?.playerEvents?.enabled ? boss.playerEvents.list || [] : [])
    .map((e) => `${e.emoji} ${e.name}`)
    .join("・");
  if (events) lines.push(`**攻擊事件**　${events}`);

  const rcfg = boss?.rally || {};
  const rallySources = Array.isArray(rcfg.spawnSources) ? rcfg.spawnSources : ["summon"];
  if (rcfg.enabled && rallySources.includes(bossDoc.spawn_source)) {
    lines.push(
      `**📣 反攻號角**　全場累積 ${rcfg.hitsPerRally ?? 0} 刀還沒打倒牠 → 全員出刀次數 +${rcfg.attackBonus ?? 0}`
      + `（最多 ${rcfg.maxRallies ?? 0} 次）`,
    );
  }
  if (!lines.length) return null;
  return {
    name: "🎲 戰場變數",
    value: `${lines.join("\n")}\n-# 技能每隔幾分鐘發動一次，攻擊事件每刀都有機會觸發——看到公告就知道該衝還是該等。`,
    inline: false,
  };
}

// 獎勵只講「出手就有」與「打贏才有」兩句，檔位細節留給結算公告。
function rewardField() {
  const tiers = [...(boss?.rewards?.participation?.tiers || [])]
    .sort((a, b) => (a.minDamage ?? 0) - (b.minDamage ?? 0));
  if (!tiers.length) return null;
  const bottom = tiers[0];
  const top = tiers[tiers.length - 1];
  const topGains = [`${(top.coins || 0).toLocaleString()} 金幣`, `${top.xp || 0} 經驗`];
  if (top.rare > 0) topGains.push(`✨ 傳說碎片 ×${top.rare}`);
  if (top.diamond > 0) topGains.push(`💎 鑽石 ×${top.diamond}`);
  const poolPct = Math.round((boss?.rewards?.poolRatio ?? 0) * 100);
  return {
    name: "🎖️ 獎勵",
    value: `**出手就有**　${(bottom.coins || 0).toLocaleString()} 金幣起，傷害越高檔位越高`
      + `（最高 ${top.emoji} ${top.name}：${topGains.join("・")}）\n`
      + `**擊敗才有**　傷害分潤（血量 ×${poolPct}% 的獎勵池）、排名掉落、尾刀與首刀獎`,
    inline: false,
  };
}

async function announceSpawn(client, bossDoc, opts = {}) {
  const intro = opts.summon
    ? (boss?.summon?.summonIntro || "討伐能量集滿，魔王被喚醒了！")
    : (pickFrom(boss?.spawnIntros) || "傳說中的存在現身了！");
  const battlefield = battlefieldField(bossDoc);
  const reward = rewardField();

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`${opts.summon ? "🔮 " : ""}${bossDoc.emoji} ${bossDoc.name} 出現！`)
    .setDescription(intro)
    .addFields(
      statField(bossDoc),
      deadlineField(bossDoc),
      attackField(bossDoc),
      ...(battlefield ? [battlefield] : []),
      ...(reward ? [reward] : []),
    )
    .setFooter({
      text: opts.summon
        ? `由社群 ${opts.contributorCount || 0} 位冒險者喚醒 · /魔王 攻擊 一起討伐！`
        : "輸入 /魔王 攻擊 一起討伐！",
    });

  // 出場公告同步到戰鬥頻道與編年史頻道（結算公告同樣走兩邊）。
  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  const liveCh = await resolveChannel(client, boss?.announceChannelId);
  if (liveCh) await liveCh.send(payload).catch(() => {});
  if (boss?.chronicleChannelId && boss.chronicleChannelId !== boss.announceChannelId) {
    const chronicleCh = await resolveChannel(client, boss.chronicleChannelId);
    if (chronicleCh) await chronicleCh.send(payload).catch(() => {});
  }

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

// 魔王技能 / 脫戰回血的即時播報。events 由 bossSkills.tick 或攻擊結果（破甲）帶出來。
async function announceSkillEvents(client, events) {
  const list = (events || []).filter((e) => e?.text);
  if (!list.length) return;
  const ch = await resolveChannel(client, boss?.announceChannelId);
  if (!ch) return;
  for (const e of list) {
    const content = e.hint ? `${e.text}\n${e.hint}` : e.text;
    await ch.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }
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
  announceSpawn,
  announceSummonReserved,
  announcePreNotice,
  announcePhase,
  announceCombo,
  announceSkillEvents,
  announceSettlement,
};
