require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const mineService = require("../../features/mining/mineService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");
const { COIN_EMOJI } = require("../../constants/coin");

// 稀有礦石（幸運礦工任務）
const RARE_ORES = ["iron", "gold", "diamond"];

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
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

      const oreDef = mining.ores[result.ore];
      const value = (oreDef?.price || 0) * result.qty;
      const readyEpoch = Math.floor(result.newCooldownAt / 1000);

      if (result.ore === "diamond") {
        await sendLegendaryAnnouncement(client, interaction);
      }

      const headerTitle =
        result.ore === "diamond"
          ? `✨ 傳說！你挖到了${oreDef?.name || "傳說礦"}！`
          : "⛏️ 挖礦成功";

      const container = new ContainerBuilder()
        .setAccentColor(result.ore === "diamond" ? 0xff6ec7 : 0xf1c40f)
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
      if (result.buff.consume.usePotion) buffNotes.push("🍀 幸運藥水 +luck");
      if (result.buff.donationLuckBonus > 0) {
        buffNotes.push(
          `<:money:1509128163504947210> 贊助加成幸運 +${Math.round(result.buff.donationLuckBonus * 100)}%`,
        );
      }
      if (buffNotes.length) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**本次加成**\n${buffNotes.join(" ・ ")}`,
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
      const row = reminder.buildButtonRow({
        type: "mining",
        ownerId: interaction.user.id,
        enabled: notifyEnabled,
      });

      container.addActionRowComponents(row);

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
