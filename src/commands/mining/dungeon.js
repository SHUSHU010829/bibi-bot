require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { mining, dungeon, commandChannels, normalChannelId } = require("../../config");
const dungeonService = require("../../features/mining/dungeonService");
const floorService = require("../../features/dungeon/floorService");
const diamondAnnouncer = require("../../features/mining/diamondAnnouncer");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");
const { buildOverflowConfirmView } = require("../../features/mining/overflowConfirm");
const { COIN_EMOJI } = require("../../constants/coin");

const CONTINUE_PREFIX = "dungeon_continue_";
const DUNGEON_OVERFLOW_CONFIRM_PREFIX = "dungeon_overflow_confirm_";
const DUNGEON_OVERFLOW_CANCEL_PREFIX = "dungeon_overflow_cancel_";

// Phase H+ 新面板 button prefix
const RAID_PANEL_PREFIX = "raid_panel_";       // 重整面板：raid_panel_<ownerId>
const RAID_ENTER_PREFIX = "raid_enter_";       // 進入戰鬥：raid_enter_<ownerId>_<theme>_<floor>
const RAID_LOG_PREFIX = "raid_log_";           // 看日誌：raid_log_<ownerId>_<runId>
const RAID_HEAL_PREFIX = "raid_heal_";         // 補血：raid_heal_<ownerId>_<tier>
const RAID_AGAIN_PREFIX = "raid_again_";       // 再戰：raid_again_<ownerId>_<theme>_<floor>

const MAX_LABEL_LEN = 80;

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

function weaponLabel(key) {
  const def = (dungeon?.weapons || {})[key] || {};
  return `${def.emoji || "👊"} ${def.name || key}`;
}

async function dmWeaponLowDurability(interaction, weaponKey, durabilityAfter, level) {
  const def = (dungeon?.weapons || {})[weaponKey] || {};
  const critical = level === "critical";
  const label = `${def.emoji || ""} ${def.name || weaponKey}`.trim();
  const container = new ContainerBuilder()
    .setAccentColor(critical ? 0xed4245 : 0xfaa61a)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        critical ? "### 🚨 武器快斷了！" : "### ⚠️ 武器耐久偏低"
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        critical
          ? `你的 **${label}** 只剩 **${durabilityAfter}** 次耐久，下一次戰鬥就會斷！`
          : `你的 **${label}** 耐久剩 **${durabilityAfter}** 次，差不多該準備了。`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 趁還沒斷，到 `/合成` 再做一把、或到 `/裝備` 用礦石修復耐久。"
      )
    );
  const channelId = commandChannels?.mining?.[0] || normalChannelId;
  if (interaction.guildId && channelId) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("前往頻道補救")
          .setURL(`https://discord.com/channels/${interaction.guildId}/${channelId}`)
      )
    );
  }
  await interaction.user.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

function appendCombatExtras(container, result, interaction) {
  if (result.usingFist) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 👊 你空手搏鬥，勝率極低！用 /合成 打一把劍（🗡️ 鐵劍只要鐵礦 ×20）大幅提升戰鬥力。",
      ),
    );
  }
  if (result.weaponBroke) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 你的 ${weaponLabel(result.weaponBefore)} 耐久耗盡，已退回赤手空拳，記得再 /合成 一把劍。`,
      ),
    );
  } else if (result.weaponDurabilityAfter !== null) {
    const warn = dungeon?.durabilityWarn || {};
    const after = result.weaponDurabilityAfter;
    const label = weaponLabel(result.weaponBefore);
    let line;
    if (typeof warn.critical === "number" && after <= warn.critical) {
      line = `🚨 **武器快斷了！**\n${label} 只剩 **${after}** 次，再戰就會斷裂退回赤手空拳。快去 \`/合成\` 一把新的、或到 \`/裝備\` 用礦石修復耐久！`;
    } else if (typeof warn.low === "number" && after <= warn.low) {
      line = `⚠️ **武器耐久偏低**\n${label} 剩 **${after}** 次，建議先去 \`/合成\` 備一把、或到 \`/裝備\` 用礦石修復耐久。`;
    } else {
      line = `**武器耐久**\n${label} 剩 ${after} 次`;
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
    if (result.weaponDurabilityWarnCrossed && interaction) {
      dmWeaponLowDurability(
        interaction,
        result.weaponBefore,
        after,
        result.weaponDurabilityWarnCrossed,
      ).catch(() => {});
    }
  }

  if (result.encounter) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${result.encounter.emoji} 突發事件：${result.encounter.name}**\n${result.encounter.body}`,
        ),
      );
  }
}

async function applyStaminaNotifyPre(client, interaction, container) {
  try {
    const fullAt = await dungeonService
      .staminaFullAt(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      })
      .catch(() => 0);

    const state = await reminder
      .getState(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "dungeon",
      })
      .catch(() => null);

    if (!state?.enabled && fullAt > Date.now()) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 🔔 想在體力補滿時收到提醒？用 `/通知設定` 開啟地下城體力通知。"
        )
      );
    }
    return { fullAt, subscribed: !!state?.enabled };
  } catch (_) {
    return { fullAt: 0, subscribed: false };
  }
}

async function applyStaminaNotifyPost(client, interaction, notifyInfo) {
  if (!notifyInfo?.subscribed) return;
  await reminder
    .refreshIfEnabled(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      type: "dungeon",
      readyAt: notifyInfo.fullAt,
    })
    .catch(() => {});
}

function runPostTasks(client, interaction, result, notifyInfo) {
  (async () => {
    try {
      const dungeonHooks = [
        { questId: "daily_dungeon_10" },
        { questId: "weekly_dungeon" },
      ];
      if (result.won) {
        dungeonHooks.push({ questId: "daily_dungeon_win" });
        dungeonHooks.push({ questId: "weekly_dungeon_win" });
      }
      await applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        dungeonHooks,
      );
      await applyStaminaNotifyPost(client, interaction, notifyInfo);
    } catch (e) {
      console.log(`[WARN] /地下城 事後補登失敗：${e?.message || e}`.yellow);
    }
  })();
}

function buildContinueRow(ownerId, name) {
  let label = name ? `🔄 繼續探索・${name}` : "🔄 繼續探索";
  if (label.length > MAX_LABEL_LEN) label = label.slice(0, MAX_LABEL_LEN);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONTINUE_PREFIX}${ownerId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
  );
}

function parseContinueId(customId) {
  if (!customId || !customId.startsWith(CONTINUE_PREFIX)) return null;
  const ownerId = customId.slice(CONTINUE_PREFIX.length);
  return ownerId ? { ownerId } : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase H+ 入口面板 / 戰鬥結算 builders
// ────────────────────────────────────────────────────────────────────────────

function shieldLabel(key) {
  if (!key) return "—";
  const def = (dungeon?.shields || {})[key] || {};
  return `${def.emoji || "🛡️"} ${def.name || key}`;
}
function themeLabel(t) {
  return `${t.emoji || ""} ${t.name}`.trim();
}
function hpBar(cur, max, width = 10) {
  const pct = Math.max(0, Math.min(1, cur / max));
  const filled = Math.round(pct * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function statusLines(status) {
  const lines = [];
  lines.push(`❤️ HP：**${status.hp} / ${status.hpMax}** \`${hpBar(status.hp, status.hpMax)}\``);
  lines.push(`🔋 體力：**${status.stamina} / ${status.staminaMax}**`);
  const w = dungeon?.weapons?.[status.weapon] || {};
  const weaponLine =
    `${weaponLabel(status.weapon)} ・ ATK ${w.atk || 0} ・ DEF ${w.def || 0}` +
    (status.weaponDurability != null ? ` ・ 耐久 ${status.weaponDurability}/${status.weaponMaxDurability || w.durability || "?"}` : "");
  lines.push(`🗡️ 武器：${weaponLine}`);
  if (status.shield) {
    const sd = dungeon?.shields?.[status.shield] || {};
    lines.push(
      `🛡️ 盾：${shieldLabel(status.shield)} ・ DEF ${sd.def || 0} ・ 格擋 ${Math.round((sd.blockRate || 0) * 100)}%` +
        ` ・ 耐久 ${status.shieldDurability}/${status.shieldMaxDurability || sd.durability || "?"}`,
    );
  }
  if (status.hpCritical) {
    lines.push("-# 💔 重傷狀態：ATK ×0.8、暴擊率 ×0.5（HP 回到 20% 即解除）");
  } else if (status.hpLow) {
    lines.push("-# ⚠️ HP 偏低，建議補血或先休息再戰。");
  }
  if (status.weapon === "fist") {
    lines.push("-# 👊 你還沒武器！先 /挖礦 累積鐵礦，再到 /合成 打一把 🗡️ 鐵劍（ATK +25 / DEF +5）。");
  }
  if (!status.shield) {
    lines.push("-# 🛡️ 還沒盾？Lv.5 起可到 /合成 打一面 🪨 鐵盾（DEF +10、格擋 25%）。");
  }
  return lines;
}

function buildFloorActionRow(ownerId, floorStates, themeId = "mine") {
  const row = new ActionRowBuilder();
  for (const fs of floorStates) {
    const f = fs.floor;
    if (!f) continue;
    let label = `${f.emoji || ""} ${f.floor}F`;
    if (label.length > 80) label = label.slice(0, 80);
    const btn = new ButtonBuilder()
      .setCustomId(`${RAID_ENTER_PREFIX}${ownerId}_${themeId}_${f.floor}`)
      .setLabel(label)
      .setStyle(fs.unlocked ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!fs.unlocked);
    if (!fs.unlocked) btn.setEmoji("🔒");
    row.addComponents(btn);
  }
  return row;
}

function buildActionsRow(ownerId, status) {
  const row = new ActionRowBuilder();
  const small = status.potions.small;
  const medium = status.potions.medium;
  const large = status.potions.large;
  const full = status.hp >= status.hpMax;
  // 三瓶各一個按鈕，玩家自己選；沒持有的 disable。HP 滿時全 disable。
  const mkBtn = (tier, emoji, name, count) =>
    new ButtonBuilder()
      .setCustomId(`${RAID_HEAL_PREFIX}${ownerId}_${tier}`)
      .setLabel(`${emoji} ${name}（${count}）`)
      .setStyle(count > 0 && !full ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(count <= 0 || full);
  row.addComponents(mkBtn("small", "💊", "小", small));
  row.addComponents(mkBtn("medium", "💊", "中", medium));
  row.addComponents(mkBtn("large", "💊", "大", large));
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${RAID_PANEL_PREFIX}${ownerId}`)
      .setLabel("🔄 重整")
      .setStyle(ButtonStyle.Secondary),
  );
  return row;
}

async function buildEntryPanel(client, interaction) {
  const status = await dungeonService.getDungeonStatus(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
  });
  const floorStates = floorService.listFloors(status.profile, status.level, "mine");

  const container = new ContainerBuilder()
    .setAccentColor(status.hpCritical ? 0xe74c3c : status.hpLow ? 0xfaa61a : 0x3498db)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚔️ 地下城副本"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLines(status).join("\n")))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**選擇樓層挑戰**（礦坑主題）"));

  const lines = [];
  for (const fs of floorStates) {
    const f = fs.floor;
    if (!f) continue;
    if (fs.unlocked) {
      lines.push(`${f.emoji || ""} **${f.floor}F ${f.name}** ・ 體力 -${f.staminaCost} ・ 獎勵 ×${f.rewardMultiplier}`);
    } else {
      const r = fs.requirement;
      const progress = fs.progress || {};
      if (fs.reason === "level") {
        lines.push(`🔒 ${f.emoji || ""} ${f.floor}F ${f.name} — 解鎖：等級 ${r.level}（目前 Lv.${progress.level}）`);
      } else if (fs.reason === "prereq_clears") {
        lines.push(`🔒 ${f.emoji || ""} ${f.floor}F ${f.name} — 解鎖：${progress.floor}F 通關 ${r.count} 次（目前 ${progress.cleared} 次）`);
      } else {
        lines.push(`🔒 ${f.emoji || ""} ${f.floor}F ${f.name} — 未解鎖`);
      }
    }
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  container.addActionRowComponents(buildFloorActionRow(interaction.user.id, floorStates));
  container.addActionRowComponents(buildActionsRow(interaction.user.id, status));

  // 主題鎖定提示（v1 只開礦坑）
  const themeStates = floorService.listThemes(status.profile, status.level);
  const lockedThemes = themeStates.filter((t) => !t.unlocked && t.reason !== "unknown_theme");
  if (lockedThemes.length) {
    const tlines = lockedThemes.map((ts) => {
      const t = ts.theme;
      const r = ts.requirement;
      if (ts.reason === "level") return `-# 🔒 ${themeLabel(t)} — 等級 ${r.level}`;
      if (ts.reason === "prereq_clears") return `-# 🔒 ${themeLabel(t)} — ${ts.progress?.preTheme} 主題 ${ts.progress?.preFloor}F 通關 ${r.prereqClears} 次`;
      return `-# 🔒 ${themeLabel(t)}`;
    });
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tlines.join("\n")));
  }
  return container;
}

function oreLabel(key) {
  const def = (mining?.ores || {})[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}

function buildBattleResultPanel(ownerId, result) {
  const container = new ContainerBuilder();
  const isWin = result.won;
  container.setAccentColor(isWin ? 0x2ecc71 : 0xe74c3c);

  const title = isWin
    ? `## ⚔️ ${result.floorEmoji || ""} ${result.floor}F ${result.floorName || ""} — ✅ 勝利！（${result.turns} 回合）`
    : result.battleResult === "draw"
      ? `## ⏳ ${result.floorEmoji || ""} ${result.floor}F ${result.floorName || ""} — 戰鬥逾時（${result.turns} 回合，視同失敗）`
      : `## 💀 ${result.floorEmoji || ""} ${result.floor}F ${result.floorName || ""} — 戰鬥失敗（${result.turns} 回合）`;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`${title}\n你${isWin ? "擊敗" : "不敵"} **${result.monster.emoji} ${result.monster.name}**`),
  );
  container.addSeparatorComponents(new SeparatorBuilder());

  const stateLines = [];
  stateLines.push(`❤️ HP：${result.hpBefore} → **${result.hpAfter}/${result.hpMax}** \`${hpBar(result.hpAfter, result.hpMax)}\``);
  if (result.shieldBefore != null) stateLines.push(`🛡️ 盾耐久：${result.shieldBefore} → ${result.shieldAfter}`);
  stateLines.push(`🔋 體力：${result.staminaBefore} → ${result.staminaAfter}/${result.staminaMax}`);
  if (result.weaponDurabilityAfter != null) {
    stateLines.push(`⚔️ 武器耐久：${weaponLabel(result.weaponBefore)} 剩 ${result.weaponDurabilityAfter}（-${result.weaponDurabilityCost}）`);
  } else if (result.weaponBroke) {
    stateLines.push(`⚔️ ${weaponLabel(result.weaponBefore)} 耐久耗盡，已退回赤手空拳！`);
  }
  if (result.damageDealt) stateLines.push(`-# 造成 ${result.damageDealt} 傷害・受 ${result.damageTaken} 傷害・暴擊 ${result.critCount} 次・格擋 ${result.blockCount} 次`);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(stateLines.join("\n")));

  if (isWin) {
    container.addSeparatorComponents(new SeparatorBuilder());
    const lootLines = [];
    if (result.oreGained) {
      lootLines.push(
        result.oreOverflowToCoins
          ? `背包已滿：${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty} 折算為 +${result.coinsGained.toLocaleString()} ${COIN_EMOJI}`
          : `${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty}`,
      );
    }
    if (result.legendaryGained) lootLines.push(`✨ 傳說素材碎片 ×${result.legendaryGained}`);
    if (result.potionGained) lootLines.push(`🍀 幸運藥水 ×${result.potionGained}`);
    if (result.ticketGained) lootLines.push(`🎫 CD 縮短券 ×${result.ticketGained}`);
    if (result.slimeGained) lootLines.push(`💧 怪物黏液 ×${result.slimeGained}`);
    if (result.seedGained?.qty) {
      const seedName =
        result.seedGained.seedKey === "seed_strawberry" ? "🍓 草莓種子"
        : result.seedGained.seedKey === "seed_black_rose" ? "🌹 黑玫瑰種子"
        : `🌱 ${result.seedGained.seedKey}`;
      lootLines.push(`${seedName} ×${result.seedGained.qty}`);
    }
    if (!result.oreGained && result.coinsGained > 0) lootLines.push(`+${result.coinsGained.toLocaleString()} ${COIN_EMOJI}`);
    if (!lootLines.length) lootLines.push("這次什麼都沒掉落…");
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`✨ **戰利品**\n${lootLines.join("\n")}`));
    if (result.floorEvents?.length) {
      for (const ev of result.floorEvents) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`🎉 **新樓層解鎖！** ${ev.floor}F 已開放挑戰`),
        );
      }
    }
  } else if (result.deathDrop) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 死亡懲罰：背包遺失 ${result.deathDrop.key} ×${result.deathDrop.qty}`),
    );
  }

  const potionsAfter = result.potionsAfter || { small: 0, medium: 0, large: 0 };
  const hasPotion = (potionsAfter.small + potionsAfter.medium + potionsAfter.large) > 0;
  // 補血預設用最小可用瓶（與戰中自動藥水規則一致，避免浪費）
  const healTier = potionsAfter.small > 0 ? "small" : potionsAfter.medium > 0 ? "medium" : potionsAfter.large > 0 ? "large" : null;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RAID_AGAIN_PREFIX}${ownerId}_${result.theme}_${result.floor}`)
      .setLabel(`⚔️ 再戰 ${result.floor}F`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${RAID_LOG_PREFIX}${ownerId}_${result.runId}`)
      .setLabel("📜 戰鬥日誌")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${RAID_HEAL_PREFIX}${ownerId}_${healTier || "none"}`)
      .setLabel(hasPotion ? `💊 補血（最小瓶）` : "💊 無生命藥水")
      .setStyle(hasPotion && result.hpAfter < result.hpMax ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!hasPotion || result.hpAfter >= result.hpMax),
    new ButtonBuilder()
      .setCustomId(`${RAID_PANEL_PREFIX}${ownerId}`)
      .setLabel("⚙️ 換樓層")
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(row);

  if (result.weaponBroke) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 你的武器斷了！到 /合成 打一把新的，或到 /裝備 用磨石修復。"),
    );
  }
  if (result.hpAfter < result.hpMax * 0.3) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# ❤️ HP 偏低，建議補血或先休息再戰。/商店 → 挖礦道具 有生命藥水。"),
    );
  }
  return container;
}

// 公開精簡播報（dungeon.json.channelId 頻道）。一行訊息，不洗版。
function publicBroadcastContent(displayName, result) {
  const f = `${result.floorEmoji || ""} ${result.floor}F ${result.floorName || ""}`.trim();
  if (result.won) {
    const lootBrief = [];
    if (result.oreGained && !result.oreOverflowToCoins) lootBrief.push(`${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty}`);
    if (result.legendaryGained) lootBrief.push(`✨碎片×${result.legendaryGained}`);
    if (result.coinsGained > 0) lootBrief.push(`+${result.coinsGained.toLocaleString()} ${COIN_EMOJI}`);
    const tail = lootBrief.length ? ` ・ ${lootBrief.join("、")}` : "";
    return `⚔️ **${displayName}** 通過 ${f}（${result.turns} 回合）${tail}`;
  }
  if (result.battleResult === "draw") {
    return `⏳ **${displayName}** 在 ${f} 戰鬥逾時撤退（${result.turns} 回合）`;
  }
  return `💀 **${displayName}** 在 ${f} 倒下了（撐了 ${result.turns} 回合）`;
}

async function showEntryPanel(client, interaction) {
  const container = await buildEntryPanel(client, interaction);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  return interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

// 統一的地下城執行流程；/地下城、「繼續探索」、「繼續（折金幣）」共用。
async function executeDungeon(client, interaction, { allowOverflow = false } = {}) {
  let dungeonResult = null;
  try {
    dungeonResult = await dungeonService.enterDungeon(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      username: interaction.user.username,
      allowOverflow,
    });
    const result = dungeonResult;

    if (!result.ok) {
      if (result.reason === "disabled") {
        return interaction.editReply("🔧 地下城系統尚未啟動！");
      }
      if (result.reason === "no_stamina") {
        const container = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 😮‍💨 體力耗盡"),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `🔋 目前體力：**0 / ${result.max}**\n` +
                (result.nextRegenAt
                  ? `下一點體力：<t:${Math.floor(result.nextRegenAt / 1000)}:R>（每小時回復 1 點）`
                  : "每小時回復 1 點，休息一下再來。"),
            ),
          );

        const potionCount = result.potionCount || 0;
        if (potionCount > 0) {
          container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`mining_use_stamina_potion_${interaction.user.id}`)
                .setLabel(`🧪 補充體力藥水（剩 ${potionCount} 瓶）`)
                .setStyle(ButtonStyle.Success),
            ),
          );
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 點上方按鈕立即補體力，補完再執行 /地下城 繼續探索。",
            ),
          );
        } else {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 想立刻續命？到 /商店 → 挖礦道具 買體力藥水（每日上限 3 瓶）。",
            ),
          );
        }

        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "backpack_full") {
        const confirm = buildOverflowConfirmView({
          title: "背包已滿，無法收下戰利品礦石",
          body: "繼續探索的話，戰利品掉到礦會直接折成金幣入帳，其他類型獎勵不受影響。",
          used: result.used,
          cap: result.cap,
          confirmCustomId: `${DUNGEON_OVERFLOW_CONFIRM_PREFIX}${interaction.user.id}`,
          cancelCustomId: `${DUNGEON_OVERFLOW_CANCEL_PREFIX}${interaction.user.id}`,
          confirmLabel: "繼續探索（礦折金幣）",
        });
        return interaction.editReply({
          components: [confirm],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply("🔧 進地下城失敗，請稍後再試。");
    }

    if (result.encounterDiamond > 0) {
      diamondAnnouncer
        .announceDiamond(client, {
          user: interaction.user,
          guildId: interaction.guildId,
          source: "encounter",
          qty: result.encounterDiamond,
          fallbackChannel: interaction.channel,
        })
        .catch(() => {});
    }

    const m = result.monster;
    const winPct = Math.round(result.winRate * 100);
    const subTag = result.staminaBonus > 0
      ? `（含 Twitch 訂閱加乘 +${result.staminaBonus}）`
      : "";
    const staminaLine = `🔋 體力：${result.stamina}/${result.staminaMax}${subTag}`;
    const name =
      interaction.member?.displayName || interaction.user.username;
    const continueRow = buildContinueRow(interaction.user.id, name);

    if (!result.won) {
      const container = new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 💀 戰鬥失敗\n` +
              `你遭遇了 **${m.emoji} ${m.name}**（HP ${m.hp}）！\n` +
              `你的攻擊力 **${result.atk}**，勝率 **${winPct}%**…可惜這次落敗了，空手而歸。`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**狀態**\n${staminaLine}`),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**累積探索**\n${result.dungeonCount.toLocaleString()} 次`,
          ),
        );
      if (result.foodBuffLines?.length) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🍽️ 食物加成**\n${result.foodBuffLines.join("\n")}`,
          ),
        );
      }
      container.addActionRowComponents(continueRow);
      appendCombatExtras(container, result, interaction);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 合成更好的武器能提升戰鬥力，提高勝率！",
        ),
      );
      const notifyInfo = await applyStaminaNotifyPre(
        client,
        interaction,
        container,
      );
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      runPostTasks(client, interaction, result, notifyInfo);
      return;
    }

    const lootKind = result.loot.kind || result.loot.id;
    let rewardLine;
    if ((lootKind === "ore" || result.loot.id === "ore_fragment") && result.oreGained) {
      if (result.oreOverflowToCoins) {
        rewardLine =
          `🎒 背包已滿！戰利品 ${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty} ` +
          `折算成 **+${result.coinsGained.toLocaleString()}** ${COIN_EMOJI}`;
      } else {
        rewardLine = `掉落 **${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty}**！`;
      }
      if (result.oreGained.ore === "diamond" && !result.oreOverflowToCoins) {
        diamondAnnouncer
          .announceDiamond(client, {
            user: interaction.user,
            guildId: interaction.guildId,
            source: "dungeon",
            qty: result.oreGained.qty || 1,
            fallbackChannel: interaction.channel,
          })
          .catch(() => {});
      }
    } else if (lootKind === "coins") {
      rewardLine = `掉落 **+${result.coinsGained.toLocaleString()}** ${COIN_EMOJI}！`;
    } else if (lootKind === "fragment" || result.loot.id === "legendary_fragment") {
      rewardLine = `掉落 **✨ 傳說素材碎片 ×${result.legendaryGained}**！（合成 🔥 傳說之劍的材料）`;
    } else if (lootKind === "luck_potion") {
      rewardLine = `掉落 **🍀 幸運藥水 ×${result.potionGained}**！（挖礦時自動生效）`;
    } else if (lootKind === "cd_ticket") {
      rewardLine =
        result.ticketGained > 0
          ? `掉落 **🎫 CD 縮短券 ×${result.ticketGained}**！`
          : `🎫 CD 縮短券已達持有上限，折算成 **+${result.coinsGained.toLocaleString()}** ${COIN_EMOJI}`;
    } else if (lootKind === "slime") {
      rewardLine = `掉落 **💧 怪物黏液 ×${result.slimeGained}**！（農場高階肥料 -25% 成長時間）`;
    } else if (lootKind === "seed" && result.seedGained) {
      const seedName = result.seedGained.seedKey === "seed_black_rose"
        ? "🌹 黑玫瑰種子"
        : result.seedGained.seedKey === "seed_strawberry"
        ? "🍓 草莓種子"
        : `🌱 ${result.seedGained.seedKey}`;
      rewardLine = `掉落 **${seedName} ×${result.seedGained.qty}**！（去 /農場 種下）`;
    } else {
      rewardLine = "雖然贏了，但這次什麼都沒掉落…運氣差了點。";
    }

    const winTitle = result.crit ? "⚡ 暴擊命中！戰鬥勝利！" : "⚔️ 戰鬥勝利！";

    const container = new ContainerBuilder()
      .setAccentColor(result.crit ? 0xf1c40f : 0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${winTitle}\n` +
            `你擊敗了 **${m.emoji} ${m.name}**（HP ${m.hp}）！\n` +
            `戰鬥力 **${result.atk}** ・ 勝率 **${winPct}%**\n\n${rewardLine}`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**狀態**\n${staminaLine}`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**累積探索**\n${result.dungeonCount.toLocaleString()} 次`,
        ),
      );

    if (result.balance != null) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**目前餘額**\n${result.balance.toLocaleString()} ${COIN_EMOJI}`,
        ),
      );
    }

    if (result.foodBuffLines?.length) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**🍽️ 食物加成**\n${result.foodBuffLines.join("\n")}`,
        ),
      );
    }

    container.addActionRowComponents(continueRow);
    appendCombatExtras(container, result, interaction);
    const notifyInfo = await applyStaminaNotifyPre(
      client,
      interaction,
      container,
    );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    runPostTasks(client, interaction, result, notifyInfo);
  } catch (error) {
    console.log(`[ERROR] /地下城:\n${error}\n${error.stack}`.red);
    if (dungeonResult?.ok) {
      await dungeonService
        .rollbackDungeon(
          client,
          {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            username: interaction.user.username,
            member: interaction.member,
          },
          dungeonResult,
        )
        .catch(() => {});
    }
    await interaction
      .editReply("🔧 地下城探索失敗，請呼叫舒舒！體力與物品已退回。")
      .catch(() => {});
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("地下城")
    .setDescription("⚔️ 進入副本面板挑樓層挑戰，HP 多回合戰鬥（體力 / 戰利品 / 解鎖進度都在面板看）")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      return await showEntryPanel(client, interaction);
    } catch (err) {
      console.log(`[ERROR] /地下城 panel: ${err}\n${err.stack}`.red);
      return interaction.editReply("🔧 副本面板載入失敗，請呼叫舒舒！");
    }
  },

  // 既有：給 handleDungeonContinue.js 用（「繼續探索」舊訊息按鈕仍可運作）
  CONTINUE_PREFIX,
  buildContinueRow,
  parseContinueId,
  executeDungeon,
  DUNGEON_OVERFLOW_CONFIRM_PREFIX,
  DUNGEON_OVERFLOW_CANCEL_PREFIX,

  // Phase H+：給 handleDungeonRaidButton.js 用
  RAID_PANEL_PREFIX,
  RAID_ENTER_PREFIX,
  RAID_LOG_PREFIX,
  RAID_HEAL_PREFIX,
  RAID_AGAIN_PREFIX,
  buildEntryPanel,
  buildBattleResultPanel,
  publicBroadcastContent,
  showEntryPanel,
};
