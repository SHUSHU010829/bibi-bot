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
const { parseSocialLink } = require("../../features/share/socialLinks");

const PLATFORM_LABELS = {
  twitter: "𝕏 貼文",
  instagram: { p: "📸 IG 貼文", reel: "🎬 IG Reels", tv: "🎬 IG 影片" },
};

const ERRORS = {
  invalid: {
    title: "❌ 認不得這個連結",
    detail: "目前支援：脆（threads.com / threads.net）、X / Twitter（x.com / twitter.com）、Instagram（instagram.com）的貼文連結。",
    hint: "X 要 /帳號/status/xxx、IG 要 /p/xxx 或 /reel/xxx；t.co、IG /share 這類短連結請先在 App 打開後再「複製連結」。",
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

function socialLinkLabel(link) {
  if (link.platform === "twitter") {
    return link.username ? `𝕏 @${link.username} 的貼文` : PLATFORM_LABELS.twitter;
  }
  return PLATFORM_LABELS.instagram[link.kind];
}

// X / IG：不用 Components V2，Discord 才會幫訊息裡的連結產生預覽。
// 遮罩連結指向 embed 代理拿預覽，乾淨的原始連結用 <> 包起來避免重複預覽。
async function replySocialLink(interaction, link) {
  await interaction.reply({
    content: `[${socialLinkLabel(link)}](${link.previewUrl})\n-# <${link.url}>`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("開啟貼文")
          .setStyle(ButtonStyle.Link)
          .setURL(link.url)
      ),
    ],
    allowedMentions: { parse: [] },
  });
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
    .setName("分享")
    .setDescription("分享脆 / X / IG 貼文：去掉追蹤碼並顯示預覽 🔗")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("連結")
        .setDescription("脆、X（Twitter）或 Instagram 的貼文連結")
        .setRequired(true)
    ),

  run: async (client, interaction) => {
    const input = interaction.options.getString("連結");

    const socialLink = parseSocialLink(input);
    if (socialLink) {
      try {
        return await replySocialLink(interaction, socialLink);
      } catch (error) {
        console.log(`[ERROR] /分享 發生錯誤：\n${error}`.red);
        return interaction
          .reply({
            components: [errorContainer(ERRORS.unexpected)],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }

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
        ? buildThreadsPreview(result.data, result.url).addSeparatorComponents(
            new SeparatorBuilder()
          )
        : new ContainerBuilder().setAccentColor(0x000000);

      container
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`🧵 ${result.url}`)
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
      console.log(`[ERROR] /分享 發生錯誤：\n${error}`.red);
      await replyErrorPrivately(interaction, ERRORS.unexpected);
    }
  },
};
