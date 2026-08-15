const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { boss, craft } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");
const bossEngine = require("./bossEngine");
const dungeonService = require("../mining/dungeonService");
const { materialLabel } = require("../mining/craftMaterials");

function nameOf(guild, userId) {
  return plainifyUserMentions(guild, `<@${userId}>`);
}

const COLOR_NORMAL = 0xe67e22;
const COLOR_BROKEN = 0xf39c12;
const COLOR_ENRAGED = 0xc0392b;
const COLOR_VICTORY = 0x2ecc71;
const COLOR_EXPIRED = 0x7f8c8d;
const COLOR_ERROR = 0xe74c3c;
const COLOR_AMMO = 0x9b59b6;

function phaseColor(phase) {
  if (phase === "enraged") return COLOR_ENRAGED;
  if (phase === "broken") return COLOR_BROKEN;
  return COLOR_NORMAL;
}

function rageLine(stacks, counterRate) {
  if (!stacks || stacks <= 0) return null;
  return `-# 😡 魔王怒氣 Lv.${stacks} — 反擊率升至 ${Math.round((counterRate || 0) * 100)}%（越打越兇）`;
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

// 封魔彈藥：庫存可事先囤，但只能投入「正在場上的這隻魔王」，所以按鈕只長在戰鬥訊息上。
function sealingAmmoButton(userId, ammo) {
  return new ButtonBuilder()
    .setCustomId(`boss_ammo_${userId}`)
    .setLabel(`封魔彈藥 ×${ammo.count}`)
    .setEmoji("💥")
    .setStyle(ButtonStyle.Primary);
}

function ammoEffectText() {
  const acfg = boss?.sealingAmmo || {};
  return `攻擊次數 +${acfg.attackLimitBonus || 0}・傷害 +${acfg.bossDamagePct || 0}%`;
}

// 打造指引：材料清單取自合成配方（唯一真實來源），避免與 boss.json 的複本分岔。
function ammoCraftHint() {
  const acfg = boss?.sealingAmmo || {};
  const recipe = (craft?.recipes || []).find((r) => r.result?.type === "sealing_ammo");
  const mats = Object.entries(recipe?.materials || {})
    .map(([mat, qty]) => materialLabel(mat, qty))
    .join("・");
  return `到 \`/裝備 分頁:合成\` →「🛤️ 活動」打造：${mats}＋${(acfg.coinCost || 0).toLocaleString()} 逼幣，每週限 1 個`;
}

// 投彈入口說明：合成成功訊息、背包、戰況都指向這一段，避免各自寫一份而分岔。
function ammoUsageHint() {
  return `魔王在場時到 \`/魔王 戰況\` 按「💥 封魔彈藥」投入，該場${ammoEffectText()}（不會過期，單場限用 1 個）`;
}

// 戰況面板的彈藥狀態行：已投入 / 手上有幾個 / 一個都沒有各講清楚，不要只在有貨時才提。
function ammoStatusLine(ammo) {
  if (!ammo?.enabled) return null;
  if (ammo.active) return `-# 💥 封魔彈藥已投入本場：${ammoEffectText()}（單場限用 1 個）`;
  if (ammo.count > 0) {
    return `-# 💥 持有封魔彈藥 **${ammo.count}** 個 — 按下方按鈕投入，本場${ammoEffectText()}`;
  }
  return `-# 💥 沒有封魔彈藥（投入後該場${ammoEffectText()}）——${ammoCraftHint()}`;
}

// 先開藥水選擇面板（boss_potion_<ownerId>），由玩家挑小 / 中 / 大，不直接灌下最大的一瓶。
function staminaPotionButton(userId) {
  return new ButtonBuilder()
    .setCustomId(`boss_potion_${userId}`)
    .setLabel("喝體力藥水")
    .setEmoji("🧪")
    .setStyle(ButtonStyle.Success);
}

// 攻擊結果附帶的「目前戰力加成」區塊：攻擊力 + 食物 buff + 公會世界王加成 + Combo。
function buffBlockContent(buffInfo, displayName) {
  if (!buffInfo) return null;
  const lines = [
    `⚔️ 攻擊力 **${buffInfo.atk}**${buffInfo.luckBonus > 0 ? `　🍀 幸運 +${Math.round(buffInfo.luckBonus * 100)}%` : ""}`,
  ];
  for (const f of buffInfo.foodBuffs || []) {
    lines.push(`${f.emoji} **${f.name}**：${f.desc}${f.expire}`);
  }
  const gbits = [];
  if (buffInfo.bossAtkPct > 0) gbits.push(`攻擊力 +${Math.round(buffInfo.bossAtkPct * 100)}%`);
  if (buffInfo.bossDmgPct > 0) gbits.push(`傷害 +${buffInfo.bossDmgPct}%`);
  if (gbits.length) lines.push(`🏰 公會世界王加成：${gbits.join("・")}`);
  if (buffInfo.ammoActive) lines.push(`💥 **封魔彈藥生效中**：本場${ammoEffectText()}`);
  if (buffInfo.comboActive) lines.push(`⚡ Combo 加成生效中（×${boss?.combo?.bonusMult ?? 1.3}）`);
  if (!(buffInfo.foodBuffs || []).length) {
    lines.push("-# 沒有食物 buff — 用 /烹飪 煮「地下城 ATK / 全屬性」料理，打魔王更痛");
  }
  return `**🍽️ ${displayName} 的戰力加成**\n${lines.join("\n")}`;
}

// 戰鬥中即時提示「目前參加獎檔位 + 離下一檔還差多少傷害」，讓玩家看得到繼續打的回報。
function participationProgressLine(myDamage) {
  const tiers = [...(boss?.rewards?.participation?.tiers || [])]
    .sort((a, b) => (a.minDamage ?? 0) - (b.minDamage ?? 0));
  const current = bossEngine.participationTier(myDamage);
  if (!current) return null;
  const next = tiers.find((t) => myDamage < (t.minDamage ?? 0));
  const gains = [`${(current.coins || 0).toLocaleString()} ${COIN_EMOJI}`, `${current.xp || 0} 經驗`];
  if (current.rare > 0) gains.push(`✨ 傳說碎片 ×${current.rare}`);
  if (current.diamond > 0) gains.push(`💎 鑽石 ×${current.diamond}`);
  const tail = next
    ? `　再 ${(next.minDamage - myDamage).toLocaleString()} 傷害升到 ${next.emoji} ${next.name}`
    : "　已是最高檔";
  return `-# 🎖️ 參加獎 ${current.emoji} **${current.name}**（本場傷害 ${myDamage.toLocaleString()}）：${gains.join("・")}${tail}`;
}

function addParticipationLine(container, myDamage) {
  const line = participationProgressLine(myDamage);
  if (line) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
}

function addBuffBlock(container, buffInfo, displayName) {
  const content = buffBlockContent(buffInfo, displayName);
  if (!content) return;
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

// 攻擊結果 / 戰況共用的操作按鈕列：能攻擊時放「再次攻擊」，一律附喝藥水 + 查戰況。
// 手上有沒投入的封魔彈藥時多一顆投彈鈕（本場已投入或庫存為 0 就不占版面）。
function actionRow(userId, { canAttack, staminaEmpty, ammo } = {}) {
  const row = new ActionRowBuilder();
  if (canAttack) {
    const btn = attackButton(userId);
    if (staminaEmpty) btn.setDisabled(true);
    row.addComponents(btn);
  }
  if (ammo?.enabled && !ammo.active && ammo.count > 0) {
    row.addComponents(sealingAmmoButton(userId, ammo));
  }
  row.addComponents(staminaPotionButton(userId), infoButton(userId));
  return row;
}

function buildAttackResultContainer({ userId, displayName, result }) {
  const b = result.boss;
  const phase = result.phaseAfter;
  const color = result.killed ? COLOR_VICTORY : phaseColor(phase);
  const container = new ContainerBuilder().setAccentColor(color);

  if (result.isCounter) {
    const messages = boss?.counterMessages || ["{name} 反擊了 **{user}**！"];
    const text = messages[Math.floor(Math.random() * messages.length)]
      .replace(/\{name\}/g, b.name)
      .replace(/\{user\}/g, displayName);
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${b.emoji} ${displayName} 被反擊了！\n${text}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${b.emoji} ${b.name} 狀態**（${phaseLabel(phase)}）\n${hpBar(b.current_hp, b.max_hp)}`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${displayName}** 的狀態\n🔋 體力：${result.stamina}/${result.staminaMax}（被反擊額外 -1）\n⚔️ 本場攻擊次數：${result.attackCount}/${result.attackLimit}${result.bonusAttacks > 0 ? `（含庫存 +${result.bonusAttacks}）` : ""}`,
        ),
      );
    const rl = rageLine(result.rageStacks, result.counterRate);
    if (rl) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rl));
  } else if (result.killed) {
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🏆 ${displayName} 的致命一擊！\n**${displayName}** 對 **${b.emoji} ${b.name}** 造成 **${result.damage.toLocaleString()}** 點傷害，給予最後一擊！`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🐉 **${b.name}** 被 **${displayName}** 擊敗了！結算公告即將發布。`,
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
    const firstStrikeLine = result.firstStrike ? `\n🥇 **首刀命中！結算時可獲得首刀獎勵**` : "";
    const critLine = result.isCrit ? `\n💥 **會心一擊！傷害 ×${boss?.crit?.damageMult ?? 2}**` : "";
    const targetedLine = result.targeted
      ? `\n-# 🎯 **${displayName}** 是目前的傷害王，魔王火力鎖定你（反擊率 +${Math.round((boss?.aggro?.counterBonus ?? 0) * 100)}%）`
      : "";
    const hitTitle = result.isCrit ? "💥 會心一擊！" : "⚔️ 攻擊命中！";
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${hitTitle}${displayName} 出手\n**${displayName}** 對 **${b.emoji} ${b.name}** 造成 **${result.damage.toLocaleString()}** 點傷害！${critLine}${firstStrikeLine}${phaseChangeLine}${comboLine}${targetedLine}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${b.emoji} ${b.name} 狀態**（${phaseLabel(phase)}）\n${hpBar(b.current_hp, b.max_hp)}`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${displayName}** 的狀態\n🔋 體力：${result.stamina}/${result.staminaMax}\n⚔️ 本場攻擊次數：${result.attackCount}/${result.attackLimit}${result.bonusAttacks > 0 ? `（含庫存 +${result.bonusAttacks}）` : ""}${result.xpGained > 0 ? `\n✨ 經驗 +${result.xpGained}` : ""}`,
        ),
      );
    if (result.sameUserStreak > 1) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 連續攻擊衰減中（×${Math.max(boss?.combo?.sameUserMinMult ?? 0.5, 1 - (result.sameUserStreak - 1) * (boss?.combo?.sameUserDecay ?? 0.1)).toFixed(2)}）— 換別人接力可累積 Combo`,
        ),
      );
    }
    const rl = rageLine(result.rageStacks, result.counterRate);
    if (rl) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rl));
  }

  if (!result.killed) {
    addParticipationLine(container, result.myDamage);
    addBuffBlock(container, result.buffInfo, displayName);
    container.addActionRowComponents(
      actionRow(userId, {
        canAttack: result.attackCount < result.attackLimit,
        staminaEmpty: result.stamina <= 0,
        ammo: result.ammo,
      }),
    );
  }
  return container;
}

function buildComboResultContainer({ userId, displayName, hits, stopReason }) {
  const last = hits[hits.length - 1];
  const b = last.boss;
  const phase = last.phaseAfter;
  const killed = hits.some((h) => h.killed);
  const lowStamina = !killed && last.stamina <= 1;
  const color = killed ? COLOR_VICTORY : lowStamina ? COLOR_ERROR : phaseColor(phase);
  const container = new ContainerBuilder().setAccentColor(color);

  const totalDamage = hits.reduce((s, h) => s + (h.damage || 0), 0);
  const totalXp = hits.reduce((s, h) => s + (h.xpGained || 0), 0);
  const counters = hits.filter((h) => h.isCounter).length;
  const phaseChange = hits.find((h) => h.phaseChanged);
  const comboTriggered = hits.some((h) => h.comboTriggered);

  const headline = killed
    ? `# 🏆 ${displayName} 的致命一擊！\n**${displayName}** 連擊 ${hits.length} 刀，最終擊敗 **${b.emoji} ${b.name}**！`
    : lowStamina
      ? `# ⚠️ ${displayName} 體力低落\n**${displayName}** 連擊 ${hits.length} 刀，對 **${b.emoji} ${b.name}** 造成共 **${totalDamage.toLocaleString()}** 點傷害！`
      : `# ⚔️ ${displayName} 連擊 ${hits.length} 刀！\n**${displayName}** 對 **${b.emoji} ${b.name}** 造成共 **${totalDamage.toLocaleString()}** 點傷害！`;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headline));
  if (hits.some((h) => h.firstStrike)) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🥇 **${displayName} 首刀命中！結算時可獲得首刀獎勵**`),
    );
  }

  const hitLines = hits.map((h, i) => {
    if (h.isCounter) return `**第 ${i + 1} 刀** 被反擊（-2 體力）`;
    const extras = [];
    if (h.isCrit) extras.push(`💥 會心`);
    if (h.phaseChanged) extras.push(`進入 ${phaseLabel(h.phaseAfter)}`);
    if (h.comboTriggered) extras.push(`⚡ 觸發 Combo`);
    return `**第 ${i + 1} 刀** ${h.damage.toLocaleString()} 傷害${extras.length ? "（" + extras.join("、") + "）" : ""}`;
  });
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${hitLines.join("\n")}${totalXp > 0 ? `\n✨ 本次共獲得經驗 +${totalXp}` : ""}`,
      ),
    );

  if (!killed) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${b.emoji} ${b.name} 狀態**（${phaseLabel(phase)}）\n${hpBar(b.current_hp, b.max_hp)}`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${displayName}** 的狀態\n🔋 體力：${last.stamina}/${last.staminaMax}${counters > 0 ? `（${counters} 次被反擊）` : ""}\n⚔️ 本場攻擊次數：${last.attackCount}/${last.attackLimit}${last.bonusAttacks > 0 ? `（含庫存 +${last.bonusAttacks}）` : ""}`,
        ),
      );
    const rl = rageLine(last.rageStacks, last.counterRate);
    if (rl) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rl));
    if (last.targeted) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 🎯 **${displayName}** 是目前的傷害王，魔王火力鎖定你（反擊率 +${Math.round((boss?.aggro?.counterBonus ?? 0) * 100)}%）`,
        ),
      );
    }
  }

  const stopHint = {
    stamina_drained: `已自動停止：${displayName} 體力歸零`,
    attack_limit_reached: `已自動停止：${displayName} 用完本場攻擊次數`,
    killed: null,
  }[stopReason];
  if (stopHint) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${stopHint}`));
  } else if (lowStamina) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${displayName} 體力低落，建議等回復再戰`));
  }

  if (!killed) {
    addParticipationLine(container, last.myDamage);
    addBuffBlock(container, last.buffInfo, displayName);
    container.addActionRowComponents(
      actionRow(userId, {
        canAttack: last.attackCount < last.attackLimit,
        staminaEmpty: last.stamina <= 0,
        ammo: last.ammo,
      }),
    );
  }

  return { container, killed, phaseChange, comboTriggered };
}

function buildInfoContainer({ userId, displayName, boss: b, ranking, totalDamage, comboActive, guild, ammo }) {
  const phase = b.phase || "normal";
  // ends_at 為 null＝招喚場無時間限制，待到被擊殺為止。
  const noLimit = b.ends_at == null;
  const remainMs = noLimit ? 0 : Math.max(0, b.ends_at - Date.now());
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
        `${noLimit ? "⏰ 討伐期限：無時限，待到被擊殺" : `⏰ 剩餘時間：${remainMin}m ${remainSec}s`}${comboActive ? `\n⚡ Combo 進行中（×${boss?.combo?.bonusMult ?? 1.3}）` : ""}`,
      ),
    );

  const infoRage = rageLine(bossEngine.rageState(b).stacks, bossEngine.effectiveCounterRate(b));
  if (infoRage) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(infoRage));
  }

  if (ranking?.length) {
    const top = ranking.slice(0, 5);
    const myIdx = ranking.findIndex((r) => r.userId === userId);
    const aggroOn = boss?.aggro?.enabled && ranking.length >= (boss?.aggro?.minParticipants ?? 2);
    const lines = top.map((r, i) => {
      const me = r.userId === userId ? "👉 " : "";
      const target = aggroOn && i === 0 ? " 🎯（魔王目標）" : "";
      return `${me}**#${i + 1}** ${nameOf(guild, r.userId)} — ${r.damage.toLocaleString()} 傷害${target}`;
    });
    if (myIdx >= 5) {
      const me = ranking[myIdx];
      lines.push(`-# ${displayName} 目前排第 ${myIdx + 1}：${me.damage.toLocaleString()} 傷害`);
    } else if (myIdx < 0) {
      lines.push(`-# ${displayName} 還沒出手，快去 /魔王 攻擊！`);
    }
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**傷害排行（總傷害 ${totalDamage.toLocaleString()}）**\n${lines.join("\n")}`,
        ),
      );
  }

  const ammoLine = ammoStatusLine(ammo);
  if (ammoLine) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(ammoLine));
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# 📋 ${displayName} 的戰況面板 — 按鈕只有你能按`),
  );
  container.addActionRowComponents(actionRow(userId, { canAttack: true, ammo }));
  return container;
}

// 喝體力藥水前的選瓶面板：列出小 / 中 / 大各持有幾瓶，玩家自己挑一瓶再喝。
// 每個 tier 的按鈕沿用背包的處理器（mining_use_stamina_potion_<tier>_<ownerId>）。
const POTION_TIERS = [
  { tier: "small", emoji: "🥤" },
  { tier: "medium", emoji: "🧴" },
  { tier: "large", emoji: "🍶" },
];

function buildStaminaPotionPickerContainer({ userId, displayName, profile, stamina, staminaMax: max }) {
  const owned = POTION_TIERS.map((t) => {
    const meta = dungeonService.STAMINA_POTION_TIERS[t.tier];
    const restore = dungeonService.staminaPotionRestore(t.tier);
    return {
      ...t,
      name: meta.name,
      count: profile?.[meta.field] || 0,
      restoreText: restore >= 9999 ? "補滿體力" : `恢復 ${restore} 點體力`,
    };
  });
  const total = owned.reduce((s, t) => s + t.count, 0);

  if (total <= 0) {
    return buildErrorContainer({
      title: "🧪 沒有體力藥水",
      body: `**${displayName}** 目前持有 0 瓶體力藥水。\n🔋 體力：**${stamina}/${max}**`,
      hint: "到 /商店 → 地下城道具 購買體力藥水（小 / 中 / 大）。",
    });
  }

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_NORMAL)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🧪 ${displayName} 要喝哪一種體力藥水？`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🔋 目前體力：**${stamina}/${max}**`),
    );

  const empty = [];
  for (const t of owned) {
    if (t.count <= 0) {
      empty.push(`${t.emoji} ${t.name}`);
      continue;
    }
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mining_use_stamina_potion_${t.tier}_${userId}`)
          .setLabel(`${t.name} ×${t.count}：${t.restoreText}`)
          .setEmoji(t.emoji)
          .setStyle(ButtonStyle.Success),
      ),
    );
  }
  if (empty.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 尚無：${empty.join("・")}`),
    );
  }
  return container;
}

// 手上還有沒投入的彈藥時，把「投彈」直接掛在錯誤訊息上（最常見的情境：攻擊次數用完）。
function addSealingAmmoOffer(container, userId, ammo) {
  if (!ammo?.enabled || ammo.active || !(ammo.count > 0)) return container;
  return container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 💥 你還有 **${ammo.count}** 個封魔彈藥沒投入——投進去這場就${ammoEffectText()}`,
      ),
    )
    .addActionRowComponents(new ActionRowBuilder().addComponents(sealingAmmoButton(userId, ammo)));
}

function buildSealingAmmoUsedContainer({ userId, displayName, result }) {
  const b = result.boss;
  return new ContainerBuilder()
    .setAccentColor(COLOR_AMMO)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💥 封魔彈藥投入！\n**${displayName}** 把封魔彈藥灌進武器，準備轟 **${b.emoji} ${b.name}**。`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⚔️ 本場攻擊次數 **+${result.attackLimitBonus}**\n`
          + `💥 世界王傷害 **+${result.bossDamagePct}%**\n`
          + `🎒 剩餘持有：**${result.countAfter}** 個`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 只對這一場有效，單場限用 1 個；剩下的會留到下一場魔王。",
      ),
    )
    .addActionRowComponents(actionRow(userId, { canAttack: true }));
}

// 投彈失敗：每種原因都要講清楚「為什麼不行」＋「現在該做什麼」。
function buildSealingAmmoErrorContainer(reason, ammo) {
  const count = ammo?.count || 0;
  if (reason === "no_boss") {
    return buildErrorContainer({
      title: "🌙 現在沒有魔王在場",
      body: `封魔彈藥只能投進「正在場上的魔王」，沒辦法先開好等下一場。\n🎒 目前持有：**${count}** 個（不會過期，會留到下一場）`,
      hint: "下一場固定魔王在 **週六 21:00**；也可以多打 /地下城 累積討伐能量提前召喚。",
    });
  }
  if (reason === "no_ammo") {
    return buildErrorContainer({
      title: "💥 沒有封魔彈藥",
      body: `你手上有 **0** 個封魔彈藥，需要 **1** 個才能投入本場。\n投入後該場${ammoEffectText()}。`,
      hint: ammoCraftHint(),
    });
  }
  if (reason === "already_used") {
    return buildErrorContainer({
      title: "💥 本場已經投過封魔彈藥",
      body: `這場魔王你已經投入過 1 個，效果生效中：${ammoEffectText()}。\n🎒 剩餘持有：**${count}** 個`,
      hint: "單場限用 1 個，剩下的留到下一場魔王再用。",
    });
  }
  if (reason === "disabled") {
    return buildErrorContainer({
      title: "🔧 封魔彈藥未啟用",
      body: "這個伺服器目前沒有開放封魔彈藥。",
    });
  }
  return buildErrorContainer({
    title: "❌ 投入失敗",
    body: "出了點狀況，請稍後再試。",
  });
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

// 參加獎摘要：本場有人拿到的檔位各列一行（門檻 + 內容 + 人數），沒人達到的檔位不占版面。
function participationSummaryLines(payouts) {
  const byTier = new Map();
  for (const p of payouts) {
    if (!p.participation) continue;
    const key = p.participation.minDamage ?? 0;
    if (!byTier.has(key)) byTier.set(key, { tier: p.participation, count: 0 });
    byTier.get(key).count += 1;
  }
  return [...byTier.values()]
    .sort((a, b) => (b.tier.minDamage ?? 0) - (a.tier.minDamage ?? 0))
    .map(({ tier, count }) => {
      const gains = [`＋${(tier.coins || 0).toLocaleString()} ${COIN_EMOJI}`, `＋${tier.xp || 0} 經驗`];
      if (tier.rare > 0) gains.push(`✨ 傳說碎片 ×${tier.rare}`);
      if (tier.diamond > 0) gains.push(`💎 鑽石 ×${tier.diamond}`);
      const threshold = (tier.minDamage ?? 0) > 0
        ? `傷害 ≥ ${tier.minDamage.toLocaleString()}`
        : "有出手";
      return `${tier.emoji} **${tier.name}**（${threshold}）：${gains.join("・")} — ${count} 人`;
    });
}

function buildSettlementContainer(settlement) {
  const { bossDoc, killed, payouts, totalDamage, totalPool, killerUserId, killerBonus, killerRare, mvpUserId, comboMvpUserId, punchingBagUserId, firstStrikerUserId, firstStrikeBonus, guild } = settlement;
  const color = killed ? COLOR_VICTORY : COLOR_EXPIRED;
  const container = new ContainerBuilder().setAccentColor(color);
  const headline = killed
    ? `# 🏆 ${bossDoc.emoji} ${bossDoc.name} 已被擊敗！`
    : `# ⏳ ${bossDoc.emoji} ${bossDoc.name} 逃離了戰場`;
  const statusLine = killed
    ? `**戰況**\n總傷害：${totalDamage.toLocaleString()}　參戰人數：${payouts.length}　獎勵池：${totalPool.toLocaleString()} ${COIN_EMOJI}`
    : `**戰況**\n總傷害：${totalDamage.toLocaleString()}　參戰人數：${payouts.length}　獎勵池：—（未擊敗，只發參加獎）`;
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headline))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine));

  const participationLines = participationSummaryLines(payouts);
  if (participationLines.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🎖️ **參加獎（依本場傷害發放，出手就有）**\n${participationLines.join("\n")}`,
      ),
    );
  }

  const killXpBonus = boss?.rewards?.killXpBonus ?? 0;
  if (killed && killXpBonus > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`✨ **擊殺加碼**：全體參戰者各 +${killXpBonus} 經驗`),
    );
  }

  if (killed && killerUserId) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🗡️ **最後一擊**：${nameOf(guild, killerUserId)}　＋${killerBonus.toLocaleString()} ${COIN_EMOJI}　＋✨ 傳說碎片 ×${killerRare}`,
      ),
    );
  }
  if (mvpUserId) {
    const mvp = payouts.find((p) => p.userId === mvpUserId);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⚔️ **本場 MVP**：${nameOf(guild, mvpUserId)}　傷害 ${mvp?.damage.toLocaleString() || 0}（${mvp?.attacks || 0} 次出手）`,
      ),
    );
  }
  if (firstStrikerUserId && firstStrikeBonus > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🥇 **首刀**：${nameOf(guild, firstStrikerUserId)}　＋${firstStrikeBonus.toLocaleString()} ${COIN_EMOJI}`,
      ),
    );
  }
  if (comboMvpUserId) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🎯 **開團王**：${nameOf(guild, comboMvpUserId)}`),
    );
  }
  if (punchingBagUserId) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🤡 **被龍揍王**：${nameOf(guild, punchingBagUserId)}`),
    );
  }

  const top = payouts.slice(0, 5);
  if (top.length) {
    const lines = top.map((p, i) => {
      const tierTag = p.participation ? `　${p.participation.emoji} ${p.participation.name}` : "";
      if (!killed) {
        return `**#${i + 1}** ${nameOf(guild, p.userId)} — ${p.damage.toLocaleString()} 傷害${tierTag}`;
      }
      const extras = [];
      if (p.rareReward) extras.push(`✨ 傳說碎片 ×${p.rareReward}`);
      if (p.diamondReward) extras.push(`💎 鑽石 ×${p.diamondReward}`);
      if (p.killBonus) extras.push(`擊殺 +${p.killBonus}`);
      if (p.guildClubName) extras.push(`🏰 ${p.guildClubName}`);
      return `**#${i + 1}** ${nameOf(guild, p.userId)} — ${p.damage.toLocaleString()} 傷害　→ ${p.share.toLocaleString()} ${COIN_EMOJI}${extras.length ? "（" + extras.join("、") + "）" : ""}${tierTag}`;
    });
    const topSuffix = killed ? "" : "（未擊敗，只有參加獎）";
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**Top 5 戰報**${topSuffix}\n${lines.join("\n")}`,
        ),
      );
  }

  // 公會傷害榜 + 公庫入帳（Module B/C 連動結果）
  const gAgg = (settlement.guildAggregates || []).filter((g) => g.damage > 0);
  if (gAgg.length > 0) {
    const top3 = gAgg.slice(0, 3);
    const medals = ["🥇", "🥈", "🥉"];
    const lines = top3.map((g, i) => {
      const treasury = g.treasuryAdded > 0
        ? `　→ 公庫 +${g.treasuryAdded.toLocaleString()} ${COIN_EMOJI}${g.treasuryLocked > 0 ? `（含鎖定 ${g.treasuryLocked.toLocaleString()}）` : ""}`
        : "";
      return `${medals[i]} **${g.name}**　Lv.${g.level}　${g.damage.toLocaleString()} 傷害（${g.contributors} 人）${treasury}`;
    });
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**🏰 公會戰績**\n${lines.join("\n")}`),
      );
    const lockHours = settlement.guildSync?.treasuryLockHours || 0;
    if (lockHours > 0 && top3.some((g) => g.treasuryLocked > 0)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 含擊殺者 / MVP 分潤的鎖定金將於 ${lockHours} 小時後解鎖到可分配餘額。`,
        ),
      );
    }
  }

  if (!killed) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 💨 沒能在時限內擊敗牠，BOSS 帶著寶藏逃走了——參戰者仍拿到參加獎，但傷害分潤與稀有掉落都沒了。下次要在時間內解決牠！",
      ),
    );
  }
  return container;
}

function energyBar(current, max, len = 16) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const filled = Math.round(ratio * len);
  return "🟪".repeat(filled) + "⬜".repeat(len - filled);
}

function buildSummonProgressContainer(p) {
  const full = p.energy >= p.threshold;
  const container = new ContainerBuilder().setAccentColor(full ? COLOR_VICTORY : 0x9b59b6);
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("# 🔮 魔王討伐能量"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${energyBar(p.energy, p.threshold)}\n**${p.energy.toLocaleString()} / ${p.threshold.toLocaleString()}**`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `📅 本週已召喚：**${p.summonedThisWeek} / ${p.maxPerWeek}** 場　👥 本輪貢獻者：${p.contributorCount} 人`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⚔️ **你的攻擊庫存：${p.myCharges} / ${p.chargeCap}**\n-# 打地下城累積，任何一場魔王（含週六固定場）都能多打這麼多刀。`,
      ),
    );

  if (p.activeBoss) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ⚔️ **${p.activeBoss.emoji} ${p.activeBoss.name}** 正在場上！用 /魔王 攻擊 出手，庫存會自動用在超過基礎次數的攻擊上。`,
      ),
    );
  } else if (p.cooldownUntil) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🧊 魔王剛離場，討伐冷卻中——<t:${Math.floor(p.cooldownUntil / 1000)}:R> 後才會再召喚（避免連續出場）。`,
      ),
    );
  } else if (full && p.summonedThisWeek >= p.maxPerWeek) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🈵 能量已滿，但本週召喚次數已用完——下週能量會再度喚醒魔王。",
      ),
    );
  } else if (full) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# ✅ 能量已滿，下一次地下城通關就會召喚魔王！"),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 多去 /地下城 探索、擊敗 mini-BOSS 累積能量，集滿就會自動召喚一隻額外魔王。",
      ),
    );
  }
  return container;
}

module.exports = {
  buildAttackResultContainer,
  buildComboResultContainer,
  buildInfoContainer,
  buildStaminaPotionPickerContainer,
  buildSealingAmmoUsedContainer,
  buildSealingAmmoErrorContainer,
  addSealingAmmoOffer,
  buildErrorContainer,
  ammoStatusLine,
  ammoUsageHint,
  buildSettlementContainer,
  buildSummonProgressContainer,
  phaseLabel,
  phaseColor,
  hpBar,
};
