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
const { COIN_EMOJI } = require("../../constants/coin");

// 「繼續探索」按鈕 customId 格式：dungeon_continue_<ownerId>
// ownerId 為純數字 snowflake，放最後一個底線後，方便切分。
// 重複探索流程由 events/interactionCreate/handleDungeonContinue.js 處理。
const CONTINUE_PREFIX = "dungeon_continue_";

// Discord 按鈕文字上限 80 字
const MAX_LABEL_LEN = 80;

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

function weaponLabel(key) {
  const def = (dungeon?.weapons || {})[key] || {};
  return `${def.emoji || "👊"} ${def.name || key}`;
}

// 武器耐久提示 + 突發事件，兩種戰鬥結果共用，append 進 container。
function appendCombatExtras(container, result) {
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
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**武器耐久**\n${weaponLabel(result.weaponBefore)} 剩 ${result.weaponDurabilityAfter} 次`,
      ),
    );
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

// 體力補滿到點通知：刷新已訂閱者的 readyAt；沒訂閱就在訊息底部給個小提示。
async function applyStaminaNotify(client, interaction, container) {
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

  if (state?.enabled) {
    await reminder
      .refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "dungeon",
        readyAt: fullAt,
      })
      .catch(() => {});
  } else if (fullAt > Date.now()) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🔔 想在體力補滿時收到提醒？用 `/通知設定` 開啟地下城體力通知。"
      )
    );
  }
}

// 帶上玩家名稱，讓大量訊息中能快速分辨是誰的按鈕。
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName("地下城")
    .setDescription("消耗體力深入地下城戰鬥，勝利可獲得礦石、金幣或傳說素材 ⚔️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const result = await dungeonService.enterDungeon(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        username: interaction.user.username,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 地下城系統尚未啟動！");
        }
        if (result.reason === "no_stamina") {
          const tail = result.nextRegenAt
            ? `\n下一點體力：<t:${Math.floor(result.nextRegenAt / 1000)}:R>`
            : "";
          return interaction.editReply(
            `😮‍💨 體力耗盡了（0/${result.max}）！每小時回復 1 點，休息一下再來。${tail}`
          );
        }
        return interaction.editReply("🔧 進地下城失敗，請稍後再試。");
      }

      // 地下城任務進度：完成一場探索（不論勝負）＋勝利再加計勝場
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
          )
          .addActionRowComponents(continueRow);
        appendCombatExtras(container, result);
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 合成更好的武器能提升戰鬥力，提高勝率！",
          ),
        );
        await applyStaminaNotify(client, interaction, container);
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      // 勝利戰利品描述
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

      container.addActionRowComponents(continueRow);
      appendCombatExtras(container, result);
      await applyStaminaNotify(client, interaction, container);

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /地下城:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 地下城探索失敗，請呼叫舒舒！").catch(() => {});
    }
  },

  CONTINUE_PREFIX,
  buildContinueRow,
  parseContinueId,
};
