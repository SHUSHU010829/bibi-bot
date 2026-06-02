require("colors");

const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");
const { DateTime } = require("luxon");

const { morningMessage } = require("../../config");
const getPoem = require("../../utils/getPoem");
const getStraw = require("../../utils/getStraw");
const changeTraditional = require("../../utils/changeTraditional");
const generateFortuneCard = require("../../utils/generateFortuneCard");

const WEEKDAY_EN = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("抽籤")
    .setDescription("來抽個籤吧！🧧")
    .addStringOption((option) =>
      option.setName("諮詢方向").setDescription("輸入想抽籤的主題")
    ),

  run: async (client, interaction) => {
    try {
      await interaction.deferReply();

      const question = interaction.options.getString("諮詢方向") || "日常求籤";
      const strawResult = await getStraw();
      const fortuneText = strawResult.replace(/^\S+\s+/, "").trim();

      const poem = await getPoem();
      let poemContent = "";
      let poemOrigin = "";
      let poemAuthor = "";
      if (poem) {
        const content = await changeTraditional(poem.content);
        const origin = await changeTraditional(poem.origin);
        const author = await changeTraditional(poem.author);
        poemContent = content?.text || "";
        poemOrigin = origin?.text || "";
        poemAuthor = author?.text || "";
      }

      const timezone = morningMessage?.timezone || "Asia/Taipei";
      const now = DateTime.now().setZone(timezone);
      const dateStr = `${now.toFormat("yyyy.MM.dd")} ${WEEKDAY_EN[now.weekday] || ""}`.trim();
      const serialNo = "0829";

      let attachment = null;
      let fileName = null;
      try {
        const pngBuffer = await generateFortuneCard({
          fortuneText,
          question,
          poemContent,
          poemOrigin,
          poemAuthor,
          dateStr,
          serialNo,
        });
        fileName = `fortune-${serialNo}.png`;
        attachment = new AttachmentBuilder(pngBuffer, { name: fileName });
      } catch (cardErr) {
        console.log(
          `[WARN] fortune card render failed, falling back to text: ${cardErr.message}`.yellow
        );
      }

      const container = new ContainerBuilder()
        .setAccentColor(0xc8553d)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🧧 籤詩\n諮詢方向：**${question}**`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder());

      if (attachment) {
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder()
              .setURL(`attachment://${fileName}`)
              .setDescription(`籤詩 No.${serialNo}・${dateStr}`)
          )
        );
      } else {
        const poemBlock =
          poemContent && poemOrigin
            ? `\n\n*${poemContent}*\n-# ── ${poemAuthor ? `${poemAuthor}・` : ""}《${poemOrigin}》`
            : "";
        container
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `### ${strawResult}${poemBlock}`
            )
          )
          .addSeparatorComponents(new SeparatorBuilder());
      }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 🍀 抽自逼逼機器人廟口籤筒・No.${serialNo}・${dateStr}`
        )
      );

      await interaction.editReply({
        components: [container],
        files: attachment ? [attachment] : [],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(
        `[ERROR] An error occurred inside the straws ask:\n${error}`.red
      );
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply({ content: "哎呀！今天籤筒休息了 💤", components: [] })
          .catch(() => {});
      } else {
        await interaction
          .reply({ content: "哎呀！今天籤筒休息了 💤", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  },
};
