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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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
const RAID_FORCE_PREFIX = "raid_force_";       // 強制進場（低 HP 確認後）：raid_force_<ownerId>_<theme>_<floor>
const RAID_BOSS_PREFIX = "raid_boss_";         // 挑戰 mini-BOSS：raid_boss_<ownerId>_<theme>
const RAID_USE_STAMINA_PREFIX = "raid_use_stamina_"; // 體力耗盡時喝精力藥水：raid_use_stamina_<ownerId>
const RAID_SETTINGS_PREFIX = "raid_settings_"; // 開設定面板：raid_settings_<ownerId>
const RAID_PREF_TOGGLE_PREFIX = "raid_pref_toggle_"; // SelectMenu：自動藥水開關
const RAID_PREF_TIER_PREFIX = "raid_pref_tier_";     // SelectMenu：用哪瓶偏好

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
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${RAID_SETTINGS_PREFIX}${ownerId}`)
      .setLabel("⚙️ 設定")
      .setStyle(ButtonStyle.Secondary),
  );
  return row;
}

// Phase H+ 設定面板：自動藥水開關 + 用哪瓶優先
function buildSettingsPanel(ownerId, status) {
  const autoPotion = status.autoPotion !== false;
  const tier = status.autoPotionTier || "smallest";
  const tierLabel = {
    smallest: "最小可用瓶（最省，預設）",
    largest: "最大可用瓶（救急）",
    small: "只用 💊 小瓶",
    medium: "只用 💊 中瓶",
    large: "只用 💊 大瓶",
  }[tier] || tier;
  const stateLines = [
    `自動藥水：**${autoPotion ? "✅ 開啟" : "⛔ 關閉"}**`,
    `優先順序：**${tierLabel}**`,
    "-# HP ≤ 30% 時觸發；開關關閉時戰鬥中完全不自動吃，請在面板上手動補血。",
  ];

  const toggleSelect = new StringSelectMenuBuilder()
    .setCustomId(`${RAID_PREF_TOGGLE_PREFIX}${ownerId}`)
    .setPlaceholder("自動藥水：開 / 關")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("✅ 開啟自動藥水（HP ≤ 30% 自動吃）")
        .setValue("on")
        .setDefault(autoPotion),
      new StringSelectMenuOptionBuilder()
        .setLabel("⛔ 關閉自動藥水（完全手動補血）")
        .setValue("off")
        .setDefault(!autoPotion),
    );
  const tierSelect = new StringSelectMenuBuilder()
    .setCustomId(`${RAID_PREF_TIER_PREFIX}${ownerId}`)
    .setPlaceholder("用哪瓶優先")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("最小可用瓶（小→中→大，最省）").setValue("smallest").setDefault(tier === "smallest"),
      new StringSelectMenuOptionBuilder().setLabel("最大可用瓶（大→中→小，救急）").setValue("largest").setDefault(tier === "largest"),
      new StringSelectMenuOptionBuilder().setLabel("只用 💊 小瓶").setValue("small").setDefault(tier === "small"),
      new StringSelectMenuOptionBuilder().setLabel("只用 💊 中瓶").setValue("medium").setDefault(tier === "medium"),
      new StringSelectMenuOptionBuilder().setLabel("只用 💊 大瓶").setValue("large").setDefault(tier === "large"),
    );

  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚙️ 地下城設定"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(stateLines.join("\n")))
    .addActionRowComponents(new ActionRowBuilder().addComponents(toggleSelect))
    .addActionRowComponents(new ActionRowBuilder().addComponents(tierSelect))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${RAID_PANEL_PREFIX}${ownerId}`)
          .setLabel("⬅️ 回主面板")
          .setStyle(ButtonStyle.Primary),
      ),
    );
  return container;
}

async function buildEntryPanel(client, interaction, { themeId = "mine" } = {}) {
  const status = await dungeonService.getDungeonStatus(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
  });
  // 防呆：選了未解鎖的主題就 fallback 回礦坑
  const requested = floorService.themeUnlockState(status.profile, status.level, themeId);
  if (!requested.unlocked) themeId = "mine";
  const floorStates = floorService.listFloors(status.profile, status.level, themeId);

  // 當前主題的中文標題
  const themesAll = floorService.listThemes(status.profile, status.level);
  const curTheme = (dungeon?.themes || []).find((t) => t.id === themeId) || { id: "mine", name: "礦坑", emoji: "⛏️" };

  const container = new ContainerBuilder()
    .setAccentColor(status.hpCritical ? 0xe74c3c : status.hpLow ? 0xfaa61a : 0x3498db)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚔️ 地下城"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLines(status).join("\n")))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**選擇樓層挑戰**（${curTheme.emoji || ""} ${curTheme.name}主題）`));

  // 主題切換按鈕（依解鎖狀態 disable，鎖定者加 🔒 emoji）
  const themeRow = new ActionRowBuilder();
  for (const ts of themesAll) {
    const t = ts.theme;
    const btn = new ButtonBuilder()
      .setCustomId(`${RAID_PANEL_PREFIX}${interaction.user.id}_${t.id}`)
      .setLabel(`${t.emoji || ""} ${t.name}`)
      .setStyle(t.id === themeId ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!ts.unlocked || t.id === themeId);
    if (!ts.unlocked) btn.setEmoji("🔒");
    themeRow.addComponents(btn);
  }

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
  container.addActionRowComponents(buildFloorActionRow(interaction.user.id, floorStates, themeId));
  container.addActionRowComponents(themeRow);
  container.addActionRowComponents(buildActionsRow(interaction.user.id, status));

  // Phase H+ mini-BOSS（解鎖時才顯示按鈕；門檻：當前主題 5F 通關 ×5）
  const mbState = floorService.miniBossUnlockState(status.profile, status.level, themeId);
  if (mbState.unlocked) {
    const mb = mbState.miniBoss;
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 👹 mini-BOSS：${mb.emoji || ""} ${mb.name}（HP ${mb.hp.toLocaleString()} ・ ATK ${mb.atk}）\n-# 體力 -${mb.staminaCost || 3} ・ 武器耐久 -${mb.weaponDurabilityCost || 4} ・ 必掉傳說碎片 ×1 ・ 屠龍累積 +1`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${RAID_BOSS_PREFIX}${interaction.user.id}_${themeId}`)
            .setLabel(`⚔️ 挑戰 ${mb.name}`)
            .setStyle(ButtonStyle.Danger),
        ),
      );
  } else if (mbState.reason === "prereq_clears") {
    const p = mbState.progress || {};
    const r = mbState.requirement || {};
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 👹 mini-BOSS：當前主題 5F 通關 ${r.clears} 次解鎖（目前 ${p.cleared} 次）`,
      ),
    );
  }

  // 主題鎖定條件提示（顯示尚未解鎖的主題該怎麼解）
  const lockedThemes = themesAll.filter((t) => !t.unlocked && t.reason !== "unknown_theme");
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

// 死亡懲罰掉物名稱（依 kind 走 mining/fishing/farming 名稱表，避免印出原始 key — CLAUDE.md #9）
function deathDropLabel(drop) {
  const { farming, fishing } = require("../../config");
  if (drop.kind === "ore") return oreLabel(drop.key);
  if (drop.kind === "fish") {
    const f = fishing?.fish?.[drop.key] || {};
    return `${f.emoji || "🐟"} ${f.name || drop.key}`;
  }
  if (drop.kind === "veggie") {
    const c = farming?.crops?.[drop.key] || {};
    return `${c.emoji || "🌱"} ${c.name || drop.key}`;
  }
  return drop.key;
}

function buildBattleResultPanel(ownerId, result) {
  const container = new ContainerBuilder();
  const isWin = result.won;
  container.setAccentColor(isWin ? 0x2ecc71 : 0xe74c3c);

  // H6：mini-BOSS 標題不重複 emoji。普通樓層仍走「樓層 emoji + 樓層名 + 主題」格式。
  const headLabel = result.isMiniBoss
    ? `🏆 mini-BOSS：${result.monster.emoji} ${result.monster.name}`
    : `${result.floorEmoji || ""} ${result.floor}F ${result.floorName || ""}`.trim();
  const title = isWin
    ? `## ⚔️ ${headLabel} — ✅ 勝利！（${result.turns} 回合）`
    : result.battleResult === "draw"
      ? `## ⏳ ${headLabel} — 戰鬥逾時（${result.turns} 回合，視同失敗）`
      : `## 💀 ${headLabel} — 戰鬥失敗（${result.turns} 回合）`;

  // 副標：mini-BOSS 已在頭部寫過怪物名，這裡不重複；一般樓層顯示怪物。
  const subline = result.isMiniBoss
    ? ""
    : `\n你${isWin ? "擊敗" : "不敵"} **${result.monster.emoji} ${result.monster.name}**`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`${title}${subline}`),
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
      new TextDisplayBuilder().setContent(`-# 死亡懲罰：背包遺失 ${deathDropLabel(result.deathDrop)} ×${result.deathDrop.qty}`),
    );
  }

  if (result.encounter) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${result.encounter.emoji} **突發事件：${result.encounter.name}**\n${result.encounter.body}`,
      ),
    );
  }

  const potionsAfter = result.potionsAfter || { small: 0, medium: 0, large: 0 };
  const hasPotion = (potionsAfter.small + potionsAfter.medium + potionsAfter.large) > 0;
  // 補血預設用最小可用瓶（與戰中自動藥水規則一致，避免浪費）
  const healTier = potionsAfter.small > 0 ? "small" : potionsAfter.medium > 0 ? "medium" : potionsAfter.large > 0 ? "large" : null;
  const againCustomId = result.isMiniBoss
    ? `${RAID_BOSS_PREFIX}${ownerId}_${result.theme}`
    : `${RAID_AGAIN_PREFIX}${ownerId}_${result.theme}_${result.floor}`;
  const againLabel = result.isMiniBoss ? `⚔️ 再戰 mini-BOSS` : `⚔️ 再戰 ${result.floor}F`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(againCustomId)
      .setLabel(againLabel)
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
      new TextDisplayBuilder().setContent("-# 你的武器斷了！到 /合成 打一把新的，或到 /裝備 用劣質磨石修復。"),
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
  if (result.isMiniBoss) {
    if (result.won) {
      const total = result.dragonSlayerTotal ?? null;
      const tail = total != null ? `屠龍累積 **${total}/10**` : `屠龍累積 +1`;
      return `🏆 **${displayName}** 擊敗 ${result.monster.emoji || ""} ${result.monster.name}！${tail}`;
    }
    return `💀 **${displayName}** 挑戰 ${result.monster.emoji || ""} ${result.monster.name} 失敗，撐了 ${result.turns} 回合`;
  }
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

// 戰前低 HP 確認面板：HP < 30% 時點樓層按鈕觸發，避免新手不小心送頭。
function buildLowHpConfirmPanel(ownerId, status, themeId, floor) {
  const f = (dungeon?.floors || []).find((x) => x.floor === floor) || {};
  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⚠️ HP 偏低，建議先補血"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `目前 ❤️ HP **${status.hp}/${status.hpMax}**（${Math.round(status.hp / status.hpMax * 100)}%）` +
        `\n進入 ${f.emoji || ""} ${f.floor}F ${f.name || ""} 風險高，怪物 ATK 約 ${f.monsterAtkRange?.[0] || "?"}–${f.monsterAtkRange?.[1] || "?"}。`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 重傷狀態下 ATK ×0.8、暴擊率 ×0.5。建議先補血、或回換樓層改打低樓層。",
      ),
    );

  const small = status.potions.small;
  const medium = status.potions.medium;
  const large = status.potions.large;
  const hasPotion = (small + medium + large) > 0;
  const healTier = small > 0 ? "small" : medium > 0 ? "medium" : large > 0 ? "large" : null;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RAID_HEAL_PREFIX}${ownerId}_${healTier || "none"}`)
      .setLabel(hasPotion ? "💊 補血（最小瓶）" : "💊 無生命藥水")
      .setStyle(hasPotion ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!hasPotion),
    new ButtonBuilder()
      .setCustomId(`${RAID_FORCE_PREFIX}${ownerId}_${themeId}_${floor}`)
      .setLabel(`⚠️ 強制進場 ${floor}F`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${RAID_PANEL_PREFIX}${ownerId}`)
      .setLabel("❌ 取消（回面板）")
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(row);
  return container;
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
                .setLabel(`🧪 補充精力藥水（剩 ${potionCount} 瓶）`)
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
              "-# 想立刻續命？到 /商店 → 挖礦道具 買精力藥水（每日上限 3 瓶）。",
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
    .setDescription("⚔️ 進入地下城面板挑樓層挑戰，HP 多回合戰鬥（體力 / 戰利品 / 解鎖進度都在面板看）")
    .setContexts(InteractionContextType.Guild),

  // 地下城頻道綁定改由 dungeon.json 的 channelId 決定（見 run() 內檢查），
  // 跳過依資料夾分流的 channelGuard，避免雙重檢查衝突（mining bucket 不含此頻道）。
  skipChannelGuard: true,

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // 頻道綁定：規格要求只允許在 dungeon.channelId 使用，其他頻道回 ephemeral 提示
    const boundChannel = dungeon?.channelId;
    if (boundChannel && interaction.channelId !== boundChannel) {
      const container = new ContainerBuilder()
        .setAccentColor(0xfaa61a)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("## 🔒 請至指定頻道使用"),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `/地下城 面板僅限在 <#${boundChannel}> 使用。\n戰鬥結果會公開播報到該頻道，避免洗版其他頻道。`,
          ),
        );
      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    try {
      return await showEntryPanel(client, interaction);
    } catch (err) {
      console.log(`[ERROR] /地下城 panel: ${err}\n${err.stack}`.red);
      return interaction.editReply("🔧 地下城面板載入失敗，請呼叫舒舒！");
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
  RAID_FORCE_PREFIX,
  RAID_BOSS_PREFIX,
  RAID_USE_STAMINA_PREFIX,
  RAID_SETTINGS_PREFIX,
  RAID_PREF_TOGGLE_PREFIX,
  RAID_PREF_TIER_PREFIX,
  buildEntryPanel,
  buildBattleResultPanel,
  buildLowHpConfirmPanel,
  buildSettingsPanel,
  publicBroadcastContent,
  showEntryPanel,
};
