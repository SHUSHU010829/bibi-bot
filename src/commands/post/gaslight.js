require("colors");

const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("生成情勒文")
    .setDescription("這裡有現成的情勒文，歡迎偷偷拿走！"),

  run: async (client, interaction) => {
    const collection = client.gaslightCollection;

    await interaction.deferReply();

    try {
      const postList = await collection.find({}).toArray();
      if (postList.length > 0) {
        const randomPost =
          postList[Math.floor(Math.random() * postList.length)].post;
        await interaction.editReply(randomPost);
      } else {
        await interaction.editReply("目前沒有情勒文庫存。");
      }
    } catch (error) {
      await interaction.editReply("🔧 獲取情勒文失敗，請呼叫舒舒！");
      console.log(
        `[ERROR] An error occurred inside the gaslight post:\n${error}`.red
      );
    }
  },
};
