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

const { mining, dungeon } = require("../../config");
const dungeonService = require("../../features/mining/dungeonService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");
const { buildOverflowConfirmView } = require("../../features/mining/overflowConfirm");
const { COIN_EMOJI } = require("../../constants/coin");

const CONTINUE_PREFIX = "dungeon_continue_";
const DUNGEON_OVERFLOW_CONFIRM_PREFIX = "dungeon_overflow_confirm_";
const DUNGEON_OVERFLOW_CANCEL_PREFIX = "dungeon_overflow_cancel_";

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
  const head =
    level === "critical"
      ? `🚨 你的 **${def.emoji || ""} ${def.name || weaponKey}** 只剩 **${durabilityAfter}** 次耐久，下一次戰鬥就會斷！`
      : `⚠️ 你的 **${def.emoji || ""} ${def.name || weaponKey}** 耐久剩 **${durabilityAfter}** 次，差不多該準備了。`;
  await interaction.user.send(
    `${head}\n趁還沒斷，到 \`/合成\` 再做一把、或到 \`/裝備\` 用礦石修復耐久。`
  );
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
    .setDescription("消耗體力深入地下城戰鬥，勝利可獲得礦石、金幣或傳說素材 ⚔️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();
    return executeDungeon(client, interaction, { allowOverflow: false });
  },

  CONTINUE_PREFIX,
  buildContinueRow,
  parseContinueId,
  executeDungeon,
  DUNGEON_OVERFLOW_CONFIRM_PREFIX,
  DUNGEON_OVERFLOW_CANCEL_PREFIX,
};
