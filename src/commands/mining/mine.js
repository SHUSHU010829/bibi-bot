require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, commandChannels, normalChannelId } = require("../../config");
const mineService = require("../../features/mining/mineService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");
const eventEngine = require("../../features/event/eventEngine");
const {
  buildOverflowConfirmView,
  overflowLineText,
} = require("../../features/mining/overflowConfirm");
const { COIN_EMOJI } = require("../../constants/coin");

// 「背包滿了，繼續挖礦讓溢出折金幣」確認鈕 customId
const MINE_OVERFLOW_CONFIRM_PREFIX = "mine_overflow_confirm_";
const MINE_OVERFLOW_CANCEL_PREFIX = "mine_overflow_cancel_";

// 稀有礦石（幸運礦工任務）
const RARE_ORES = ["iron", "gold", "diamond"];

function oreLabel(oreKey) {
  const def = eventEngine.resolveOreDef(oreKey) || mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}

// 挖礦後顯示背包空位剩餘；快滿時提醒清空間，已滿時提示繼續挖會折金幣。
function backpackSpaceLine({ backpackFree, backpackUsed: used, backpackCap: cap }) {
  if (typeof backpackFree !== "number" || typeof cap !== "number") return "";
  if (backpackFree <= 0) {
    return (
      `**🎒 背包空位**\n已滿（${used}/${cap}）\n` +
      "-# 再挖會直接折成金幣，先去 `/賣礦` 或 `/合成` 騰出空間吧！"
    );
  }
  const warn = backpackFree <= 5 ? "（快滿了）" : "";
  let line = `**🎒 背包空位**\n剩餘 **${backpackFree}**／共 ${cap} 格${warn}`;
  if (warn) line += "\n-# 快滿了！考慮先去 `/賣礦` 或 `/合成` 清出空間。";
  return line;
}

// 「找鑑定師賭石」按鈕 customId 格式：mining_appraise_<ownerId>_<mineTs>
// mineTs 用來對上 DB 的 pending_appraisal.ts，確保只認最新一次挖礦、且單次有效。
const APPRAISE_PREFIX = "mining_appraise_";
const MAX_LABEL_LEN = 80;

// 冷卻中的 /挖礦 訊息上「🎫 使用 CD 縮短券」按鈕。
const MINE_CD_TICKET_PREFIX = "mine_cd_use_ticket_";

function parseMineCdTicketId(customId) {
  if (!customId || !customId.startsWith(MINE_CD_TICKET_PREFIX)) return null;
  const ownerId = customId.slice(MINE_CD_TICKET_PREFIX.length);
  if (!ownerId) return null;
  return { ownerId };
}

function pickaxeDurabilityLine(pickaxe, durability, maxDurability) {
  if (!pickaxe || pickaxe === "wood" || durability === null || durability === undefined) {
    return `🪓 **目前鎬子**\n${pickaxeLabel("wood")}（無耐久消耗）`;
  }
  const warn = mining?.durabilityWarn || {};
  const label = pickaxeLabel(pickaxe);
  const maxText = typeof maxDurability === "number" ? `/${maxDurability}` : "";
  if (typeof warn.critical === "number" && durability <= warn.critical) {
    return `🚨 **鎬子快斷了！**\n${label} 只剩 **${durability}**${maxText} 次，再挖就會斷裂退回木鎬。\n-# 快去 \`/合成\` 一把新的、或到 \`/背包\` 用劣質磨鎬石補耐久！`;
  }
  if (typeof warn.low === "number" && durability <= warn.low) {
    return `⚠️ **鎬子耐久偏低**\n${label} 剩 **${durability}**${maxText} 次\n-# 建議先去 \`/合成\` 備一把、或到 \`/背包\` 用劣質磨鎬石補耐久。`;
  }
  return `🪓 **目前鎬子**\n${label}・耐久 ${durability}${maxText} 次`;
}

function buildCooldownView({
  ownerId,
  readyAt,
  cdTickets,
  cdTicketUsedToday,
  cdTicketDailyLimit,
  cdTicketReductionMs,
  notifyEnabled,
  pickaxe,
  pickaxeDurability,
  pickaxeMaxDurability,
}) {
  const readyEpoch = Math.floor(readyAt / 1000);
  const reductionMin = Math.max(1, Math.round((cdTicketReductionMs || 0) / 60000));
  const overDailyLimit =
    cdTicketDailyLimit > 0 && cdTicketUsedToday >= cdTicketDailyLimit;

  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⏳ 鎬子還在休息\n下次可挖礦：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        pickaxeDurabilityLine(pickaxe, pickaxeDurability, pickaxeMaxDurability),
      ),
    );

  if (cdTickets > 0 && !overDailyLimit) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `🎫 **CD 縮短券** ×${cdTickets}\n-# 立即 -${reductionMin} 分；冷卻歸零會自動再挖一次`,
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${MINE_CD_TICKET_PREFIX}${ownerId}`)
            .setLabel(`使用 1 張（-${reductionMin} 分）`)
            .setStyle(ButtonStyle.Primary),
        ),
    );
  } else if (cdTickets > 0 && overDailyLimit) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🎫 今日 CD 縮短券已用 ${cdTicketUsedToday}/${cdTicketDailyLimit} 張，明天再用吧！`,
      ),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🎫 沒有 CD 縮短券，可到 `/商店` 看看，或等冷卻自然結束。",
      ),
    );
  }

  if (!notifyEnabled) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🔔 想冷卻結束時收到提醒？用 `/通知設定` 開啟挖礦到點通知。",
      ),
    );
  }

  return container;
}

function buildAppraiseRow(ownerId, ts, qty, feePerStone) {
  const fee = (feePerStone || 0) * (qty || 0);
  let label = `🔍 找鑑定師賭石（${qty} 顆・${fee.toLocaleString()} 金幣）`;
  if (label.length > MAX_LABEL_LEN) label = label.slice(0, MAX_LABEL_LEN);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPRAISE_PREFIX}${ownerId}_${ts}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
  );
}

function parseAppraiseId(customId) {
  if (!customId || !customId.startsWith(APPRAISE_PREFIX)) return null;
  const rest = customId.slice(APPRAISE_PREFIX.length);
  const us = rest.lastIndexOf("_");
  if (us <= 0) return null;
  const ownerId = rest.slice(0, us);
  const ts = Number(rest.slice(us + 1));
  if (!ownerId || !Number.isFinite(ts)) return null;
  return { ownerId, ts };
}

// 統一的挖礦執行流程，/挖礦 與「繼續（折金幣）」按鈕共用。
// allowOverflow=true 時 mineService 會跳過背包滿檢查、roll 出的礦溢出折金幣。
async function executeMine(client, interaction, { allowOverflow = false } = {}) {
  try {
    const result = await mineService.mine(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      username: interaction.user.username,
      allowOverflow,
    });

    if (!result.ok) {
      if (result.reason === "disabled") {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }
      if (result.reason === "cooldown") {
        const notifyState = await reminder.getState(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "mining",
        });
        const container = buildCooldownView({
          ownerId: interaction.user.id,
          readyAt: result.readyAt,
          cdTickets: result.cdTickets,
          cdTicketUsedToday: result.cdTicketUsedToday,
          cdTicketDailyLimit: result.cdTicketDailyLimit,
          cdTicketReductionMs: result.cdTicketReductionMs,
          notifyEnabled: !!notifyState?.enabled,
          pickaxe: result.pickaxe,
          pickaxeDurability: result.pickaxeDurability,
          pickaxeMaxDurability: result.pickaxeMaxDurability,
        });
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "backpack_full") {
        const confirm = buildOverflowConfirmView({
          title: "背包已滿",
          body: "目前沒辦法放更多礦石。要繼續挖礦的話，這次挖到的礦會直接折成金幣入帳。",
          used: result.used,
          cap: result.cap,
          confirmCustomId: `${MINE_OVERFLOW_CONFIRM_PREFIX}${interaction.user.id}`,
          cancelCustomId: `${MINE_OVERFLOW_CANCEL_PREFIX}${interaction.user.id}`,
          confirmLabel: "繼續挖礦（折金幣）",
        });
        return interaction.editReply({
          components: [confirm],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply("🔧 挖礦失敗，請稍後再試。");
    }

    const oreDef = eventEngine.resolveOreDef(result.ore) || mining.ores[result.ore];
    const value = (oreDef?.price || 0) * result.qty;
    const readyEpoch = Math.floor(result.newCooldownAt / 1000);

    if (result.ore === "diamond") {
      await sendLegendaryAnnouncement(client, interaction);
    }

    const isEventOre = !!oreDef?.event;
    const headerTitle =
      result.ore === "diamond"
        ? `✨ 傳說！你挖到了${oreDef?.name || "傳說礦"}！`
        : isEventOre
          ? `🎉 限定！你挖到了${oreDef?.name || "限定礦"}！`
          : "⛏️ 挖礦成功";

    const minedLine =
      result.qty > 0
        ? `你挖到了 **${oreLabel(result.ore)} ×${result.qty}**！\n預估賣價：**${value.toLocaleString()}** ${COIN_EMOJI}`
        : `你挖到了 **${oreLabel(result.ore)} ×${result.overflowQty}**，但背包放不下，全部折成金幣入帳。`;

    const container = new ContainerBuilder()
      .setAccentColor(
        result.ore === "diamond" ? 0xff6ec7 : isEventOre ? 0x9b59b6 : 0xf1c40f,
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${headerTitle}\n${minedLine}`),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**下次可挖礦**\n<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**累積挖礦**\n${result.mineCountTotal.toLocaleString()} 次`,
        ),
      );

    // 背包滿溢出折金幣的提示（只有部份溢出 / 全溢出時才顯示）
    if (result.overflowQty > 0 && result.qty > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          overflowLineText(result.ore, result.overflowQty, result.overflowCoins),
        ),
      );
    } else if (result.overflowQty > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `💰 折算金幣：**+${result.overflowCoins.toLocaleString()}** ${COIN_EMOJI}`,
        ),
      );
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(backpackSpaceLine(result)),
    );

    const buffNotes = [];
    if (result.buff.consume.usePotion) buffNotes.push("🍀 幸運藥水加成");
    if (result.buff.twitchLuckBonus > 0) {
      const tierLabel = { tier1: "T1", tier2: "T2", tier3: "T3" };
      const tierName = tierLabel[result.buff.twitchTierKey] || "";
      buffNotes.push(
        `<:twitch:1509949525618589786> 訂閱${tierName ? ` ${tierName}` : ""} 加成`,
      );
    }
    if (result.buff.donationLuckBonus > 0) {
      buffNotes.push("<:money:1509128163504947210> 贊助加成");
    }
    if (result.buff.eventLuckBonus > 0) {
      buffNotes.push("🎉 活動幸運加成");
    }
    if (result.buff.eventQtyBonus > 0) {
      buffNotes.push("🎉 活動數量加成");
    }
    if (buffNotes.length) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**挖礦幸運加成**\n${buffNotes.join(" ・ ")}`,
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

    if (result.durabilityBroke) {
      const brokeDef = mining?.pickaxes?.[result.pickaxeBefore] || {};
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 你的 ${brokeDef.name || result.pickaxeBefore} 耐久耗盡，已退回木鎬。`,
        ),
      );
      await dmPickaxeBroke(interaction, result.pickaxeBefore).catch(() => {});
    } else if (result.durabilityAfter !== null) {
      const warn = mining?.durabilityWarn || {};
      const after = result.durabilityAfter;
      const label = pickaxeLabel(result.pickaxeBefore);
      let line;
      if (typeof warn.critical === "number" && after <= warn.critical) {
        line = `🚨 **鎬子快斷了！**\n${label} 只剩 **${after}** 次，再挖就會斷裂退回木鎬。快去 \`/合成\` 一把新的、或到 \`/背包\` 用劣質磨鎬石補耐久！`;
      } else if (typeof warn.low === "number" && after <= warn.low) {
        line = `⚠️ **鎬子耐久偏低**\n${label} 剩 **${after}** 次，建議先去 \`/合成\` 備一把、或到 \`/背包\` 用劣質磨鎬石補耐久。`;
      } else {
        line = `**鎬子耐久**\n${label} 剩 ${after} 次`;
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
      if (result.durabilityWarnCrossed) {
        dmPickaxeLowDurability(
          interaction,
          result.pickaxeBefore,
          after,
          result.durabilityWarnCrossed,
        ).catch(() => {});
      }
    }

    const notifyState = await reminder.getState(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      type: "mining",
    });
    const notifyEnabled = !!notifyState?.enabled;
    if (notifyEnabled) {
      await reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "mining",
        readyAt: result.newCooldownAt,
      });
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

    if (result.appraisal) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "**🔍 賭石**\n-# 付費請鑑定師逐顆開石頭，有機率變成更值錢的礦——也可能全部碎掉！只有剛挖到時能賭。",
          ),
        )
        .addActionRowComponents(
          buildAppraiseRow(
            interaction.user.id,
            result.appraisal.ts,
            result.appraisal.qty,
            result.appraisal.feePerStone,
          ),
        );
    }

    if (!notifyEnabled) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 🔔 想冷卻結束時收到提醒？用 `/通知設定` 開啟挖礦到點通知。",
        ),
      );
    }

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    gameTitleService
      .check(
        client,
        {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
        },
        ["mining"]
      )
      .catch(() => {});

    const mineHooks = [
      { questId: "daily_mine_3" },
      { questId: "weekly_mine_20" },
    ];
    if (RARE_ORES.includes(result.ore)) {
      mineHooks.push({ questId: "daily_rare_ore" });
    }
    if (result.ore === "diamond") {
      mineHooks.push({ questId: "weekly_diamond" });
    }
    mineHooks.push(
      ...eventEngine.getEventQuestHooksByType("mine_count", { ore: result.ore }),
    );
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
      mineHooks
    );
  } catch (error) {
    console.log(`[ERROR] /挖礦:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 挖礦失敗，請呼叫舒舒！").catch(() => {});
  }
}

async function sendLegendaryAnnouncement(client, interaction) {
  const content = `✨💎 **${interaction.user}** 挖到了傳說中的 **${oreLabel("diamond")}**！`;

  const channelId = mining?.announceChannelId;
  try {
    if (channelId) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch?.isTextBased()) {
        await ch.send({ content });
        return;
      }
    }
    if (interaction.channel?.isTextBased()) {
      await interaction.channel.send({ content });
    }
  } catch (e) {
    console.log(`[WARN] 彩虹石公告失敗：${e.message}`.yellow);
  }
}

function miningChannelButtonRow(guildId, label) {
  const channelId = commandChannels?.mining?.[0] || normalChannelId;
  if (!guildId || !channelId) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(label)
      .setURL(`https://discord.com/channels/${guildId}/${channelId}`)
  );
}

async function dmPickaxeBroke(interaction, pickaxeBefore) {
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("### 💔 鎬子斷了！")
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `你的 **${pickaxeLabel(pickaxeBefore)}** 耐久已耗盡，自動退回 **${pickaxeLabel("wood")}**。\n` +
          "-# 想繼續享受加成，到 `/合成` 再合成一把吧！"
      )
    );
  const row = miningChannelButtonRow(interaction.guildId, "前往頻道使用 /合成");
  if (row) container.addActionRowComponents(row);
  await interaction.user.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function dmPickaxeLowDurability(interaction, pickaxeBefore, durabilityAfter, level) {
  const critical = level === "critical";
  const container = new ContainerBuilder()
    .setAccentColor(critical ? 0xed4245 : 0xfaa61a)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        critical ? "### 🚨 鎬子快斷了！" : "### ⚠️ 鎬子耐久偏低"
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        critical
          ? `你的 **${pickaxeLabel(pickaxeBefore)}** 只剩 **${durabilityAfter}** 次耐久，下一次挖礦就會斷！`
          : `你的 **${pickaxeLabel(pickaxeBefore)}** 耐久剩 **${durabilityAfter}** 次，差不多該準備了。`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 趁還沒斷，到 `/合成` 再做一把、或到 `/背包` 用劣質磨鎬石補滿耐久。"
      )
    );
  const row = miningChannelButtonRow(interaction.guildId, "前往頻道補救");
  if (row) container.addActionRowComponents(row);
  await interaction.user.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("挖礦")
    .setDescription("挖礦！每隔一段時間可挖一次，挖到的礦石可賣錢或合成裝備 ⛏️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();
    return executeMine(client, interaction, { allowOverflow: false });
  },

  APPRAISE_PREFIX,
  parseAppraiseId,
  oreLabel,
  executeMine,
  MINE_OVERFLOW_CONFIRM_PREFIX,
  MINE_OVERFLOW_CANCEL_PREFIX,
  MINE_CD_TICKET_PREFIX,
  parseMineCdTicketId,
  buildCooldownView,
};
