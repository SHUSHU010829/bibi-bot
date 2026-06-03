const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { boss } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");

const COLOR_NORMAL = 0xe67e22;
const COLOR_BROKEN = 0xf39c12;
const COLOR_ENRAGED = 0xc0392b;
const COLOR_VICTORY = 0x2ecc71;
const COLOR_EXPIRED = 0x7f8c8d;
const COLOR_ERROR = 0xe74c3c;

function phaseColor(phase) {
  if (phase === "enraged") return COLOR_ENRAGED;
  if (phase === "broken") return COLOR_BROKEN;
  return COLOR_NORMAL;
}

function phaseLabel(phase) {
  return boss?.phases?.[phase]?.label || phase;
}

function hpBar(current, max, len = 16) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const filled = Math.round(ratio * len);
  return "█".repeat(filled) + "░".repeat(len - filled) + ` ${current.toLocaleString()}/${max.toLocaleString()}`;
}

function attackButton(userId) {
  return new ButtonBuilder()
    .setCustomId(`boss_attack_${userId}`)
    .setLabel("再次攻擊")
    .setEmoji("⚔️")
    .setStyle(ButtonStyle.Danger);
}

function infoButton(userId) {
  return new ButtonBuilder()
    .setCustomId(`boss_info_${userId}`)
    .setLabel("查看戰況")
    .setEmoji("📊")
    .setStyle(ButtonStyle.Secondary);
}

function buildAttackResultContainer({ userId, displayName, result }) {
  const b = result.boss;
  const phase = result.phaseAfter;
  const color = result.killed ? COLOR_VICTORY : phaseColor(phase);
  const container = new ContainerBuilder().setAccentColor(color);

  if (result.isCounter) {
    const messages = boss?.counterMessages || ["BOSS 反擊了你！"];
    const text = messages[Math.floor(Math.random() * messages.length)].replace(/\{name\}/g, b.name);
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${b.emoji} 被反擊了！\n${text}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**BOSS 狀態**（${phaseLabel(phase)}）\n${hpBar(b.current_hp, b.max_hp)}`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🔋 體力：${result.stamina}/${result.staminaMax}（被反擊額外 -1）\n⚔️ 本場攻擊次數：${result.attackCount}/${result.attackLimit}`,
        ),
      );
  } else if (result.killed) {
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🏆 致命一擊！\n**${displayName}** 對 **${b.emoji} ${b.name}** 造成 **${result.damage.toLocaleString()}** 點傷害，給予最後一擊！`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🐉 **${b.name}** 已被擊敗！結算公告即將發布。`,
        ),
      );
  } else {
    const phaseChangeLine = result.phaseChanged
      ? `\n💥 **進入 ${phaseLabel(phase)} 階段！**`
      : "";
    const comboLine = result.comboTriggered
      ? `\n⚡ **觸發 Combo！全場傷害 ×${(boss?.combo?.bonusMult ?? 1.3)} 持續 ${(boss?.combo?.durationSec ?? 120)} 秒！**`
      : result.comboActive
        ? `\n⚡ Combo 進行中（×${(boss?.combo?.bonusMult ?? 1.3)}）`
        : "";
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ⚔️ 攻擊命中！\n**${displayName}** 對 **${b.emoji} ${b.name}** 造成 **${result.damage.toLocaleString()}** 點傷害！${phaseChangeLine}${comboLine}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**BOSS 狀態**（${phaseLabel(phase)}）\n${hpBar(b.current_hp, b.max_hp)}`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🔋 體力：${result.stamina}/${result.staminaMax}\n⚔️ 本場攻擊次數：${result.attackCount}/${result.attackLimit}`,
        ),
      );
    if (result.sameUserStreak > 1) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 連續攻擊衰減中（×${Math.max(boss?.combo?.sameUserMinMult ?? 0.5, 1 - (result.sameUserStreak - 1) * (boss?.combo?.sameUserDecay ?? 0.1)).toFixed(2)}）— 換別人接力可累積 Combo`,
        ),
      );
    }
  }

  if (!result.killed && result.attackCount < result.attackLimit) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(attackButton(userId), infoButton(userId)),
    );
  } else if (!result.killed) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(infoButton(userId)),
    );
  }
  return container;
}

function buildInfoContainer({ userId, boss: b, ranking, totalDamage, comboActive }) {
  const phase = b.phase || "normal";
  const remainMs = Math.max(0, b.ends_at - Date.now());
  const remainMin = Math.floor(remainMs / 60000);
  const remainSec = Math.floor((remainMs % 60000) / 1000);
  const container = new ContainerBuilder().setAccentColor(phaseColor(phase));
  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${b.emoji} ${b.name} — ${phaseLabel(phase)}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**血量**\n${hpBar(b.current_hp, b.max_hp)}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⏰ 剩餘時間：${remainMin}m ${remainSec}s${comboActive ? `\n⚡ Combo 進行中（×${boss?.combo?.bonusMult ?? 1.3}）` : ""}`,
      ),
    );

  if (ranking?.length) {
    const top = ranking.slice(0, 5);
    const myIdx = ranking.findIndex((r) => r.userId === userId);
    const lines = top.map((r, i) => {
      const me = r.userId === userId ? "👉 " : "";
      return `${me}**#${i + 1}** <@${r.userId}> — ${r.damage.toLocaleString()} 傷害`;
    });
    if (myIdx >= 5) {
      const me = ranking[myIdx];
      lines.push(`-# 你目前排第 ${myIdx + 1}：${me.damage.toLocaleString()} 傷害`);
    } else if (myIdx < 0) {
      lines.push(`-# 你還沒出手，快去 /攻擊！`);
    }
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**傷害排行（總傷害 ${totalDamage.toLocaleString()}）**\n${lines.join("\n")}`,
        ),
      );
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(attackButton(userId), infoButton(userId)),
  );
  return container;
}

function buildErrorContainer({ title, body, hint }) {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_ERROR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
}

function buildSettlementContainer(settlement) {
  const { bossDoc, killed, payouts, totalDamage, totalPool, killerUserId, killerBonus, killerRare, mvpUserId, comboMvpUserId, punchingBagUserId } = settlement;
  const color = killed ? COLOR_VICTORY : COLOR_EXPIRED;
  const container = new ContainerBuilder().setAccentColor(color);
  const headline = killed
    ? `# 🏆 ${bossDoc.emoji} ${bossDoc.name} 已被擊敗！`
    : `# ⏳ ${bossDoc.emoji} ${bossDoc.name} 逃離了戰場`;
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headline))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**戰況**\n總傷害：${totalDamage.toLocaleString()}　參戰人數：${payouts.length}　獎勵池：${totalPool.toLocaleString()} ${COIN_EMOJI}`,
      ),
    );

  if (killed && killerUserId) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🗡️ **最後一擊**：<@${killerUserId}>　＋${killerBonus.toLocaleString()} ${COIN_EMOJI}　＋✨ ×${killerRare}`,
      ),
    );
  }
  if (mvpUserId) {
    const mvp = payouts.find((p) => p.userId === mvpUserId);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⚔️ **本場 MVP**：<@${mvpUserId}>　傷害 ${mvp?.damage.toLocaleString() || 0}（${mvp?.attacks || 0} 次出手）`,
      ),
    );
  }
  if (comboMvpUserId) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🎯 **開團王**：<@${comboMvpUserId}>`),
    );
  }
  if (punchingBagUserId) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🤡 **被龍揍王**：<@${punchingBagUserId}>`),
    );
  }

  const top = payouts.slice(0, 5);
  if (top.length) {
    const lines = top.map((p, i) => {
      const extras = [];
      if (p.rareReward) extras.push("✨ ×1");
      if (p.killBonus) extras.push(`擊殺 +${p.killBonus}`);
      return `**#${i + 1}** <@${p.userId}> — ${p.damage.toLocaleString()} 傷害　→ ${p.share.toLocaleString()} ${COIN_EMOJI}${extras.length ? "（" + extras.join("、") + "）" : ""}`;
    });
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Top 5 戰報**\n${lines.join("\n")}`),
      );
  }

  if (!killed) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 時間到，BOSS 逃跑了。下次再戰！"),
    );
  }
  return container;
}

module.exports = {
  buildAttackResultContainer,
  buildInfoContainer,
  buildErrorContainer,
  buildSettlementContainer,
  phaseLabel,
};
