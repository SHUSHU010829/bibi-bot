// Phase H+ 地下城副本面板按鈕處理器。
//
// 處理 customId：
//   raid_panel_<ownerId>                       → 重整面板 / 換樓層
//   raid_enter_<ownerId>_<theme>_<floor>       → 進入戰鬥（從面板）
//   raid_again_<ownerId>_<theme>_<floor>       → 再戰同樓層（從結算面板）
//   raid_log_<ownerId>_<runId>                 → 看完整戰鬥日誌（ephemeral follow-up）
//   raid_heal_<ownerId>_<tier>                 → 喝生命藥水（small/medium/large）
//
// 所有按鈕必驗 owner。

require("colors");
const { MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const dungeonCmd = require("../../commands/mining/dungeon");
const dungeonService = require("../../features/mining/dungeonService");
const hpService = require("../../features/dungeon/hpService");
const floorService = require("../../features/dungeon/floorService");
const choiceEventService = require("../../features/dungeon/choiceEventService");
const reminder = require("../../features/reminders/cooldownReminderService");
const { isGameRoom } = require("../../features/gameRoom/service");
const { dungeon } = require("../../config");
const { consume } = require("../../utils/rateLimiter");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");

const PREFIXES = [
  dungeonCmd.RAID_PANEL_PREFIX,
  dungeonCmd.RAID_ENTER_PREFIX,
  dungeonCmd.RAID_AGAIN_PREFIX,
  dungeonCmd.RAID_FORCE_PREFIX,
  dungeonCmd.RAID_BOSS_PREFIX,
  dungeonCmd.RAID_PREP_PREFIX,
  dungeonCmd.RAID_CHOICE_PREFIX,
  dungeonCmd.RAID_STAMINA_PICK_PREFIX,
  dungeonCmd.RAID_USE_STAMINA_PREFIX,
  dungeonCmd.RAID_LOG_PREFIX,
  dungeonCmd.RAID_HEAL_PREFIX,
  dungeonCmd.RAID_SETTINGS_PREFIX,
  dungeonCmd.RAID_PREF_TOGGLE_PREFIX,
  dungeonCmd.RAID_PREF_TIER_PREFIX,
];

function matchAction(cid) {
  for (const p of PREFIXES) {
    if (cid.startsWith(p)) return { prefix: p, payload: cid.slice(p.length) };
  }
  return null;
}

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

// 戰鬥結果 → 同訊息更新為結算面板 + 公開精簡播報
async function runBattleAndRender(client, interaction, { themeId, floor, isMiniBoss = false }) {
  const result = await dungeonService.enterDungeonHp(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    username: interaction.user.username,
    themeId,
    floor,
    isMiniBoss,
  });

  if (!result.ok) {
    const container = new ContainerBuilder().setAccentColor(0xe74c3c);
    if (result.reason === "mini_boss_locked") {
      const ms = result.miniBossState;
      const r = ms?.requirement || {};
      const p = ms?.progress || {};
      if (r.recharge) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## ⏳ mini-BOSS 蓄力中"));
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `單次挑戰制：擊敗後需再通關 ${p.floor || 5}F ×${r.clears} 才能再戰\n目前已刷：${p.cleared || 0} 次`,
          ),
        );
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 先回主面板多打幾場 5F，累滿就能再挑戰 BOSS。"),
        );
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🔒 mini-BOSS 未解鎖"));
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `解鎖條件：${p.floor || 5}F 通關 ${r.clears || 5} 次\n目前：${p.cleared || 0} 次`,
          ),
        );
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 多打 5F 累積通關次數。"),
        );
      }
    } else if (result.reason === "floor_locked") {
      const fs = result.floorState;
      const f = fs?.floor;
      const r = fs?.requirement || {};
      const p = fs?.progress || {};
      let body;
      if (fs?.reason === "level") {
        body = `🔒 ${f?.emoji || ""} ${f?.floor}F ${f?.name} 尚未解鎖！\n解鎖條件：等級 ${r.level}\n目前：Lv.${p.level}`;
      } else if (fs?.reason === "prereq_clears") {
        body = `🔒 ${f?.emoji || ""} ${f?.floor}F ${f?.name} 尚未解鎖！\n解鎖條件：${p.floor}F 通關 ${r.count} 次\n目前：${p.cleared} 次`;
      } else {
        body = `🔒 樓層尚未解鎖`;
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔒 樓層未解鎖`));
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 多打低樓層累積通關，或升等開新樓層。"));
    } else if (result.reason === "no_stamina") {
      const lines = [
        `🔋 體力剩 0/${result.max}（需要 ${result.staCost} 點才能進場）`,
      ];
      if (result.nextRegenAt) lines.push(`下一點體力：<t:${Math.floor(result.nextRegenAt / 1000)}:R>（每小時 +1）`);
      if (result.potionCount > 0) lines.push(`-# 你有 ${result.potionCount} 瓶體力藥水，按下方按鈕直接喝。`);
      else lines.push("-# 到 /商店 → 地下城道具 補體力藥水（每日上限 3 瓶）");
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 😮‍💨 體力耗盡"));
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
      // 直接喝體力藥水（持有時才顯示）
      if (result.potionCount > 0) {
        container.addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${dungeonCmd.RAID_STAMINA_PICK_PREFIX}${interaction.user.id}`)
              .setLabel(`🥤 喝體力藥水（剩 ${result.potionCount}）`)
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`${dungeonCmd.RAID_PANEL_PREFIX}${interaction.user.id}_${themeId}`)
              .setLabel("⬅️ 回主面板")
              .setStyle(ButtonStyle.Secondary),
          ),
        );
      }
    } else if (result.reason === "backpack_full") {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🎒 背包已滿"));
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`目前 ${result.used}/${result.cap}，先 /賣礦 或 /合成 清空間再戰。`));
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("🔧 進地下城失敗，請稍後再試。"));
    }
    return interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  // 1) 更新 ephemeral 為結算面板
  const resultContainer = dungeonCmd.buildBattleResultPanel(interaction.user.id, result);
  await interaction.editReply({
    components: [resultContainer],
    flags: MessageFlags.IsComponentsV2,
  });

  if (result.weaponDurabilityWarnCrossed && result.weaponBefore) {
    dungeonCmd
      .dmWeaponLowDurability(
        interaction,
        result.weaponBefore,
        result.weaponDurabilityAfter,
        result.weaponDurabilityWarnCrossed,
      )
      .catch(() => {});
  }

  // 2) 公開精簡播報（送到 dungeon.channelId，沒設或頻道不可用則 fallback 當前頻道）
  //    在個人遊戲房內觸發時，播報保留在房內，不外送到公開地下城頻道。
  const displayName = interaction.member?.displayName || interaction.user.username;
  const content = dungeonCmd.publicBroadcastContent(displayName, result);
  const channelId = dungeon?.channelId;
  let pubChannel = interaction.channel;
  if (channelId && !isGameRoom(interaction.channelId)) {
    try {
      const c = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (c?.isTextBased?.()) pubChannel = c;
    } catch (_) {}
  }
  await pubChannel?.send({ content }).catch(() => {});

  // 3) 任務 / 通知 / 稱號補登（fire-and-forget）
  (async () => {
    try {
      // 體力剛被扣，若玩家有開地下城體力到點通知，refresh readyAt 為
      // 「打完這場後的剩餘體力補滿時間」；否則 cron 會用打前算的舊時間 DM，
      // 提早通知玩家體力補滿。
      const fullAt = await dungeonService
        .staminaFullAt(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
        })
        .catch(() => 0);
      await reminder
        .refreshIfEnabled(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "dungeon",
          readyAt: fullAt,
        })
        .catch(() => {});

      const applyQuestHooks = require("../../features/quests/applyQuestHooks");
      const hooks = [{ questId: "daily_dungeon_10" }, { questId: "weekly_dungeon" }];
      if (result.won) {
        hooks.push({ questId: "daily_dungeon_win" });
        hooks.push({ questId: "weekly_dungeon_win" });
        // Phase H+ 新增任務鉤點
        if (result.floor >= 3) hooks.push({ questId: "daily_dungeon_floor3" });
        if (result.isMiniBoss) hooks.push({ questId: "weekly_mini_boss" });
        if (result.theme === "ice") hooks.push({ questId: "weekly_dungeon_ice" });
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
        hooks,
      );
      // 稱號自動檢查（dungeon 類 + 龍裔屠龍累積，category boss）
      if (result.won) {
        const gameTitleService = require("../../features/gameTitles/gameTitleService");
        gameTitleService
          .check(
            client,
            {
              userId: interaction.user.id,
              guildId: interaction.guildId,
              member: interaction.member,
            },
            ["dungeon", "boss"],
          )
          .catch(() => {});
      }
    } catch (e) {
      console.log(`[WARN] /地下城 panel 事後補登：${e?.message || e}`.yellow);
    }
  })();
}

async function showEntryPanelOnSameMessage(client, interaction, opts = {}) {
  const container = await dungeonCmd.buildEntryPanel(client, interaction, opts);
  return interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function showBattleLog(interaction, runId) {
  const client = interaction.client;
  if (!client.dungeonRunsCollection) {
    return replyEphemeral(interaction, "🔧 戰鬥日誌系統未啟動。");
  }
  // M5 修正：先 defer 避免 Mongo 查詢慢時超過 3s 互動視窗
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const doc = await client.dungeonRunsCollection.findOne({ run_id: runId, user_id: interaction.user.id }).catch(() => null);
  if (!doc) return interaction.editReply("找不到這場戰鬥的紀錄（或已過期）。").catch(() => {});

  const log = doc.battle_log || [];
  // L2 修正：把怪物名 / mini-BOSS 中文名帶進日誌格式器，避免一直印「怪物反擊」。
  // 優先用 run 內存的名稱（涵蓋 mini-BOSS 變體），fallback 才查 config。
  const monsterDef = dungeon?.monsterDefs?.[doc.monster_id]
    || dungeon?.miniBosses?.[doc.theme]
    || null;
  const monsterLabel = doc.monster_name
    ? `${doc.monster_emoji || "👹"} ${doc.monster_name}`
    : monsterDef
      ? `${monsterDef.emoji || "👹"} ${monsterDef.name}`
      : "👹 怪物";
  const lines = [];
  const maxLines = 20;
  if (log.length <= maxLines) {
    for (const e of log) lines.push(formatLogEntry(e, monsterLabel));
  } else {
    for (let i = 0; i < 10; i += 1) lines.push(formatLogEntry(log[i], monsterLabel));
    lines.push(`-# … 中段 ${log.length - 20} 條省略 …`);
    for (let i = log.length - 10; i < log.length; i += 1) lines.push(formatLogEntry(log[i], monsterLabel));
  }

  // doc.theme 是 system key，UI 要顯示中文（CLAUDE.md #9）
  const themeDef = (dungeon?.themes || []).find((t) => t.id === doc.theme);
  const themeLabel = themeDef ? `${themeDef.emoji || ""} ${themeDef.name}` : doc.theme;

  const container = new ContainerBuilder()
    .setAccentColor(doc.result === "win" ? 0x2ecc71 : 0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📜 戰鬥日誌 — ${themeLabel} ${doc.floor}F`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n") || "（無）"));
  return interaction.editReply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

function formatLogEntry(e, monsterLabel = "👹 怪物") {
  if (!e) return "";
  const turn = e.turn ? `第 ${e.turn} 回合：` : "";
  switch (e.type) {
    case "player_attack":
      return `🗡️ ${turn}你揮砍 → ${e.damage} 傷害${e.crit ? "（暴擊！）" : ""}${e.wounded ? "（重傷狀態）" : ""}`;
    case "monster_attack":
      return `${monsterLabel} ${turn}反擊 ${e.raw_damage} → ${e.blocked ? "🛡️ 格擋！" : ""}受 ${e.damage} 傷（HP ${e.hp_after}${e.shield_after != null ? `，盾 ${e.shield_after}` : ""}）`;
    case "status_apply":
      return `${turn}${e.note || `${e.target} 陷入${e.status}`}`;
    case "status_tick":
      return `${turn}${e.status} 持續傷害 → ${e.damage} 傷（HP ${e.hp_after}）`;
    case "status_immunity":
      return `${turn}${e.note}`;
    case "pet_assist":
      if (e.kind === "combat") return `🐶 ${turn}寵物追擊 → ${e.damage} 傷害（怪物 HP ${e.hp_after}）`;
      if (e.kind === "healer") return `🐶 ${turn}寵物治癒 → 回 ${e.heal} HP（HP ${e.hp_after}）`;
      return `🐶 ${turn}寵物協戰`;
    case "shield_reflect":
      return `✨ ${turn}盾光反射！對怪物造成 ${e.damage} 反彈傷害（怪物 HP ${e.hp_after}）`;
    case "potion_auto":
      return `💊 ${turn}自動使用生命藥水（${e.tier}）→ 回 ${e.heal} HP（HP ${e.hp_after}）`;
    case "player_stunned":
      return `💫 ${turn}你被暈眩，本回合無法行動`;
    case "note":
      return `${turn}${e.note}`;
    default:
      return `${turn}${e.type}`;
  }
}

async function doHeal(client, interaction, tier, themeId) {
  if (tier === "none") {
    return replyEphemeral(interaction, "你沒有生命藥水，到 /商店 → 挖礦道具 購買。");
  }
  const status = await dungeonService.getDungeonStatus(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
  });
  const result = await hpService.useHpPotion(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    tier,
    level: status.level,
    extras: {},
  });
  if (!result.ok) {
    if (result.reason === "no_potion") return replyEphemeral(interaction, "你沒有這瓶藥水了。");
    if (result.reason === "full") return replyEphemeral(interaction, `❤️ HP 已滿（${result.hp}/${result.hpMax}）`);
    return replyEphemeral(interaction, "🔧 補血失敗，請稍後再試。");
  }
  // 喝完 → 重整面板（保留當前副本主題）
  return showEntryPanelOnSameMessage(client, interaction, themeId ? { themeId } : {});
}

module.exports = async (client, interaction) => {
  try {
    // 同時接 button 與 string select menu（設定面板用 select）
    const isBtn = interaction.isButton?.() === true;
    const isSel = interaction.isStringSelectMenu?.() === true;
    if (!isBtn && !isSel) return;
    const cid = interaction.customId;
    const m = matchAction(cid);
    if (!m) return;

    // 解析 ownerId（第一段，到下底線為止）
    const firstUnderscore = m.payload.indexOf("_");
    const ownerId = firstUnderscore === -1 ? m.payload : m.payload.slice(0, firstUnderscore);
    if (interaction.user.id !== ownerId) {
      return replyEphemeral(interaction, "🚫 這不是你的地下城面板！");
    }
    // 限流
    const rl = consume(interaction.user.id, "btn:raid", { windowMs: 1500, max: 1 });
    if (!rl.allowed) {
      return replyEphemeral(interaction, `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`);
    }

    if (m.prefix === dungeonCmd.RAID_PANEL_PREFIX) {
      // payload = <ownerId> 或 <ownerId>_<theme>
      const parts = m.payload.split("_");
      const themeArg = parts[1]; // 可選
      if (!(await deferUpdateSafe(interaction))) return;
      await showEntryPanelOnSameMessage(client, interaction, themeArg ? { themeId: themeArg } : {});
      trackSuccess("raid-panel");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_BOSS_PREFIX) {
      // payload = <ownerId>_<theme>
      const parts = m.payload.split("_");
      const themeId = parts[1];
      if (!themeId) return replyEphemeral(interaction, "🔧 主題參數錯誤。");
      if (!(await deferUpdateSafe(interaction))) return;
      // BOSS 遭遇面板已顯示 HP 並提供「先去準備」，這裡不再攔低 HP，直接迎戰。
      await runBattleAndRender(client, interaction, { themeId, floor: 5, isMiniBoss: true });
      trackSuccess("raid-boss");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_PREP_PREFIX) {
      // payload = <ownerId>_<theme>：BOSS 遭遇時的「先去準備」面板（補血/檢視裝備）
      const parts = m.payload.split("_");
      const themeId = parts[1];
      if (!themeId) return replyEphemeral(interaction, "🔧 主題參數錯誤。");
      if (!(await deferUpdateSafe(interaction))) return;
      const status = await dungeonService.getDungeonStatus(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      });
      const mbState = floorService.miniBossUnlockState(status.profile, status.level, themeId);
      // 準備期間 BOSS 已被別的路徑消耗（理論上不會）→ 回主面板即可
      if (!mbState.unlocked) {
        await showEntryPanelOnSameMessage(client, interaction, { themeId });
        trackSuccess("raid-prep-fallback");
        return;
      }
      const container = dungeonCmd.buildBossPrepPanel(interaction.user.id, status, themeId, mbState.miniBoss);
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("raid-prep");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_CHOICE_PREFIX) {
      // payload = <ownerId>_<optIdx>_<eventId>（eventId 可能含底線 → 取剩餘全部）
      const parts = m.payload.split("_");
      const optIdx = parseInt(parts[1], 10);
      const eventId = parts.slice(2).join("_");
      if (!eventId || !Number.isFinite(optIdx)) {
        return replyEphemeral(interaction, "🔧 事件參數錯誤。");
      }
      if (!(await deferUpdateSafe(interaction))) return;
      const event = choiceEventService.getEvent(eventId);
      const option = event?.options?.[optIdx];
      if (!event || !option) {
        return replyEphemeral(interaction, "🔧 這個事件已經過期或不存在了。");
      }
      const status = await dungeonService.getDungeonStatus(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      });
      const res = await choiceEventService.resolveOption(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        username: interaction.user.username,
        eventId,
        optionId: option.id,
        status,
      });
      const container = new ContainerBuilder().setAccentColor(0x9b59b6);
      if (!res.ok) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## ❓ 事件結束"));
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent("這個事件已經無法處理了。"));
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## ${res.event.emoji} ${res.event.name}`),
        );
        container.addSeparatorComponents(new SeparatorBuilder());
        const body = [`你選擇了：**${res.option.emoji || ""} ${res.option.label}**`];
        if (res.outcomeText) body.push(res.outcomeText);
        if (res.resultLines?.length) body.push(res.resultLines.join("\n"));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body.join("\n")));
      }
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${dungeonCmd.RAID_PANEL_PREFIX}${interaction.user.id}`)
            .setLabel("⬅️ 回主面板")
            .setStyle(ButtonStyle.Primary),
        ),
      );
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("raid-choice");
      return;
    }

    if (
      m.prefix === dungeonCmd.RAID_ENTER_PREFIX ||
      m.prefix === dungeonCmd.RAID_AGAIN_PREFIX ||
      m.prefix === dungeonCmd.RAID_FORCE_PREFIX
    ) {
      // payload = <ownerId>_<theme>_<floor>
      const parts = m.payload.split("_");
      const themeId = parts[1];
      const floor = parseInt(parts[2], 10);
      if (!themeId || !Number.isFinite(floor)) {
        return replyEphemeral(interaction, "🔧 樓層參數錯誤。");
      }
      if (!(await deferUpdateSafe(interaction))) return;
      // 戰前低 HP 確認（強制進場 prefix 跳過）
      if (m.prefix !== dungeonCmd.RAID_FORCE_PREFIX) {
        const status = await dungeonService.getDungeonStatus(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
        });
        if (status.hpLow) {
          const container = dungeonCmd.buildLowHpConfirmPanel(
            interaction.user.id, status, themeId, floor,
          );
          await interaction.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
          });
          trackSuccess("raid-enter-confirm");
          return;
        }
      }
      await runBattleAndRender(client, interaction, { themeId, floor });
      trackSuccess("raid-enter");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_LOG_PREFIX) {
      const parts = m.payload.split("_");
      const runId = parts.slice(1).join("_");
      await showBattleLog(interaction, runId);
      trackSuccess("raid-log");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_STAMINA_PICK_PREFIX) {
      if (!(await deferUpdateSafe(interaction))) return;
      const status = await dungeonService.getDungeonStatus(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      });
      if (dungeonService.totalStaminaPotions(status.profile) <= 0) {
        return replyEphemeral(interaction, "🥤 你沒有體力藥水了，到 /商店 → 地下城道具 補貨。");
      }
      if (status.stamina >= status.staminaMax) {
        return replyEphemeral(interaction, "🔋 體力已滿，不需要喝。");
      }
      await interaction.editReply({
        components: [dungeonCmd.buildStaminaPotionPickPanel(interaction.user.id, status)],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("raid-stamina-pick");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_USE_STAMINA_PREFIX) {
      // payload = <ownerId> 或 <ownerId>_<tier>（tier ∈ small/medium/large）
      const tier = m.payload.split("_")[1];
      if (!(await deferUpdateSafe(interaction))) return;
      const result = await dungeonService.useStaminaPotion(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        tier,
      });
      if (!result.ok) {
        const msg = {
          no_potion: "🥤 你沒有體力藥水了，到 /商店 → 地下城道具 補貨。",
          full: "🔋 體力已滿，不需要喝。",
          disabled: "🔧 系統暫時無法使用。",
          retry: "⏳ 操作衝突，請再試一次。",
        }[result.reason] || "🔧 使用失敗，請稍後再試。";
        return replyEphemeral(interaction, msg);
      }
      // 喝完後直接回主面板
      await showEntryPanelOnSameMessage(client, interaction);
      // 體力上升 → 補滿時間提前，refresh reminder readyAt（無訂閱時 no-op）
      reminder
        .refreshIfEnabled(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "dungeon",
          readyAt: await dungeonService
            .staminaFullAt(client, {
              userId: interaction.user.id,
              guildId: interaction.guildId,
              member: interaction.member,
            })
            .catch(() => 0),
        })
        .catch(() => {});
      trackSuccess("raid-use-stamina");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_HEAL_PREFIX) {
      const parts = m.payload.split("_");
      const tier = parts[1];
      const themeId = parts[2]; // 可選
      if (!(await deferUpdateSafe(interaction))) return;
      await doHeal(client, interaction, tier, themeId);
      trackSuccess("raid-heal");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_SETTINGS_PREFIX) {
      const themeId = m.payload.split("_")[1]; // 可選
      if (!(await deferUpdateSafe(interaction))) return;
      const status = await dungeonService.getDungeonStatus(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      });
      const container = dungeonCmd.buildSettingsPanel(interaction.user.id, status, themeId);
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("raid-settings-open");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_PREF_TOGGLE_PREFIX) {
      // StringSelect 值：'on' / 'off'
      const themeId = m.payload.split("_")[1]; // 可選
      const value = interaction.values?.[0];
      if (!(await deferUpdateSafe(interaction))) return;
      await dungeonService.setAutoPotionPref(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        autoPotion: value === "on",
      });
      // 重新渲染設定面板（讓 setDefault 反映新值）
      const status = await dungeonService.getDungeonStatus(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      });
      await interaction.editReply({
        components: [dungeonCmd.buildSettingsPanel(interaction.user.id, status, themeId)],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("raid-pref-toggle");
      return;
    }

    if (m.prefix === dungeonCmd.RAID_PREF_TIER_PREFIX) {
      const themeId = m.payload.split("_")[1]; // 可選
      const value = interaction.values?.[0];
      if (!(await deferUpdateSafe(interaction))) return;
      await dungeonService.setAutoPotionPref(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        tier: value,
      });
      const status = await dungeonService.getDungeonStatus(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
      });
      await interaction.editReply({
        components: [dungeonCmd.buildSettingsPanel(interaction.user.id, status, themeId)],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("raid-pref-tier");
      return;
    }
  } catch (err) {
    logger.error(
      {
        source: "dungeon-raid",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "地下城面板按鈕處理失敗",
    );
    trackError("dungeon-raid", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 地下城操作失敗，請呼叫舒舒！");
  }
};
