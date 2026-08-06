require("colors");

const { respondChoices } = require("./choiceInput");
const { foodNameChoices, FOOD_NAME_STRIP } = require("../features/food/foodNameChoices");

module.exports = async (client, interaction) => {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "食物名稱") {
    return interaction.respond([]).catch(() => {});
  }

  try {
    const options = await foodNameChoices(client, interaction);
    await respondChoices(interaction, options, focused.value, { strip: FOOD_NAME_STRIP });
  } catch (err) {
    console.log(`[ERROR] Food name autocomplete failed:\n${err}`.red);
    interaction.respond([]).catch(() => {});
  }
};
