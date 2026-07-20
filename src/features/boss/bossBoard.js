// 頻道置頂「魔王即時戰況看板」：bot 維護一則置頂訊息，攻擊 / 階段 / 寶箱狀態一變就原地重繪。
// 在洗頻道的環境也能靠釘選一鍵找到最新血量、排行與正在出現的寶箱。
// 倒數用 <t:…:R> 由客戶端自動更新；重繪節流成最多每 MIN_INTERVAL_MS 一次並保證尾更新，避免編輯限流。
require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { boss } = require("../../config");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");
const bossEngine = require("./bossEngine");
const { phaseColor, phaseLabel, hpBar } = require("./bossView");

const MIN_INTERVAL_MS = 3000;
const lastAt = new Map();
const timers = new Map();

function boardKey(guildId) {
  return `bossBoard:${guildId}`;
}

function nameOf(guild, userId) {
  return plainifyUserMentions(guild, `<@${userId}>`);
}

async function resolveChannel(client) {
  const id = boss?.announceChannelId;
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

function render(info, guild) {
  const b = info.boss;
  const phase = b.phase || "normal";
  const container = new ContainerBuilder()
    .setAccentColor(phaseColor(phase))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${b.emoji} ${b.name} — ${phaseLabel(phase)}`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**血量**\n${hpBar(b.current_hp, b.max_hp)}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⏰ 結束 <t:${Math.floor(b.ends_at / 1000)}:R>${info.comboActive ? `　⚡ Combo ×${boss?.combo?.bonusMult ?? 1.3}` : ""}`,
      ),
    );

  const rageStacks = bossEngine.rageState(b).stacks;
  if (rageStacks > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 😡 怒氣 Lv.${rageStacks}｜反擊率升至 ${Math.round(bossEngine.effectiveCounterRate(b) * 100)}%`,
      ),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  if (info.ranking?.length) {
    const aggroOn = boss?.aggro?.enabled && info.ranking.length >= (boss?.aggro?.minParticipants ?? 2);
    const lines = info.ranking.slice(0, 5).map((r, i) => {
      const target = aggroOn && i === 0 ? " 🎯" : "";
      return `**#${i + 1}** ${nameOf(guild, r.userId)} — ${r.damage.toLocaleString()}${target}`;
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**傷害排行（總傷害 ${info.totalDamage.toLocaleString()}）**\n${lines.join("\n")}`,
      ),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 還沒有人出手，搶頭香！"),
    );
  }

  // 寶箱進看板：進行中的寶箱常駐一顆按鈕，不會被洗走錯過。
  const t = b.active_treasure;
  const treasureActive = t && !t.claimed_by && Date.now() < t.expires_at;
  if (treasureActive) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🎁 **寶箱出現！先搶先贏** · <t:${Math.floor(t.expires_at / 1000)}:R> 消失`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`boss_chest_${b.boss_id}_${t.id}`)
            .setLabel("開寶箱")
            .setEmoji("🎁")
            .setStyle(ButtonStyle.Success),
        ),
      );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("boss_board_attack")
          .setLabel("攻擊一刀")
          .setEmoji("⚔️")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("boss_board_combo")
          .setLabel("連擊 5 刀")
          .setEmoji("🔥")
          .setStyle(ButtonStyle.Secondary),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 即時更新 · 點按鈕直接開打，或用 `/魔王 攻擊`"),
    );
  return container;
}

async function doRefresh(client, guildId) {
  try {
    if (!client.countersCollection) return;
    const info = await bossEngine.getBossInfo(client, guildId);
    if (!info.ok) return; // 沒有進行中的 BOSS
    const ch = await resolveChannel(client);
    if (!ch) return;
    const guild = client.guilds.cache.get(guildId) || ch.guild;
    const payload = {
      components: [render(info, guild)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
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
      await client.countersCollection.updateOne(
        { _id: boardKey(guildId) },
        { $set: { channelId: ch.id, messageId: msg.id, updatedAt: new Date() } },
        { upsert: true },
      ).catch(() => {});
    }
  } catch (e) {
    console.log(`[BOSS] board refresh failed: ${e.message}`.red);
  }
}

// 節流重繪：熱戰時每刀都想更新，但編輯太密會被限流。
// force=true 立即重繪（階段變化 / 寶箱 / 召喚）；否則最多每 MIN_INTERVAL_MS 一次並排一次尾更新。
function scheduleRefresh(client, guildId, force = false) {
  if (!guildId) return;
  const now = Date.now();
  const last = lastAt.get(guildId) || 0;
  if (force || now - last >= MIN_INTERVAL_MS) {
    lastAt.set(guildId, now);
    doRefresh(client, guildId);
    return;
  }
  if (timers.has(guildId)) return;
  const wait = MIN_INTERVAL_MS - (now - last);
  timers.set(
    guildId,
    setTimeout(() => {
      timers.delete(guildId);
      lastAt.set(guildId, Date.now());
      doRefresh(client, guildId);
    }, wait),
  );
}

// 戰鬥結束（結算 / 中止）：刪掉置頂看板並清紀錄，避免留下過期的置頂。
async function finalize(client, guildId) {
  try {
    const timer = timers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(guildId);
    }
    lastAt.delete(guildId);
    if (!client.countersCollection) return;
    const rec = await client.countersCollection.findOne({ _id: boardKey(guildId) }).catch(() => null);
    if (rec?.messageId) {
      const ch = await resolveChannel(client);
      const msg = ch ? await ch.messages.fetch(rec.messageId).catch(() => null) : null;
      if (msg) {
        await msg.unpin().catch(() => {});
        await msg.delete().catch(() => {});
      }
    }
    await client.countersCollection.deleteOne({ _id: boardKey(guildId) }).catch(() => {});
  } catch (e) {
    console.log(`[BOSS] board finalize failed: ${e.message}`.red);
  }
}

module.exports = { scheduleRefresh, finalize };
