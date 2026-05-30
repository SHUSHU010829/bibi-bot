require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const mineService = require("../../features/mining/mineService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");
const eventEngine = require("../../features/event/eventEngine");
const { COIN_EMOJI } = require("../../constants/coin");

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

// 「找鑑定師賭石」按鈕 customId 格式：mining_appraise_<ownerId>_<mineTs>
// mineTs 用來對上 DB 的 pending_appraisal.ts，確保只認最新一次挖礦、且單次有效。
const APPRAISE_PREFIX = "mining_appraise_";
const MAX_LABEL_LEN = 80;

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName("挖礦")
    .setDescription("挖礦！每隔一段時間可挖一次，挖到的礦石可賣錢或合成裝備 ⛏️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const result = await mineService.mine(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        username: interaction.user.username,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 挖礦系統尚未啟動！");
        }
        if (result.reason === "cooldown") {
          const readyEpoch = Math.floor(result.readyAt / 1000);
          return interaction.editReply(
            `⛏️ 你的鎬子還在休息！下次可挖礦：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`
          );
        }
        if (result.reason === "backpack_full") {
          return interaction.editReply(
            `🎒 背包滿了（${result.used}/${result.cap}）！先用 \`/賣礦\` 賣掉一些礦石再來挖。`
          );
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

      const container = new ContainerBuilder()
        .setAccentColor(
          result.ore === "diamond" ? 0xff6ec7 : isEventOre ? 0x9b59b6 : 0xf1c40f,
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${headerTitle}\n` +
              `你挖到了 **${oreLabel(result.ore)} ×${result.qty}**！\n` +
              `預估賣價：**${value.toLocaleString()}** ${COIN_EMOJI}`,
          ),
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

      if (result.durabilityBroke) {
        const brokeDef = mining?.pickaxes?.[result.pickaxeBefore] || {};
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 你的 ${brokeDef.name || result.pickaxeBefore} 耐久耗盡，已退回木鎬。`,
          ),
        );
        await dmPickaxeBroke(interaction, result.pickaxeBefore).catch(() => {});
      } else if (result.durabilityAfter !== null) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**鎬子耐久**\n${pickaxeLabel(result.pickaxeBefore)} 剩 ${result.durabilityAfter} 次`,
          ),
        );
      }

      // 到點通知改由 /通知設定 集中管理；這裡只負責把「已訂閱」者的冷卻時間更新到最新。
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

      // 突發事件（戰鬥擴充）：採集途中的隨機事件
      if (result.encounter) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**${result.encounter.emoji} 突發事件：${result.encounter.name}**\n${result.encounter.body}`,
            ),
          );
      }

      // 剛挖到石頭：附上「找鑑定師賭石」按鈕（只有這次、限時有效）
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

      // 挖礦任務進度（非阻塞）
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
      // 限時活動限定任務（Phase S5）：挖礦次數型，依目前生效活動動態併入
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
  },

  APPRAISE_PREFIX,
  parseAppraiseId,
  oreLabel,
};

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

async function dmPickaxeBroke(interaction, pickaxeBefore) {
  const def = mining?.pickaxes?.[pickaxeBefore] || {};
  await interaction.user.send(
    `⛏️ 你的 **${def.emoji || ""} ${def.name || pickaxeBefore}** 耐久已耗盡，自動退回 **木鎬**。\n` +
      `想繼續享受加成，到 \`/合成\` 再合成一把吧！`
  );
}
