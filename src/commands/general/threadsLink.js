require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const {
  resolveCleanThreadsUrl,
} = require("../../features/threads/threadsLinkResolver");
const { extractThreadsUrl } = require("../../features/threads/threadsScraper");
const { buildThreadsPreview } = require("../../features/threads/threadsPreview");

const ERRORS = {
  invalid: {
    title: "❌ 這不是脆的連結",
    detail: "只認得 threads.com / threads.net 的貼文連結。",
    hint: "支援永久連結（/@帳號/post/xxx）與分享短連結（/share、/t、/p）。",
  },
  unresolved: {
    title: "❌ 解析不出原始連結",
    detail: "這則貼文可能已被刪除、設為私人，或脆這次沒有回傳貼文資訊。",
    hint: "可以在脆上打開貼文，改用右上角「複製連結」拿到的網址再試一次。",
  },
  unreachable: {
    title: "❌ 連不上脆",
    detail: "脆目前沒有回應，可能是暫時被擋下或網路不穩。",
    hint: "過幾分鐘再試一次就好。",
  },
  unexpected: {
    title: "❌ 出了點問題",
    detail: "解析連結時發生非預期錯誤。",
    hint: "稍後再試一次，如果一直失敗請回報開發者。",
  },
};

function errorContainer({ title, detail, hint }) {
  return new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(detail))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
}

// 失敗只給發指令的人看。已經公開 defer 過，先把等待中的訊息收掉再補一則私人的。
async function replyErrorPrivately(interaction, spec) {
  await interaction.deleteReply().catch(() => {});
  await interaction.followUp({
    components: [errorContainer(spec)],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports = {
  skipChannelGuard: true,
  data: new SlashCommandBuilder()
    .setName("脆")
    .setDescription("把脆的分享短連結還原成不帶追蹤碼的原始連結 🧵")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("連結")
        .setDescription("脆的貼文連結或分享短連結")
        .setRequired(true)
    ),

  run: async (client, interaction) => {
    const input = interaction.options.getString("連結");

    // 網址格式不對在連外前就擋掉，直接回私人訊息，不用先公開 defer
    if (!extractThreadsUrl(input)) {
      return interaction.reply({
        components: [errorContainer(ERRORS.invalid)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      const result = await resolveCleanThreadsUrl(input, { withPreview: true });

      if (!result.ok) {
        return replyErrorPrivately(interaction, ERRORS[result.reason]);
      }

      const container = result.data
        ? buildThreadsPreview(result.data, result.url)
        : new ContainerBuilder().setAccentColor(0x000000);

      const note =
        result.source === "resolved"
          ? "已還原成貼文原始連結，追蹤碼都拿掉了。"
          : result.original === result.url
            ? "這個連結本來就是乾淨的，沒東西可以拿掉。"
            : "已移除追蹤參數。";

      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`🧵 ${result.url}`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            result.data ? `-# ${note}` : `-# ${note}（抓不到貼文內容，只給連結）`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel("開啟貼文")
              .setStyle(ButtonStyle.Link)
              .setURL(result.url)
          )
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /脆 發生錯誤：\n${error}`.red);
      await replyErrorPrivately(interaction, ERRORS.unexpected);
    }
  },
};
