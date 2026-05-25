require("colors");

const {
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const { developersId, serverId, commandChannels } = require("../../config");
const mConfig = require("../../messageConfig.json");
const getLocalCommands = require("../../utils/getLocalCommands");
const { consume } = require("../../utils/rateLimiter");
const { allowedChannelsFor } = require("../../utils/commandChannelGuard");

// 賭場類指令冷卻較短，避免打斷遊戲節奏
const CASINO_COMMANDS = new Set([
  "blackjack",
  "hilo",
  "射龍門",
  "roulette",
  "slot",
  "slottest",
  "poker",
]);

// Discord 互動 token 只有 3 秒效期；超過就會回 10062 Unknown interaction。
// 這個錯誤已經無法挽救，記下警告就好，不要再嘗試回覆。
const UNKNOWN_INTERACTION = 10062;

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    if (replyErr?.code !== UNKNOWN_INTERACTION) {
      console.log(`[ERROR] 回覆驗證訊息失敗：${replyErr}`.red);
    }
  }
}

module.exports = async (client, interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const localCommands = getLocalCommands();

  try {
    const commandObject = localCommands.find(
      (cmd) => cmd.data.name === interaction.commandName
    );
    if (!commandObject) return;

    // 頻道分流：只在主伺服器生效。私人(ephemeral)與管理員/開發者指令豁免。
    // 用錯頻道就回覆一則 ephemeral 提醒，引導到對應頻道。
    if (interaction.guildId === serverId) {
      const allowed = allowedChannelsFor(commandObject, commandChannels);
      if (allowed && !allowed.includes(interaction.channelId)) {
        const mentions = allowed.map((id) => `<#${id}>`).join("、");
        await safeReply(interaction, {
          content: `🚫 \`/${commandObject.data.name}\` 不能在這裡使用喔！請到 ${mentions} 使用這個指令。`,
        });
        return;
      }
    }

    // 速率限制：開發者與管理員豁免
    const isDev = developersId.includes(interaction.member?.id);
    const isAdmin = interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    );
    if (!isDev && !isAdmin) {
      const cmdName = interaction.commandName;
      const windowMs = CASINO_COMMANDS.has(cmdName) ? 1500 : 3000;
      const r = consume(interaction.user.id, `cmd:${cmdName}`, {
        windowMs,
        max: 1,
      });
      if (!r.allowed) {
        const sec = Math.ceil(r.retryAfterMs / 1000);
        await safeReply(interaction, {
          content: `⏳ 操作太頻繁，請 ${sec} 秒後再試。`,
        });
        return;
      }
    }

    if (commandObject.devOnly) {
      if (!developersId.includes(interaction.member.id)) {
        const rEmbed = new EmbedBuilder()
          .setColor(`${mConfig.embedColorError}`)
          .setDescription(`${mConfig.commandDevOnly}`);
        await safeReply(interaction, { embeds: [rEmbed] });
        return;
      }
    }

    if (commandObject.testMode) {
      if (interaction.guild.id !== serverId) {
        const rEmbed = new EmbedBuilder()
          .setColor(`${mConfig.embedColorError}`)
          .setDescription(`${mConfig.commandTestMode}`);
        await safeReply(interaction, { embeds: [rEmbed] });
        return;
      }
    }

    if (commandObject.userPermissions?.length) {
      for (const permission of commandObject.userPermissions) {
        if (interaction.member.permissions.has(permission)) {
          continue;
        }
        const rEmbed = new EmbedBuilder()
          .setColor(`${mConfig.embedColorError}`)
          .setDescription(`${mConfig.userNoPermissions}`);
        await safeReply(interaction, { embeds: [rEmbed] });
        return;
      }
    }

    if (commandObject.botPermissions?.length) {
      for (const permission of commandObject.botPermissions) {
        const bot = interaction.guild.members.me;
        if (bot.permissions.has(permission)) {
          continue;
        }
        const rEmbed = new EmbedBuilder()
          .setColor(`${mConfig.embedColorError}`)
          .setDescription(`${mConfig.botNoPermissions}`);
        await safeReply(interaction, { embeds: [rEmbed] });
        return;
      }
    }

    await commandObject.run(client, interaction);
  } catch (err) {
    const sub = (() => {
      try {
        const group = interaction.options.getSubcommandGroup(false);
        const name = interaction.options.getSubcommand(false);
        return [group, name].filter(Boolean).join(" ");
      } catch (_) {
        return "";
      }
    })();
    const cmdLabel = sub
      ? `/${interaction.commandName} ${sub}`
      : `/${interaction.commandName}`;
    const userLabel = `${interaction.user?.tag ?? "?"}(${interaction.user?.id ?? "?"})`;

    if (err?.code === UNKNOWN_INTERACTION) {
      // 互動已逾期，通常是指令在 3 秒內沒有 defer/reply。
      // 不要再嘗試回覆，避免再次拋出 10062 連鎖。
      console.log(
        `[WARN] ${cmdLabel} 互動已逾期（10062）— 指令在 3 秒內未呼叫 deferReply/reply。user=${userLabel}`
          .yellow
      );
      return;
    }

    console.log(
      `[ERROR] ${cmdLabel} 執行失敗 user=${userLabel}\n${err?.stack || err}`
        .red
    );
    await safeReply(interaction, {
      content: "🔧 指令執行時發生錯誤，請稍後再試或呼叫舒舒！",
    });
  }
};
