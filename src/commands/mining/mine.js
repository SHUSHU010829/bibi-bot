require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const mineService = require("../../features/mining/mineService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const reminder = require("../../features/reminders/cooldownReminderService");
const { COIN_EMOJI } = require("../../constants/coin");

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

      // 鑽石（傳說）：特殊呈現 + 公告
      if (result.ore === "diamond") {
        await sendLegendaryAnnouncement(client, interaction);
      }

      const embed = new EmbedBuilder()
        .setColor(result.ore === "diamond" ? 0xff6ec7 : 0xf1c40f)
        .setTitle(
          result.ore === "diamond"
            ? `✨ 傳說！你挖到了${oreDef?.name || "傳說礦"}！`
            : "⛏️ 挖礦成功"
        )
        .setDescription(
          `你挖到了 **${oreLabel(result.ore)} ×${result.qty}**！\n` +
            `預估賣價：**${value.toLocaleString()}** ${COIN_EMOJI}`
        )
        .addFields(
          {
            name: "下次可挖礦",
            value: `<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`,
            inline: true,
          },
          {
            name: "累積挖礦",
            value: `${result.mineCountTotal.toLocaleString()} 次`,
            inline: true,
          }
        );

      const buffNotes = [];
      if (result.buff.consume.usePotion) buffNotes.push("🍀 幸運藥水 +luck");
      if (buffNotes.length) {
        embed.addFields({ name: "本次加成", value: buffNotes.join(" ・ ") });
      }

      if (result.durabilityBroke) {
        // footer 不會渲染自訂 emoji，這裡只放名稱
        const brokeDef = mining?.pickaxes?.[result.pickaxeBefore] || {};
        embed.setFooter({
          text: `你的 ${brokeDef.name || result.pickaxeBefore} 耐久耗盡，已退回木鎬。`,
        });
        await dmPickaxeBroke(interaction, result.pickaxeBefore).catch(() => {});
      } else if (result.durabilityAfter !== null) {
        embed.addFields({
          name: "鎬子耐久",
          value: `${pickaxeLabel(result.pickaxeBefore)} 剩 ${result.durabilityAfter} 次`,
          inline: true,
        });
      }

      const notifyState = await reminder.getState(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "mining",
      });
      const notifyEnabled = !!notifyState?.enabled;
      // 已開啟通知者，把追蹤的冷卻更新成本次最新值
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

      await interaction.editReply({ embeds: [embed], components: [row] });

      // 稱號解鎖檢查不阻塞回覆；MiningProfiles 已寫入本次挖礦數據
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
    // 沒設定公告頻道就在當前頻道公開慶祝
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
