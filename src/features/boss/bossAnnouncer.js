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

async function announceSpawn(client, bossDoc, opts = {}) {
  // ends_at 為 null＝招喚場無時間限制，待到被擊殺為止。
  const endField = bossDoc.ends_at != null
    ? { name: "⏳ 戰鬥結束", value: `<t:${Math.floor(bossDoc.ends_at / 1000)}:R>`, inline: true }
    : { name: "⏳ 討伐期限", value: "無時限，待到被擊殺", inline: true };
  const basisSuffix = bossDoc.participant_basis != null
    ? `\n-# 依預估 ${bossDoc.participant_basis} 名參戰者 × 社群平均戰力換算（打得越多人、裝備越好，牠越硬）`
    : "";
  const limit = bossEngine.baseAttackLimitFor(bossDoc);
  const cdSec = boss?.attackCooldownSec ?? 0;
  const cdText = cdSec > 0
    ? `每人 ${limit} 次\n-# 每刀間隔 ${cdSec} 秒`
    : `每人 ${limit} 次`;
  const skillNames = (boss?.skills?.enabled ? boss.skills.list || [] : [])
    .map((s) => `${s.emoji} ${s.name}`)
    .join("・");
  const skillField = skillNames
    ? {
      name: "🎲 魔王技能（戰鬥中不定時發動）",
      value: `${skillNames}\n-# 減傷、回血、禁會心都可能出現；也有讓全場傷害翻倍的破綻窗口，看到公告就衝。`,
      inline: false,
    }
    : null;
  const intro = opts.summon
    ? (boss?.summon?.summonIntro || "討伐能量集滿，魔王被喚醒了！")
    : (pickFrom(boss?.spawnIntros) || "傳說中的存在現身了！");
  const titlePrefix = opts.summon ? "🔮 " : "";
  // 參加獎檔位表放進出場公告，讓玩家一眼看到「出手就有、打越痛拿越多」。
  const ptiers = [...(boss?.rewards?.participation?.tiers || [])]
    .sort((a, b) => (a.minDamage ?? 0) - (b.minDamage ?? 0));
  const participationField = ptiers.length
    ? {
      name: "🎖️ 參加獎（出手就有，依傷害分檔）",
      value: ptiers
        .map((t) => {
          const gains = [`${(t.coins || 0).toLocaleString()} 金幣`, `${t.xp || 0} 經驗`];
          if (t.rare > 0) gains.push(`✨ 傳說碎片 ×${t.rare}`);
          if (t.diamond > 0) gains.push(`💎 鑽石 ×${t.diamond}`);
          const threshold = (t.minDamage ?? 0) > 0 ? `傷害 ≥ ${t.minDamage.toLocaleString()}` : "有出手";
          return `${t.emoji} **${t.name}**（${threshold}）：${gains.join("・")}`;
        })
        .join("\n"),
      inline: false,
    }
    : null;

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`${titlePrefix}${bossDoc.emoji} ${bossDoc.name} 出現！`)
    .setDescription(intro)
    .addFields(
      {
        name: "💖 血量",
        value: `${bossDoc.max_hp.toLocaleString()}${basisSuffix}`,
        inline: false,
      },
      endField,
      { name: "⚔️ 攻擊上限", value: cdText, inline: true },
      ...(skillField ? [skillField] : []),
      ...(participationField ? [participationField] : []),
    )
    .setFooter({
      text: opts.summon
        ? `由社群 ${opts.contributorCount || 0} 位冒險者的地下城探索喚醒 · /魔王 攻擊 一起討伐！`
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
  announcePhase,
  announceCombo,
  announceSkillEvents,
  announceSettlement,
};
