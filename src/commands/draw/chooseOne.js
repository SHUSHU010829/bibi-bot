require("colors");

const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

function randomColor() {
  return Math.floor(Math.random() * 0xffffff);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("二選一")
    .setDescription("讓機器人幫你選！支援 2-5 個選項")
    .addStringOption((option) =>
      option
        .setName("選擇一")
        .setDescription("輸入想要抽選項目的第一項")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("選擇二")
        .setDescription("輸入想要抽選項目的第二項")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("選擇三")
        .setDescription("輸入想要抽選項目的第三項（可選）")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("選擇四")
        .setDescription("輸入想要抽選項目的第四項（可選）")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("選擇五")
        .setDescription("輸入想要抽選項目的第五項（可選）")
        .setRequired(false)
    ),

  run: async (client, interaction) => {
    const { options } = interaction;

    const CHOICE_NAMES = ["選擇一", "選擇二", "選擇三", "選擇四", "選擇五"];
    const COUNT_LABEL = ["", "一", "二", "三", "四", "五"];

    const choices = CHOICE_NAMES
      .map((name) => options.getString(name)?.trim())
      .filter((value) => value);

    await interaction.deferReply();

    try {
      const result = choices[Math.floor(Math.random() * choices.length)];
      const choicesText = choices
        .map((c, i) => `${i + 1}. "${c}"`)
        .join(" v.s ");
      const headerLabel = COUNT_LABEL[choices.length] || "多";

      const container = new ContainerBuilder()
        .setAccentColor(randomColor())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${headerLabel}選一結果 ⬇️\n# 機器人選了 "${result}"！`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`➡️ ${choicesText}`),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 從 ${choices.length} 個選項中選出 ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      await interaction.editReply("哎呀！今天懶得選擇 💤");
      console.log(
        `[ERROR] An error occurred inside the choose One:\n${error}`.red
      );
    }
  },
};
