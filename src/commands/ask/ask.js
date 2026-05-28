require("colors");

const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const getAnswer = require("../../utils/getAnswer.js");
const changeTraditional = require("../../utils/changeTraditional.js");

function randomColor() {
  return Math.floor(Math.random() * 0xffffff);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("我想問")
    .setDescription("跟逼逼機器人問是非題（會回 Yes / No / Maybe）💬")
    .addStringOption((option) =>
      option
        .setName("問題")
        .setDescription("輸入想問的是非題（例：今天該加班嗎？）")
        .setRequired(true)
    ),

  run: async (client, interaction) => {
    const question = interaction.options.getString("問題");

    await interaction.deferReply();

    try {
      const answer = await getAnswer();

      let title = "🤔 我不知道";
      if (answer && answer.code === 1) {
        const final = await changeTraditional(answer.data.zh);
        if (final?.text) title = final.text;
      }

      const container = new ContainerBuilder()
        .setAccentColor(randomColor())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# ${title}`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`📝 問題：${question}`),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(
        `[ERROR] An error occurred inside the command ask:\n${error}`.red
      );
      await interaction
        .editReply("🔧 詢問失敗，請稍後再試！")
        .catch(() => {});
    }
  },
};
