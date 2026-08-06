require("colors");
const { MessageFlags } = require("discord.js");

const autocompleteBeverageStore = require("../../../utils/autocompleteBeverageStore");
const autocompleteFoodName = require("../../../utils/autocompleteFoodName");
const { CATEGORY_LABEL } = require("../../../constants/foodCategories");
const { resolveChoice } = require("../../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../../utils/choiceErrorContainer");
const { foodNameChoices, FOOD_NAME_STRIP } = require("../foodNameChoices");

async function autocomplete(client, interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "飲料店") {
    return autocompleteBeverageStore(client, interaction);
  }
  if (focused.name === "食物名稱") {
    return autocompleteFoodName(client, interaction);
  }
  return interaction.respond([]).catch(() => {});
}

async function run(client, interaction) {
  const { options } = interaction;
  const category = options.getString("類別");
  const beverageStore = options.getString("飲料店")?.trim() || null;

  const collection = client.collection;

  await interaction.deferReply();

  try {
    // 選單顯示「珍奶（50嵐）」但 value 只有食物名稱，玩家貼整行回來要先還原
    const picked = resolveChoice(
      options.getString("食物名稱"),
      await foodNameChoices(client, interaction),
      { strip: FOOD_NAME_STRIP },
    );
    if (!picked.ok) {
      return interaction.editReply({
        components: [buildChoiceErrorContainer(picked, { what: "食物" })],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    const foodToDelete = picked.value;

    let deleteQuery = { name: foodToDelete };

    if (category) {
      deleteQuery.category = category;
    }

    if (category === "beverage" && beverageStore) {
      deleteQuery.beverageStore = beverageStore;
    }

    const matchingItems = await collection.find({ name: foodToDelete }).toArray();

    if (matchingItems.length > 1 && !category) {
      let msg = `找到多個「${foodToDelete}」選項，請指定類別：\n`;
      matchingItems.forEach((item) => {
        let itemDesc = `- ${CATEGORY_LABEL[item.category]}`;
        if (item.beverageStore) {
          itemDesc += `（${item.beverageStore}）`;
        }
        msg += itemDesc + "\n";
      });
      interaction.editReply(msg);
      return;
    }

    const deleteResult = await collection.deleteOne(deleteQuery);

    if (deleteResult.deletedCount === 1) {
      let msg = `已刪除食物選項：${foodToDelete}`;
      if (category) {
        msg += `（${CATEGORY_LABEL[category]}`;
        if (beverageStore) {
          msg += ` - ${beverageStore}`;
        }
        msg += "）";
      }
      interaction.editReply(msg);
      console.log(`Deleted food: ${foodToDelete}`.yellow);
    } else {
      let msg = `找不到要刪除的食物選項：${foodToDelete}`;
      if (category) {
        msg += `（${CATEGORY_LABEL[category]}`;
        if (beverageStore) {
          msg += ` - ${beverageStore}`;
        }
        msg += "）";
      }
      interaction.editReply(msg);
    }
  } catch (error) {
    interaction.editReply("🔧 刪除食物失敗，請呼叫舒舒！");
    console.log(
      `[ERROR] An error occurred inside the delete food:\n${error}`.red
    );
  }
}

module.exports = { run, autocomplete };
